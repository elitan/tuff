//! Learned speeds along the tracks, and grading of position guesses.
//!
//! Every pair of consecutive snapped fixes says how fast a train moved along a known route.
//! That speed is added to each ~200 m cell of track the route crosses (per direction and
//! product), so over time we learn how fast trains run where: slow into stations, fast on
//! open line. The same fixes grade ways of guessing where a silent train is now: from a fix
//! 30 or 60 s back, how far along the route would each method have put it, versus where the
//! train really was. The totals (`prediction_errors`) show when learned speeds pay off.

use std::collections::{HashMap, HashSet, VecDeque};

use super::railway::LatLon;

const CELL_M: f64 = 200.0;
/// Route points are sampled this often when learning and when walking a prediction.
const STEP_M: f64 = 50.0;
/// Slower than this (m/s) counts as standing still.
const STOPPED: f64 = 0.5;
/// A cell's learned speed is used once it has this many samples.
const MIN_SAMPLES: i64 = 5;
/// Steps between fixes outside this range (s) aren't learned from.
const LEARN_DT: (f64, f64) = (2.0, 60.0);
/// Faster than this (m/s, 360 km/h) is a bad route, not a train.
const MAX_V: f64 = 100.0;
/// A gap longer than this (ms) starts the train's history over.
const RESET_MS: i64 = 10 * 60_000;
pub const HORIZONS_S: [i64; 2] = [30, 60];
/// Grade from a fix within this much (ms) past the horizon.
const HORIZON_SLACK_MS: i64 = 15_000;

/// (cell x, cell y, direction sector, product)
pub type Key = (i64, i64, u8, String);

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Stat {
    pub n: i64,
    pub sum_v: f64,
    pub sum_v2: f64,
    pub n_stopped: i64,
}

impl Stat {
    pub fn sample(v: f64) -> Stat {
        Stat {
            n: 1,
            sum_v: v,
            sum_v2: v * v,
            n_stopped: (v < STOPPED) as i64,
        }
    }
    fn add(&mut self, o: &Stat) {
        self.n += o.n;
        self.sum_v += o.sum_v;
        self.sum_v2 += o.sum_v2;
        self.n_stopped += o.n_stopped;
    }
    fn mean(&self) -> Option<f64> {
        (self.n >= MIN_SAMPLES).then(|| self.sum_v / self.n as f64)
    }
}

/// One fix as the follower stored it.
pub struct Observed<'a> {
    pub train: &'a str,
    pub product: &'a str,
    pub ts: i64,
    pub at: LatLon,
    /// Degrees, 0 = north.
    pub bearing: Option<f64>,
    /// km/h, as reported.
    pub speed: Option<f64>,
    /// Route along the rails from the previous fix (None: not snapped, or no route).
    pub path: Option<&'a [LatLon]>,
    /// First time this fix is stored (overlapping followers see each fix twice).
    pub new: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Grade {
    pub method: &'static str,
    pub horizon_s: i64,
    pub error_m: f64,
}

struct Entry {
    ts: i64,
    /// Metres along the train's route.
    d: f64,
    /// m/s over the step that ended here.
    v: Option<f64>,
    /// Reported speed, m/s.
    reported: Option<f64>,
}

/// A train's recent route (points with metres along it) and fixes.
#[derive(Default)]
struct History {
    pts: Vec<(LatLon, f64)>,
    fixes: VecDeque<Entry>,
}

/// Learned speeds and each train's recent history, kept by one follower job.
#[derive(Default)]
pub struct Memory {
    pub stats: HashMap<Key, Stat>,
    history: HashMap<String, History>,
}

impl Memory {
    pub fn new(stats: HashMap<Key, Stat>) -> Memory {
        Memory {
            stats,
            history: HashMap::new(),
        }
    }

