//! Integration tests for trains, through the real HTTP router. They avoid the network:
//! bad input is refused before any request to Trafikverket, and positions are read from
//! the database.

use std::time::Duration;

use northstack::testing::{Client, TestDb};
use server::features::trains::types::*;
use server::{AppState, MIGRATOR};

async fn setup() -> (TestDb, Client) {
    let db = northstack::testing::db(&MIGRATOR).await;
    let router =
        server::build().router(AppState::new(db.pool()), db.pool(), Duration::from_secs(30));
    (db, Client::new(router))
}

#[tokio::test]
async fn board_refuses_odd_station_codes() {
    let (_db, client) = setup().await;
    let err = client
        .call::<_, Board>(
            "trains.board",
            &BoardInput {
                sig: "Cst\"/><X".into(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, northstack::ErrorCode::BadRequest);
}

#[tokio::test]
async fn positions_start_empty_and_return_a_cursor() {
    let (_db, client) = setup().await;
    let out: Positions = client
        .call("trains.positions", &PositionsInput { since: None })
        .await
        .unwrap();
    assert!(out.fixes.is_empty());
    let next: Positions = client
        .call(
            "trains.positions",
            &PositionsInput {
                since: Some(out.cursor),
            },
        )
        .await
        .unwrap();
    assert!(next.fixes.is_empty());
    assert_eq!(next.cursor, out.cursor);
}
