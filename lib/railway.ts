import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Railway graph built from OpenStreetMap (data/railway.json, see scripts/build-railway.mjs).
 * Snaps GPS positions onto the nearest track and finds the path along the tracks
 * between two consecutive positions, so trains can be animated along the rails.
 */

const SNAP_RADIUS_M = 80;     // GPS further than this from any track isn't snapped
const CELL_M = 250;           // spatial grid cell size
const LAT0 = 59.5;            // projection origin (Mälardalen)
const MX = 111_320 * Math.cos((LAT0 * Math.PI) / 180); // metres per degree longitude
const MY = 110_540;                                     // metres per degree latitude

export type Snap = { a: number; b: number; t: number; x: number; y: number };
export type LatLon = [number, number];

type Graph = {
  xs: Float64Array; ys: Float64Array;
  adj: number[][];              // node -> neighbour nodes
  grid: Map<number, number[]>;  // cell -> segment ids
  segA: Int32Array; segB: Int32Array;
};

let graph: Graph | null = null;

function load(): Graph {
  if (graph) return graph;
  const { coords, ways } = JSON.parse(
    readFileSync(path.join(process.cwd(), "data", "railway.json"), "utf8"),
  ) as { coords: number[]; ways: number[][] };

  const n = coords.length / 2;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { ys[i] = coords[2 * i] * MY; xs[i] = coords[2 * i + 1] * MX; }

  const adj: number[][] = Array.from({ length: n }, () => []);
  const sa: number[] = [], sb: number[] = [];
  for (const w of ways) {
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1], b = w[i];
      if (a === b) continue;
      adj[a].push(b); adj[b].push(a);
      sa.push(a); sb.push(b);
    }
  }

  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 1_000_003 + cy;
  for (let s = 0; s < sa.length; s++) {
    const a = sa[s], b = sb[s];
    const x0 = Math.floor(Math.min(xs[a], xs[b]) / CELL_M), x1 = Math.floor(Math.max(xs[a], xs[b]) / CELL_M);
    const y0 = Math.floor(Math.min(ys[a], ys[b]) / CELL_M), y1 = Math.floor(Math.max(ys[a], ys[b]) / CELL_M);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = key(cx, cy);
      const list = grid.get(k);
      if (list) list.push(s); else grid.set(k, [s]);
    }
  }

  graph = { xs, ys, adj, grid, segA: Int32Array.from(sa), segB: Int32Array.from(sb) };
  return graph;
}

const dist = (g: Graph, a: number, b: number) => Math.hypot(g.xs[a] - g.xs[b], g.ys[a] - g.ys[b]);
const toLatLon = (x: number, y: number): LatLon => [+(y / MY).toFixed(6), +(x / MX).toFixed(6)];

/** Track points within SNAP_RADIUS_M of a position, nearest first (at most one per segment). */
function candidates(g: Graph, lat: number, lon: number): (Snap & { d: number })[] {
  const px = lon * MX, py = lat * MY;
  const cx = Math.floor(px / CELL_M), cy = Math.floor(py / CELL_M);
  const seen = new Set<number>();
  const out: (Snap & { d: number })[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const s of g.grid.get((cx + dx) * 1_000_003 + (cy + dy)) ?? []) {
      if (seen.has(s)) continue;
      seen.add(s);
      const a = g.segA[s], b = g.segB[s];
      const vx = g.xs[b] - g.xs[a], vy = g.ys[b] - g.ys[a];
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((px - g.xs[a]) * vx + (py - g.ys[a]) * vy) / len2));
      const x = g.xs[a] + t * vx, y = g.ys[a] + t * vy;
      const d = Math.hypot(px - x, py - y);
      if (d <= SNAP_RADIUS_M) out.push({ a, b, t, x, y, d });
    }
  }
  return out.sort((p, q) => p.d - q.d);
}

// ---------- shortest path (Dijkstra with a distance cap) ----------

class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

/** Path along the tracks from snap `s` to snap `e`, or null if longer than `limit` metres. */
function route(g: Graph, s: Snap, e: Snap, limit: number): { cost: number; pts: [number, number][] } | null {
  const segLen = (p: Snap) => dist(g, p.a, p.b);
  // same segment: straight along it
  if ((s.a === e.a && s.b === e.b) || (s.a === e.b && s.b === e.a)) {
    return { cost: Math.hypot(s.x - e.x, s.y - e.y), pts: [[s.x, s.y], [e.x, e.y]] };
  }
  const best = new Map<number, number>(), prev = new Map<number, number>();
  const heap = new Heap();
  const seed = (node: number, c: number) => {
    if (c < (best.get(node) ?? Infinity)) { best.set(node, c); prev.set(node, -1); heap.push(c, node); }
  };
  seed(s.a, s.t * segLen(s));
  seed(s.b, (1 - s.t) * segLen(s));
  const endCost = new Map([[e.a, e.t * segLen(e)], [e.b, (1 - e.t) * segLen(e)]]);

  let found = -1, foundCost = Infinity;
  while (heap.size) {
    const [c, u] = heap.pop();
    if (c > (best.get(u) ?? Infinity)) continue;
    if (c > limit || c >= foundCost) break;
    const ec = endCost.get(u);
    if (ec != null && c + ec < foundCost) { found = u; foundCost = c + ec; }
    for (const v of g.adj[u]) {
      const nc = c + dist(g, u, v);
      if (nc < (best.get(v) ?? Infinity)) { best.set(v, nc); prev.set(v, u); heap.push(nc, v); }
    }
  }
  if (found < 0 || foundCost > limit) return null;

  const nodes: number[] = [];
  for (let u = found; u !== -1; u = prev.get(u)!) nodes.push(u);
  nodes.reverse();
  return {
    cost: foundCost,
    pts: [[s.x, s.y], ...nodes.map(u => [g.xs[u], g.ys[u]] as [number, number]), [e.x, e.y]],
  };
}

/**
 * Snap a new GPS fix onto the tracks and, given the previous snapped fix,
 * return the path along the rails between them.
 * - snap: where to draw the train (null if not near a track)
 * - path: [lat, lon][] from the previous to the new snapped point (null → move straight)
 */
export function trackPath(prev: Snap | null, lat: number, lon: number): { snap: Snap | null; path: LatLon[] | null } {
  const g = load();
  const cands = candidates(g, lat, lon).slice(0, 8);
  if (!cands.length) return { snap: null, path: null };
  if (!prev) return { snap: cands[0], path: null };

  // Try each nearby track (e.g. both tracks of a double-track line) and keep the one
  // reachable by the shortest believable route from where the train was.
  let bestSnap: Snap = cands[0], bestPath: [number, number][] | null = null, bestScore = Infinity;
  for (const c of cands) {
    const straight = Math.hypot(c.x - prev.x, c.y - prev.y);
    const r = route(g, prev, c, straight * 1.5 + 300);
    if (!r) continue;
    const score = r.cost + c.d * 2;    // prefer short routes, then tracks closer to the GPS fix
    if (score < bestScore) { bestScore = score; bestSnap = c; bestPath = r.pts; }
  }
  return {
    snap: bestSnap,
    path: bestPath ? bestPath.map(([x, y]) => toLatLon(x, y)) : null,
  };
}

export function snapToLatLon(s: Snap): LatLon { return toLatLon(s.x, s.y); }
