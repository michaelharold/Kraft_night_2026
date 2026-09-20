/**
 * Sahaya landmark table (README §7, CONTRACTS §7).
 *
 * SMS-in requests (`HELP <text>`) carry no GPS. `matchLandmark(text)` looks for a
 * known place name in the text so dispatch can still run; when nothing matches the
 * request is created with `location: null` and flagged for the coordinator.
 *
 * COORDINATES ARE APPROXIMATE. Every entry below is placed from general knowledge of
 * Kollam, Kerala, around TKM College of Engineering (campus centre ≈ 8.913, 76.635).
 * They are demo-plausible (intended to be within ~1 km of the real place) and are NOT
 * survey-grade. Each entry is marked "approx." for that reason.
 *
 * Matching rules (CONTRACTS §7):
 *   - both the text and every alias are normalised: lowercase, apostrophes removed
 *     ("men's" → "mens"), all other punctuation replaced by spaces, whitespace collapsed;
 *   - an alias must appear as a whole word / phrase (`\b` boundaries), so "hostelry"
 *     does not match "hostel";
 *   - the LONGEST matching alias wins; ties go to the entry that appears first in the table.
 *
 * Comment-level test (kept here on purpose, mirrored in tests/landmarks.test.ts):
 *   matchLandmark("trapped near TKMCE hostel")  →  TKMCE men's hostel
 *   ("tkmce hostel" (12 chars) beats both "hostel" and "tkmce"; the ladies hostel has
 *   no alias that matches this text, and the campus gate's "tkmce" is shorter.)
 *
 * NOTE: `isLatLng` is intentionally NOT exported from here — it belongs to lib/validate.ts (M2).
 */
import type { LatLng } from "./types";

export type Landmark = { name: string; aliases: string[]; location: LatLng };

export type LandmarkMatch = { name: string; location: LatLng; alias: string };

// Order matters only for tie-breaking (first entry wins on equal alias length).
export const LANDMARKS: Landmark[] = [
  {
    // approx.
    name: "TKMCE main campus gate",
    aliases: [
      "tkmce",
      "tkm",
      "tkm college",
      "college",
      "campus",
      "college gate",
      "tkmce gate",
      "tkm gate",
      "tkmce main gate",
      "tkm main gate",
      "main gate",
      "tkmce campus",
      "tkm campus",
      "tkm college gate",
      "tkm college of engineering",
      "tkm engineering college",
      "thangal kunju musaliar college",
      "tkmce college",
    ],
    location: { lat: 8.9138, lng: 76.6335 },
  },
  {
    // approx.
    name: "TKMCE men's hostel",
    aliases: [
      "tkmce hostel",
      "hostel",
      "mens hostel",
      "men's hostel",
      "boys hostel",
      "tkm hostel",
      "tkmce mens hostel",
      "tkmce men's hostel",
      "tkmce boys hostel",
      "tkm mens hostel",
      "tkm men's hostel",
      "tkm boys hostel",
      "college hostel",
      "gents hostel",
      "hostel gate",
    ],
    location: { lat: 8.9152, lng: 76.6352 },
  },
  {
    // approx.
    name: "TKMCE ladies hostel",
    aliases: [
      "ladies hostel",
      "womens hostel",
      "women's hostel",
      "girls hostel",
      "tkmce ladies hostel",
      "tkm ladies hostel",
      "tkmce girls hostel",
      "tkm girls hostel",
      "tkmce womens hostel",
      "tkmce women's hostel",
    ],
    location: { lat: 8.9122, lng: 76.6318 },
  },
  {
    // approx.
    name: "Karicode",
    aliases: ["karicode", "karikode", "karicod", "karikkode", "karicode junction"],
    location: { lat: 8.9112, lng: 76.6292 },
  },
  {
    // approx.
    name: "Kilikollur",
    aliases: ["kilikollur", "kilikolloor", "kilikolur", "kilikollur junction", "kilikollur bridge"],
    location: { lat: 8.9028, lng: 76.6228 },
  },
  {
    // approx.
    name: "Kadappakada",
    aliases: ["kadappakada", "kadapakada", "kadappakkada", "kadappakada junction"],
    location: { lat: 8.8925, lng: 76.6012 },
  },
  {
    // approx.
    name: "Chinnakada",
    aliases: ["chinnakada", "chinnakkada", "chinakada", "chinnakada junction", "chinnakada clock tower", "clock tower"],
    location: { lat: 8.8872, lng: 76.5912 },
  },
  {
    // approx.
    name: "Kollam Junction railway station",
    aliases: [
      "kollam junction",
      "railway station",
      "kollam railway station",
      "kollam station",
      "kollam jn",
      "train station",
      "quilon junction",
      "kollam junction railway station",
    ],
    location: { lat: 8.8862, lng: 76.5992 },
  },
  {
    // approx.
    name: "Kollam KSRTC bus stand",
    aliases: [
      "ksrtc",
      "bus stand",
      "bus station",
      "ksrtc bus stand",
      "ksrtc stand",
      "kollam ksrtc",
      "kollam bus stand",
      "ksrtc bus station",
      "andamukkam",
    ],
    location: { lat: 8.8832, lng: 76.5882 },
  },
  {
    // approx.
    name: "Kollam beach",
    aliases: ["beach", "kollam beach", "mahatma gandhi beach", "gandhi beach", "kollam beach park", "beach road"],
    location: { lat: 8.8762, lng: 76.5862 },
  },
  {
    // approx.
    name: "Ashtamudi lake boat jetty",
    aliases: [
      "ashtamudi",
      "ashtamudi lake",
      "ashtamudy",
      "ashtamudi boat jetty",
      "boat jetty",
      "jetty",
      "kollam boat jetty",
      "lake",
      "link road jetty",
    ],
    location: { lat: 8.8898, lng: 76.5858 },
  },
  {
    // approx.
    name: "Kottiyam",
    aliases: ["kottiyam", "kottiam", "kottiyam junction"],
    location: { lat: 8.8632, lng: 76.6492 },
  },
  {
    // approx.
    name: "Kavanad",
    aliases: ["kavanad", "kavanadu", "kavanad junction"],
    location: { lat: 8.9142, lng: 76.5772 },
  },
  {
    // approx.
    name: "Sakthikulangara",
    aliases: ["sakthikulangara", "sakthikulangara harbour", "sakthikulangara harbor", "harbour", "harbor", "fishing harbour"],
    location: { lat: 8.9282, lng: 76.5492 },
  },
  {
    // approx.
    name: "Thangassery",
    aliases: ["thangassery", "thangasseri", "tangasseri", "thangassery lighthouse", "lighthouse"],
    location: { lat: 8.8802, lng: 76.5652 },
  },
  {
    // approx.
    name: "Thevally",
    aliases: ["thevally", "thevalli", "thevally palace"],
    location: { lat: 8.9002, lng: 76.5992 },
  },
  {
    // approx.
    name: "Asramam",
    aliases: ["asramam", "ashramam", "asramam maidan", "asramam ground", "asramam link road"],
    location: { lat: 8.8952, lng: 76.5932 },
  },
  {
    // approx.
    name: "Polayathode",
    aliases: ["polayathode", "polayathod", "polayathodu"],
    location: { lat: 8.8792, lng: 76.6052 },
  },
  {
    // approx.
    name: "Pallimukku",
    aliases: ["pallimukku", "pallimuku", "pallimukku junction"],
    location: { lat: 8.8832, lng: 76.6182 },
  },
  {
    // approx.
    name: "Mundakkal",
    aliases: ["mundakkal", "mundakal", "mundakkal beach"],
    location: { lat: 8.8762, lng: 76.6012 },
  },
  {
    // approx.
    name: "Anchalumoodu",
    aliases: ["anchalumoodu", "anchalummoodu", "anchalumood", "anchalumoodu junction"],
    location: { lat: 8.8992, lng: 76.6412 },
  },
];

