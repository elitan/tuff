//! RPC handlers for trains.

use chrono::{DateTime, Utc};
use northstack::{Ctx, EnqueueOptions, ErrorCode, Job, RpcError, RpcResult};

use super::db;
use super::jobs::{self, FollowPositions, RefreshStations, RefreshTrains};
use super::types::*;
use crate::AppState;

/// Trains with a fix in the last 10 minutes are on the map.
const WINDOW_MS: i64 = 10 * 60_000;
/// Overlap between polls, so a fix stored while a poll was being answered isn't missed
/// (the browser ignores fixes it already has).
const OVERLAP_MS: i64 = 2_000;

/// Fixes for the map: every train seen in the last 10 minutes, or only what's new since `since`.
pub async fn positions(ctx: Ctx<AppState>, input: PositionsInput) -> RpcResult<Positions> {
    let state = &ctx.state;
    let now = Utc::now().timestamp_millis();
    // Someone is watching: make sure the live feed is being followed (after a deploy, or when
    // the app wakes up from sleep, the next cron slot can be minutes away) and trains are fresh.
    let latest = db::latest_received(&state.db).await?;
    if latest.is_none_or(|t| t < now - 60_000) {
        enqueue_once(state, &FollowPositions, format!("follow:{}", now / 60_000)).await?;
    }
    ensure_trains(state, false).await?;

    let received_after = input.since.map_or(0, |s| s - OVERLAP_MS);
    let (fixes, cursor) = db::fixes(&state.db, now - WINDOW_MS, received_after).await?;
    Ok(Positions {
        fixes,
        cursor: cursor.max(input.since.unwrap_or(0)),
    })
}

/// Advertised trains running now (origin, destination, operator).
pub async fn list(ctx: Ctx<AppState>, _input: ()) -> RpcResult<Vec<TrainInfo>> {
    ensure_trains(&ctx.state, true).await?;
    Ok(db::trains(&ctx.state.db).await?)
}

/// Passenger stations, for the map.
pub async fn stations(ctx: Ctx<AppState>, _input: ()) -> RpcResult<Vec<MapStation>> {
    ensure_stations(&ctx.state).await?;
    Ok(db::map_stations(&ctx.state.db).await?)
}

/// Departures and arrivals at a station, live from Trafikverket.
pub async fn board(ctx: Ctx<AppState>, input: BoardInput) -> RpcResult<Board> {
    let sig = input.sig.trim();
    northstack::ensure!(
        !sig.is_empty() && sig.len() <= 10 && sig.chars().all(|c| c.is_alphanumeric() || c == ' '),
        "invalid station"
    );
    ensure_stations(&ctx.state).await?;
    let station = db::map_station(&ctx.state.db, sig)
        .await?
        .ok_or_else(|| RpcError::not_found("unknown station"))?;
    let names = db::station_names(&ctx.state.db).await?;
    let (departures, arrivals) = ctx
        .state
        .trafikverket
        .board(sig, &names)
        .await
        .map_err(upstream)?;
    Ok(Board {
        station,
        departures,
        arrivals,
    })
}

/// Stations: loaded on first use, then refreshed daily in the background.
async fn ensure_stations(state: &AppState) -> RpcResult<()> {
    match db::refreshed_at(&state.db, "stations").await? {
        None => jobs::refresh_stations(state).await.map_err(upstream)?,
        Some(at) if older_than(at, 24 * 3600) => {
            enqueue_once(
                state,
                &RefreshStations,
                format!("stations:{}", Utc::now().date_naive()),
            )
            .await?
        }
        Some(_) => {}
    }
    Ok(())
}

/// Running trains: loaded on first use (`wait`) or in the background, refreshed every 5 minutes.
async fn ensure_trains(state: &AppState, wait: bool) -> RpcResult<()> {
    let at = db::refreshed_at(&state.db, "trains").await?;
    if at.is_none() && wait {
        jobs::refresh_trains(state).await.map_err(upstream)?;
    } else if at.is_none_or(|at| older_than(at, 5 * 60)) {
        let slot = Utc::now().timestamp() / 300;
        enqueue_once(state, &RefreshTrains, format!("trains:{slot}")).await?;
    }
    Ok(())
}

fn older_than(at: DateTime<Utc>, secs: i64) -> bool {
    Utc::now() - at > chrono::Duration::seconds(secs)
}

/// Enqueue a job unless one with this key was already enqueued.
async fn enqueue_once<J: Job>(state: &AppState, job: &J, key: String) -> RpcResult<()> {
    let opts = EnqueueOptions {
        run_key: Some(key),
        ..Default::default()
    };
    northstack::enqueue_with(&state.db, job, opts).await?;
    Ok(())
}

/// Trafikverket is down or slow: say so (the browser retries), and log the cause.
fn upstream(e: anyhow::Error) -> RpcError {
    tracing::warn!(error = %format!("{e:#}"), "Trafikverket request failed");
    RpcError::new(
        ErrorCode::Internal,
        "Trafikverket svarar inte just nu. Försök igen om en stund.",
    )
}
