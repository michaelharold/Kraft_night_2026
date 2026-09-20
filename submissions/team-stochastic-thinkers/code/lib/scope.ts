/**
 * Local AI job scoping (Ollama). Turns a customer's raw description into a structured job breakdown the worker can
 * prepare from: title, category, urgency, time estimate, required tools, skill level, matching tags, steps, and the
 * PHOTOS (what + angle + why) and QUESTIONS the customer should answer before a worker sets off.
 *
 * - Model: OLLAMA_SCOPE_MODEL (default "llama3.1"); if it is not installed, errors or times out, OLLAMA_MODEL
 *   (default "qwen2.5:3b") is tried once. Both run locally; nothing leaves the machine.
 * - Output: raw JSON only (system prompt + JSON-schema `format`), then a hand-written guard. Enumerated fields are
 *   clamped to the shared vocabularies in lib/taxonomy.ts so MongoDB matching compares like with like.
 * - Failure: throws ScopeError("ai_unavailable" | "ai_invalid"); the route answers 503/502 and the UI falls back to
 *   the normal (unscoped) request.
 */
import { SERVICES, SKILL_LABELS, TOOLS, TOOL_LABELS, isService, isTool, type Service } from "./taxonomy";
import type { PhotoRequest, SkillLevel, TaskScope, Tool } from "./types";

export class ScopeError extends Error {
  constructor(public code: "ai_unavailable" | "ai_invalid", message: string) { super(message); }
}

