//! Railway graph built from OpenStreetMap (`server/data/railway.json`, see
//! scripts/build-railway.mjs). Snaps GPS positions onto the nearest track and finds the
//! path along the tracks between two consecutive positions, so the browser can animate
//! trains along the rails. Built once, on first use.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const SNAP_RADIUS_M: f64 = 80.0; // GPS further than this from any track isn't snapped
const AHEAD_M: f64 = 2000.0; // how much track ahead of a moving train to send
const AHEAD_TOLERANCE_M: f64 = 3.0; // ...simplified: no point further than this off the track
const MAX_TURN_DEG: f64 = 60.0; // a sharper turn ends the track ahead
const CELL_M: f64 = 250.0; // spatial grid cell size
const LAT0: f64 = 59.5; // x is degrees longitude scaled as at this latitude
const MY: f64 = 110_540.0; // metres per degree latitude

/// Projected x units per degree longitude (metres at LAT0).
fn mx() -> f64 {
    111_320.0 * LAT0.to_radians().cos()
}

/// Real metres per projected x unit at projected y: shrinks going north (0.77 at 67° N).
fn kx(y: f64) -> f64 {
    (y / MY).to_radians().cos() / LAT0.to_radians().cos()
}

/// Metres between two projected points (local scale at their mid latitude).
fn metres(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    ((ax - bx) * kx((ay + by) / 2.0)).hypot(ay - by)
}

/// A point on the track graph: `t` along the segment from node `a` to node `b`, at (x, y) metres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Snap {
    pub a: u32,
    pub b: u32,
    pub t: f64,
    pub x: f64,
    pub y: f64,
}

pub type LatLon = [f64; 2];

struct Graph {
    xs: Vec<f64>,
    ys: Vec<f64>,
    adj: Vec<Vec<u32>>,
    grid: HashMap<(i64, i64), Vec<u32>>,
    seg_a: Vec<u32>,
    seg_b: Vec<u32>,
}

#[derive(Deserialize)]
struct RawGraph {
    coords: Vec<f64>,
    ways: Vec<Vec<u32>>,
}

static GRAPH: OnceLock<Graph> = OnceLock::new();

fn graph() -> &'static Graph {
    GRAPH.get_or_init(|| {
        let raw: RawGraph = serde_json::from_str(include_str!("../../../data/railway.json"))
            .expect("server/data/railway.json is valid");
        build(raw)
    })
}

fn build(raw: RawGraph) -> Graph {
    let n = raw.coords.len() / 2;
    let mx = mx();
    let (mut xs, mut ys) = (Vec::with_capacity(n), Vec::with_capacity(n));
    for i in 0..n {
        ys.push(raw.coords[2 * i] * MY);
        xs.push(raw.coords[2 * i + 1] * mx);
    }
    let mut adj = vec![Vec::new(); n];
    let (mut seg_a, mut seg_b) = (Vec::new(), Vec::new());
    for w in &raw.ways {
        for p in w.windows(2) {
            let (a, b) = (p[0], p[1]);
            if a == b {
                continue;
            }
            adj[a as usize].push(b);
            adj[b as usize].push(a);
            seg_a.push(a);
            seg_b.push(b);
        }
    }
    let mut grid: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
    for s in 0..seg_a.len() {
        let (a, b) = (seg_a[s] as usize, seg_b[s] as usize);
        let cell = |v: f64| (v / CELL_M).floor() as i64;
        let (x0, x1) = (cell(xs[a].min(xs[b])), cell(xs[a].max(xs[b])));
        let (y0, y1) = (cell(ys[a].min(ys[b])), cell(ys[a].max(ys[b])));
        for cx in x0..=x1 {
            for cy in y0..=y1 {
                grid.entry((cx, cy)).or_default().push(s as u32);
            }
        }
    }
    Graph {
        xs,
        ys,
        adj,
        grid,
        seg_a,
        seg_b,
    }
}

impl Graph {
    fn dist(&self, a: u32, b: u32) -> f64 {
        let (a, b) = (a as usize, b as usize);
        metres(self.xs[a], self.ys[a], self.xs[b], self.ys[b])
    }

