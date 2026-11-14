import "server-only";
import { snapToLatLon, trackPath, type Snap } from "./railway";
import type { Position } from "./trafikverket";

const FORGET_MS = 10 * 60_000; // older than this, don't route from the previous fix

type Last = { ts: number; snap: Snap | null; result: Position };

// Shared across all connections, so every client gets the same snapped result
// for the same GPS fix (and routing runs once per fix, not once per client).
const last = new Map<string, Last>();

/** Moves a position onto the nearest track and adds `path`: the route along the rails from the previous fix. */
export function onTrack(p: Position): Position {
  const prev = last.get(p.n);
  if (prev && p.ts === prev.ts) return prev.result;
  if (prev && p.ts < prev.ts) {                       // late/replayed fix: snap only
    const { snap } = trackPath(null, p.lat, p.lon);
    return snap ? { ...p, ...latLon(snap) } : p;
  }

  const from = prev && p.ts - prev.ts < FORGET_MS ? prev.snap : null;
  const { snap, path } = trackPath(from, p.lat, p.lon);
  const result: Position = snap ? { ...p, ...latLon(snap), ...(path ? { path } : {}) } : p;
  last.set(p.n, { ts: p.ts, snap, result });
  return result;
}

function latLon(s: Snap) {
  const [lat, lon] = snapToLatLon(s);
  return { lat, lon };
}
