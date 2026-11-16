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
