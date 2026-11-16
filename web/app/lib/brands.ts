/**
 * Train companies/brands: a colour for the map and a short monogram for badges.
 * Colours are picked to be told apart on the map (light and dark), loosely inspired
 * by each brand – they are not official brand colours. Adjust freely.
 *
 * To use an official logo you have the rights to, put it in public/logos/<key>.svg
 * and set `logo: true` on the brand; the badge then shows the image instead of the monogram.
 */

export type Brand = {
  key: string;
  name: string;     // shown in filters and legends
  short: string;    // monogram on the badge
  color: string;
  logo?: boolean;
};

const BRANDS: (Brand & { match: RegExp })[] = [
  { key: "sj",          name: "SJ",              short: "SJ",  color: "#3f4a56", match: /^SJ\b/i },
  { key: "sl",          name: "SL Pendeltåg",    short: "SL",  color: "#e5489a", match: /^SL\b|pendeltåg$/i },
  { key: "pagatag",     name: "Pågatågen",       short: "PÅ",  color: "#8b3fb0", match: /pågatåg/i },
  { key: "vasttagen",   name: "Västtågen",       short: "VT",  color: "#1e6fd9", match: /västtåg|vasttrafik/i },
  { key: "malartag",    name: "Mälartåg",        short: "MT",  color: "#d93a3a", match: /mälartåg|mälardalstrafik/i },
  { key: "krosatag",    name: "Krösatågen",      short: "KT",  color: "#ef8a17", match: /krösatåg/i },
  { key: "oresundstag", name: "Öresundståg",     short: "ÖT",  color: "#0e8c8c", match: /öresundståg/i },
  { key: "norrtag",     name: "Norrtåg",         short: "NT",  color: "#3e9b4f", match: /norrtåg/i },
  { key: "tib",         name: "Tåg i Bergslagen",short: "TiB", color: "#c99a06", match: /^tib$|tåg i bergslagen/i },
  { key: "ostgota",     name: "Östgötapendeln",  short: "ÖG",  color: "#6d5bd0", match: /östgöta/i },
  { key: "upptaget",    name: "Upptåget",        short: "UL",  color: "#0098d8", match: /upptåg|^UL\b/i },
  { key: "arlanda",     name: "Arlanda Express", short: "AE",  color: "#e6b800", match: /arlanda express/i },
  { key: "xtaget",      name: "X-Tåget",         short: "X",   color: "#8c6d46", match: /x-tåg|x-trafik/i },
  { key: "vr",          name: "VR",              short: "VR",  color: "#5ba829", match: /^VR\b/i },
  { key: "vy",          name: "Vy",              short: "Vy",  color: "#0b7a55", match: /^vy\b/i },
  { key: "snalltaget",  name: "Snälltåget",      short: "SN",  color: "#b5179e", match: /snälltåg/i },
  { key: "tagab",       name: "Tågab",           short: "TÅ",  color: "#7c8a99", match: /tågab/i },
  { key: "museum",      name: "Museitåg",        short: "M",   color: "#a68a64", match: /museitåg|järnvägsmuseet/i },
];

const cache = new Map<string, Brand>();

/** Brand for a train, from its product name (e.g. "SJ Snabbtåg") and/or operator name. */
export function brandOf(product?: string, owner?: string): Brand {
  const id = `${product ?? ""}|${owner ?? ""}`;
  let b = cache.get(id);
  if (!b) {
    const hit = BRANDS.find(x => x.match.test(product ?? "")) ?? BRANDS.find(x => x.match.test(owner ?? ""));
    b = hit ? { key: hit.key, name: hit.name, short: hit.short, color: hit.color, logo: hit.logo }
            : fallback(product || owner || "Tåg");
    cache.set(id, b);
  }
  return b;
}

function fallback(name: string): Brand {
  const short = name.replace(/[^A-Za-zÅÄÖåäö ]/g, "").split(/\s+/).filter(Boolean)
    .map(w => w[0]).join("").slice(0, 2).toUpperCase() || "T";
  return { key: `other:${name}`, name, short, color: "#64748b" };
}

/** Readable text colour (white or near-black) on top of a brand colour. */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 ? "#14110a" : "#ffffff";
}