    /// Take in a fix. For a new one, returns the speed samples to store and the grades of
    /// guesses made from 30 and 60 s earlier.
    pub fn observe(&mut self, o: &Observed) -> (Vec<(Key, Stat)>, Vec<Grade>) {
        let reported = o.speed.map(|kmh| kmh / 3.6);
        let h = self.history.entry(o.train.to_string()).or_default();
        let last = h.fixes.back();
        let path = o.path.filter(|p| p.len() >= 2);
        let (Some(last), Some(path)) = (last, path) else {
            return (self.restart(o, reported), vec![]);
        };
        if o.ts <= last.ts || o.ts - last.ts > RESET_MS {
            return (self.restart(o, reported), vec![]);
        }
        let (last_ts, last_d) = (last.ts, last.d);
        let mut d = h.pts.last().map_or(0.0, |p| p.1);
        let start = d;
        for w in path.windows(2) {
            d += metres(w[0], w[1]);
            h.pts.push((w[1], d));
        }
        let step = d - last_d;
        let dt = (o.ts - last_ts) as f64 / 1000.0;
        let v = step / dt;
        h.fixes.push_back(Entry {
            ts: o.ts,
            d,
            v: Some(v).filter(|v| *v <= MAX_V),
            reported,
        });

        let (mut learned, mut grades) = (vec![], vec![]);
        if o.new {
            grades = self.grade(o.train, o.product);
            if (LEARN_DT.0..=LEARN_DT.1).contains(&dt) && v <= MAX_V {
                learned = samples(path, start, v, o.bearing, o.at, o.product);
                for (k, s) in &learned {
                    self.stats.entry(k.clone()).or_default().add(s);
                }
            }
        }
        self.trim(o.train, o.ts);
        (learned, grades)
    }

    /// The train's history starts over at this fix (first fix, gap, or no route).
    fn restart(&mut self, o: &Observed, reported: Option<f64>) -> Vec<(Key, Stat)> {
        let h = self.history.get_mut(o.train).expect("entry exists");
        h.pts = vec![(o.at, 0.0)];
        h.fixes = VecDeque::from([Entry {
            ts: o.ts,
            d: 0.0,
            v: None,
            reported,
        }]);
        vec![]
    }

    /// Grade guesses made from earlier fixes against the train's newest fix.
    fn grade(&self, train: &str, product: &str) -> Vec<Grade> {
        let h = &self.history[train];
        let now = h.fixes.back().expect("just pushed");
        let mut out = vec![];
        for horizon_s in HORIZONS_S {
            let target = now.ts - horizon_s * 1000;
            let Some(from) = h.fixes.iter().rev().find(|e| e.ts <= target) else {
                continue;
            };
            let Some(v) = from.v.filter(|_| target - from.ts <= HORIZON_SLACK_MS) else {
                continue;
            };
            let secs = (now.ts - from.ts) as f64 / 1000.0;
            let actual = now.d - from.d;
            let learned_here = self.speed_at(&h.pts, from.d, product);
            let scale = match learned_here {
                Some(l) if l > 2.0 && v > 2.0 => (v / l).clamp(0.5, 1.5),
                _ => 1.0,
            };
            let guesses = [
                ("hold", 0.0),
                ("last_speed", v * secs),
                ("reported", from.reported.unwrap_or(v) * secs),
                ("learned", self.walk(&h.pts, from.d, secs, 1.0, v, product)),
                (
                    "learned_scaled",
                    self.walk(&h.pts, from.d, secs, scale, v, product),
                ),
            ];
            for (method, guess) in guesses {
                out.push(Grade {
                    method,
                    horizon_s,
                    error_m: (guess - actual).abs(),
                });
            }
        }
        out
    }

    /// Learned speed at `d` metres along the route.
    fn speed_at(&self, pts: &[(LatLon, f64)], d: f64, product: &str) -> Option<f64> {
        let (at, heading) = point_at(pts, d)?;
        self.lookup(at, heading, product)
    }

    fn lookup(&self, at: LatLon, heading: f64, product: &str) -> Option<f64> {
        let (cx, cy) = cell(at);
        let k = (cx, cy, sector(heading), product.to_string());
        self.stats.get(&k).and_then(Stat::mean)
    }

    /// How far a train gets in `secs` from `d` along the route at learned speeds (× `scale`),
    /// using `fallback` (m/s) where nothing is learned yet and past the end of the route.
    fn walk(
        &self,
        pts: &[(LatLon, f64)],
        d: f64,
        secs: f64,
        scale: f64,
        fallback: f64,
        product: &str,
    ) -> f64 {
        let end = pts.last().map_or(d, |p| p.1);
        let (mut pos, mut left, mut v) = (d, secs, fallback);
        while left > 0.0 && pos < end {
            v = point_at(pts, pos)
                .and_then(|(at, heading)| self.lookup(at, heading, product))
                .map_or(fallback, |l| l * scale)
                .max(1.0); // learned speeds near stations can be ~0: keep moving
            let step = STEP_M.min(end - pos);
            let t = step / v;
            if t > left {
                return pos + v * left - d;
            }
            pos += step;
            left -= t;
        }
        pos + v * left.max(0.0) - d
    }