    /// Track points within SNAP_RADIUS_M of a position, nearest first (at most one per segment).
    fn candidates(&self, lat: f64, lon: f64) -> Vec<(Snap, f64)> {
        let (px, py) = (lon * mx(), lat * MY);
        let k = kx(py); // x distances in real metres near here
        let (cx, cy) = ((px / CELL_M).floor() as i64, (py / CELL_M).floor() as i64);
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for dx in -1..=1 {
            for dy in -1..=1 {
                for &s in self.grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    if !seen.insert(s) {
                        continue;
                    }
                    let (a, b) = (self.seg_a[s as usize], self.seg_b[s as usize]);
                    let (ax, ay) = (self.xs[a as usize], self.ys[a as usize]);
                    let (vx, vy) = (self.xs[b as usize] - ax, self.ys[b as usize] - ay);
                    let len2 = Some(k * k * vx * vx + vy * vy)
                        .filter(|l| *l > 0.0)
                        .unwrap_or(1.0);
                    let t = ((k * k * (px - ax) * vx + (py - ay) * vy) / len2).clamp(0.0, 1.0);
                    let (x, y) = (ax + t * vx, ay + t * vy);
                    let d = ((px - x) * k).hypot(py - y);
                    if d <= SNAP_RADIUS_M {
                        out.push((Snap { a, b, t, x, y }, d));
                    }
                }
            }
        }
        out.sort_by(|p, q| p.1.total_cmp(&q.1));
        out
    }

    /// Path along the tracks from `s` to `e`, or None if longer than `limit` metres.
    fn route(&self, s: &Snap, e: &Snap, limit: f64) -> Option<(f64, Vec<(f64, f64)>)> {
        let seg_len = |p: &Snap| self.dist(p.a, p.b);
        // same segment: straight along it
        if (s.a == e.a && s.b == e.b) || (s.a == e.b && s.b == e.a) {
            return Some((metres(s.x, s.y, e.x, e.y), vec![(s.x, s.y), (e.x, e.y)]));
        }
        let mut best: HashMap<u32, f64> = HashMap::new();
        let mut prev: HashMap<u32, Option<u32>> = HashMap::new();
        // min-heap on cost; f64 costs are non-negative, so their bit patterns order correctly
        let mut heap = BinaryHeap::new();
        let mut seed =
            |node: u32, c: f64, best: &mut HashMap<u32, f64>, heap: &mut BinaryHeap<_>| {
                if c < *best.get(&node).unwrap_or(&f64::INFINITY) {
                    best.insert(node, c);
                    prev.insert(node, None);
                    heap.push(Reverse((c.to_bits(), node)));
                }
            };
        seed(s.a, s.t * seg_len(s), &mut best, &mut heap);
        seed(s.b, (1.0 - s.t) * seg_len(s), &mut best, &mut heap);
        let end_cost: HashMap<u32, f64> =
            HashMap::from([(e.a, e.t * seg_len(e)), (e.b, (1.0 - e.t) * seg_len(e))]);

        let (mut found, mut found_cost) = (None, f64::INFINITY);
        while let Some(Reverse((bits, u))) = heap.pop() {
            let c = f64::from_bits(bits);
            if c > *best.get(&u).unwrap_or(&f64::INFINITY) {
                continue;
            }
            if c > limit || c >= found_cost {
                break;
            }
            if let Some(ec) = end_cost.get(&u)
                && c + ec < found_cost
            {
                found = Some(u);
                found_cost = c + ec;
            }
            for &v in &self.adj[u as usize] {
                let nc = c + self.dist(u, v);
                if nc < *best.get(&v).unwrap_or(&f64::INFINITY) {
                    best.insert(v, nc);
                    prev.insert(v, Some(u));
                    heap.push(Reverse((nc.to_bits(), v)));
                }
            }
        }
        let found = found.filter(|_| found_cost <= limit)?;
        let mut nodes = vec![found];
        while let Some(Some(p)) = prev.get(nodes.last().unwrap()) {
            nodes.push(*p);
        }
        nodes.reverse();
        let mut pts = vec![(s.x, s.y)];
        pts.extend(
            nodes
                .iter()
                .map(|&u| (self.xs[u as usize], self.ys[u as usize])),
        );
        pts.push((e.x, e.y));
        Some((found_cost, pts))
    }
}

