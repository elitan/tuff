CREATE TABLE track_speeds ( -- Learned train speeds per ~200 m of track, direction and product, from every live fix.
    -- 200 m grid cell (x: east, y: north), see speeds.rs.
    cx        INTEGER NOT NULL,
    cy        INTEGER NOT NULL,
    -- Direction of travel in 45° sectors: 0 = north, 2 = east, 4 = south, 6 = west.
    sector    INTEGER NOT NULL,
    -- Train product (e.g. "SL Pendeltåg"), or "" when unknown (freight).
    product   TEXT NOT NULL,
    -- Number of samples, sum of speeds and of squared speeds (m/s), samples standing still.
    n         INTEGER NOT NULL,
    sum_v     REAL NOT NULL,
    sum_v2    REAL NOT NULL,
    n_stopped INTEGER NOT NULL,
    PRIMARY KEY (cx, cy, sector, product)
);

CREATE TABLE prediction_errors ( -- How far off each way of guessing a train's position was, per day: graded on live fixes.
    -- UTC day, e.g. "2026-11-17".
    day        TEXT NOT NULL,
    -- "hold", "last_speed", "reported", "learned", "learned_scaled".
    method     TEXT NOT NULL,
    -- Seconds since the fix the guess starts from (30 or 60).
    horizon_s  INTEGER NOT NULL,
    n          INTEGER NOT NULL,
    -- Sum of absolute errors along the track, metres.
    sum_abs    REAL NOT NULL,
    -- Guesses within 100, 250 and 500 m.
    within_100 INTEGER NOT NULL,
    within_250 INTEGER NOT NULL,
    within_500 INTEGER NOT NULL,
    PRIMARY KEY (day, method, horizon_s)
);
