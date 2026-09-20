/**
 * 30 deterministic demo helpers around SEED_CENTER (docs/CONTRACTS.md §7). Self-contained so Node can run it
 * directly (`npm run seed`): only `node:` builtins and `import type`. Seeded helpers are deliberately weaker
 * than a real demo phone (reliability 0.5–0.65, lastSeen −15 min, never every flood/evacuation skill, none
 * within 150 m) so demo phones registered at the venue land in wave 1's top 3.
 */
import type { Helper, LanguageCode, LatLng, Skill, TrustTier, UserLocation } from "../lib/types";

const NAMES = ["Anjali Nair", "Faizal Rahman", "Reshma Pillai", "Sreekumar V", "Fathima Beevi", "Vishnu Prasad",
  "Divya Menon", "Joseph Thomas", "Nimmy George", "Rahul Krishnan", "Athira S", "Shaji Mathew", "Lekshmi Devi",
  "Anas Muhammed", "Meera Suresh", "Arjun Das", "Sneha Varghese", "Biju Kumar", "Ayesha Salim", "Gokul Raj",
  "Parvathy R", "Nikhil Jose", "Haritha K", "Sabu Abraham", "Jithin Lal", "Revathi Mohan", "Irfan Ali",
  "Sandra Babu", "Manoj Pillai", "Deepa Unni"];

// 30 skill sets: every skill ≥ 2×, doctor/nurse/swimmer/boat_owner ≥ 3×, nobody holds all of
// {boat_owner, swimmer, driver_4x4} or all of {swimmer, boat_owner, first_aid}.
// 30 demo providers for the community-services app: every service is offered by 2–4 people nearby.
// Trades only, and deliberately even: 5 providers per service across the 8 bookable trades, so no service on
// the home screen ever reads "1 nearby" in a demo. The medical skillsets that used to sit at 9, 10, 11, 18, 19,
// 25, 26 and 30 were reassigned when doctor/nurse/caregiver stopped being bookable (see lib/taxonomy.ts).
const SKILLSETS: Skill[][] = [
  ["plumber"], ["electrician"], ["carpenter"], ["ac_technician"], ["appliance_repair"], ["painter"], ["cleaner"], ["mechanic"],
  ["cleaner"], ["painter"], ["mechanic"], ["plumber", "electrician"], ["electrician", "appliance_repair"], ["ac_technician", "appliance_repair"],
  ["carpenter", "painter"], ["cleaner"], ["mechanic"], ["ac_technician"], ["cleaner", "painter"], ["plumber"],
  ["electrician"], ["carpenter"], ["painter", "cleaner"], ["ac_technician"], ["appliance_repair"], ["mechanic", "ac_technician"],
  ["plumber", "carpenter"], ["appliance_repair"], ["mechanic", "electrician"], ["plumber", "carpenter"],
];
/** Typical local rates (₹) per service: [min, max]. Each provider gets a slightly different range. */
const RATES: Partial<Record<Skill, [number, number]>> = {
  plumber: [300, 800], electrician: [300, 900], carpenter: [400, 1200], ac_technician: [500, 1500], appliance_repair: [400, 1200],
  painter: [800, 3000], cleaner: [400, 1500], mechanic: [300, 1000], doctor: [300, 800], nurse: [400, 1000], caregiver: [600, 1500],
};
/** Tool kits per service (duplicated from lib/taxonomy.ts SERVICE_TOOLS so this file stays self-contained). */
const KITS: Partial<Record<Skill, string[]>> = {
  plumber: ["pipe_wrench", "plunger", "pipe_sealant", "drain_snake", "power_drill", "screwdriver_set"],
  electrician: ["multimeter", "voltage_tester", "wire_stripper", "insulation_tape", "ladder", "screwdriver_set", "power_drill"],
  carpenter: ["power_drill", "saw", "hammer", "measuring_tape", "screwdriver_set", "sandpaper"],
  ac_technician: ["ac_gas_kit", "vacuum_pump", "multimeter", "ladder", "screwdriver_set"],
  appliance_repair: ["multimeter", "screwdriver_set", "voltage_tester", "spanner_set"],
  painter: ["paint_roller", "ladder", "sandpaper", "measuring_tape"],
  cleaner: ["vacuum_cleaner", "pressure_washer", "cleaning_kit"],
  mechanic: ["spanner_set", "tyre_inflator", "jumper_cables", "screwdriver_set"],
  doctor: ["stethoscope", "bp_monitor", "thermometer", "glucometer", "first_aid_kit"],
  nurse: ["bp_monitor", "thermometer", "glucometer", "first_aid_kit"],
  caregiver: ["thermometer", "bp_monitor", "first_aid_kit"],
};
/** Every third provider is missing one tool, so tool matching has something to discriminate on in the demo. */
/**
 * Languages across the 30 providers. Most of Kollam reads Malayalam, so the mix is weighted that way — but every
 * service has at least one provider who does NOT, which is the whole point: a demo where everyone shares a
 * language proves nothing. Deterministic by index so a rehearsed demo behaves the same way twice.
 */
