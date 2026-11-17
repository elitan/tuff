//! All SQL for trains: stations, running trains and live positions.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::{SqliteExecutor, SqlitePool};

use super::railway::Snap;
use super::speeds::{Grade, Key, Stat};
use super::trafikverket::RawStation;
use super::types::{Fix, MapStation, PredictionRow, TrainInfo};

// ---------- refreshes ----------

pub async fn refreshed_at(db: &SqlitePool, name: &str) -> sqlx::Result<Option<DateTime<Utc>>> {
    sqlx::query_scalar!("SELECT at FROM refreshes WHERE name = $1", name)
        .fetch_optional(db)
        .await
}

pub async fn mark_refreshed<'e>(db: impl SqliteExecutor<'e>, name: &str) -> sqlx::Result<()> {
    let now = Utc::now();
    sqlx::query!(
        "INSERT INTO refreshes (name, at) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET at = excluded.at",
        name,
        now
    )
    .execute(db)
    .await?;
    Ok(())
}

// ---------- stations ----------

/// Location signature -> short name, for timetables.
pub async fn station_names(db: &SqlitePool) -> sqlx::Result<HashMap<String, String>> {
    let rows = sqlx::query!("SELECT sig, short_name FROM stations")
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|r| (r.sig, r.short_name)).collect())
}

/// Every station with coordinates (timing points too): sig -> (name, lat, lon).
pub async fn station_points(db: &SqlitePool) -> sqlx::Result<HashMap<String, (String, f64, f64)>> {
    let rows = sqlx::query!(
        r#"SELECT sig, name, lat AS "lat!: f64", lon AS "lon!: f64" FROM stations
           WHERE lat IS NOT NULL AND lon IS NOT NULL"#
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.sig, (r.name, r.lat, r.lon)))
        .collect())
}

/// Passenger stations with coordinates.
pub async fn map_stations(db: &SqlitePool) -> sqlx::Result<Vec<MapStation>> {
    let rows = sqlx::query!(
        r#"SELECT sig, name, lat AS "lat!: f64", lon AS "lon!: f64" FROM stations
           WHERE advertised AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY sig"#
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| MapStation {
            sig: r.sig,
            name: r.name,
            lat: r.lat,
            lon: r.lon,
        })
        .collect())
}

pub async fn map_station(db: &SqlitePool, sig: &str) -> sqlx::Result<Option<MapStation>> {
    let row = sqlx::query!(
        r#"SELECT sig, name, lat AS "lat!: f64", lon AS "lon!: f64" FROM stations
           WHERE sig = $1 AND advertised AND lat IS NOT NULL AND lon IS NOT NULL"#,
        sig
    )
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| MapStation {
        sig: r.sig,
        name: r.name,
        lat: r.lat,
        lon: r.lon,
    }))
}

pub async fn replace_stations(db: &SqlitePool, list: &[RawStation]) -> sqlx::Result<()> {
    let mut tx = northstack::db::begin(db).await?;
    sqlx::query!("DELETE FROM stations")
        .execute(&mut *tx)
        .await?;
    for s in list {
        sqlx::query!(
            "INSERT INTO stations (sig, name, short_name, advertised, lat, lon) VALUES ($1, $2, $3, $4, $5, $6)",
            s.sig,
            s.name,
            s.short_name,
            s.advertised,
            s.lat,
            s.lon
        )
        .execute(&mut *tx)
        .await?;
    }
    mark_refreshed(&mut *tx, "stations").await?;
    tx.commit().await
}

// ---------- trains ----------

pub async fn trains(db: &SqlitePool) -> sqlx::Result<Vec<TrainInfo>> {
    let rows = sqlx::query!(
        "SELECT number, from_name, to_name, product, owner FROM trains ORDER BY number"
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| TrainInfo {
            number: r.number,
            from: r.from_name,
            to: r.to_name,
            product: r.product,
            owner: r.owner,
        })
        .collect())
}

pub async fn replace_trains(db: &SqlitePool, list: &[TrainInfo]) -> sqlx::Result<()> {
    let mut tx = northstack::db::begin(db).await?;
    sqlx::query!("DELETE FROM trains").execute(&mut *tx).await?;
    for t in list {
        sqlx::query!(
            "INSERT INTO trains (number, from_name, to_name, product, owner) VALUES ($1, $2, $3, $4, $5)",
            t.number,
            t.from,
            t.to,
            t.product,
            t.owner
        )
        .execute(&mut *tx)
        .await?;
    }
    mark_refreshed(&mut *tx, "trains").await?;
    tx.commit().await
}

