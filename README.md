# Tuff

Every train in Sweden, live on the map, with live station boards: https://tuff-tuff.apps.j4labs.se

Trains move along the real rails as Trafikverket reports their positions. Click a train to follow
it, search for a train, station or operator, filter by operator, or open a station for its
departures and arrivals.

Built on [northstack](https://github.com/elitan/northstack) (Rust + SQLite + React in one binary).

## Run it

You need Rust, Bun and `just`, and a free Trafikverket API key from
https://data.trafikverket.se (or via Trafiklab).

```bash
cp .env.example .env    # then set TRAFIKVERKET_API_KEY
just dev
```

Then open http://localhost:5300.

## How it works

```
Trafikverket position stream ──▶ trains.follow_positions job ──▶ positions (SQLite) ──▶ trains.positions ◀── browser, every 2 s
                                  snaps each fix to the rails
                                  (server/data/railway.json)
```

- **Live positions.** A background job follows Trafikverket's live position stream, snaps every
  GPS fix onto the nearest track, routes it along the rails from the train's previous fix, and
  stores the latest fix per train. Cron starts a new follower every 5 minutes (they overlap by
  30 s), and a visit starts one right away if none is running, so it also works after a deploy
  or when the app wakes from sleep. Browsers poll `trains.positions` with a cursor and get only
  what's new; the map plays the routes back smoothly a few seconds behind real time.
- **Trains and stations** are cached in SQLite: running trains (origin, destination, operator)
  are refreshed every 5 minutes, stations daily.
- **Station boards** come live from Trafikverket when a board is open.

```
server/src/features/trains/   procedures, jobs, SQL, the Trafikverket client, rail snapping
server/data/railway.json      Sweden's railway graph from OpenStreetMap (scripts/build-railway.mjs)
web/app/components/           the map, station board and operator badges
web/app/lib/                  smooth motion along the rails, operator colours
```

The framework guide is in [docs/northstack.md](docs/northstack.md); [AGENTS.md](AGENTS.md) has the
rules for coding agents.

## Running in production

`docker build -t tuff .` gives one small image. It needs `TRAFIKVERKET_API_KEY`, and a persistent
volume at `/data` for the SQLite file (local disk, not a network file system).

It runs on frost (project and service `tuff`, volume `tuff-data` at `/data`, the key as a service
variable); every push to `main` deploys.

## Data

Positions, timetables and stations © Trafikverket (open data). Railway geometry and map tiles ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
