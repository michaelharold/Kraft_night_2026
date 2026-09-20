/**
 * Sahaya triage — Ollama structured classification with a rules fallback
 * (README §4, §10 rule 2; CONTRACTS §6 `GET/POST /api/triage`, §7 `lib/triage.ts`).
 *
 * The model only CLASSIFIES (need type, urgency, skills, equipment, hidden scene hazard,
 * one-line summary). Everything the user is told to do comes from curated cards in
 * lib/guidance.ts, and every decision that matters for safety is made by explainable code
 * here or in lib/triage-rules.ts. `triage()` never throws and never hangs longer than
 * OLLAMA_TIMEOUT_MS (default 4 s): on any failure it returns `triageByRules(text)`.
 *
 * Hazard alerts (docs/UPGRADE.md §2, README §10 rule 9): the JSON schema makes the model fill
 * `hazardAlert { hasHazard, hazardKind }` and ONLY those two are ever read. The warning a
 * frightened person sees is `hazardAlertFor(kind)` from the curated table in lib/hazards.ts.
 * `hazardTitle` / `hazardAction` are NOT requested from the model: with them in the schema the
 * warm qwen2.5:3b answered the demo phrases in 3.0–3.9 s (110–136 output tokens at ~40 tok/s),
 * flush against the 4 s timeout, and the longer prompt made the need-type classification worse.
 * Without them: 47–67 tokens, 1.3–1.9 s. If the model ever sends those keys anyway (older
 * prompts, `format: "json"` fallback), `readModelHazard` ignores them. Keyword rules
 * (`detectHazardByRules`) run on every request and win over the model whenever they fire.
 *
 * All env vars (OLLAMA_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT_MS) are read at call time so
 * tests can point at a fake server.
 */
import {
  EQUIPMENT,
  NEED_TYPES,
  SKILLS,
  URGENCIES,
  TYPE_SKILLS,
  TYPE_LABELS,
  isEquipment,
  isNeedType,
  isSkill,
  isUrgency,
} from "./taxonomy";
import type { Equipment, HazardAlert, NeedType, Skill, TriageResult, Urgency } from "./types";
import { MAX_EQUIPMENT, detectEquipmentByRules, detectHazardByRules, triageByRules } from "./triage-rules";
import { HAZARD_KINDS, hazardAlertFor, isHazardKind } from "./hazards";
import type { HazardKind } from "./hazards";

export type OllamaTriageOutput = {
  type: NeedType;
  urgency: Urgency;
  skills: Skill[];
  summary: string;
  confidence: number;
  equipment: Equipment[]; // keyword rules ∪ valid model entries, max MAX_EQUIPMENT
  hazardAlert: HazardAlert; // curated text for the classified kind — never the model's words
};

/** Output budget: the compact JSON is 47–67 tokens for the demo phrases; 256 leaves room for a long summary. */
export const OLLAMA_NUM_PREDICT = 256;

// ---------------------------------------------------------------------------
// Env (read inside functions, never at module load)
// ---------------------------------------------------------------------------

function ollamaUrl(): string {
  const raw = process.env.OLLAMA_URL;
  const url = raw && raw.trim() ? raw.trim() : "http://127.0.0.1:11434";
  return url.replace(/\/+$/, "");
}

function ollamaModel(): string {
  const raw = process.env.OLLAMA_MODEL;
  return raw && raw.trim() ? raw.trim() : "qwen2.5:3b";
}