// ---------- positions ----------

/// A fix ready to store: where to draw it, and where it snapped (for routing the next one).
pub struct StoredFix {
    pub fix: Fix,
    pub snap: Option<Snap>,
}

/// The last fix time and snap of every train, to route the next fix from.
pub async fn last_snaps(db: &SqlitePool) -> sqlx::Result<HashMap<String, (i64, Option<Snap>)>> {
    let rows = sqlx::query!("SELECT train, ts, snap FROM positions")
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.train,
                (r.ts, r.snap.and_then(|s| serde_json::from_value(s).ok())),
            )
        })
        .collect())
}

/// Store a batch of fixes. A fix older than the one stored is ignored (two followers may
/// overlap). Returns, per fix, whether it was new.
pub async fn store_fixes(
    db: &SqlitePool,
    fixes: &[StoredFix],
    received_at: i64,
) -> sqlx::Result<Vec<bool>> {
    if fixes.is_empty() {
        return Ok(vec![]);
    }
    let mut new = Vec::with_capacity(fixes.len());
    let mut tx = northstack::db::begin(db).await?;
    for f in fixes {
        let path = f.fix.path.as_ref().map(|p| serde_json::json!(p));
        let ahead = f.fix.ahead.as_ref().map(|p| serde_json::json!(p));
        let snap = f.snap.as_ref().map(|s| serde_json::json!(s));
        let done = sqlx::query!(
            "INSERT INTO positions (train, lat, lon, bearing, speed, ts, path, snap, received_at, ahead)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (train) DO UPDATE SET lat = excluded.lat, lon = excluded.lon,
               bearing = excluded.bearing, speed = excluded.speed, ts = excluded.ts, path = excluded.path,
               snap = excluded.snap, received_at = excluded.received_at, ahead = excluded.ahead
             WHERE excluded.ts > positions.ts",
            f.fix.n,
            f.fix.lat,
            f.fix.lon,
            f.fix.bearing,
            f.fix.speed,
            f.fix.ts,
            path,
            snap,
            received_at,
            ahead
        )
        .execute(&mut *tx)
        .await?;
        new.push(done.rows_affected() > 0);
    }
    tx.commit().await?;
    Ok(new)
}

/// Fixes of advertised passenger trains, taken after `ts_after` and received after `received_after`.
pub async fn fixes(
    db: &SqlitePool,
    ts_after: i64,
    received_after: i64,
) -> sqlx::Result<(Vec<Fix>, i64)> {
    let rows = sqlx::query!(
        r#"SELECT p.train, p.lat, p.lon, p.bearing, p.speed, p.ts, p.path, p.ahead, p.received_at
           FROM positions p JOIN trains t ON t.number = p.train
           WHERE p.ts > $1 AND p.received_at > $2
           ORDER BY p.ts"#,
        ts_after,
        received_after
    )
    .fetch_all(db)
    .await?;
    let cursor = rows
        .iter()
        .map(|r| r.received_at)
        .max()
        .unwrap_or(received_after);
    let fixes = rows
        .into_iter()
        .map(|r| Fix {
            n: r.train,
            lat: r.lat,
            lon: r.lon,
            bearing: r.bearing,
            speed: r.speed,
            ts: r.ts,
            path: r.path.and_then(|p| serde_json::from_value(p).ok()),
            ahead: r.ahead.and_then(|p| serde_json::from_value(p).ok()),
        })
        .collect();
    Ok((fixes, cursor))
}

/// When the newest fix arrived (ms since epoch): tells whether the live feed is being followed.
pub async fn latest_received(db: &SqlitePool) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar!(r#"SELECT max(received_at) AS "latest: i64" FROM positions"#)
        .fetch_one(db)
        .await
}

/// Forget trains that have been silent since `ts_before`.
pub async fn delete_fixes_before(db: &SqlitePool, ts_before: i64) -> sqlx::Result<u64> {
    Ok(
        sqlx::query!("DELETE FROM positions WHERE ts < $1", ts_before)
            .execute(db)
            .await?
            .rows_affected(),
    )
}

// ---------- learned speeds ----------

/// Train number -> product, for the advertised trains running now.
pub async fn products(db: &SqlitePool) -> sqlx::Result<HashMap<String, String>> {
    let rows = sqlx::query!("SELECT number, product FROM trains")
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|r| (r.number, r.product)).collect())
}

