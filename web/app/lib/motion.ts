/**
 * Smooth train motion by drawing each train where it most likely is *now*.
 *
 * Fixes arrive ~8 s after they were taken and, for some trains, 30+ s apart. So each
 * train's latest fix is moved forward at its speed along the track ahead (sent by the
 * server, straight on at junctions), for up to PREDICT_MAX_MS. The drawn position eases
 * towards that target and never moves backwards: if a train was guessed too far, it waits
 * for the real one to catch up.
 */

export type LatLon = [number, number];

// east–west metres per degree shrink going north: use the cosine at the pair's mid latitude
const cosLat = (a: LatLon, b: LatLon) => Math.cos(((a[0] + b[0]) * Math.PI) / 360);
export const metres = (a: LatLon, b: LatLon) =>
  Math.hypot((b[0] - a[0]) * 110_540, (b[1] - a[1]) * 111_320 * cosLat(a, b));
export const heading = (a: LatLon, b: LatLon) =>
  (Math.atan2((b[1] - a[1]) * cosLat(a, b), b[0] - a[0]) * 180) / Math.PI;

const PREDICT_MAX_MS = 90_000;  // stop guessing this long after the last fix
const EASE_MS = 1_200;          // how quickly the drawn train settles on its target
const SNAP_IF_BEHIND_M = 3_000; // further behind than this: jump instead of hurrying
const RESET_JUMP_M = 3_000;     // a straight-line jump this long means "start over here"
const MAX_V = 100;              // m/s; faster is a bad route, not a train

export class Track {
  private pts: LatLon[];
  private cum: number[];        // cumulative metres at each point (absolute, never rebased)
  private fixIdx: number;       // index in pts of the latest fix; after it comes the track ahead
  private lastD: number;        // metres at the latest fix
  private v = 0;                // m/s, to move on from the latest fix
  private shown: number;        // metres drawn
  lastFix: number;

  constructor(at: LatLon, ts: number, speed?: number | null, ahead?: LatLon[] | null) {
    this.pts = [at];
    this.cum = [0];
    this.fixIdx = 0;
    this.lastD = 0;
    this.shown = 0;
    this.lastFix = ts;
    this.v = speed != null ? speed / 3.6 : 0;
    this.extend(ahead);
  }

  /**
   * Add a fix. `path` is the route along the rails from the previous fix (first point ≈
   * previous fix), `ahead` the track ahead of this one, `speed` km/h as reported.
   */
  add(at: LatLon, ts: number, path?: LatLon[] | null, speed?: number | null, ahead?: LatLon[] | null) {
    if (ts <= this.lastFix) return;
    const drawn = this.pointAt(this.shown).at;
    // forget the old guess about the track ahead
    this.pts.length = this.fixIdx + 1;
    this.cum.length = this.fixIdx + 1;
    const last = this.pts[this.fixIdx];
    const prevD = this.lastD, prevTs = this.lastFix;
    if (!path?.length && metres(last, at) > RESET_JUMP_M) {
      // no route and a big jump (lost signal, wrong snap...): start a fresh track here
      this.pts = [at]; this.cum = [0]; this.shown = 0;
      this.fixIdx = 0; this.lastD = 0; this.lastFix = ts; this.v = speed != null ? speed / 3.6 : 0;
      this.extend(ahead);
      return;
    }
    for (const p of path?.length ? path.slice(1) : [at]) {
      const prev = this.pts[this.pts.length - 1];
      this.pts.push(p);
      this.cum.push(this.cum[this.cum.length - 1] + metres(prev, p));
    }
    this.fixIdx = this.pts.length - 1;
    this.lastD = this.cum[this.fixIdx];
    this.lastFix = ts;
    const dt = (ts - prevTs) / 1000;
    const measured = this.cum.length > 1 && dt > 0 && dt <= 60 ? (this.lastD - prevD) / dt : null;
    const v = speed != null ? speed / 3.6 : measured;
    this.v = v != null && v >= 0 && v <= MAX_V ? v : 0;
    this.extend(ahead);
    // The route may differ from the guess (another branch, or a wrong direction): carry on
    // from the spot on the new route nearest to where the train is drawn, not from the same
    // distance, which could now be somewhere else.
    this.shown = this.nearest(drawn);
  }

  /** Metres along the route of its point nearest to `p`. */
  private nearest(p: LatLon): number {
    const { pts, cum } = this;
    if (pts.length === 1) return cum[0];
    const k = 111_320 * Math.cos((p[0] * Math.PI) / 180);
    let best = Infinity, at = cum[0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const vx = (b[1] - a[1]) * k, vy = (b[0] - a[0]) * 110_540;
      const px = (p[1] - a[1]) * k, py = (p[0] - a[0]) * 110_540;
      const len2 = vx * vx + vy * vy;
      const f = len2 > 0 ? Math.max(0, Math.min(1, (px * vx + py * vy) / len2)) : 0;
      const d = Math.hypot(px - f * vx, py - f * vy);
      if (d < best) { best = d; at = cum[i - 1] + f * (cum[i] - cum[i - 1]); }
    }
    return at;
  }

  private extend(ahead?: LatLon[] | null) {
    for (const p of ahead?.slice(1) ?? []) {
      const prev = this.pts[this.pts.length - 1];
      this.pts.push(p);
      this.cum.push(this.cum[this.cum.length - 1] + metres(prev, p));
    }
  }

  /** Where the train most likely is now: the latest fix moved on at its speed. */
  private target(now: number) {
    const elapsed = Math.max(0, Math.min(PREDICT_MAX_MS, now - this.lastFix)) / 1000;
    const end = this.cum[this.cum.length - 1];
    return Math.min(end, this.lastD + this.v * elapsed);
  }

  /** Advance by `dt` ms of real time and return where to draw the train. */
  step(dt: number, now = Date.now()): { at: LatLon; dir: number | null } {
    const target = this.target(now);
    const gap = target - this.shown;
    if (gap > SNAP_IF_BEHIND_M || this.shown < this.cum[0]) this.shown = target;
    else if (gap > 0) this.shown += gap * Math.min(1, dt / EASE_MS);
    this.trim();
    return this.pointAt(this.shown);
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

  /** Drop points the drawn train has left behind. */
  private trim() {
    const keep = this.shown - 50;
    let n = 0;
    while (n < this.fixIdx - 1 && this.cum[n + 1] < keep) n++;
    if (n > 0) { this.pts.splice(0, n); this.cum.splice(0, n); this.fixIdx -= n; }
  }
}