const ollamaUrl = () => (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const primaryModel = () => process.env.OLLAMA_SCOPE_MODEL?.trim() || "llama3.1";
const fallbackModel = () => process.env.OLLAMA_MODEL?.trim() || "qwen2.5:3b";
const timeoutMs = () => { const n = Number(process.env.OLLAMA_SCOPE_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 45_000; };
const LEVELS: SkillLevel[] = ["basic", "intermediate", "expert"];

export function scopeSystemPrompt(): string {
  return [
    "You are Sahaya's job-scoping assistant for a local home-services and basic-care marketplace in Kerala, India.",
    "Read the customer's description and return ONLY one raw JSON object. No prose, no markdown, no code fences.",
    "Fields:",
    `- parsedTitle: short job title, max 60 characters.`,
    `- category: exactly one of ${SERVICES.join(", ")}.`,
    `- urgencyScore: integer 1-10 (10 = must start right now, 1 = any day).`,
    `- estimatedTimeMinutes: integer 10-480, realistic on-site time for one worker.`,
    `- requiredTools: 1-5 items, each exactly one of ${TOOLS.join(", ")}.`,
    `- skillLevelRequired: one of basic, intermediate, expert.`,
    `- workerMatchingTags: 1-3 services from the category list above that could do this job.`,
    `- steps: 2-5 short steps the worker will likely do.`,
    `- photoRequests: 1-4 photos the customer should take so the worker can bring the right parts. Each item has`,
    `  what (the object to photograph), angle (exact angle/distance, e.g. "close-up from underneath", "wide shot from the doorway"),`,
    `  and why (what the worker learns from it).`,
    `- questions: 0-3 short yes/no or one-word questions whose answers change what the worker brings (e.g. pipe material, AC brand).`,
    "Never give medical diagnoses; for doctor/nurse/caregiver jobs ask only for practical details (age, symptoms started when, current medicines).",
  ].join("\n");
}

export function scopeSchema(): Record<string, unknown> {
  const str = { type: "string" };
  return {
    type: "object",
    properties: {
      parsedTitle: str,
      category: { type: "string", enum: [...SERVICES] },
      urgencyScore: { type: "integer" },
      estimatedTimeMinutes: { type: "integer" },
      requiredTools: { type: "array", items: { type: "string", enum: [...TOOLS] } },
      skillLevelRequired: { type: "string", enum: LEVELS },
      workerMatchingTags: { type: "array", items: { type: "string", enum: [...SERVICES] } },
      steps: { type: "array", items: str },
      photoRequests: { type: "array", items: { type: "object", properties: { what: str, angle: str, why: str }, required: ["what", "angle", "why"] } },
      questions: { type: "array", items: str },
    },
    required: ["parsedTitle", "category", "urgencyScore", "estimatedTimeMinutes", "requiredTools", "skillLevelRequired", "workerMatchingTags", "steps", "photoRequests", "questions"],
  };
}

const clampInt = (x: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};
const cleanText = (x: unknown, max: number) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Hand-written guard: accepts anything, returns a valid TaskScope or throws ai_invalid. `hint` = the service the user tapped. */
export function normalizeScope(raw: unknown, model: string, hint: Service | null): TaskScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ScopeError("ai_invalid", "not an object");
  const o = raw as Record<string, unknown>;
  // The service the user tapped wins over the model's guess: they know they asked for a plumber.
  const category: Service | null = hint ?? (isService(o.category) ? o.category : null);
  if (!category) throw new ScopeError("ai_invalid", "no valid category");
  // When the user tapped a service, only that trade is matched (a small model over-tags: "carpenter" for a sink leak).
  const tags = hint ? [hint] : [...new Set([category, ...(Array.isArray(o.workerMatchingTags) ? o.workerMatchingTags.filter(isService) : [])])].slice(0, 3);
  const tools = [...new Set(Array.isArray(o.requiredTools) ? o.requiredTools.filter(isTool) : [])].slice(0, 5) as Tool[];
  const photos: PhotoRequest[] = (Array.isArray(o.photoRequests) ? o.photoRequests : [])
    .map((p) => (p && typeof p === "object" ? p as Record<string, unknown> : {}))
    .map((p) => ({ what: cleanText(p.what, 80), angle: cleanText(p.angle, 80), why: cleanText(p.why, 120) }))
    .filter((p) => p.what && p.angle)
    .slice(0, 4);
  const steps = (Array.isArray(o.steps) ? o.steps : []).map((x) => cleanText(x, 100)).filter(Boolean).slice(0, 5);
  const questions = (Array.isArray(o.questions) ? o.questions : []).map((x) => cleanText(x, 120)).filter(Boolean).slice(0, 3);
  return {
    parsedTitle: cleanText(o.parsedTitle, 60) || `${SKILL_LABELS[category]} job`,
    category, urgencyScore: clampInt(o.urgencyScore, 1, 10, 5), estimatedTimeMinutes: clampInt(o.estimatedTimeMinutes, 10, 480, 60),
    requiredTools: tools,
    skillLevelRequired: LEVELS.includes(o.skillLevelRequired as SkillLevel) ? (o.skillLevelRequired as SkillLevel) : "intermediate",
    workerMatchingTags: tags, steps,
    photoRequests: photos.length ? photos : [{ what: "The problem area", angle: "clear photo from about 1 metre away", why: "Shows the worker what to expect" }],
    questions, model, source: "ollama",
  };
}

async function generate(model: string, description: string, hint: Service | null, ms: number): Promise<TaskScope> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const prompt = hint ? `Service the customer chose: ${hint}.\nCustomer's description: ${description}` : `Customer's description: ${description}`;
    const res = await fetch(`${ollamaUrl()}/api/generate`, {
      method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, system: scopeSystemPrompt(), prompt, stream: false, format: scopeSchema(), keep_alive: "10m", options: { temperature: 0.1, num_predict: 700 } }),
    });
    if (res.status === 404) throw new ScopeError("ai_unavailable", `model ${model} is not installed`);
    if (!res.ok) throw new ScopeError("ai_unavailable", `ollama answered ${res.status}`);
    const body = (await res.json()) as { response?: unknown };
    if (typeof body.response !== "string") throw new ScopeError("ai_invalid", "no response text");
    let parsed: unknown;
    try { parsed = JSON.parse(body.response); } catch { throw new ScopeError("ai_invalid", "model did not return JSON"); }
    return normalizeScope(parsed, model, hint);
  } catch (e) {
    if (e instanceof ScopeError) throw e;
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new ScopeError("ai_unavailable", aborted ? `${model} timed out after ${ms} ms` : `cannot reach Ollama at ${ollamaUrl()}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Scope a job. Tries the primary model, then the smaller fallback model once. Throws ScopeError. */
export async function scopeTask(description: string, hint: Service | null): Promise<TaskScope> {
  const started = Date.now();
  try {
    const s = await generate(primaryModel(), description, hint, timeoutMs());
    console.log(`[scope] model=${s.model} category=${s.category} tools=${s.requiredTools.join("+")} ms=${Date.now() - started}`);
    return s;
  } catch (e) {
    if (primaryModel() === fallbackModel()) throw e;
    console.warn(`[scope] ${primaryModel()} failed (${(e as Error).message}); trying ${fallbackModel()}`);
    const s = await generate(fallbackModel(), description, hint, 20_000);
    console.log(`[scope] model=${s.model} (fallback) category=${s.category} ms=${Date.now() - started}`);
    return s;
  }
}

export const toolLabel = (t: Tool) => TOOL_LABELS[t];
