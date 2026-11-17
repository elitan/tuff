//! Types shared with the frontend.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// An advertised train running now.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TrainInfo {
    /// Advertised train number.
    pub number: String,
    pub from: String,
    pub to: String,
    /// e.g. "SJ Snabbtåg", "SL Pendeltåg", "Mälartåg"
    pub product: String,
    /// InformationOwner, e.g. "SJ", "Mälardalstrafik AB"
    pub owner: String,
}

/// A passenger station on the map.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MapStation {
    /// Location signature, e.g. "Cst".
    pub sig: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PositionsInput {
    /// The `cursor` from the previous answer; leave out for every train seen in the last 10 minutes.
    #[serde(default)]
    #[ts(optional)]
    pub since: Option<i64>,
}

/// A train's latest fix, snapped to the rails.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    /// Advertised train number.
    pub n: String,
    pub lat: f64,
    pub lon: f64,
    pub bearing: Option<f64>,
    /// km/h
    pub speed: Option<f64>,
    /// When the fix was taken, ms since epoch.
    pub ts: i64,
    /// Route along the rails from the previous fix, [lat, lon] points.
    pub path: Option<Vec<[f64; 2]>>,
    /// The track ahead (~2 km, straight on at junctions), from this fix: [lat, lon] points.
    /// None when the train isn't moving.
    pub ahead: Option<Vec<[f64; 2]>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Positions {
    pub fixes: Vec<Fix>,
    /// Pass as `since` next time to get only newer fixes.
    pub cursor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardInput {
    /// Station location signature, e.g. "Cst".
    pub sig: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardRow {
    pub id: String,
    /// Advertised train number.
    pub train: String,
    pub product: String,
    /// Timetable time, ISO.
    pub time: String,
    /// New expected time when late.
    pub estimated: Option<String>,
    /// When it actually departed or arrived.
    pub actual: Option<String>,
    pub track: Option<String>,
    pub canceled: bool,
    /// Destination (departures) or origin (arrivals).
    pub place: String,
    pub via: Vec<String>,
    /// Deviations, e.g. "Spårändrat", "Inställt", "Ersättningsbuss".
    pub notes: Vec<String>,
    /// A replacement bus rather than a train.
    pub bus: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub station: MapStation,
    pub departures: Vec<BoardRow>,
    pub arrivals: Vec<BoardRow>,
}

/// One day's totals for one way of guessing where a silent train is.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PredictionRow {
    /// UTC day, e.g. "2026-11-17".
    pub day: String,
    /// "hold", "last_speed", "reported", "learned" or "learned_scaled".
    pub method: String,
    /// Seconds since the fix the guess starts from.
    pub horizon_s: i64,
    /// Guesses graded.
    pub n: i64,
    /// Mean distance along the track from where the train really was.
    pub mean_error_m: f64,
    pub within_100_pct: f64,
    pub within_250_pct: f64,
    pub within_500_pct: f64,
}

/// How well guesses about silent trains are doing, and how much has been learned.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PredictionStats {
    /// ~200 m cells of track (per direction and product) with a learned speed.
    pub learned_cells: i64,
    /// Speed samples taken in total.
    pub samples: i64,
    /// Last 14 days, newest first.
    pub rows: Vec<PredictionRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RouteInput {
    /// Advertised train number.
    pub number: String,
}

/// A timetable time at a stop.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StopTime {
    /// Timetable time, ISO.
    pub time: String,
    /// New expected time when late.
    pub estimated: Option<String>,
    /// When it actually happened.
    pub actual: Option<String>,
}

/// A place in a train's timetable.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RouteStop {
    /// Location signature, e.g. "Cst".
    pub sig: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    /// A stop for passengers (false: a timing point the train passes).
    pub advertised: bool,
    pub arrival: Option<StopTime>,
    pub departure: Option<StopTime>,
    pub track: Option<String>,
    pub canceled: bool,
    /// The train has left (or, at its last stop, arrived).
    pub passed: bool,
}

/// A train's whole run today: its timetable places and the railway between them.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TrainRoute {
    pub number: String,
    pub stops: Vec<RouteStop>,
    /// `legs[i]` is the railway from `stops[i]` to `stops[i + 1]`: [lat, lon] points.
    pub legs: Vec<Vec<[f64; 2]>>,
}