const SEED_LANGUAGES: LanguageCode[] = ["ml-IN", "ml-IN", "ta-IN", "ml-IN", "hi-IN", "ml-IN", "ta-IN", "ml-IN",
  "en-IN", "ml-IN", "te-IN", "ml-IN", "ta-IN", "hi-IN", "ml-IN", "kn-IN", "ml-IN", "en-IN", "ml-IN", "ta-IN",
  "ml-IN", "hi-IN", "ta-IN", "te-IN", "ml-IN", "hi-IN", "ta-IN", "ml-IN", "kn-IN", "ml-IN"];

function seedTools(skills: Skill[], i: number): Helper["toolsOnHand"] {
  const all = [...new Set(skills.flatMap((s) => KITS[s] ?? []))];
  return (i % 3 === 2 ? all.slice(1) : all) as Helper["toolsOnHand"];
}

function seedRates(skills: Skill[], i: number): Partial<Record<Skill, { min: number; max: number }>> {
  const out: Partial<Record<Skill, { min: number; max: number }>> = {};
  for (const sk of skills) {
    const r = RATES[sk];
    if (!r) continue;
    const bump = ((i * 37) % 5) * 50; // deterministic variety
    out[sk] = { min: r[0] + bump, max: r[1] + bump * 2 };
  }
  return out;
}

/**
 * Trust tier of a seeded helper (docs/UPGRADE.md §3): doctor / nurse → Tier 3 first responder; electrician / plumber /
 * generator owner → Tier 2 certified pro; everyone else → Tier 1 neighbour. Literals, not lib/policy.ts, so this file
 * stays runnable on its own under Node's type stripping.
 */