impl Graph {
    /// The track ahead of a train at `cur` heading `heading` (degrees, 0 = north): up to
    /// `limit` metres, taking the straightest way at every junction.
    fn ahead(&self, cur: &Snap, heading: f64, limit: f64) -> Vec<(f64, f64)> {
        let k = kx(cur.y);
        // directions in real metres (east, north)
        let dir = |x0: f64, y0: f64, x1: f64, y1: f64| ((x1 - x0) * k, y1 - y0);
        let mut d_in = (heading.to_radians().sin(), heading.to_radians().cos());
        let mut pts = vec![(cur.x, cur.y)];
        let node = |u: u32| (self.xs[u as usize], self.ys[u as usize]);
        // first node: the end of the current segment we're heading towards
        let (mut u, mut prev) = {
            let (a, b) = (node(cur.a), node(cur.b));
            let da = dir(cur.x, cur.y, a.0, a.1);
            let db = dir(cur.x, cur.y, b.0, b.1);
            let dot = |d: (f64, f64)| d.0 * d_in.0 + d.1 * d_in.1;
            if cur.t > 0.0 && cur.t < 1.0 {
                if dot(db) >= dot(da) {
                    (cur.b, Some(cur.a))
                } else {
                    (cur.a, Some(cur.b))
                }
            } else if cur.t >= 1.0 {
                (cur.b, None) // on a node: every way out is a candidate
            } else {
                (cur.a, None)
            }
        };
        let mut total = metres(cur.x, cur.y, node(u).0, node(u).1);
        if total > 0.5 {
            d_in = dir(cur.x, cur.y, node(u).0, node(u).1);
            pts.push(node(u));
        }
        let cos_max = MAX_TURN_DEG.to_radians().cos();
        while total < limit {
            let (ux, uy) = node(u);
            let len_in = d_in.0.hypot(d_in.1);
            let next = self.adj[u as usize]
                .iter()
                .filter(|&&v| Some(v) != prev)
                .map(|&v| {
                    let d = dir(ux, uy, node(v).0, node(v).1);
                    let cos = (d.0 * d_in.0 + d.1 * d_in.1) / (d.0.hypot(d.1) * len_in).max(1e-9);
                    (v, d, cos)
                })
                .max_by(|p, q| p.2.total_cmp(&q.2));
            let Some((v, d, _)) = next.filter(|n| n.2 >= cos_max) else {
                break;
            };
            total += d.0.hypot(d.1);
            pts.push(node(v));
            (prev, u, d_in) = (Some(u), v, d);
        }
        if pts.len() < 2 {
            vec![]
        } else {
            simplify(&pts, AHEAD_TOLERANCE_M / k.min(1.0))
        }
    }
}

/// Ramer–Douglas–Peucker: fewer points, none of the dropped ones further than `tol` off the
/// line (in projected units).
fn simplify(pts: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    fn off(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
        let (vx, vy) = (b.0 - a.0, b.1 - a.1);
        let len = vx.hypot(vy);
        if len == 0.0 {
            return (p.0 - a.0).hypot(p.1 - a.1);
        }
        ((p.0 - a.0) * vy - (p.1 - a.1) * vx).abs() / len
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0, pts.len() - 1)];
    while let Some((i, j)) = stack.pop() {
        let far = (i + 1..j)
            .map(|m| (m, off(pts[m], pts[i], pts[j])))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((m, d)) = far
            && d > tol
        {
            keep[m] = true;
            stack.push((i, m));
            stack.push((m, j));
        }
    }
    pts.iter()
        .zip(keep)
        .filter(|(_, k)| *k)
        .map(|(p, _)| *p)
        .collect()
}

fn to_lat_lon(x: f64, y: f64) -> LatLon {
    let r6 = |v: f64| (v * 1e6).round() / 1e6;
    [r6(y / MY), r6(x / mx())]
}

pub fn snap_lat_lon(s: &Snap) -> LatLon {
    to_lat_lon(s.x, s.y)
}

/// A fix placed on the tracks.
#[derive(Debug, Default)]
pub struct Placed {
    /// Where to draw the train (None if not near a track).
    pub snap: Option<Snap>,
    /// [lat, lon] points along the rails from the previous snapped point (None: move straight).
    pub path: Option<Vec<LatLon>>,
    /// [lat, lon] points along the track ahead, from the snapped point (None: not moving,
    /// or no track ahead).
    pub ahead: Option<Vec<LatLon>>,
}

/// Snap a new GPS fix onto the tracks and, given the previous snapped fix, find the path
/// along the rails between them and the track ahead. `bearing` is the train's reported
/// heading (degrees, 0 = north).
pub fn track_path(prev: Option<&Snap>, lat: f64, lon: f64, bearing: Option<f64>) -> Placed {
    let (snap, path) = snap_and_route(prev, lat, lon);
    let g = graph();
    // Direction of travel: the train's own bearing, else the route, if it moved far enough
    // that GPS jitter can't flip it (a few metres back and forth at a platform).
    let moved = |s: &Snap| {
        path.as_ref()?
            .iter()
            .rev()
            .find(|p| metres(p.0, p.1, s.x, s.y) >= 10.0)
            .map(|p| ((s.x - p.0) * kx(s.y)).atan2(s.y - p.1).to_degrees())
    };
    let ahead = snap
        .as_ref()
        .and_then(|s| Some((s, bearing.or_else(|| moved(s))?)))
        .map(|(s, heading)| g.ahead(s, heading, AHEAD_M))
        .filter(|a| !a.is_empty())
        .map(|a| a.into_iter().map(|(x, y)| to_lat_lon(x, y)).collect());
    let path = path.map(|pts| pts.into_iter().map(|(x, y)| to_lat_lon(x, y)).collect());
    Placed { snap, path, ahead }
}

