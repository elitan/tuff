import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import L from "leaflet";
import { api, type Fix, type MapStation, type RouteStop, type TrainInfo, type TrainRoute } from "northstack";
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
  // the marker's elements, looked up once (not per frame)
  el: HTMLElement;
  tm: HTMLElement;
  svg: SVGSVGElement;
  dirEl: SVGElement;
  nodirEl: SVGElement;
  known: boolean | null;    // whether the heading is drawn (null: not set yet)
  drawn: string;            // last position written to the DOM, to skip unchanged trains
  track: Track;         // buffered GPS fixes along the rails, played back smoothly
  angle: number;        // drawn heading (degrees, cumulative so turns take the short way)
  target: number | null;// heading we're turning towards (null = unknown → show a dot)
  p: Position;
};

type Row = { n: string; from: string; to: string; product: string; brand: Brand; speed: number | null; age: number };

// Top-down train: a lead car with a rounded nose and windscreen, coupled to a second car.
// Drawn pointing up (north) and rotated to the direction of travel. Plain dot until we know the heading.
// The train number is part of the marker (not a Leaflet tooltip), so it moves with the
// marker's transform: a tooltip is repositioned on every move, reading its size each time.
const icon = (n: string) => L.divIcon({
  className: "", iconSize: [44, 44], iconAnchor: [22, 22],
  html: `<div class="tm"><span class="halo"></span><span class="tlabel">${n.replace(/[^\w-]/g, "")}</span><svg viewBox="0 0 44 44">
    <g class="dir">
      <path class="body" d="M16.5 21 V9.5 C16.5 5 19 2.5 22 2.5 C25 2.5 27.5 5 27.5 9.5 V21 Q27.5 22.5 26 22.5 H18 Q16.5 22.5 16.5 21 Z"/>
      <path class="glass" d="M18.6 8.6 C19.2 6 20.4 4.9 22 4.9 C23.6 4.9 24.8 6 25.4 8.6 Z"/>
      <rect class="body" x="16.5" y="24" width="11" height="17.5" rx="1.6"/>
      <path class="roof" d="M22 11.5 V20.5 M22 26 V39.5"/>
    </g>
    <circle class="body nodir" cx="22" cy="22" r="6.5"/></svg></div>`,
});

