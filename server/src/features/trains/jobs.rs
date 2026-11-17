//! Background jobs for trains: following the live position stream, and refreshing the
//! running trains and the stations. Handlers are safe to run twice (they overwrite).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use chrono::Utc;
use northstack::Job;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::db::{self, StoredFix};
use super::railway::{Snap, snap_lat_lon, track_path};
use super::speeds::{Memory, Observed};
use super::trafikverket::{RawFix, SseParser, fixes};
use super::types::Fix;
use crate::AppState;

/// How long one job follows the stream. Cron starts a new one every 5 minutes, so they
/// overlap by 30 s and there is never a gap (both write the same rows; newer fix wins).
pub const FOLLOW_FOR: Duration = Duration::from_secs(330);
/// Older than this, a train's previous fix isn't routed from (signal lost, new run).
const FORGET_MS: i64 = 10 * 60_000;
/// Trains silent this long are deleted.
const KEEP_MS: i64 = 15 * 60_000;

/// Follow Trafikverket's live position stream for a few minutes, snapping each fix to the
/// rails and storing it in `positions`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowPositions;

impl Job for FollowPositions {
    const KIND: &'static str = "trains.follow_positions";
    // the next cron slot (or a visit) starts a fresh one; no point retrying an old one
    const MAX_ATTEMPTS: i32 = 1;
    const TIMEOUT: Duration = Duration::from_secs(480);
}

pub async fn follow_positions(state: AppState, _job: FollowPositions) -> anyhow::Result<()> {
    let deadline = Instant::now() + FOLLOW_FOR;
    let mut last = db::last_snaps(&state.db).await?;
    let mut learn = Learn {
        memory: Memory::new(db::speeds(&state.db).await?),
        products: db::products(&state.db).await?,
    };
    let mut since = Utc::now() - chrono::Duration::minutes(10);
    let mut next_cleanup = Instant::now();
    // The stream can end early (upstream restarts): reconnect until the deadline.
    while Instant::now() < deadline {
        let (snapshot, url) = state.trafikverket.position_stream(since).await?;
        last = ingest(&state, snapshot, last, &mut learn).await?;
        since = Utc::now() - chrono::Duration::minutes(1);

        let mut res = state.trafikverket.open_stream(&url).await?;
        let (mut parser, mut pending) = (SseParser::default(), Vec::new());
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let chunk = match tokio::time::timeout(left, res.chunk()).await {
                Err(_) => return Ok(()), // deadline
                Ok(chunk) => chunk?,
            };
            let Some(chunk) = chunk else { break }; // stream ended: reconnect
            pending.extend_from_slice(&chunk);
            // a chunk can end mid-character: decode what's complete, keep the rest
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) => e.valid_up_to(),
            };
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            let mut batch = Vec::new();
            for data in parser.push(&text) {
                let Ok(event) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                for result in event["RESPONSE"]["RESULT"].as_array().into_iter().flatten() {
                    batch.extend(fixes(result));
                }
            }
            if !batch.is_empty() {
                last = ingest(&state, batch, last, &mut learn).await?;
            }
            if Instant::now() >= next_cleanup {
                db::delete_fixes_before(&state.db, Utc::now().timestamp_millis() - KEEP_MS).await?;
                next_cleanup = Instant::now() + Duration::from_secs(60);
            }
        }
    }
    Ok(())
}

type Last = HashMap<String, (i64, Option<Snap>)>;

/// Learned speeds and train products, kept for the life of one follower.
struct Learn {
    memory: Memory,
    products: HashMap<String, String>,
}

/// Snap a batch of fixes (on the CPU pool: routing is real work) and store them, then learn
/// speeds from the new ones and grade guesses against them.
async fn ingest(
    state: &AppState,
    raw: Vec<RawFix>,
    last: Last,
    learn: &mut Learn,
) -> anyhow::Result<Last> {
    let (stored, last) = northstack::cpu::spawn(move || snap_all(raw, last)).await?;
    let new = db::store_fixes(&state.db, &stored, Utc::now().timestamp_millis()).await?;
    let (mut samples, mut grades) = (vec![], vec![]);
    for (f, new) in stored.iter().zip(new) {
        let product = learn.products.get(&f.fix.n).map_or("", String::as_str);
        let (s, g) = learn.memory.observe(&Observed {
            train: &f.fix.n,
            product,
            ts: f.fix.ts,
            at: [f.fix.lat, f.fix.lon],
            bearing: f.fix.bearing,
            speed: f.fix.speed,
            path: f.fix.path.as_deref(),
            new: new && f.snap.is_some(),
        });
        samples.extend(s);
        grades.extend(g);
    }
    db::add_speeds(&state.db, &samples).await?;
    let day = Utc::now().format("%Y-%m-%d").to_string();
    db::add_grades(&state.db, &day, &grades).await?;
    Ok(last)
}

