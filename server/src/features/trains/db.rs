//! All SQL for trains: stations, running trains and live positions.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::{SqliteExecutor, SqlitePool};

use super::railway::Snap;
use super::trafikverket::RawStation;
use super::types::{Fix, MapStation, TrainInfo};

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

/// Store a batch of fixes. A fix older than the one stored is ignored (two followers may overlap).
pub async fn store_fixes(
    db: &SqlitePool,
    fixes: &[StoredFix],
    received_at: i64,
) -> sqlx::Result<()> {
    if fixes.is_empty() {
        return Ok(());
    }
    let mut tx = northstack::db::begin(db).await?;
    for f in fixes {
        let path = f.fix.path.as_ref().map(|p| serde_json::json!(p));
        let snap = f.snap.as_ref().map(|s| serde_json::json!(s));
        sqlx::query!(
            "INSERT INTO positions (train, lat, lon, bearing, speed, ts, path, snap, received_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (train) DO UPDATE SET lat = excluded.lat, lon = excluded.lon,
               bearing = excluded.bearing, speed = excluded.speed, ts = excluded.ts, path = excluded.path,
               snap = excluded.snap, received_at = excluded.received_at
             WHERE excluded.ts > positions.ts",
            f.fix.n,
            f.fix.lat,
            f.fix.lon,
            f.fix.bearing,
            f.fix.speed,
            f.fix.ts,
            path,
            snap,
            received_at
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Fixes of advertised passenger trains, taken after `ts_after` and received after `received_after`.
pub async fn fixes(
    db: &SqlitePool,
    ts_after: i64,
    received_after: i64,
) -> sqlx::Result<(Vec<Fix>, i64)> {
    let rows = sqlx::query!(
        r#"SELECT p.train, p.lat, p.lon, p.bearing, p.speed, p.ts, p.path, p.received_at
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
