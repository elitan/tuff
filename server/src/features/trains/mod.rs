//! trains: every train in Sweden, live. Follows Trafikverket's position stream in a
//! background job and keeps positions, running trains and stations in SQLite.

mod db;
mod jobs;
mod procedures;
mod railway;
mod speeds;
mod trafikverket;
pub mod types;

pub use trafikverket::Trafikverket;

use crate::AppState;
use northstack::{Cron, Jobs, Rpc};

pub fn rpc() -> Rpc<AppState> {
    Rpc::new()
        .query("trains.positions", procedures::positions)
        .query("trains.list", procedures::list)
        .query("trains.stations", procedures::stations)
        .query("trains.board", procedures::board)
        .query("trains.predictionStats", procedures::prediction_stats)
}

pub fn jobs() -> Jobs<AppState> {
    Jobs::new()
        .register(jobs::follow_positions)
        .register(jobs::refresh_trains_job)
        .register(jobs::refresh_stations_job)
}

pub fn cron() -> Cron {
    Cron::new()
        .add("trains.follow_positions", "0 */5 * * * *", |_| {
            jobs::FollowPositions
        })
        .add("trains.refresh_trains", "20 */5 * * * *", |_| {
            jobs::RefreshTrains
        })
        .add("trains.refresh_stations", "0 30 3 * * *", |_| {
            jobs::RefreshStations
        })
}
