import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { api, type Fix, type MapStation, type TrainInfo } from "northstack";
import { Track } from "../lib/motion";
import StationBoard from "./StationBoard";
import BrandBadge from "./BrandBadge";
import { brandOf, type Brand } from "../lib/brands";

type Position = Fix;
type Station = MapStation;

const MAX_AGE_MS = 10 * 60_000;   // drop trains silent for this long
const STALE_MS = 2 * 60_000;      // fade trains silent for this long
const TURN_MS = 350;              // how quickly a train turns to a new heading
const FOLLOW_ZOOM = 14;
const STATION_ZOOM = 12;          // zoom used when opening a station
const LABEL_ZOOM = 11;            // show train numbers from this zoom
const SHOW_STATIONS_ZOOM = 8;     // station dots from this zoom
const STATION_LABEL_ZOOM = 12;    // station names from this zoom
const FAR_ZOOM = 9;               // below this: smaller trains, fewer position updates
const LIST_LIMIT = 200;           // rows rendered in the train list (search narrows it)
const POLL_MS = 2_000;            // how often to ask the server for new positions

// Standard OSM tiles, toned down to a quiet monochrome basemap in CSS (.leaflet-tile-pane)
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Trafikverket';

type TrainState = {
  marker: L.Marker;
  track: Track;         // buffered GPS fixes along the rails, played back smoothly
  angle: number;        // drawn heading (degrees, cumulative so turns take the short way)
  target: number | null;// heading we're turning towards (null = unknown → show a dot)
  p: Position;
};

type Row = { n: string; from: string; to: string; product: string; brand: Brand; speed: number | null; age: number };

// Top-down train: a lead car with a rounded nose and windscreen, coupled to a second car.
// Drawn pointing up (north) and rotated to the direction of travel. Plain dot until we know the heading.
const ICON = L.divIcon({
  className: "", iconSize: [44, 44], iconAnchor: [22, 22],
  html: `<div class="tm"><span class="halo"></span><svg viewBox="0 0 44 44">
    <g class="dir">
      <path class="body" d="M16.5 21 V9.5 C16.5 5 19 2.5 22 2.5 C25 2.5 27.5 5 27.5 9.5 V21 Q27.5 22.5 26 22.5 H18 Q16.5 22.5 16.5 21 Z"/>
      <path class="glass" d="M18.6 8.6 C19.2 6 20.4 4.9 22 4.9 C23.6 4.9 24.8 6 25.4 8.6 Z"/>
      <rect class="body" x="16.5" y="24" width="11" height="17.5" rx="1.6"/>
      <path class="roof" d="M22 11.5 V20.5 M22 26 V39.5"/>
    </g>
    <circle class="body nodir" cx="22" cy="22" r="6.5"/></svg></div>`,
});

