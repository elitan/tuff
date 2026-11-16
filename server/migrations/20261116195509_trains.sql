CREATE TABLE stations ( -- Trafikverket's stations (TrainStation), refreshed daily.
    -- Location signature, e.g. "Cst".
    sig        TEXT PRIMARY KEY NOT NULL,
    -- Full name, e.g. "Stockholm Central".
    name       TEXT NOT NULL,
    -- Short name used in timetables, e.g. "Stockholm C".
    short_name TEXT NOT NULL,
    -- Open to passengers: shown on the map, with a departure board.
    advertised BOOLEAN NOT NULL,
    lat        REAL,
    lon        REAL
);

CREATE TABLE trains ( -- Advertised passenger trains running now (TrainAnnouncement), refreshed every 5 minutes.
    -- Advertised train number.
    number    TEXT PRIMARY KEY NOT NULL,
    from_name TEXT NOT NULL,
    to_name   TEXT NOT NULL,
    -- Product, e.g. "SJ Snabbtåg", "SL Pendeltåg", "Mälartåg".
    product   TEXT NOT NULL,
    -- Information owner, e.g. "SJ", "Mälardalstrafik AB".
    owner     TEXT NOT NULL
);

CREATE TABLE positions ( -- Latest fix of every train from Trafikverket's live stream, snapped to the rails. @name(TrainPosition)
    -- Advertised train number (freight too; the API joins with trains).
    train       TEXT PRIMARY KEY NOT NULL,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    bearing     REAL,
    -- km/h
    speed       REAL,
    -- When the fix was taken, ms since epoch.
    ts          INTEGER NOT NULL,
    -- Route along the rails from the previous fix: [[lat, lon], ...].
    path        JSON,
    -- Where the fix snapped onto the track graph; the next fix routes from here. @private
    snap        JSON,
    -- When we received it, ms since epoch: the polling cursor.
    received_at INTEGER NOT NULL
);
CREATE INDEX positions_received_at ON positions (received_at);
CREATE INDEX positions_ts ON positions (ts);

CREATE TABLE refreshes ( -- When each dataset was last loaded from Trafikverket ("stations", "trains").
    name TEXT PRIMARY KEY NOT NULL,
    at   TIMESTAMP NOT NULL
);