export function seedTier(skills: Skill[]): TrustTier {
  if (skills.some((s) => s === "doctor" || s === "nurse")) return "TIER_3_FIRST_RESPONDER";
  if (skills.some((s) => s === "electrician" || s === "plumber" || s === "generator_owner")) return "TIER_2_CERTIFIED_PRO";
  return "TIER_1_NEIGHBOR";
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedHelpers(center: LatLng, now: Date): Helper[] {
  const rnd = mulberry32(20260919);
  const lastSeen = new Date(now.getTime() - 15 * 60_000).toISOString();
  return NAMES.map((name, i) => {
    const band = i % 3; // 0: 0.15–1 km, 1: 1–2 km, 2: 2–5 km — 10 each
    const [lo, hi] = band === 0 ? [0.15, 1] : band === 1 ? [1.001, 2] : [2.001, 5];
    const km = lo + rnd() * (hi - lo);
    const bearing = (i * 137.508 + rnd() * 20) * (Math.PI / 180);
    const dLat = (km / 111.32) * Math.cos(bearing);
    const dLng = (km / (111.32 * Math.cos((center.lat * Math.PI) / 180))) * Math.sin(bearing);
    const trustTier = seedTier(SKILLSETS[i]);
    return {
      id: `seed-helper-${String(i + 1).padStart(2, "0")}`,
      name,
      phone: `+9190000000${String(i + 1).padStart(2, "0")}`,
      skills: SKILLSETS[i],
      language: SEED_LANGUAGES[i],
      rates: seedRates(SKILLSETS[i], i),
      toolsOnHand: seedTools(SKILLSETS[i], i),
      location: { lat: +(center.lat + dLat).toFixed(6), lng: +(center.lng + dLng).toFixed(6) },
      onDuty: true,
      reliability: +(0.8 + rnd() * 0.18).toFixed(3), // 4.0–4.9 stars
      lastSeen,
      trustTier,
      credentialId: trustTier === "TIER_1_NEIGHBOR" ? null : `SEED-${String(i + 1).padStart(2, "0")}`, // demo licence number
      // 4 out of 5 demo providers are ID-verified (no document is stored for seeded people).
      idProof: i % 5 === 4 ? null : { fileId: null, fileName: "seed", mime: "", size: 0, uploadedAt: lastSeen, status: "verified" as const, reviewedBy: "seed", reviewedAt: lastSeen, note: null },
    };
  });
}

const FIRST = ["Aarav", "Diya", "Kiran", "Lakshmi", "Manu", "Neha", "Omana", "Pranav", "Rani", "Sajan", "Tessa", "Unni",
  "Varsha", "Abdul", "Bindu", "Chandran", "Devika", "Eldho", "Gayathri", "Hari"];
const LAST = ["Nair", "Pillai", "Kurian", "Menon", "Varghese", "Rahman", "Das", "Thomas", "Iyer", "Joseph"];

/** 60 synthetic residents who share their location, so a disaster zone has people to find in a demo. */
export function seedResidents(center: LatLng, now: Date): UserLocation[] {
  const rnd = mulberry32(424242);
  return Array.from({ length: 60 }, (_, i) => {
    const km = 0.1 + rnd() * 3.5, b = rnd() * 2 * Math.PI;
    const location = {
      lat: +(center.lat + (km / 111.32) * Math.cos(b)).toFixed(6),
      lng: +(center.lng + (km / (111.32 * Math.cos((center.lat * Math.PI) / 180))) * Math.sin(b)).toFixed(6),
    };
    const updatedAt = new Date(now.getTime() - Math.floor(rnd() * 20) * 60_000).toISOString();
    return {
      phone: `+9191100000${String(i + 1).padStart(2, "0")}`, name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
      helperId: null, location, accuracyM: Math.round(8 + rnd() * 40), source: "seed" as const, updatedAt,
      history: [{ ...location, at: updatedAt }],
    };
  });
}

async function main(): Promise<void> {
  const fs = await import("node:fs");
  const env: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.replace(/\s+#.*$/, "").match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env.local is fine */ }
  const lat = Number(env.SEED_CENTER_LAT), lng = Number(env.SEED_CENTER_LNG);
  const center = Number.isFinite(lat) && Number.isFinite(lng) && env.SEED_CENTER_LAT ? { lat, lng } : { lat: 8.913, lng: 76.635 };
  const base = process.env.RESQ_URL ?? "http://127.0.0.1:3000";
  const headers = { "content-type": "application/json", "x-ops-password": env.OPS_PASSWORD || "resq-ops" };
  let ok = 0;
  const tiers: Record<string, number> = {};
  try {
    for (const h of seedHelpers(center, new Date())) {
      // The whole record is posted, so trustTier + credentialId reach a server that booted before the upgrade.
      const r = await fetch(`${base}/api/helpers`, { method: "POST", headers, body: JSON.stringify({ ...h, verified: h.idProof?.status === "verified" }) });
      if (r.ok) { ok++; const t = h.trustTier ?? "TIER_1_NEIGHBOR"; tiers[t] = (tiers[t] ?? 0) + 1; }
      else console.error(`seed: ${h.id} → ${r.status} ${await r.text()}`);
    }
  } catch {
    console.log(`seed: server not reachable at ${base}; MemoryStore seeds itself at boot (SEED_ON_BOOT=1)`);
    return;
  }
  const warm = await fetch(`${base}/api/triage`).then((r) => r.json()).catch(() => null);
  console.log(`seed: ${ok}/30 helpers upserted around ${center.lat},${center.lng}; tiers: ${JSON.stringify(tiers)}; ollama warm-up: ${JSON.stringify(warm)}`);
}

if (/scripts[\\/]seed\.[tj]s$/.test(process.argv[1] ?? "")) void main();