function ollamaTimeoutMs(): number {
  const n = Number(process.env.OLLAMA_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

// ---------------------------------------------------------------------------
// Guard + normalisation (README §4: hand-written, no schema libraries)
// ---------------------------------------------------------------------------

/**
 * Hard requirements only: an object whose `type` is a NeedType and whose `urgency`
 * is an Urgency. Everything else (skills, summary, confidence) is lenient and is
 * repaired by `normalizeTriageOutput` (CONTRACTS §7).
 */
export function isTriageOutput(x: unknown): x is { type: NeedType; urgency: Urgency } {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return isNeedType(o.type) && isUrgency(o.urgency);
}

/**
 * What survives of the model's `hazardAlert`: the classification, nothing else. Lenient —
 * anything that is not an object is "no hazard"; `hasHazard: true` with a missing, unknown or
 * "none" kind is "other" (the model saw a danger it could not name). `hazardTitle` and
 * `hazardAction` are deliberately NOT read: an LLM must not word safety instructions.
 */
export function readModelHazard(raw: unknown): { hasHazard: boolean; kind: HazardKind } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { hasHazard: false, kind: "none" };
  const o = raw as Record<string, unknown>;
  const hasHazard = o.hasHazard === true || (typeof o.hasHazard === "string" && o.hasHazard.trim().toLowerCase() === "true");
  if (!hasHazard) return { hasHazard: false, kind: "none" };
  const k = o.hazardKind !== undefined ? o.hazardKind : o.kind; // `format: "json"` fallback models sometimes shorten the key
  return { hasHazard: true, kind: isHazardKind(k) && k !== "none" ? k : "other" };
}

/** Rule equipment first (deterministic), then the model's valid entries; deduped, max MAX_EQUIPMENT. */
export function mergeEquipment(fromRules: Equipment[], fromModel: unknown): Equipment[] {
  const out: Equipment[] = [];
  for (const e of fromRules) if (isEquipment(e) && !out.includes(e)) out.push(e);
  if (Array.isArray(fromModel)) {
    for (const e of fromModel) if (isEquipment(e) && !out.includes(e)) out.push(e);
  }
  return out.slice(0, MAX_EQUIPMENT);
}

/**
 * Apply CONTRACTS §7 leniency to a guarded object:
 * - skills: array entries that are valid Skills, deduped; non-array/empty → TYPE_SKILLS[type]
 * - confidence: finite number clamped 0..1; missing/NaN → 0.5
 * - summary: string truncated to 140 chars; missing/non-string → first 100 chars of the input text
 * - equipment: detectEquipmentByRules(text) ∪ valid model entries, deduped, max 4
 * - hazardAlert: kind = detectHazardByRules(text) when it fires, else the model's kind (see
 *   readModelHazard); the returned alert is ALWAYS hazardAlertFor(kind) — curated words only
 */
export function normalizeTriageOutput(
  x: { type: NeedType; urgency: Urgency },
  text: string,
): OllamaTriageOutput {
  const o = x as unknown as Record<string, unknown>;

  let skills: Skill[] = [];
  if (Array.isArray(o.skills)) {
    for (const s of o.skills) {
      if (isSkill(s) && !skills.includes(s)) skills.push(s);
    }
  }
  // Curated defaults lead (a 3B model picks odd skills, e.g. counselor for snakebite); model extras follow, max 4.
  skills = [...TYPE_SKILLS[x.type], ...skills.filter((s) => !TYPE_SKILLS[x.type].includes(s))].slice(0, 4);

  let confidence = 0.5;
  if (typeof o.confidence === "number" && Number.isFinite(o.confidence)) {
    confidence = Math.min(1, Math.max(0, o.confidence));
  }

  let summary: string;
  if (typeof o.summary === "string" && o.summary.trim().length > 0) {
    summary = o.summary.trim().slice(0, 140);
  } else {
    summary = text.trim().slice(0, 100);
  }

  const equipment = mergeEquipment(detectEquipmentByRules(text), o.equipment);

  const byRules = detectHazardByRules(text);
  const kind: HazardKind = byRules !== "none" ? byRules : readModelHazard(o.hazardAlert).kind;
  const hazardAlert = hazardAlertFor(kind);

  return { type: x.type, urgency: x.urgency, skills, summary, confidence, equipment, hazardAlert };
}

// ---------------------------------------------------------------------------
// Prompt + schema (both built from lib/taxonomy.ts — never typed twice)
// ---------------------------------------------------------------------------

/** One-line description per need type for the system prompt. */
const TYPE_HINTS: Record<NeedType, string> = {
  flood_rescue: "people in or surrounded by rising water, flooded house or basement, drowning, need a boat/swimmer/pump",
  cardiac_no_breathing: "collapsed, unconscious, not breathing, no pulse, chest pain",
  bleeding: "heavy or uncontrolled bleeding, deep wound",
  fracture: "broken bone, fall injury, cannot bear weight",
  electrical: "electric shock, live wire, electrocution, sparking",
  fire: "fire, smoke, burns, gas leak or smell of gas, explosion",
  trapped_structural: "trapped under debris, building or wall collapse, landslide",
  snakebite: "snake bite or venomous bite/sting",
  evacuation_mobility: "must move someone who cannot move (elderly, disabled, bedridden, baby, pregnant)",
  supplies_oxygen_meds: "needs oxygen, insulin, medicines, food, drinking water, generator",
  missing_person: "person missing, lost, cannot be found or contacted",
  other: "anything that fits none of the above",
};

/** One-line meaning per hazard kind for the system prompt (the user never sees these; see lib/hazards.ts). */
const HAZARD_HINTS: Record<HazardKind, string> = {
  electrocution: "water or wet floor indoors (flooded room/basement), water near wiring/sockets/meter, fallen or live wire",
  gas_leak: "smell of gas, LPG cylinder leaking",
  fire_smoke: "fire, smoke, burning, explosion",
  fast_water: "fast or rising water outdoors, river in flood, people swept away",
  structural_collapse: "cracked or collapsed building/wall/roof, landslide, rubble",
  contaminated_water: "sewage, drain overflow, dirty flood water",
  chemical: "acid, chemical spill, toxic fumes, pesticide",
  traffic: "casualty on a road with moving vehicles",
  animal: "snake, dog, bees, wasps, elephant nearby",
  other: "a real scene danger that fits none of the above",
  none: "no danger from the surroundings (purely medical: collapse, bleeding, fracture, fever, medicines)",
};

/** System prompt: short instructions plus the taxonomy lists (types, skills, equipment, hazard kinds); no examples. */
export function buildSystemPrompt(): string {
  const typeLines = NEED_TYPES.map((t) => `- ${t}: ${TYPE_LABELS[t]} — ${TYPE_HINTS[t]}`).join("\n");
  const hazardLines = HAZARD_KINDS.map((k) => `- ${k}: ${HAZARD_HINTS[k]}`).join("\n");
  return [
    "You are the triage classifier for a neighbourhood emergency response app in Kerala, India.",
    "Classify the user's message. Output compact JSON on one line, no prose, no markdown, no line breaks.",
    "",
    "type must be exactly one of:",
    typeLines,
    "",
    `urgency must be one of: ${URGENCIES.join(", ")}.`,
    `skills is a list of helper skills needed, each one of: ${SKILLS.join(", ")}.`,
    `equipment is what a helper must bring, ONLY if the message names it, each one of: ${EQUIPMENT.join(", ")}. Usually [].`,
    "summary is one short line (max 140 characters) restating the emergency.",
    "confidence is your certainty 0..1 that type and urgency are correct.",
    "Prefer evacuation_mobility when there is water plus a person who cannot move.",
    "",
    "HIDDEN ENVIRONMENTAL HAZARD: could the surroundings injure the person or an arriving helper, even if unsaid (flood water indoors may be electrified)? hazardAlert.hazardKind must be exactly one of:",
    hazardLines,
    "hazardAlert.hasHazard is true exactly when hazardKind is not none. Never invent a hazard for a purely medical emergency.",
    "",
    "Return exactly this JSON shape:",
    '{"type":"<type>","urgency":"<urgency>","skills":["<skill>"],"equipment":[],"summary":"<one line>","confidence":0.0,"hazardAlert":{"hasHazard":false,"hazardKind":"none"}}',
  ].join("\n");
}

/** Plain JSON-schema object for Ollama's structured-outputs `format` (CONTRACTS §7). */
export function triageSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      type: { type: "string", enum: [...NEED_TYPES] },
      urgency: { type: "string", enum: [...URGENCIES] },
      skills: { type: "array", items: { type: "string", enum: [...SKILLS] } },
      equipment: { type: "array", items: { type: "string", enum: [...EQUIPMENT] } },
      summary: { type: "string" },
      confidence: { type: "number" },
      // Classification only. hazardTitle/hazardAction are deliberately absent (latency, see the header);
      // the UI shows lib/hazards.ts text for the kind, never model words.
      hazardAlert: {
        type: "object",
        properties: {
          hasHazard: { type: "boolean" },
          hazardKind: { type: "string", enum: [...HAZARD_KINDS] },
        },
        required: ["hasHazard", "hazardKind"],
      },
    },
    required: ["type", "urgency", "skills", "equipment", "summary", "confidence", "hazardAlert"],
  };
}

