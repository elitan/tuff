//! Railway graph built from OpenStreetMap (`server/data/railway.json`, see
//! scripts/build-railway.mjs). Snaps GPS positions onto the nearest track and finds the
//! path along the tracks between two consecutive positions, so the browser can animate
//! trains along the rails. Built once, on first use.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const SNAP_RADIUS_M: f64 = 80.0; // GPS further than this from any track isn't snapped
const CELL_M: f64 = 250.0; // spatial grid cell size
const LAT0: f64 = 59.5; // projection origin (Mälardalen)
const MY: f64 = 110_540.0; // metres per degree latitude

/// Metres per degree longitude at LAT0.
fn mx() -> f64 {
    111_320.0 * (LAT0 * std::f64::consts::PI / 180.0).cos()
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
        (self.xs[a] - self.xs[b]).hypot(self.ys[a] - self.ys[b])
    }

    /// Track points within SNAP_RADIUS_M of a position, nearest first (at most one per segment).
    fn candidates(&self, lat: f64, lon: f64) -> Vec<(Snap, f64)> {
        let (px, py) = (lon * mx(), lat * MY);
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
                    let len2 = Some(vx * vx + vy * vy).filter(|l| *l > 0.0).unwrap_or(1.0);
                    let t = (((px - ax) * vx + (py - ay) * vy) / len2).clamp(0.0, 1.0);
                    let (x, y) = (ax + t * vx, ay + t * vy);
                    let d = (px - x).hypot(py - y);
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
            return Some(((s.x - e.x).hypot(s.y - e.y), vec![(s.x, s.y), (e.x, e.y)]));
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

fn to_lat_lon(x: f64, y: f64) -> LatLon {
    let r6 = |v: f64| (v * 1e6).round() / 1e6;
    [r6(y / MY), r6(x / mx())]
}

pub fn snap_lat_lon(s: &Snap) -> LatLon {
    to_lat_lon(s.x, s.y)
}

/// Snap a new GPS fix onto the tracks and, given the previous snapped fix, return the path
/// along the rails between them.
/// - snap: where to draw the train (None if not near a track)
/// - path: [lat, lon] points from the previous to the new snapped point (None → move straight)
pub fn track_path(prev: Option<&Snap>, lat: f64, lon: f64) -> (Option<Snap>, Option<Vec<LatLon>>) {
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
        let straight = (c.x - prev.x).hypot(c.y - prev.y);
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
    let path = best_path.map(|pts| pts.into_iter().map(|(x, y)| to_lat_lon(x, y)).collect());
    (Some(best_snap), path)
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
    fn real_graph_loads() {
        // Stockholm Central is on the tracks
        let (snap, path) = track_path(None, 59.3303, 18.0575);
        assert!(snap.is_some());
        assert!(path.is_none());
    }
}
