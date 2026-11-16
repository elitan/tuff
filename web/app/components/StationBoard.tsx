import { useEffect, useState } from "react";
import { api, type Board, type BoardRow } from "northstack";
import BrandBadge from "./BrandBadge";

const REFRESH_MS = 30_000;

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
const minutesUntil = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 60_000);

type Props = {
  sig: string;
  liveTrains: Set<string>;            // trains currently on the map (clickable)
  onFollow: (train: string) => void;
  onClose: () => void;
};

export default function StationBoard({ sig, liveTrains, onFollow, onClose }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"departures" | "arrivals">("departures");
  const [, setNow] = useState(0);     // re-render every 15 s for countdowns

  useEffect(() => {
    let alive = true;
    setBoard(null);
    setError(null);
    // polled while open; an error shows inside the board, not over the whole map
    const load = () =>
      api.trains.board.call({ sig })
        .then(d => { if (alive) { setBoard(d); setError(null); } })
        .catch(e => alive && setError(String(e)));
    load();
    const t = setInterval(load, REFRESH_MS);
    const c = setInterval(() => setNow(n => n + 1), 15_000);
    return () => { alive = false; clearInterval(t); clearInterval(c); };
  }, [sig]);

  const rows = board?.[tab] ?? [];

  return (
    <section className="board glass" aria-label="Stationstavla">
      <header className="board-head">
        <div className="board-title">
          <div>
            <div className="eyebrow">Station</div>
            <h2>{board?.station.name ?? " "}</h2>
          </div>
          <button className="icon-btn" aria-label="Stäng" onClick={onClose}>
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
          </button>
        </div>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === "departures"} onClick={() => setTab("departures")}>Avgångar</button>
          <button role="tab" aria-selected={tab === "arrivals"} onClick={() => setTab("arrivals")}>Ankomster</button>
        </div>
      </header>

      <ul className="board-rows">
        {!board && !error && Array.from({ length: 6 }, (_, i) => <li key={i} className="brow skeleton" />)}
        {error && <li className="empty">Kunde inte hämta tavlan</li>}
        {board && !rows.length && <li className="empty">Inga {tab === "departures" ? "avgångar" : "ankomster"} de närmaste timmarna</li>}
        {rows.map(r => (
          <Row key={r.id} r={r} dep={tab === "departures"} live={liveTrains.has(r.train)} onFollow={onFollow} />
        ))}
      </ul>
    </section>
  );
}

function Row({ r, dep, live, onFollow }: { r: BoardRow; dep: boolean; live: boolean; onFollow: (t: string) => void }) {
  const late = r.estimated && Date.parse(r.estimated) - Date.parse(r.time) >= 60_000;
  const done = !!r.actual;
  const expected = r.actual ?? r.estimated ?? r.time;
  const mins = minutesUntil(expected);

  let status: string | null = null;
  if (r.canceled) status = "Inställt";
  else if (done) status = `${dep ? "Avgick" : "Ankom"} ${hhmm(r.actual!)}`;
  else if (mins <= 0) status = "Nu";
  else if (mins < 20) status = `om ${mins} min`;

  return (
    <li>
      <button
        className={`brow${done ? " done" : ""}${r.canceled ? " canceled" : ""}${live ? " live" : ""}`}
        disabled={!live}
        onClick={() => onFollow(r.train)}
        title={live ? "Följ tåget på kartan" : undefined}
      >
        <span className="btime mono">
          <b className={late || r.canceled ? "struck" : ""}>{hhmm(r.time)}</b>
          {late && !r.canceled && <em>{hhmm(r.estimated!)}</em>}
        </span>
        <span className="bmain">
          <b>{r.place}</b>
          {r.via.length > 0 && <small className="via">via {r.via.join(", ")}</small>}
          <small className="meta">
            <BrandBadge product={r.product} size="sm" />
            {live && <i className="livedot" />}
            {r.bus ? "Buss · " : ""}{r.product} {r.train}
            {status && <> · <span className={r.canceled ? "bad" : late ? "warn" : ""}>{status}</span></>}
          </small>
          {r.notes.length > 0 && (
            <span className="notes">{r.notes.map(n => <span key={n} className="note">{n}</span>)}</span>
          )}
        </span>
        <span className="btrack">
          <small>Spår</small>
          <b className="mono">{r.track ?? "–"}</b>
        </span>
      </button>
    </li>
  );
}
