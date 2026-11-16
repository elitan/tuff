// Downloads the railway network for Sweden (plus cross-border lines to Oslo, Copenhagen, Narvik)
// from OpenStreetMap (Overpass API) and writes a compact graph to server/data/railway.json.
//   node scripts/build-railway.mjs                 (download + build)
//   node scripts/build-railway.mjs a.json b.json   (build from existing Overpass JSON files)
// The area is fetched in chunks, because public Overpass servers refuse one query this big.
// Railway data © OpenStreetMap contributors, ODbL.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// south, west, north, east
const AREA = [55.0, 10.5, 69.2, 24.3];
const STEP = 1.5;   // degrees of latitude per chunk
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const SKIP_USAGE = new Set(["tourism", "industrial", "test", "military"]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchChunk(bbox) {
  const query = `[out:json][timeout:300];way["railway"="rail"]["service"!~"yard|spur"](${bbox});out geom;`;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "User-Agent": "tuff-train-map/0.1", "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
          signal: AbortSignal.timeout(360_000),
        });
        const text = await res.text();
        if (res.ok && text.trimStart().startsWith("{")) return JSON.parse(text).elements;
        console.log(`    ${new URL(url).host}: HTTP ${res.status}`);
      } catch (e) {
        console.log(`    ${new URL(url).host}: ${e.message}`);
      }
    }
    await sleep(15_000 * (attempt + 1));
  }
  throw new Error(`Chunk ${bbox} failed on every mirror – try again later`);
}

async function download() {
  const [s, w, n, e] = AREA;
  const ways = new Map();
  for (let lat = s; lat < n; lat += STEP) {
    const bbox = [lat, w, Math.min(n, lat + STEP), e].map(x => x.toFixed(2)).join(",");
    console.log(`Fetching ${bbox}`);
    for (const el of await fetchChunk(bbox)) if (el.type === "way") ways.set(el.id, el);
    console.log(`  ${ways.size} ways so far`);
  }
  return [...ways.values()];
}

const files = process.argv.slice(2);
const elements = files.length
  ? [...new Map(files.flatMap(f => JSON.parse(readFileSync(f, "utf8")).elements).map(w => [w.id, w])).values()]
  : await download();

const index = new Map(); // OSM node id -> our index
const coords = [];       // flat [lat, lon, lat, lon, ...]
const ways = [];
for (const w of elements) {
  if (w.type !== "way" || !w.geometry || SKIP_USAGE.has(w.tags?.usage)) continue;
  ways.push(w.nodes.map((id, i) => {
    if (!index.has(id)) {
      index.set(id, coords.length / 2);
      coords.push(+w.geometry[i].lat.toFixed(5), +w.geometry[i].lon.toFixed(5));
    }
    return index.get(id);
  }));
}

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(new URL("../server/data/railway.json", import.meta.url), JSON.stringify({ coords, ways }));
console.log(`Wrote server/data/railway.json: ${coords.length / 2} nodes, ${ways.length} ways`);