fn snap_and_route(
    prev: Option<&Snap>,
    lat: f64,
    lon: f64,
) -> (Option<Snap>, Option<Vec<(f64, f64)>>) {
    let g = graph();
    let mut cands = g.candidates(lat, lon);
    cands.truncate(8);
    let Some(&(first, _)) = cands.first() else {
        return (None, None);
    };
    let Some(prev) = prev else {
        return (Some(first), None);
    };
    // Try each nearby track (e.g. both tracks of a double-track line) and keep the one
    // reachable by the shortest believable route from where the train was.
    let (mut best_snap, mut best_path, mut best_score) = (first, None, f64::INFINITY);
    for (c, d) in &cands {
        let straight = metres(c.x, c.y, prev.x, prev.y);
        let Some((cost, pts)) = g.route(prev, c, straight * 1.5 + 300.0) else {
            continue;
        };
        let score = cost + d * 2.0; // prefer short routes, then tracks closer to the GPS fix
        if score < best_score {
            best_score = score;
            best_snap = *c;
            best_path = Some(pts);
        }
    }
    (Some(best_snap), best_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A straight east–west track at 59.5° N with a branch, so routing has a choice.
    fn sample() -> Graph {
        let lon = |m: f64| 18.0 + m / mx();
        build(RawGraph {
            //            0: 0 m        1: 1000 m       2: 2000 m       3: branch north of node 1
            coords: vec![
                59.5,
                lon(0.0),
                59.5,
                lon(1000.0),
                59.5,
                lon(2000.0),
                59.5 + 500.0 / MY,
                lon(1000.0),
            ],
            ways: vec![vec![0, 1, 2], vec![1, 3]],
        })
    }

    #[test]
    fn snaps_and_routes_along_the_rails() {
        let g = sample();
        // 30 m north of the line, 200 m from its start
        let near = g.candidates(59.5 + 30.0 / MY, 18.0 + 200.0 / mx());
        let (s, d) = near[0];
        assert!((d - 30.0).abs() < 0.5, "{d}");
        assert_eq!((s.a, s.b), (0, 1));
        // far from any track: nothing
        assert!(g.candidates(60.0, 18.0).is_empty());
        // from 200 m to 1800 m: through node 1, ~1600 m
        let e = g.candidates(59.5, 18.0 + 1800.0 / mx())[0].0;
        let (cost, pts) = g.route(&s, &e, 5000.0).unwrap();
        assert!((cost - 1600.0).abs() < 1.0, "{cost}");
        assert_eq!(pts.len(), 3); // start, node 1, end
        // too far for the limit
        assert!(g.route(&s, &e, 1000.0).is_none());
    }

    #[test]
    fn track_ahead_goes_straight_on() {
        let g = sample();
        let cur = g.candidates(59.5, 18.0 + 500.0 / mx())[0].0;
        // eastbound at 500 m: straight through node 1 (not up the branch) to the end, 1500 m on
        let pts = g.ahead(&cur, 80.0, 5000.0);
        let last = pts.last().unwrap();
        assert!((last.0 - g.xs[2]).abs() < 1e-6 && (last.1 - g.ys[2]).abs() < 1e-6);
        // westbound: ends at node 0
        let pts = g.ahead(&cur, 260.0, 5000.0);
        assert!((pts.last().unwrap().0 - g.xs[0]).abs() < 1e-6);
        // limited, and a straight line is two points
        let pts = g.ahead(&cur, 90.0, 300.0);
        assert!(pts.len() == 2, "{pts:?}");
        // heading north from node 1 takes the branch
        let at1 = g.candidates(59.5, 18.0 + 1000.0 / mx())[0].0;
        let pts = g.ahead(&at1, 10.0, 5000.0);
        assert!((pts.last().unwrap().1 - g.ys[3]).abs() < 1e-6, "{pts:?}");
    }

    #[test]
    fn distances_shrink_going_north() {
        // 0.01° of longitude: ~564 m at 59.5° N, ~435 m at 67° N
        let x = 0.01 * mx();
        assert!((metres(0.0, 59.5 * MY, x, 59.5 * MY) - 564.6).abs() < 1.0);
        assert!((metres(0.0, 67.0 * MY, x, 67.0 * MY) - 435.0).abs() < 1.0);
    }

    #[test]
    fn real_graph_loads() {
        // Stockholm Central is on the tracks
        let placed = track_path(None, 59.3303, 18.0575, None);
        assert!(placed.snap.is_some());
        assert!(placed.path.is_none() && placed.ahead.is_none());
        // with a bearing there's track ahead, even from the first fix
        assert!(
            track_path(None, 59.3303, 18.0575, Some(0.0))
                .ahead
                .is_some()
        );
        // all of Sweden: Malmö C, Göteborg C, Kiruna
        for (lat, lon) in [(55.6090, 13.0007), (57.7089, 11.9732), (67.83474, 20.1395)] {
            assert!(
                track_path(None, lat, lon, None).snap.is_some(),
                "{lat},{lon}"
            );
        }
    }
}