/// Move each fix onto the nearest track, with the route along the rails from the train's
/// previous fix. Several fixes of one train in a batch become one, with the routes joined.
pub fn snap_all(mut raw: Vec<RawFix>, mut last: Last) -> (Vec<StoredFix>, Last) {
    raw.sort_by_key(|f| f.ts);
    let mut out: Vec<StoredFix> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for f in raw {
        let prev = last.get(&f.train);
        if prev.is_some_and(|(ts, _)| f.ts <= *ts) {
            continue; // seen already, or a late fix
        }
        let from = prev
            .filter(|(ts, _)| f.ts - ts < FORGET_MS)
            .and_then(|(_, s)| s.as_ref());
        let placed = track_path(from, f.lat, f.lon, f.bearing);
        let (snap, path, ahead) = (placed.snap, placed.path, placed.ahead);
        let (lat, lon) = snap
            .map(|s| snap_lat_lon(&s).into())
            .unwrap_or((f.lat, f.lon));
        last.insert(f.train.clone(), (f.ts, snap));
        let fix = Fix {
            n: f.train,
            lat,
            lon,
            bearing: f.bearing,
            speed: f.speed,
            ts: f.ts,
            path,
            ahead,
        };
        match index.get(&fix.n) {
            Some(&i) => {
                // join the routes: earlier fix's route, then this one's (minus the shared point)
                let path = match (out[i].fix.path.take(), fix.path.clone()) {
                    (Some(mut a), Some(b)) => {
                        a.extend(b.into_iter().skip(1));
                        Some(a)
                    }
                    _ => None,
                };
                out[i] = StoredFix {
                    fix: Fix { path, ..fix },
                    snap,
                };
            }
            None => {
                index.insert(fix.n.clone(), out.len());
                out.push(StoredFix { fix, snap });
            }
        }
    }
    (out, last)
}

/// Reload the advertised trains running now (every 5 minutes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshTrains;

impl Job for RefreshTrains {
    const KIND: &'static str = "trains.refresh_trains";
    const MAX_ATTEMPTS: i32 = 2;
}

pub async fn refresh_trains_job(state: AppState, _job: RefreshTrains) -> anyhow::Result<()> {
    refresh_trains(&state).await
}

pub async fn refresh_trains(state: &AppState) -> anyhow::Result<()> {
    if db::refreshed_at(&state.db, "stations").await?.is_none() {
        refresh_stations(state).await?;
    }
    let names = db::station_names(&state.db).await?;
    let list = state.trafikverket.trains(&names).await?;
    db::replace_trains(&state.db, &list).await?;
    tracing::info!(trains = list.len(), "trains refreshed");
    Ok(())
}

/// Reload the stations (daily).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshStations;

impl Job for RefreshStations {
    const KIND: &'static str = "trains.refresh_stations";
}

pub async fn refresh_stations_job(state: AppState, _job: RefreshStations) -> anyhow::Result<()> {
    refresh_stations(&state).await
}

pub async fn refresh_stations(state: &AppState) -> anyhow::Result<()> {
    let list = state.trafikverket.stations().await?;
    db::replace_stations(&state.db, &list).await?;
    tracing::info!(stations = list.len(), "stations refreshed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(train: &str, ts: i64) -> RawFix {
        // Stockholm Central, on the tracks
        RawFix {
            train: train.into(),
            lat: 59.3303,
            lon: 18.0575,
            bearing: None,
            speed: Some(40.0),
            ts,
        }
    }

    #[test]
    fn keeps_the_newest_fix_per_train() {
        let (out, last) = snap_all(
            vec![raw("1", 2000), raw("1", 1000), raw("2", 1500)],
            HashMap::new(),
        );
        assert_eq!(out.len(), 2);
        let one = out.iter().find(|f| f.fix.n == "1").unwrap();
        assert_eq!(one.fix.ts, 2000);
        assert!(one.snap.is_some());
        assert_eq!(last["1"].0, 2000);
        // already seen: nothing new
        let (out, _) = snap_all(vec![raw("1", 2000)], last);
        assert!(out.is_empty());
    }
}