// ---------------------------------------------------------------------------
// Safety floor (README §4: the model classifies, curated logic decides)
// ---------------------------------------------------------------------------

/**
 * DELIBERATE, EXPLAINABLE RULE — not a model output.
 *
 * A 3B model regularly under-rates life-threatening situations (it has been seen
 * labelling "collapsed, not breathing" as merely "high"). Urgency drives the SMS
 * wording and the coordinator's priority list, so we apply a floor per need type
 * that a reviewer can read and tune in one place:
 *
 *   cardiac_no_breathing → always "critical" (minutes matter; there is no non-critical cardiac arrest)
 *   fire, trapped_structural, snakebite, electrical, flood_rescue → at least "high"
 *                                                                    ("critical" stays "critical")
 *   every other type → the model's urgency is kept as-is
 *
 * The floor only ever RAISES urgency; it never lowers it.
 */
export function applyUrgencyFloor(type: NeedType, urgency: Urgency): Urgency {
  if (type === "cardiac_no_breathing") return "critical";
  const atLeastHigh: NeedType[] = ["fire", "trapped_structural", "snakebite", "electrical", "flood_rescue"];
  if (atLeastHigh.includes(type)) {
    return urgency === "critical" ? "critical" : "high";
  }
  return urgency;
}

// ---------------------------------------------------------------------------
// Ollama call
// ---------------------------------------------------------------------------

