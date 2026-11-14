import "server-only";

const API_URL = "https://api.trafikinfo.trafikverket.se/v2/data.json";

export type TrainInfo = {
  from: string;
  to: string;
  product: string;   // e.g. "SJ Snabbtåg", "SL Pendeltåg", "Mälartåg"
  owner: string;     // InformationOwner, e.g. "SJ", "Mälardalstrafik AB"
};

export type Station = { sig: string; name: string; lat: number; lon: number };

export type BoardRow = {
  id: string;
  train: string;           // advertised train number
  product: string;
  time: string;            // advertised (timetable) time, ISO
  estimated: string | null;// new expected time when late
  actual: string | null;   // when it actually departed/arrived
  track: string | null;
  canceled: boolean;
  place: string;           // destination (departures) or origin (arrivals)
  via: string[];
  notes: string[];         // deviations, e.g. "Spårändrat", "Inställt", "Ersättningsbuss"
  bus: boolean;            // replacement bus rather than a train
};

export type Board = { station: Station; departures: BoardRow[]; arrivals: BoardRow[] };

/** Slimmed-down position sent to the browser. */
export type Position = {
  n: string;            // advertised train number
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null; // km/h
  ts: number;           // ms since epoch
  path?: [number, number][]; // route along the rails from the previous fix ([lat, lon][])
};

type RawPosition = {
  Train: { AdvertisedTrainNumber: string };
  Position: { WGS84: string };
  Bearing?: number;
  Speed?: number;
  TimeStamp: string;
  Deleted?: boolean;
};

type Loc = { LocationName: string; Order?: number }[] | undefined;

function apiKey() {
  const key = process.env.TRAFIKVERKET_API_KEY;
  if (!key) throw new Error("TRAFIKVERKET_API_KEY is not set (see .env.example)");
  return key;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function query(xml: string): Promise<any[]> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: `<REQUEST><LOGIN authenticationkey="${apiKey()}"/>${xml}</REQUEST>`,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Trafikverket HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).RESPONSE.RESULT;
}

/** Cache an async loader for `ttl` ms; concurrent callers share one in-flight request. */
function cached<T>(ttl: number, load: () => Promise<T>) {
  let value: { at: number; data: T } | null = null;
  let inflight: Promise<T> | null = null;
  return async (): Promise<T> => {
    if (value && Date.now() - value.at < ttl) return value.data;
    inflight ??= load()
      .then(data => { value = { at: Date.now(), data }; return data; })
      .finally(() => { inflight = null; });
    // serve stale data while refreshing, if we have any
    return value ? value.data : inflight;
  };
}

const point = (wkt?: string) => {
  const m = wkt?.match(/[-\d.]+/g);
  return m ? { lon: Number(m[0]), lat: Number(m[1]) } : null;
};

// ---------- stations (rarely change: cache 24h) ----------

const loadStations = cached(24 * 3600_000, async () => {
  const [res] = await query(`<QUERY objecttype="TrainStation" namespace="rail.infrastructure" schemaversion="1.5">
    <INCLUDE>LocationSignature</INCLUDE><INCLUDE>AdvertisedShortLocationName</INCLUDE>
    <INCLUDE>AdvertisedLocationName</INCLUDE><INCLUDE>Advertised</INCLUDE><INCLUDE>Geometry.WGS84</INCLUDE></QUERY>`);
  const names = new Map<string, string>();
  const list: Station[] = [];
  for (const s of res.TrainStation) {
    names.set(s.LocationSignature, s.AdvertisedShortLocationName ?? s.AdvertisedLocationName ?? s.LocationSignature);
    const p = point(s.Geometry?.WGS84);
    if (s.Advertised && p) {
      list.push({ sig: s.LocationSignature, name: s.AdvertisedLocationName ?? s.AdvertisedShortLocationName, ...p });
    }
  }
  return { names, list };
});

/** Passenger stations with coordinates (for the map). */
export async function getStations(): Promise<Station[]> {
  return (await loadStations()).list;
}

// ---------- all advertised trains running now (cache 5 min) ----------

export const getTrains = cached(5 * 60_000, async (): Promise<Record<string, TrainInfo>> => {
  const [{ names }, [res]] = await Promise.all([
    loadStations(),
    query(`<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="200000">
      <FILTER><EQ name="Advertised" value="true"/>
        <GT name="AdvertisedTimeAtLocation" value="$dateadd(-0.02:00:00)"/>
        <LT name="AdvertisedTimeAtLocation" value="$dateadd(0.01:00:00)"/></FILTER>
      <INCLUDE>AdvertisedTrainIdent</INCLUDE><INCLUDE>ToLocation</INCLUDE><INCLUDE>FromLocation</INCLUDE>
      <INCLUDE>InformationOwner</INCLUDE><INCLUDE>ProductInformation</INCLUDE></QUERY>`),
  ]);
  const name = (l: Loc) => {
    const sig = l?.[0]?.LocationName;
    return sig ? names.get(sig) ?? sig : "?";
  };
  const data: Record<string, TrainInfo> = {};
  for (const a of res.TrainAnnouncement) {
    data[a.AdvertisedTrainIdent] ??= {
      from: name(a.FromLocation),
      to: name(a.ToLocation),
      product: a.ProductInformation?.[0]?.Description ?? a.InformationOwner ?? "Tåg",
      owner: a.InformationOwner ?? "",
    };
  }
  return data;
});