pub async fn speeds(db: &SqlitePool) -> sqlx::Result<HashMap<Key, Stat>> {
    let rows = sqlx::query!(
        "SELECT cx, cy, sector, product, n, sum_v, sum_v2, n_stopped FROM track_speeds"
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let stat = Stat {
                n: r.n,
                sum_v: r.sum_v,
                sum_v2: r.sum_v2,
                n_stopped: r.n_stopped,
            };
            ((r.cx, r.cy, r.sector as u8, r.product), stat)
        })
        .collect())
}

/// Add speed samples to their cells.
pub async fn add_speeds(db: &SqlitePool, samples: &[(Key, Stat)]) -> sqlx::Result<()> {
    if samples.is_empty() {
        return Ok(());
    }
    let mut tx = northstack::db::begin(db).await?;
    for ((cx, cy, sector, product), s) in samples {
        let sector = *sector as i64;
        sqlx::query!(
            "INSERT INTO track_speeds (cx, cy, sector, product, n, sum_v, sum_v2, n_stopped)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (cx, cy, sector, product) DO UPDATE SET n = n + excluded.n,
               sum_v = sum_v + excluded.sum_v, sum_v2 = sum_v2 + excluded.sum_v2,
               n_stopped = n_stopped + excluded.n_stopped",
            cx,
            cy,
            sector,
            product,
            s.n,
            s.sum_v,
            s.sum_v2,
            s.n_stopped
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Guesses, sum of errors, and guesses within 100, 250 and 500 m.
type Totals = (i64, f64, i64, i64, i64);

/// Add graded guesses to the day's totals.
pub async fn add_grades(db: &SqlitePool, day: &str, grades: &[Grade]) -> sqlx::Result<()> {
    let mut totals: HashMap<(&str, i64), Totals> = HashMap::new();
    for g in grades {
        let t = totals.entry((g.method, g.horizon_s)).or_default();
        t.0 += 1;
        t.1 += g.error_m;
        t.2 += (g.error_m <= 100.0) as i64;
        t.3 += (g.error_m <= 250.0) as i64;
        t.4 += (g.error_m <= 500.0) as i64;
    }
    if totals.is_empty() {
        return Ok(());
    }
    let mut tx = northstack::db::begin(db).await?;
    for ((method, horizon_s), (n, sum, w100, w250, w500)) in totals {
        sqlx::query!(
            "INSERT INTO prediction_errors (day, method, horizon_s, n, sum_abs, within_100, within_250, within_500)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (day, method, horizon_s) DO UPDATE SET n = n + excluded.n,
               sum_abs = sum_abs + excluded.sum_abs, within_100 = within_100 + excluded.within_100,
               within_250 = within_250 + excluded.within_250, within_500 = within_500 + excluded.within_500",
            day,
            method,
            horizon_s,
            n,
            sum,
            w100,
            w250,
            w500
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Daily totals of graded guesses since `day` (inclusive), newest first.
pub async fn prediction_rows(db: &SqlitePool, since_day: &str) -> sqlx::Result<Vec<PredictionRow>> {
    let rows = sqlx::query!(
        "SELECT day, method, horizon_s, n, sum_abs, within_100, within_250, within_500
         FROM prediction_errors WHERE day >= $1 ORDER BY day DESC, horizon_s, method",
        since_day
    )
    .fetch_all(db)
    .await?;
    let pct = |k: i64, n: i64| (1000 * k / n.max(1)) as f64 / 10.0;
    Ok(rows
        .into_iter()
        .map(|r| PredictionRow {
            day: r.day,
            method: r.method,
            horizon_s: r.horizon_s,
            n: r.n,
            mean_error_m: (r.sum_abs / r.n.max(1) as f64).round(),
            within_100_pct: pct(r.within_100, r.n),
            within_250_pct: pct(r.within_250, r.n),
            within_500_pct: pct(r.within_500, r.n),
        })
        .collect())
}

/// Cells of track with a learned speed, and samples in total.
pub async fn speed_coverage(db: &SqlitePool, min_samples: i64) -> sqlx::Result<(i64, i64)> {
    let r = sqlx::query!(
        r#"SELECT count(*) FILTER (WHERE n >= $1) AS "cells!: i64", coalesce(sum(n), 0) AS "samples!: i64"
           FROM track_speeds"#,
        min_samples
    )
    .fetch_one(db)
    .await?;
    Ok((r.cells, r.samples))
}
