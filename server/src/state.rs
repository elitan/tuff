use std::time::Duration;

use sqlx::SqlitePool;

use crate::features::trains::Trafikverket;

/// Shared application state, available to every procedure (`ctx.state`) and
/// job handler. Keep it cheap to clone.
#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    /// Trafikverket's open API (key from TRAFIKVERKET_API_KEY).
    pub trafikverket: Trafikverket,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        // reqwest uses rustls with the `ring` provider
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .user_agent("tuff (https://github.com/elitan/tuff)")
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("HTTP client");
        let key = std::env::var("TRAFIKVERKET_API_KEY")
            .ok()
            .filter(|k| !k.is_empty());
        Self {
            db,
            trafikverket: Trafikverket::new(http, key),
        }
    }
}