// ---------- station board ----------

export async function getBoard(sig: string): Promise<Board | null> {
  const [{ names, list }, [res]] = await Promise.all([
    loadStations(),
    query(`<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" orderby="AdvertisedTimeAtLocation" limit="400">
      <FILTER><EQ name="LocationSignature" value="${sig.replace(/[^\wåäöÅÄÖ ]/g, "")}"/><EQ name="Advertised" value="true"/>
        <GT name="AdvertisedTimeAtLocation" value="$dateadd(-0.00:30:00)"/>
        <LT name="AdvertisedTimeAtLocation" value="$dateadd(0.06:00:00)"/></FILTER>
      <INCLUDE>ActivityId</INCLUDE><INCLUDE>ActivityType</INCLUDE><INCLUDE>AdvertisedTrainIdent</INCLUDE>
      <INCLUDE>AdvertisedTimeAtLocation</INCLUDE><INCLUDE>EstimatedTimeAtLocation</INCLUDE><INCLUDE>TimeAtLocation</INCLUDE>
      <INCLUDE>TrackAtLocation</INCLUDE><INCLUDE>Canceled</INCLUDE><INCLUDE>Deviation</INCLUDE>
      <INCLUDE>ToLocation</INCLUDE><INCLUDE>FromLocation</INCLUDE><INCLUDE>ViaToLocation</INCLUDE><INCLUDE>ViaFromLocation</INCLUDE>
      <INCLUDE>ProductInformation</INCLUDE><INCLUDE>InformationOwner</INCLUDE><INCLUDE>TypeOfTraffic</INCLUDE></QUERY>`),
  ]);
  const station = list.find(s => s.sig === sig);
  if (!station) return null;

  const nm = (s: string) => names.get(s) ?? s;
  const ordered = (l: Loc) => [...(l ?? [])].sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0)).map(x => nm(x.LocationName));
  const recent = Date.now() - 3 * 60_000;   // keep trains that left in the last few minutes, greyed out

  const departures: BoardRow[] = [], arrivals: BoardRow[] = [];
  for (const a of res.TrainAnnouncement) {
    const dep = a.ActivityType === "Avgang";
    if (a.TimeAtLocation && Date.parse(a.TimeAtLocation) < recent) continue;
    // no report at all long after its time (typically replacement buses): it's gone
    if (!a.TimeAtLocation && Date.parse(a.EstimatedTimeAtLocation ?? a.AdvertisedTimeAtLocation) < Date.now() - 10 * 60_000) continue;
    const row: BoardRow = {
      id: a.ActivityId,
      train: a.AdvertisedTrainIdent,
      product: a.ProductInformation?.[0]?.Description ?? a.InformationOwner ?? "",
      time: a.AdvertisedTimeAtLocation,
      estimated: a.EstimatedTimeAtLocation ?? null,
      actual: a.TimeAtLocation ?? null,
      track: a.TrackAtLocation && a.TrackAtLocation !== "x" ? a.TrackAtLocation : null,
      canceled: !!a.Canceled,
      place: (dep ? ordered(a.ToLocation) : ordered(a.FromLocation)).join(", ") || "?",
      via: (dep ? ordered(a.ViaToLocation) : ordered(a.ViaFromLocation)).slice(0, 3),
      notes: (a.Deviation ?? []).map((d: { Description: string }) => d.Description),
      bus: (a.TypeOfTraffic ?? []).some((t: { Description: string }) => /buss/i.test(t.Description)),
    };
    (dep ? departures : arrivals).push(row);
  }
  return { station, departures: departures.slice(0, 60), arrivals: arrivals.slice(0, 60) };
}

// ---------- positions ----------

export function slim(p: RawPosition): Position | null {
  if (p.Deleted || !p.Train?.AdvertisedTrainNumber) return null;
  const pt = point(p.Position?.WGS84);
  if (!pt) return null;
  return {
    n: p.Train.AdvertisedTrainNumber,
    lat: pt.lat, lon: pt.lon,
    bearing: p.Bearing ?? null,
    speed: p.Speed ?? null,
    ts: Date.parse(p.TimeStamp),
  };
}

/** Positions of every train in the last 10 min plus a server-sent-events URL for live updates. */
export async function getPositionStream() {
  const [res] = await query(`<QUERY objecttype="TrainPosition" namespace="järnväg.trafikinfo" schemaversion="1.1" sseurl="true">
    <FILTER><GT name="TimeStamp" value="${new Date(Date.now() - 10 * 60_000).toISOString()}"/></FILTER></QUERY>`);
  // ($dateadd isn't allowed together with sseurl, so use an absolute time)
  const snapshot = (res.TrainPosition as RawPosition[]).map(slim).filter((p): p is Position => !!p);
  return { snapshot, sseUrl: res.INFO.SSEURL as string };
}

export type { RawPosition };