type GenerateResponse = { response?: unknown };

async function postGenerate(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  return fetch(`${ollamaUrl()}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * One Ollama round-trip. Throws on any failure (network, abort, non-2xx, bad JSON,
 * guard failure). `triage()` is the only caller that catches.
 */
export async function triageWithOllama(text: string, signal: AbortSignal): Promise<TriageResult> {
  const base: Record<string, unknown> = {
    model: ollamaModel(),
    system: buildSystemPrompt(),
    prompt: text,
    stream: false,
    options: { temperature: 0, num_predict: OLLAMA_NUM_PREDICT },
    keep_alive: "30m",
  };

  let res = await postGenerate({ ...base, format: triageSchema() }, signal);
  if (res.status === 400) {
    // Older Ollama without JSON-schema structured outputs: retry once with format "json"
    // (README §4) under the same abort signal / timeout budget.
    res = await postGenerate({ ...base, format: "json" }, signal);
  }
  if (!res.ok) {
    throw new Error(`ollama http ${res.status}`);
  }

  const envelope = (await res.json()) as GenerateResponse;
  if (typeof envelope.response !== "string") {
    throw new Error("ollama: missing response string");
  }
  const parsed: unknown = JSON.parse(envelope.response);
  if (!isTriageOutput(parsed)) {
    throw new Error("ollama: output failed type guard");
  }
  const normalised = normalizeTriageOutput(parsed, text);
  return { ...normalised, source: "ollama", clarifyingQuestion: null };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classify `text`. Tries Ollama under OLLAMA_TIMEOUT_MS; falls back to
 * `triageByRules(text)` on throw / abort / invalid output / confidence < 0.5
 * (README §4). Applies `applyUrgencyFloor` to every Ollama result. Never throws.
 *
 * `equipment` and `hazardAlert` in every branch:
 *   model unsure (< 0.5) / any failure → the rules result as-is: rule equipment, rule hazard.
 *   rules overrule the model's type    → rule equipment and rule hazard too. A model that misread
 *       the situation ("father collapsed" → structural collapse) must not get to put its hazard
 *       banner on top of the CPR card.
 *   model and rules agree / rules weak → the model's result, which normalizeTriageOutput already
 *       merged: rule hazard if one fired, else the model's kind; rule equipment ∪ model equipment.
 * In all three the alert text is hazardAlertFor(kind) — curated, never generated.
 */
const URGENCY_RANK: Record<Urgency, number> = { low: 0, medium: 1, high: 2, critical: 3 };
function maxUrgency(a: Urgency, b: Urgency): Urgency {
  return URGENCY_RANK[a] >= URGENCY_RANK[b] ? a : b;
}

export async function triage(text: string): Promise<TriageResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ollamaTimeoutMs());

  let result: TriageResult;
  try {
    const fromOllama = await triageWithOllama(text, controller.signal);
    const rules = triageByRules(text);
    if (fromOllama.confidence < 0.5) {
      result = rules;
    } else if (rules.confidence >= 0.8 && rules.type !== fromOllama.type) {
      // A strong, explicit keyword match beats a 3B model that disagrees (e.g. "water rising, grandmother can't
      // walk" must be evacuation, not structural collapse). Keep the model's one-line summary; report "rules".
      result = {
        ...rules,
        summary: fromOllama.summary || rules.summary,
        urgency: maxUrgency(rules.urgency, fromOllama.urgency),
        equipment: rules.equipment,
        hazardAlert: rules.hazardAlert,
      };
    } else {
      result = {
        ...fromOllama,
        urgency: maxUrgency(applyUrgencyFloor(fromOllama.type, fromOllama.urgency), rules.type === fromOllama.type ? rules.urgency : "low"),
        equipment: fromOllama.equipment,
        hazardAlert: fromOllama.hazardAlert,
      };
    }
  } catch {
    result = triageByRules(text);
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  console.log(
    `[triage] source=${result.source} type=${result.type} urgency=${result.urgency} hazard=${result.hazardAlert.kind} equipment=${result.equipment.join("+") || "-"} ms=${ms}`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Warm-up / health (GET /api/triage, CONTRACTS §6)
// ---------------------------------------------------------------------------

export type WarmResult = { ollama: "ok" | "down"; model: string; ms: number; modelPresent: boolean };

function modelNameMatches(candidate: unknown, wanted: string): boolean {
  if (typeof candidate !== "string") return false;
  const strip = (s: string) => (s.endsWith(":latest") ? s.slice(0, -":latest".length) : s);
  return strip(candidate) === strip(wanted);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks `/api/tags` for the model (5 s), then — only when present — runs a tiny
 * generate with `keep_alive: "30m"` under its OWN 60 s timeout (a cold load can take
 * 20–30 s; never OLLAMA_TIMEOUT_MS). The warm-up carries the real system prompt so Ollama's
 * prompt cache already holds that prefix: the first real triage then only evaluates the user's
 * sentence (the prompt is ~900 tokens ≈ 2 s of the 4 s budget when it is not cached).
 * Never throws; "down" when unreachable or the model is missing.
 */
export async function warmOllama(): Promise<WarmResult> {
  const started = Date.now();
  const model = ollamaModel();
  let modelPresent = false;

  try {
    const tags = await fetchWithTimeout(`${ollamaUrl()}/api/tags`, { method: "GET" }, 5_000);
    if (!tags.ok) {
      return { ollama: "down", model, ms: Date.now() - started, modelPresent };
    }
    const json: unknown = await tags.json();
    const models =
      typeof json === "object" && json !== null && Array.isArray((json as { models?: unknown }).models)
        ? ((json as { models: unknown[] }).models)
        : [];
    modelPresent = models.some((m) => {
      if (typeof m !== "object" || m === null) return false;
      const rec = m as { name?: unknown; model?: unknown };
      return modelNameMatches(rec.name, model) || modelNameMatches(rec.model, model);
    });
    if (!modelPresent) {
      return { ollama: "down", model, ms: Date.now() - started, modelPresent };
    }

    const gen = await fetchWithTimeout(
      `${ollamaUrl()}/api/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          system: buildSystemPrompt(),
          prompt: "ok",
          stream: false,
          options: { temperature: 0, num_predict: 1 },
          keep_alive: "30m",
        }),
      },
      60_000,
    );
    if (!gen.ok) {
      return { ollama: "down", model, ms: Date.now() - started, modelPresent };
    }
    await gen.text();
    return { ollama: "ok", model, ms: Date.now() - started, modelPresent };
  } catch {
    return { ollama: "down", model, ms: Date.now() - started, modelPresent };
  }
}