const ROUTE_REFRESH_MS = 60_000;  // refresh the followed train's timetable (delays)
const hhmm = (iso?: string | null) => (iso ? iso.slice(11, 16) : "");
/** Minutes late at a stop (estimated or actual vs timetable), if any. */
const lateMin = (s: RouteStop) => {
  const t = s.departure ?? s.arrival;
  const real = t?.actual ?? t?.estimated;
  if (!t || !real) return 0;
  return Math.round((Date.parse(real) - Date.parse(t.time)) / 60_000);
};
/** The stop's time as shown: when it really happened or is expected, else the timetable. */
const stopTime = (s: RouteStop) => {
  const t = s.departure ?? s.arrival;
  return hhmm(t?.actual ?? t?.estimated ?? t?.time);
};
const escapeHtml = (x: string) => x.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const ageText = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`);
// Ways to show a selected train and its route, to compare in the browser (styles.css, [data-look]).
const LOOKS = ["Nu", "Fokus", "Spotlight", "Tunnelbana", "Neon", "Minimal", "Tidtabell", "Kontrast", "Puls", "Gråskala", "Blå"];
const DEFAULT_LOOK = 11;

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export default function TrainMap() {
  const mapEl = useRef<HTMLDivElement>(null);
  const followedRef = useRef<string | null>(null);   // the selected train
  const centerRef = useRef(false);                     // keep the selected train in the middle
  const brandRef = useRef<string | null>(null);   // brand key filter
  const ctl = useRef({   // map actions, for the React UI below
    follow: (_n: string) => {}, unfollow: () => {}, zoom: (_d: number) => {}, fitAll: () => {},
    fitRoute: () => {}, relayout: () => {},
    openStation: (_sig: string) => {}, closeStation: () => {}, applyFilter: () => {},
  });
  const [live, setLive] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [followed, setFollowed] = useState<string | null>(null);
  const [centered, setCentered] = useState(false);
  const [look, setLook] = useState(() => {
    try { return Number(localStorage.getItem("look2")) || DEFAULT_LOOK; } catch { return DEFAULT_LOOK; }
  });
  const pickLook = (n: number) => {
    setLook(n);
    try { localStorage.setItem("look2", String(n)); } catch { /* private window */ }
    setTimeout(() => ctl.current.relayout(), 50);   // label sizes change with the look
  };
  // keys 1–9 and 0 switch looks while a train is selected
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!followedRef.current || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") { ctl.current.unfollow(); return; }
      const i = "1234567890b".indexOf(e.key);
      if (i >= 0) pickLook(i + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [route, setRoute] = useState<TrainRoute | null>(null);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (import.meta.env.DEV) (window as any).tuff = { trains, map };
    let info: Record<string, TrainInfo> = {};
    let fitted = false, lastEvent = 0, flying = false, raf = 0;

    const loadInfo = () =>
      api.trains.list.call(null)
        .then(list => { info = Object.fromEntries(list.map(t => [t.number, t])); })
        .catch(console.error);

    // Ease the drawn heading towards the target heading (per frame, no CSS transition,
    // so rotation and movement stay in lockstep).
    const turn = (t: TrainState, dt: number) => {
      const known = t.target != null;
      if (t.known !== known) {
        t.known = known;
        t.dirEl.style.display = known ? "" : "none";
        t.nodirEl.style.display = known ? "none" : "";
      }
      if (t.target == null) return;
      const delta = ((t.target - t.angle) % 360 + 540) % 360 - 180;
      if (Math.abs(delta) < 0.05 && t.svg.style.transform) return;
      t.angle += delta * Math.min(1, dt / TURN_MS);
      t.svg.style.transform = `rotate(${t.angle.toFixed(2)}deg)`;
    };

    // Leaflet rounds marker and pan positions to whole pixels, which makes slow
    // movement step visibly. Position things ourselves with sub-pixel precision.
    const exactLayerPoint = (ll: L.LatLngExpression) => map.project(ll).subtract(map.getPixelOrigin());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = map as any; // _rawPanBy / _animatingZoom / _getMapPanePos are Leaflet internals
    let lastMoveEnd = 0;
    const cls = (t: TrainState | undefined, c: string, on: boolean) => t?.tm.classList.toggle(c, on);

    // ----- operator filter -----
    const brandFor = (n: string) => brandOf(info[n]?.product, info[n]?.owner);
    // colour each train by company, and hide the ones the filter excludes
    const styleTrain = (n: string, t: TrainState) => {
      const b = brandFor(n);
      if (t.tm.dataset.brand !== b.key) { t.tm.dataset.brand = b.key; t.tm.style.setProperty("--brand", b.color); }
      const want = brandRef.current;
      const display = !want || b.key === want || n === followedRef.current ? "" : "none";
      if (t.el.style.display !== display) t.el.style.display = display;
      // with a train selected, the others step back so its route reads
      t.el.classList.toggle("dim", followedRef.current != null && n !== followedRef.current);
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
    let routeStops: RouteStop[] = [];
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
      const named = new Set(routeStops.filter(s => s.advertised).map(s => s.sig));
      for (const s of stationList.filter(s => b.contains([s.lat, s.lon]) && !named.has(s.sig)).slice(0, 150)) {
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

    // ----- the followed train's route: the railway it runs on, with its stops -----
    map.createPane("route").style.zIndex = "450";        // above tiles, below trains
    map.createPane("routeLabels").style.zIndex = "650";   // names above the trains
    const routeRenderer = L.svg({ pane: "route" });
    const routeLayer = L.layerGroup().addTo(map);
    let routeFor: string | null = null, routeTimer = 0;
    // The whole run is drawn: what's run already faint in the train's colour, what's left bright.
    // The part still to run is split at the train every second.
    let remaining: L.LatLngTuple[] = [];
    let labels: { el: HTMLElement; prio: number }[] = [];
    const line = (o: L.PolylineOptions) => L.polyline([], { pane: "route", renderer: routeRenderer, interactive: false, lineCap: "round", lineJoin: "round", ...o });
    // Colours and widths come from CSS (styles.css, per look), the options are the fallback.
    const doneLine = line({ weight: 4, opacity: 0.55, className: "r-done" });
    const behindLine = line({ weight: 4, opacity: 0.55, className: "r-behind" });
    const aheadGlow = line({ weight: 18, opacity: 0, className: "r-glow" });
    const aheadCasing = line({ weight: 8, opacity: 0.9, className: "r-casing" });
    const aheadLine = line({ weight: 4.5, opacity: 1, className: "r-ahead" });
    const splitRoute = () => {
      const t = routeFor ? trains.get(routeFor) : undefined;
      if (!t || remaining.length < 2) return;
      const p = t.marker.getLatLng(), k = Math.cos((p.lat * Math.PI) / 180);
      let best = Infinity, at = 0, cut: L.LatLngTuple = remaining[0];
      for (let i = 1; i < remaining.length; i++) {
        const [ay, ax] = remaining[i - 1], [by, bx] = remaining[i];
        const vx = (bx - ax) * k, vy = by - ay, px = (p.lng - ax) * k, py = p.lat - ay;
        const l2 = vx * vx + vy * vy, f = l2 > 0 ? Math.max(0, Math.min(1, (px * vx + py * vy) / l2)) : 0;
        const d = (px - f * vx) ** 2 + (py - f * vy) ** 2;
        if (d < best) { best = d; at = i; cut = [ay + f * (by - ay), ax + f * (bx - ax)]; }
      }
      behindLine.setLatLngs([...remaining.slice(0, at), cut]);
      const ahead = [cut, ...remaining.slice(at)];
      aheadGlow.setLatLngs(ahead);
      aheadCasing.setLatLngs(ahead);
      aheadLine.setLatLngs(ahead);
    };
    // Every stop is named at every zoom, as long as names don't overlap: the first and last
    // stop and the next one always win, then the stops still ahead, then the ones passed.
    const declutter = () => {
      const taken: DOMRect[] = [];
      for (const l of labels) l.el.style.visibility = "";
      for (const l of [...labels].sort((a, b) => a.prio - b.prio)) {
        const r = (l.el.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
        if (!r) continue;
        const hit = l.prio > 1 && taken.some(t => r.left < t.right + 4 && r.right + 4 > t.left && r.top < t.bottom && r.bottom > t.top);
        if (hit) l.el.style.visibility = "hidden"; else taken.push(r);
      }
    };
    map.on("zoomend", () => requestAnimationFrame(declutter));
    const drawRoute = (r: TrainRoute) => {
      routeLayer.clearLayers();
      labels = [];
      routeStops = r.stops;
      updateStationLabels();
      const color = brandFor(r.number).color, ink = css("--ink");
      const next = r.stops.findIndex(s => !s.passed);
      const done: L.LatLngTuple[][] = [];
      remaining = [];
      r.legs.forEach((leg, i) => {
        // a leg is done once the train has passed its far end
        if (r.stops[i + 1]?.passed) done.push(leg as L.LatLngTuple[]);
        else remaining.push(...(remaining.length ? leg.slice(1) : leg) as L.LatLngTuple[]);
      });
      doneLine.setLatLngs(done).setStyle({ color }).addTo(routeLayer);
      behindLine.setStyle({ color }).addTo(routeLayer);
      aheadGlow.setStyle({ color }).addTo(routeLayer);
      aheadCasing.setStyle({ color: ink }).addTo(routeLayer);
      aheadLine.setStyle({ color }).addTo(routeLayer);
      splitRoute();
      const last = r.stops.length - 1;
      r.stops.forEach((s, i) => {
        const end = i === 0 || i === last;
        if (!s.advertised && !end) return;
        const isNext = i === next;
        L.circleMarker([s.lat, s.lon], {
          pane: "route", renderer: routeRenderer, interactive: false,
          className: `r-stop${end ? " r-end" : ""}${isNext ? " r-next" : ""}${s.passed ? " r-passed" : ""}`,
          radius: end ? 6.5 : isNext ? 7 : 4.5, weight: 2.2,
          color: ink, opacity: s.passed && !end ? 0.5 : 1,
          fillColor: isNext ? color : end ? ink : css("--bg"), fillOpacity: 1,
        }).addTo(routeLayer);
        const late = lateMin(s);
        const html = `<span class="${s.passed ? "passed" : ""}${isNext ? " next" : ""}${end ? " end" : ""}">`
          + `<b>${escapeHtml(s.name)}</b> <em>${stopTime(s)}</em>`
          + (late > 0 && !s.canceled ? ` <i>+${late}</i>` : "")
          + (s.canceled ? ` <i>inställt</i>` : "") + `</span>`;
        const mk = L.marker([s.lat, s.lon], {
          pane: "routeLabels", interactive: false, keyboard: false,
          icon: L.divIcon({ className: "rlabel", html, iconSize: [0, 0] }),
        }).addTo(routeLayer);
        const prio = end || isNext ? 0 : s.passed ? 3 : 2;
        labels.push({ el: mk.getElement()!, prio: prio * 1000 + (s.passed ? last - i : i) });
      });
      requestAnimationFrame(declutter);
    };
    const routeBounds = () => {
      const pts = routeStops.map(s => [s.lat, s.lon] as L.LatLngTuple);
      return pts.length ? L.latLngBounds(pts) : null;
    };
    const loadRoute = (n: string) => {
      api.trains.route.call({ number: n }).then(r => {
        if (stopped || routeFor !== n) return;   // followed another train meanwhile
        drawRoute(r);
        setRoute(r);
      }).catch(e => console.warn("route:", e));
    };
    const showRoute = (n: string) => {
      if (routeFor === n) return;
      clearRoute();
      routeFor = n;
      loadRoute(n);
      routeTimer = window.setInterval(() => loadRoute(n), ROUTE_REFRESH_MS);
    };
    const clearRoute = () => {
      routeFor = null;
      window.clearInterval(routeTimer);
      routeLayer.clearLayers();
      remaining = [];
      labels = [];
      routeStops = [];
      updateStationLabels();
      setRoute(null);
    };
    const splitTimer = setInterval(splitRoute, 1000);

    // ----- follow mode -----
    // Selecting a train keeps it selected (route, card) until it's closed; moving the map only
    // stops keeping it in the middle. Selecting it again centres it again.
    const setCenter = (on: boolean) => { centerRef.current = on; setCentered(on); };
    const follow = (n: string) => {
      const t = trains.get(n);
      if (!t) return;
      setCenter(true);
      if (followedRef.current === n) {
        map.flyTo(t.marker.getLatLng(), Math.max(map.getZoom(), FOLLOW_ZOOM), { duration: 1.2 });
        return;
      }
      cls(trains.get(followedRef.current ?? ""), "followed", false);
      followedRef.current = n;
      setFollowed(n);
      cls(t, "followed", true);
      t.marker.setZIndexOffset(1000);
      applyFilter();
      showRoute(n);
      map.flyTo(t.marker.getLatLng(), Math.max(map.getZoom(), FOLLOW_ZOOM), { duration: 1.2 });
    };
    const unfollow = () => {
      const t = trains.get(followedRef.current ?? "");
      cls(t, "followed", false);
      t?.marker.setZIndexOffset(0);
      followedRef.current = null;
      setFollowed(null);
      setCenter(false);
      applyFilter();
      clearRoute();
    };
    const fitAll = () => {
      unfollow();
      const shown = [...trains.entries()]
        .filter(([n]) => !brandRef.current || brandFor(n).key === brandRef.current)
        .map(([, t]) => t.marker);
      if (shown.length) map.flyToBounds(L.featureGroup(shown).getBounds().pad(0.12), { duration: 1 });
    };
    const fitRoute = () => {
      const b = routeBounds();
      if (!b) return;
      setCenter(false);
      map.flyToBounds(b, { duration: 1, paddingTopLeft: [40, 90], paddingBottomRight: [40, 170] });
    };
    ctl.current = {
      follow, unfollow, fitAll, fitRoute, openStation, closeStation, applyFilter,
      relayout: declutter,
      zoom: d => (d > 0 ? map.zoomIn() : map.zoomOut()),
    };
    map.on("dragstart", () => setCenter(false));   // user takes over the map → stop centring
    map.on("zoomstart", () => { flying = true; });
    map.on("zoomend", () => { flying = false; });

    // ----- positions -----
    const upsert = (p: Position) => {
      if (Date.now() - p.ts > MAX_AGE_MS) return;
      const ll: [number, number] = [p.lat, p.lon];
      const t = trains.get(p.n);
      if (!t) {
        const marker = L.marker(ll, { icon: icon(p.n), keyboard: false }).addTo(map);
        const el = marker.getElement()!, svg = el.querySelector("svg")!;
        const state: TrainState = {
          marker, el, tm: el.querySelector(".tm")!, svg,
          dirEl: svg.querySelector(".dir")!, nodirEl: svg.querySelector(".nodir")!, known: null, drawn: "",
          track: new Track(ll, p.ts, p.speed, p.ahead), angle: p.bearing ?? 0, target: p.bearing, p,
        };
        trains.set(p.n, state);
        marker.on("click", () => follow(p.n));
        turn(state, TURN_MS);
        styleTrain(p.n, state);
      } else {
        if (p.ts <= t.p.ts) return;          // replayed / out-of-order event
        t.track.add(ll, p.ts, p.path, p.speed, p.ahead);
        if (!p.path && p.bearing != null) t.target = p.bearing;
        t.p = p;
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m_latlng = (marker: L.Marker, at: [number, number]) => { (marker as any)._latlng = L.latLng(at[0], at[1]); };
    // after a zoom, Leaflet has placed every marker itself: redraw them all
    map.on("zoomend viewreset", () => { for (const t of trains.values()) t.drawn = ""; });

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
        // Keep Leaflet's idea of the position current (zoom, getLatLng) without setLatLng(),
        // which fires events and repositions the marker a second time.
        m_latlng(t.marker, at);
        if (!zooming) {
          // write the DOM only when the train moved (many stand still at stations)
          const pt = exactLayerPoint(at), key = `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
          if (key !== t.drawn) { t.drawn = key; L.DomUtil.setPosition(t.el, pt); }
        }
        turn(t, far ? 1000 : dt);
      }
      // keep the followed train exactly centred by panning the map by fractional pixels
      const ft = followedN && trains.get(followedN);
      if (ft && centerRef.current && !flying && !zooming) {
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
    // train seen in the last 10 minutes.
    let cursor: number | undefined, pollTimer = 0, stopped = false;
    const poll = async () => {
      try {
        const first = cursor === undefined;
        const res = await api.trains.positions.call(first ? {} : { since: cursor });
        if (stopped) return;   // the map was taken down while we waited
        cursor = res.cursor;
        lastEvent = Date.now();
        res.fixes.sort((a, b) => a.ts - b.ts).forEach(p => upsert(p));
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
      clearInterval(routeTimer);
      clearInterval(splitTimer);
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
  const nextStop = route?.number === followed
    ? route.stops.find(s => s.advertised && !s.passed && !s.canceled)
    : undefined;
  const shownCount = brandKey ? rows.filter(r => r.brand.key === brandKey).length : rows.length;

  return (
    <div
      className={`${hud ? "has-hud" : ""}${board ? " has-board" : ""}${followed ? " sel" : ""}`}
      data-look={look}
      data-route-brand={hud?.brand.key}
      style={hud ? ({ "--route": hud.brand.color } as CSSProperties) : undefined}
    >
      <div ref={mapEl} className="map" />

      <header className="brand glass">
        <Logo />
        <div>
          <div className="word">Tuff</div>
          <div className="sub">Sveriges tåg i realtid</div>
        </div>
        <Clock />
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
        <div className="looks glass" role="radiogroup" aria-label="Utseende">
          {LOOKS.map((name, i) => (
            <button key={name} role="radio" aria-checked={look === i + 1}
              className={look === i + 1 ? "on" : ""} onClick={() => pickLook(i + 1)} title={`${name} (${"1234567890b"[i]})`}>
              <i className="mono">{"1234567890B"[i]}</i>{name}
            </button>
          ))}
        </div>
      )}

      {hud && (
        <div className="hud glass" role="status">
          <button className="hud-close glass" onClick={() => ctl.current.unfollow()}>
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
            Stäng
          </button>
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow"><BrandBadge brand={hud.brand} size="sm" /><span className="badge mono">{hud.n}</span>{hud.product}</div>
            <div className="dest">{hud.to}</div>
            {nextStop ? (
              <div className="from">
                nästa <b>{nextStop.name}</b> {stopTime(nextStop)}
                {lateMin(nextStop) > 0 && <span className="late"> +{lateMin(nextStop)} min</span>}
                {" "}· uppdaterad {ageText(hud.age)} sedan
              </div>
            ) : (
              <div className="from">från {hud.from} · uppdaterad {ageText(hud.age)} sedan</div>
            )}
            <div className="hud-actions">
              {route?.number === followed && (
                <button onClick={() => ctl.current.fitRoute()}>
                  Hela rutten · {route.stops[0].name} – {route.stops[route.stops.length - 1].name}
                </button>
              )}
              {!centered && <button onClick={() => ctl.current.follow(hud.n)}>Följ tåget</button>}
            </div>
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

// Swedish time, to the second: what the timetable times and delays are measured against.
const clockFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    // tick on the second boundary so the seconds change with the system clock
    const tick = () => { setNow(new Date()); timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5); };
    tick();
    return () => clearTimeout(timer);
  }, []);
  return <time className="clock mono" dateTime={now.toISOString()}>{clockFormat.format(now)}</time>;
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