    /// Keep about 90 s of fixes (enough for the longest horizon) and the route they cover.
    fn trim(&mut self, train: &str, now: i64) {
        let h = self.history.get_mut(train).expect("entry exists");
        let keep_from = now - (HORIZONS_S[1] * 1000 + HORIZON_SLACK_MS + 15_000);
        while h.fixes.len() > 2 && h.fixes[1].ts < keep_from {
            h.fixes.pop_front();
        }
        let first = h.fixes.front().map_or(0.0, |e| e.d);
        let n = h.pts.iter().take_while(|p| p.1 < first - 1.0).count();
        if n > 1 {
            h.pts.drain(..n - 1);
        }
    }
}

/// One speed sample for each cell the route crosses (`start` = metres at its first point).
fn samples(
    path: &[LatLon],
    start: f64,
    v: f64,
    bearing: Option<f64>,
    at: LatLon,
    product: &str,
) -> Vec<(Key, Stat)> {
    let pts: Vec<(LatLon, f64)> = std::iter::once((path[0], start))
        .chain(path.windows(2).scan(start, |d, w| {
            *d += metres(w[0], w[1]);
            Some((w[1], *d))
        }))
        .collect();
    let len = pts.last().map_or(0.0, |p| p.1) - start;
    let mut keys: HashSet<Key> = HashSet::new();
    if len < 5.0 {
        // standing (nearly) still: the route has no direction, the reported bearing does
        if let Some(b) = bearing {
            let (cx, cy) = cell(at);
            keys.insert((cx, cy, sector(b), product.to_string()));
        }
    } else {
        let mut s = 0.0;
        loop {
            if let Some((p, heading)) = point_at(&pts, start + s) {
                let (cx, cy) = cell(p);
                keys.insert((cx, cy, sector(heading), product.to_string()));
            }
            if s >= len {
                break;
            }
            s = (s + STEP_M).min(len);
        }
    }
    keys.into_iter().map(|k| (k, Stat::sample(v))).collect()
}

/// Point and heading (degrees, 0 = north) at `d` metres along a route.
fn point_at(pts: &[(LatLon, f64)], d: f64) -> Option<(LatLon, f64)> {
    if pts.len() < 2 {
        return None;
    }
    // first segment that ends at or past d, skipping zero-length ones for the heading
    let i = pts
        .windows(2)
        .position(|w| w[1].1 >= d && w[1].1 > w[0].1)
        .or_else(|| pts.windows(2).rposition(|w| w[1].1 > w[0].1))?;
    let ((a, da), (b, db)) = (pts[i], pts[i + 1]);
    let f = ((d - da) / (db - da)).clamp(0.0, 1.0);
    let p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    Some((p, heading(a, b)))
}

fn east_scale(lat: f64) -> f64 {
    111_320.0 * lat.to_radians().cos()
}

/// The 200 m grid cell a point is in.
pub fn cell(p: LatLon) -> (i64, i64) {
    let y = p[0] * 110_540.0;
    let x = p[1] * east_scale(p[0]);
    ((x / CELL_M).floor() as i64, (y / CELL_M).floor() as i64)
}

/// 45° sector of a heading: 0 = north, 2 = east, 4 = south, 6 = west.
pub fn sector(heading: f64) -> u8 {
    (((heading.rem_euclid(360.0) + 22.5) / 45.0) as u8) % 8
}

fn metres(a: LatLon, b: LatLon) -> f64 {
    let lat = (a[0] + b[0]) / 2.0;
    ((b[1] - a[1]) * east_scale(lat)).hypot((b[0] - a[0]) * 110_540.0)
}

