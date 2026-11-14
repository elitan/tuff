/**
 * Smooth train motion by "playing back" GPS fixes slightly in the past.
 *
 * Every fix is a keyframe (time → distance travelled along the rails). Instead of
 * restarting an animation whenever a fix arrives, each train has a playback clock
 * that runs a few seconds behind real time, so there is always a next keyframe to
 * move towards. Distance is interpolated with a monotone cubic, so speed changes
 * smoothly between fixes and the train never moves backwards.
 */

export type LatLon = [number, number];
type Key = { t: number; d: number };

const COS_LAT = Math.cos((59.5 * Math.PI) / 180);
export const metres = (a: LatLon, b: LatLon) =>
  Math.hypot((b[0] - a[0]) * 110_540, (b[1] - a[1]) * 111_320 * COS_LAT);
export const heading = (a: LatLon, b: LatLon) =>
  (Math.atan2((b[1] - a[1]) * COS_LAT, b[0] - a[0]) * 180) / Math.PI;

const DEFAULT_DELAY = 10_000;   // playback delay before we've measured anything
const MAX_DELAY = 30_000;
const DELAY_MARGIN = 2_500;
const CATCH_UP_MS = 4_000;      // how gently playback speeds up/slows down to its target
const JUMP_IF_BEHIND = 20_000;  // further behind than this: skip ahead instead of hurrying
const RESET_JUMP_M = 3_000;     // a straight-line jump this long means "start over here"

export class Track {
  private pts: LatLon[];
  private cum: number[];        // cumulative metres at each point (absolute, never rebased)
  private keys: Key[];
  private gaps: number[] = [];  // recent (arrival − previous fix time), to size the delay
  private clock: number;        // playback time, in the fixes' clock (ms)
  lastFix: number;

  constructor(at: LatLon, ts: number) {
    this.pts = [at];
    this.cum = [0];
    this.keys = [{ t: ts, d: 0 }];
    this.clock = ts;
    this.lastFix = ts;
  }

  /**
   * Add a fix. `path` is the route along the rails from the previous fix (first point ≈ previous fix).
   * `live` is false for fixes replayed on (re)connect, which say nothing about network delay.
   */
  add(at: LatLon, ts: number, path: LatLon[] | undefined, live: boolean, now = Date.now()) {
    if (ts <= this.lastFix) return;
    if (live) {
      this.gaps.push(now - this.lastFix);
      if (this.gaps.length > 6) this.gaps.shift();
    }
    const last = this.pts[this.pts.length - 1];
    if (!path?.length && metres(last, at) > RESET_JUMP_M) {
      // no route and a big jump (lost signal, wrong snap...): start a fresh track here
      this.pts = [at]; this.cum = [0]; this.keys = [{ t: ts, d: 0 }]; this.clock = ts;
    } else {
      for (const p of path?.length ? path.slice(1) : [at]) {
        const prev = this.pts[this.pts.length - 1];
        this.pts.push(p);
        this.cum.push(this.cum[this.cum.length - 1] + metres(prev, p));
      }
      this.keys.push({ t: ts, d: this.cum[this.cum.length - 1] });
    }
    this.lastFix = ts;
  }

  /** Delay that covers the longest recent wait for a new fix, so playback rarely runs dry. */
  private delay() {
    if (!this.gaps.length) return DEFAULT_DELAY;
    return Math.min(MAX_DELAY, Math.max(...this.gaps) + DELAY_MARGIN);
  }

  /** Advance playback by `dt` ms of real time and return where to draw the train. */
  step(dt: number, now = Date.now()): { at: LatLon; dir: number | null } {
    const target = now - this.delay();
    const first = this.keys[0].t, last = this.lastFix;
    if (target - this.clock > JUMP_IF_BEHIND) this.clock = target;
    // run slightly faster/slower than real time to drift towards the target delay
    const rate = 1 + Math.max(-0.25, Math.min(0.25, (target - this.clock) / CATCH_UP_MS));
    this.clock = Math.max(first, Math.min(last, this.clock + dt * rate));
    this.trim();
    return this.pointAt(this.distanceAt(this.clock));
  }

  /** Monotone cubic (Fritsch–Carlson) interpolation of distance over time. */
  private distanceAt(t: number): number {
    const k = this.keys;
    if (k.length === 1 || t <= k[0].t) return k[0].d;
    if (t >= k[k.length - 1].t) return k[k.length - 1].d;
    let i = 0;
    while (i < k.length - 2 && k[i + 1].t < t) i++;
    const a = k[i], b = k[i + 1];
    const h = b.t - a.t || 1;
    const delta = (b.d - a.d) / h;
    const slope = (j: number) => {          // tangent at key j
      const before = j > 0 ? (k[j].d - k[j - 1].d) / (k[j].t - k[j - 1].t || 1) : null;
      const after = j < k.length - 1 ? (k[j + 1].d - k[j].d) / (k[j + 1].t - k[j].t || 1) : null;
      if (before == null) return after!;
      if (after == null) return before;
      return before * after <= 0 ? 0 : (before + after) / 2;
    };
    let m0 = slope(i), m1 = slope(i + 1);
    if (delta === 0) { m0 = 0; m1 = 0; }
    else {
      const al = m0 / delta, be = m1 / delta, s = al * al + be * be;
      if (s > 9) { const tau = 3 / Math.sqrt(s); m0 = tau * al * delta; m1 = tau * be * delta; }
    }
    const x = (t - a.t) / h, x2 = x * x, x3 = x2 * x;
    const d = (2 * x3 - 3 * x2 + 1) * a.d + (x3 - 2 * x2 + x) * h * m0
            + (-2 * x3 + 3 * x2) * b.d + (x3 - x2) * h * m1;
    return Math.max(a.d, Math.min(b.d, d));
  }

  private pointAt(d: number): { at: LatLon; dir: number | null } {
    const { pts, cum } = this;
    if (pts.length === 1) return { at: pts[0], dir: null };
    let lo = 1, hi = cum.length - 1;              // first index with cum[i] >= d
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid + 1; else hi = mid; }
    const a = pts[lo - 1], b = pts[lo];
    const len = cum[lo] - cum[lo - 1];
    const f = len > 0 ? Math.max(0, Math.min(1, (d - cum[lo - 1]) / len)) : 1;
    return {
      at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
      dir: len > 2 ? heading(a, b) : null,
    };
  }

  /** Drop keyframes and points that playback has left behind. */
  private trim() {
    while (this.keys.length > 3 && this.keys[1].t < this.clock - 1000) this.keys.shift();
    const keep = this.keys[0].d - 50;
    let n = 0;
    while (n < this.cum.length - 2 && this.cum[n + 1] < keep) n++;
    if (n > 0) { this.pts.splice(0, n); this.cum.splice(0, n); }
  }
}