const ageText = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`);
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export default function TrainMap() {
  const mapEl = useRef<HTMLDivElement>(null);
  const followedRef = useRef<string | null>(null);
  const brandRef = useRef<string | null>(null);   // brand key filter
  const ctl = useRef({   // map actions, for the React UI below
    follow: (_n: string) => {}, unfollow: () => {}, zoom: (_d: number) => {}, fitAll: () => {},
    openStation: (_sig: string) => {}, closeStation: () => {}, applyFilter: () => {},
  });
  const [live, setLive] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [followed, setFollowed] = useState<string | null>(null);
  const [board, setBoard] = useState<string | null>(null);
  const [brandKey, setBrandKey] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    const map = L.map(mapEl.current!, { zoomControl: false, attributionControl: false })
      .setView([62.5, 16], 5);
    L.control.attribution({ prefix: false, position: "bottomleft" }).addAttribution(ATTRIBUTION).addTo(map);
    L.tileLayer(TILES, { maxZoom: 19 }).addTo(map);

    const trains = new Map<string, TrainState>();
    let info: Record<string, TrainInfo> = {};
    let fitted = false, lastEvent = 0, flying = false, raf = 0;

    const loadInfo = () =>
      api.trains.list.call(null)
        .then(list => { info = Object.fromEntries(list.map(t => [t.number, t])); })
        .catch(console.error);

    // Ease the drawn heading towards the target heading (per frame, no CSS transition,
    // so rotation and movement stay in lockstep).
    const turn = (t: TrainState, dt: number) => {
      const svg = t.marker.getElement()?.querySelector("svg");
      if (!svg) return;
      const known = t.target != null;
      if ((svg.dataset.known === "1") !== known) {
        svg.dataset.known = known ? "1" : "0";
        (svg.querySelector(".dir") as SVGElement).style.display = known ? "" : "none";
        (svg.querySelector(".nodir") as SVGElement).style.display = known ? "none" : "";
      }
      if (t.target == null) return;
      const delta = ((t.target - t.angle) % 360 + 540) % 360 - 180;
      if (Math.abs(delta) < 0.05 && svg.style.transform) return;
      t.angle += delta * Math.min(1, dt / TURN_MS);
      svg.style.transform = `rotate(${t.angle.toFixed(2)}deg)`;
    };

    // Leaflet rounds marker and pan positions to whole pixels, which makes slow
    // movement step visibly. Position things ourselves with sub-pixel precision.
    const exactLayerPoint = (ll: L.LatLngExpression) => map.project(ll).subtract(map.getPixelOrigin());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = map as any; // _rawPanBy / _animatingZoom / _getMapPanePos are Leaflet internals
    let lastMoveEnd = 0;
    const cls = (t: TrainState | undefined, c: string, on: boolean) =>
      t?.marker.getElement()?.querySelector(".tm")?.classList.toggle(c, on);

    // ----- operator filter -----
    const brandFor = (n: string) => brandOf(info[n]?.product, info[n]?.owner);
    // colour each train by company, and hide the ones the filter excludes
    const styleTrain = (n: string, t: TrainState) => {
      const el = t.marker.getElement();
      if (!el) return;
      const b = brandFor(n);
      const tm = el.querySelector(".tm") as HTMLElement | null;
      if (tm && tm.dataset.brand !== b.key) { tm.dataset.brand = b.key; tm.style.setProperty("--brand", b.color); }
      const want = brandRef.current;
      el.style.display = !want || b.key === want || n === followedRef.current ? "" : "none";
    };
    const applyFilter = () => { for (const [n, t] of trains) styleTrain(n, t); };

    // ----- stations -----
    const renderer = L.canvas({ padding: 0.5 });
    const stationLayer = L.layerGroup();
    const labelLayer = L.layerGroup().addTo(map);
    const selectedRing = L.circleMarker([0, 0], {
      renderer, radius: 10, weight: 2.5, fill: false, interactive: false,
    });
    let stationList: Station[] = [];
    const dotStyle = () => ({
      color: css("--ink"), fillColor: css("--bg"), fillOpacity: 1, weight: 1.6,
      radius: map.getZoom() >= STATION_LABEL_ZOOM ? 5 : map.getZoom() >= 10 ? 4 : 3,
    });
    const openStation = (sig: string) => {
      const s = stationList.find(x => x.sig === sig);
      if (!s) return;
      unfollow();
      setBoard(sig);
      selectedRing.setLatLng([s.lat, s.lon]).setStyle({ color: css("--accent") }).addTo(map);
      map.flyTo([s.lat, s.lon], Math.max(map.getZoom(), STATION_ZOOM), { duration: 1 });
    };
    const closeStation = () => { setBoard(null); selectedRing.remove(); };
    api.trains.stations.call(null).then((list: Station[]) => {
      if (stopped) return;
      stationList = list;
      setStations(list);
      for (const s of list) {
        L.circleMarker([s.lat, s.lon], { renderer, ...dotStyle() })
          .bindTooltip(s.name, { direction: "top", offset: [0, -6], className: "stip" })
          .on("click", () => openStation(s.sig))
          .addTo(stationLayer);
      }
      updateZoomUI();
    }).catch(console.error);

    // station name labels, only for stations in view when zoomed in
    const updateStationLabels = () => {
      labelLayer.clearLayers();
      if (map.getZoom() < STATION_LABEL_ZOOM) return;
      const b = map.getBounds();
      for (const s of stationList.filter(s => b.contains([s.lat, s.lon])).slice(0, 150)) {
        L.marker([s.lat, s.lon], {
          interactive: false, keyboard: false,
          icon: L.divIcon({ className: "slabel", html: `<span>${s.name}</span>`, iconSize: [0, 0] }),
        }).addTo(labelLayer);
      }
    };

    const updateZoomUI = () => {
      const z = map.getZoom(), el = mapEl.current;
      el?.classList.toggle("labels", z >= LABEL_ZOOM);
      el?.classList.toggle("far", z < FAR_ZOOM);
      if (z >= SHOW_STATIONS_ZOOM) stationLayer.addTo(map); else stationLayer.remove();
      const style = dotStyle();
      stationLayer.eachLayer(l => (l as L.CircleMarker).setStyle(style).setRadius(style.radius));
      updateStationLabels();
    };
    map.on("zoomend", updateZoomUI);
    map.on("moveend", () => { if (map.getZoom() >= STATION_LABEL_ZOOM) updateStationLabels(); });
    updateZoomUI();

    // ----- follow mode -----
    const follow = (n: string) => {
      const t = trains.get(n);
      if (!t) return;
      cls(trains.get(followedRef.current ?? ""), "followed", false);
      followedRef.current = n;
      setFollowed(n);
      cls(t, "followed", true);
      t.marker.setZIndexOffset(1000);
      applyFilter();
      map.flyTo(t.marker.getLatLng(), Math.max(map.getZoom(), FOLLOW_ZOOM), { duration: 1.2 });
    };
    const unfollow = () => {
      const t = trains.get(followedRef.current ?? "");
      cls(t, "followed", false);
      t?.marker.setZIndexOffset(0);
      followedRef.current = null;
      setFollowed(null);
      applyFilter();
    };
    const fitAll = () => {
      unfollow();
      const shown = [...trains.entries()]
        .filter(([n]) => !brandRef.current || brandFor(n).key === brandRef.current)
        .map(([, t]) => t.marker);
      if (shown.length) map.flyToBounds(L.featureGroup(shown).getBounds().pad(0.12), { duration: 1 });
    };
    ctl.current = {
      follow, unfollow, fitAll, openStation, closeStation, applyFilter,
      zoom: d => (d > 0 ? map.zoomIn() : map.zoomOut()),
    };
    map.on("dragstart", unfollow);           // user takes over the map → stop following
    map.on("zoomstart", () => { flying = true; });
    map.on("zoomend", () => { flying = false; });

    // ----- positions -----
    const upsert = (p: Position, live: boolean) => {
      if (Date.now() - p.ts > MAX_AGE_MS) return;
      const ll: [number, number] = [p.lat, p.lon];
      const t = trains.get(p.n);
      if (!t) {
        const marker = L.marker(ll, { icon: ICON, keyboard: false })
          .bindTooltip(p.n, { permanent: true, direction: "right", offset: [14, 0], className: "tlabel" })
          .addTo(map);
        const state: TrainState = { marker, track: new Track(ll, p.ts), angle: p.bearing ?? 0, target: p.bearing, p };
        trains.set(p.n, state);
        marker.on("click", () => follow(p.n));
        turn(state, TURN_MS);
        styleTrain(p.n, state);
      } else {
        if (p.ts <= t.p.ts) return;          // replayed / out-of-order event
        t.track.add(ll, p.ts, p.path ?? undefined, live);
        if (!p.path && p.bearing != null) t.target = p.bearing;
        t.p = p;
      }
    };

    let lastFrame = performance.now(), lastFar = 0;
    const animate = (frame: number) => {
      const dt = Math.min(250, frame - lastFrame);   // cap: tab was in the background
      lastFrame = frame;
      const zooming = m._animatingZoom;
      // Zoomed out, motion is sub-pixel anyway: update the DOM ~5×/s instead of every frame.
      const far = map.getZoom() < FAR_ZOOM;
      const drawAll = !far || frame - lastFar > 200;
      if (drawAll) lastFar = frame;
      const view = map.getBounds().pad(0.3);
      const followedN = followedRef.current;
      for (const [n, t] of trains) {
        const { at, dir } = t.track.step(dt);
        if (dir != null) t.target = dir;
        const isFollowed = n === followedN;
        // only touch the DOM for trains on screen (and the followed one)
        if (!isFollowed && (!drawAll || !view.contains(at))) continue;
        t.marker.setLatLng(at);                     // keeps Leaflet (tooltip, getLatLng) in sync
        const el = t.marker.getElement();
        if (el && !zooming) L.DomUtil.setPosition(el, exactLayerPoint(at));
        turn(t, far ? 1000 : dt);
      }
      // keep the followed train exactly centred by panning the map by fractional pixels
      const ft = followedN && trains.get(followedN);
      if (ft && !flying && !zooming) {
        const off = exactLayerPoint(ft.marker.getLatLng())
          .add(m._getMapPanePos())
          .subtract(map.getSize().divideBy(2));
        if (Math.abs(off.x) + Math.abs(off.y) > 0.01) {
          m._rawPanBy(off);
          map.fire("move");
          if (frame - lastMoveEnd > 400) { map.fire("moveend"); lastMoveEnd = frame; } // load tiles
        }
      }
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    // once a second: fade/remove silent trains and refresh the UI
    const tick = setInterval(() => {
      const now = Date.now();
      for (const [n, t] of trains) {
        if (now - t.p.ts > MAX_AGE_MS) {
          if (n === followedRef.current) unfollow();
          map.removeLayer(t.marker); trains.delete(n); continue;
        }
        cls(t, "stale", now - t.p.ts > STALE_MS);
      }
      setLive(now - lastEvent < 30_000);
      setRows([...trains.values()]
        .map(({ p }) => ({
          n: p.n, from: info[p.n]?.from ?? "–", to: info[p.n]?.to ?? "–", product: info[p.n]?.product ?? "Tåg", brand: brandFor(p.n),
          speed: p.speed, age: Math.round((now - p.ts) / 1000),
        }))
        .sort((a, b) => Number(a.n) - Number(b.n)));
    }, 1000);

    // Positions: the server follows Trafikverket's live stream and stores every train's
    // latest fix; we poll for what's new since the last answer. The first answer is every
    // train seen in the last 10 minutes (replayed fixes: they say nothing about delay).
    let cursor: number | undefined, pollTimer = 0, stopped = false;
    const poll = async () => {
      try {
        const first = cursor === undefined;
        const res = await api.trains.positions.call(first ? {} : { since: cursor });
        if (stopped) return;   // the map was taken down while we waited
        cursor = res.cursor;
        lastEvent = Date.now();
        res.fixes.sort((a, b) => a.ts - b.ts).forEach(p => upsert(p, !first));
        if (!fitted && trains.size) {
          map.fitBounds(L.featureGroup([...trains.values()].map(t => t.marker)).getBounds().pad(0.05));
          fitted = true;
        }
      } catch (e) {
        console.error("positions:", e);
      }
      if (!stopped) pollTimer = window.setTimeout(poll, POLL_MS);
    };
    poll();

    loadInfo().then(applyFilter);
    const infoTimer = setInterval(() => loadInfo().then(applyFilter), 5 * 60_000);

    return () => {
      stopped = true;
      clearTimeout(pollTimer);
      clearInterval(tick);
      clearInterval(infoTimer);
      cancelAnimationFrame(raf);
      map.remove();
    };
  }, []);

  const chooseBrand = (k: string | null) => {
    brandRef.current = k;
    setBrandKey(k);
    ctl.current.applyFilter();
  };

  // companies by number of trains running, for the filter chips (doubles as the colour legend)
  const brands = useMemo(() => {
    const count = new Map<string, { brand: Brand; n: number }>();
    for (const r of rows) {
      const c = count.get(r.brand.key);
      if (c) c.n++; else count.set(r.brand.key, { brand: r.brand, n: 1 });
    }
    return [...count.values()].sort((a, b) => b.n - a.n);
  }, [rows]);
  const activeBrand = brands.find(b => b.brand.key === brandKey)?.brand;

  const s = q.trim().toLowerCase();
  const visibleRows = useMemo(
    () => rows.filter(r => (!brandKey || r.brand.key === brandKey)
      && (!s || `${r.n} ${r.from} ${r.to} ${r.product} ${r.brand.name}`.toLowerCase().includes(s))),
    [rows, brandKey, s],
  );
  const stationHits = useMemo(
    () => (s.length >= 2 ? stations.filter(st => st.name.toLowerCase().includes(s)).slice(0, 6) : []),
    [stations, s],
  );
  const liveTrains = useMemo(() => new Set(rows.map(r => r.n)), [rows]);
  const hud = followed ? rows.find(r => r.n === followed) : undefined;
  const shownCount = brandKey ? rows.filter(r => r.brand.key === brandKey).length : rows.length;

  return (
    <div className={`${hud ? "has-hud" : ""}${board ? " has-board" : ""}`}>
      <div ref={mapEl} className="map" />

      <header className="brand glass">
        <Logo />
        <div>
          <div className="word">Tuff</div>
          <div className="sub">Sveriges tåg i realtid</div>
        </div>
      </header>

      <div className="panel">
        <button className="pill glass" onClick={() => setListOpen(o => !o)} aria-expanded={listOpen}>
          <span className={`dot${live ? " live" : ""}`} />
          <span className="count mono">{shownCount}</span>
          {activeBrand && <BrandBadge brand={activeBrand} size="sm" />}
          <span className="state">{live ? (activeBrand ? activeBrand.name : "tåg live") : "ansluter…"}</span>
          <svg className="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6l4 4 4-4" /></svg>
        </button>

        {listOpen && (
          <section className="sheet glass">
            <div className="sheet-head">
              <div className="sheet-title">
                <h2>Tåg i trafik</h2>
                <span>{visibleRows.length} av {rows.length}</span>
              </div>
              <label className="search">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Sök tåg, station eller bolag" />
              </label>
              <div className="chips" role="listbox" aria-label="Filtrera på tågbolag">
                <button className={!brandKey ? "on" : ""} onClick={() => chooseBrand(null)}>Alla <i>{rows.length}</i></button>
                {brands.map(({ brand: b, n }) => (
                  <button key={b.key} className={brandKey === b.key ? "on" : ""}
                    onClick={() => chooseBrand(brandKey === b.key ? null : b.key)}>
                    <span className="swatch" style={{ background: b.color }} />{b.name} <i>{n}</i>
                  </button>
                ))}
              </div>
            </div>
            <ul className="rows">
              {stationHits.length > 0 && <li className="group">Stationer</li>}
              {stationHits.map(st => (
                <li key={st.sig}>
                  <button className="row station" onClick={() => { ctl.current.openStation(st.sig); setListOpen(false); }}>
                    <span className="badge station-badge">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="3.5" /></svg>
                    </span>
                    <span className="route"><b>{st.name}</b><small>Avgångar och ankomster</small></span>
                    <span />
                  </button>
                </li>
              ))}
              {stationHits.length > 0 && visibleRows.length > 0 && <li className="group">Tåg</li>}
              {visibleRows.slice(0, LIST_LIMIT).map(r => (
                <li key={r.n}>
                  <button
                    className={`row${r.n === followed ? " active" : ""}${r.age * 1000 > STALE_MS ? " stale" : ""}`}
                    onClick={() => { ctl.current.follow(r.n); if (window.innerWidth < 600) setListOpen(false); }}
                  >
                    <span className="badge-pair"><BrandBadge brand={r.brand} /><span className="num mono">{r.n}</span></span>
                    <span className="route">
                      <b>{r.to}</b>
                      <small>{r.product} · från {r.from}</small>
                    </span>
                    <span className="spd mono">{r.speed != null ? <>{r.speed}<i>km/h</i></> : "–"}</span>
                  </button>
                </li>
              ))}
              {visibleRows.length > LIST_LIMIT && (
                <li className="empty">Visar {LIST_LIMIT} av {visibleRows.length} – sök för att hitta fler</li>
              )}
              {!visibleRows.length && !stationHits.length && (
                <li className="empty">{rows.length ? "Inga träffar" : "Inga tåg just nu"}</li>
              )}
            </ul>
          </section>
        )}
      </div>

      {board && (
        <StationBoard
          sig={board}
          liveTrains={liveTrains}
          onFollow={n => {
            // not enough room for both on smaller screens: close the board so the train is visible
            if (window.innerWidth < 900) ctl.current.closeStation();
            ctl.current.follow(n);
          }}
          onClose={() => ctl.current.closeStation()}
        />
      )}

      {hud && (
        <div className="hud glass" role="status">
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow"><BrandBadge brand={hud.brand} size="sm" /><span className="badge mono">{hud.n}</span>{hud.product}</div>
            <div className="dest">{hud.to}</div>
            <div className="from">från {hud.from} · uppdaterad {ageText(hud.age)} sedan</div>
          </div>
          <div className="speed mono">
            <b>{hud.speed ?? "–"}</b>
            <span>km/h</span>
          </div>
          <button className="icon-btn" aria-label="Sluta följa" onClick={() => ctl.current.unfollow()}>
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
          </button>
        </div>
      )}

      <div className="controls glass">
        <button aria-label="Zooma in" onClick={() => ctl.current.zoom(1)}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
        </button>
        <button aria-label="Zooma ut" onClick={() => ctl.current.zoom(-1)}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 8h10" /></svg>
        </button>
        <button aria-label="Visa alla tåg" onClick={() => ctl.current.fitAll()}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
        </button>
      </div>
    </div>
  );
}

function Logo() {
  // two rails and a train, drawn as a single mark
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="var(--ink)" />
      <path d="M7 19.5C11 15.5 13.5 13 21 8.5" stroke="var(--bg)" strokeOpacity=".35" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M7 22.5C12 18 15 15.5 21 12" stroke="var(--bg)" strokeOpacity=".35" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="15" cy="14.6" r="3.2" fill="var(--accent)" stroke="var(--ink)" strokeWidth="1.5" />
    </svg>
  );
}