fn heading(a: LatLon, b: LatLon) -> f64 {
    let lat = (a[0] + b[0]) / 2.0;
    ((b[1] - a[1]) * east_scale(lat))
        .atan2((b[0] - a[0]) * 110_540.0)
        .to_degrees()
        .rem_euclid(360.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A point `m` metres north of 59.5° N, 18° E.
    fn north(m: f64) -> LatLon {
        [59.5 + m / 110_540.0, 18.0]
    }

    fn fix<'a>(
        ts_s: i64,
        from: f64,
        to: f64,
        path: &'a mut Vec<LatLon>,
        new: bool,
    ) -> Observed<'a> {
        *path = vec![north(from), north((from + to) / 2.0), north(to)];
        Observed {
            train: "1",
            product: "P",
            ts: ts_s * 1000,
            at: north(to),
            bearing: Some(0.0),
            speed: Some(72.0), // 20 m/s
            path: Some(path),
            new,
        }
    }

    #[test]
    fn sectors_and_cells() {
        assert_eq!(sector(0.0), 0);
        assert_eq!(sector(350.0), 0);
        assert_eq!(sector(90.0), 2);
        assert_eq!(sector(-90.0), 6);
        assert_eq!(cell(north(0.0)).1 + 1, cell(north(200.0)).1);
        assert!((heading(north(0.0), north(10.0)) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn learns_speeds_and_grades_guesses() {
        let mut mem = Memory::default();
        let mut p = vec![];
        // first fix: nothing to learn from
        let first = Observed {
            path: None,
            ..fix(0, 0.0, 0.0, &mut p, true)
        };
        assert_eq!(mem.observe(&first), (vec![], vec![]));
        // a train at 20 m/s, a fix every 10 s for two minutes
        let mut grades = vec![];
        for i in 1..=12 {
            let (a, b) = ((i - 1) as f64 * 200.0, i as f64 * 200.0);
            let (learned, g) = mem.observe(&fix(i * 10, a, b, &mut p, true));
            // 200 m north: crosses a few cells, each sampled once at 20 m/s
            assert!(!learned.is_empty() && learned.len() <= 3, "{learned:?}");
            assert!(
                learned
                    .iter()
                    .all(|(k, s)| k.2 == 0 && (s.sum_v - 20.0).abs() < 0.1)
            );
            grades.extend(g);
        }
        // graded from 30 s and 60 s back once there was history; steady speed: only "hold" is off
        let at = |m: &str, h: i64| {
            grades
                .iter()
                .filter(|g| g.method == m && g.horizon_s == h)
                .map(|g| g.error_m)
                .collect::<Vec<_>>()
        };
        assert!(!at("hold", 60).is_empty());
        assert!(at("hold", 30).iter().all(|e| (e - 600.0).abs() < 1.0));
        for m in ["last_speed", "reported", "learned", "learned_scaled"] {
            assert!(at(m, 30).iter().all(|e| *e < 1.0), "{m}: {:?}", at(m, 30));
        }
        // a repeated fix (other follower stored it first) learns nothing
        let (learned, g) = mem.observe(&fix(130, 2400.0, 2600.0, &mut p, false));
        assert!(learned.is_empty() && g.is_empty());
    }

    #[test]
    fn walks_at_learned_speeds() {
        let mut mem = Memory::default();
        let pts: Vec<(LatLon, f64)> = (0..=10)
            .map(|i| (north(i as f64 * 100.0), i as f64 * 100.0))
            .collect();
        // learned: 10 m/s in the cells of the first 500 m
        for i in 0..=2 {
            let (cx, cy) = cell(north(i as f64 * 200.0 + 1.0));
            mem.stats.insert(
                (cx, cy, 0, "P".into()),
                Stat {
                    n: 10,
                    sum_v: 100.0,
                    sum_v2: 1000.0,
                    n_stopped: 0,
                },
            );
        }
        // 30 s from 0 m: inside the learned stretch, at 10 m/s
        let d = mem.walk(&pts, 0.0, 30.0, 1.0, 20.0, "P");
        assert!((d - 300.0).abs() < 1.0, "{d}");
        // twice as fast when scaled
        let d = mem.walk(&pts, 0.0, 15.0, 2.0, 20.0, "P");
        assert!((d - 300.0).abs() < 1.0, "{d}");
        // an unknown product walks at the fallback all the way, and past the route's end
        let d = mem.walk(&pts, 0.0, 60.0, 1.0, 20.0, "Q");
        assert!((d - 1200.0).abs() < 1.0, "{d}");
    }
}