/**
 * Normalise free text for matching: lowercase; drop apostrophes (straight and curly)
 * so "men's" becomes "mens"; turn every other non-alphanumeric character into a space;
 * collapse runs of whitespace; trim.
 */
export function normaliseLandmarkText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type CompiledAlias = { landmark: Landmark; alias: string; normalised: string; re: RegExp };

let compiled: CompiledAlias[] | null = null;

// Build the alias regexes once, preserving table order so ties resolve to the first entry.
function compileAliases(): CompiledAlias[] {
  if (compiled) return compiled;
  const out: CompiledAlias[] = [];
  for (const landmark of LANDMARKS) {
    for (const alias of landmark.aliases) {
      const normalised = normaliseLandmarkText(alias);
      if (!normalised) continue;
      // The normalised text only contains [a-z0-9 ], so \b is exactly "whole word / phrase".
      const re = new RegExp("\\b" + escapeRegExp(normalised) + "\\b");
      out.push({ landmark, alias, normalised, re });
    }
  }
  compiled = out;
  return out;
}

/**
 * Find the landmark mentioned in `text`, or null.
 *
 * Longest matching (normalised) alias wins; on equal length the entry that comes first in
 * LANDMARKS wins. `alias` in the result is the alias as written in the table.
 *
 *   matchLandmark("trapped near TKMCE hostel")?.name  === "TKMCE men's hostel"
 *   matchLandmark("HELP water in house at kadappakada")?.name === "Kadappakada"
 *   matchLandmark("college gate flooded")?.name === "TKMCE main campus gate"
 *   matchLandmark("nothing here") === null
 *   matchLandmark("hostelry") === null   // whole-word only
 */
export function matchLandmark(text: string): LandmarkMatch | null {
  if (typeof text !== "string") return null;
  const haystack = normaliseLandmarkText(text);
  if (!haystack) return null;

  let best: CompiledAlias | null = null;
  for (const c of compileAliases()) {
    // strictly longer replaces; equal length keeps the earlier (first-in-table) match
    if (best && c.normalised.length <= best.normalised.length) continue;
    if (c.re.test(haystack)) best = c;
  }
  if (!best) return null;
  return {
    name: best.landmark.name,
    location: { lat: best.landmark.location.lat, lng: best.landmark.location.lng },
    alias: best.alias,
  };
}
