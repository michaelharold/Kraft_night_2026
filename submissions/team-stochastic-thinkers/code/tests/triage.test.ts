import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  OLLAMA_NUM_PREDICT,
  isTriageOutput,
  normalizeTriageOutput,
  readModelHazard,
  mergeEquipment,
  applyUrgencyFloor,
  triage,
  triageSchema,
  buildSystemPrompt,
} from "../lib/triage";
import { EQUIPMENT, NEED_TYPES, SKILLS, TYPE_SKILLS } from "../lib/taxonomy";
import { HAZARDS, HAZARD_KINDS, NO_HAZARD } from "../lib/hazards";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type FakeHandler = (
  body: Record<string, unknown>,
  res: http.ServerResponse,
) => void | Promise<void>;

/** Starts a fake Ollama on an ephemeral port; `handler` gets the parsed POST body. */
function startFake(handler: FakeHandler): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw || "{}") as Record<string, unknown>;
        } catch {
          body = {};
        }
        void handler(body, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const GOOD_OUTPUT = {
  type: "cardiac_no_breathing",
  urgency: "critical",
  skills: ["doctor"],
  summary: "x",
  confidence: 0.9,
};

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ---------------------------------------------------------------------------
// guard + normalisation
// ---------------------------------------------------------------------------

test("isTriageOutput accepts a valid object", () => {
  assert.equal(isTriageOutput(GOOD_OUTPUT), true);
  assert.equal(isTriageOutput({ type: "bleeding", urgency: "medium" }), true);
});

test("isTriageOutput rejects bad enums and missing fields", () => {
  assert.equal(isTriageOutput({ type: "zombie", urgency: "critical" }), false);
  assert.equal(isTriageOutput({ type: "bleeding", urgency: "extreme" }), false);
  assert.equal(isTriageOutput({ urgency: "critical" }), false);
  assert.equal(isTriageOutput({ type: "bleeding" }), false);
  assert.equal(isTriageOutput(null), false);
  assert.equal(isTriageOutput("bleeding"), false);
  assert.equal(isTriageOutput([]), false);
  assert.equal(isTriageOutput({ type: 3, urgency: "high" }), false);
});

test("normalizeTriageOutput clamps confidence", () => {
  const base = { type: "bleeding", urgency: "high" } as const;
  assert.equal(normalizeTriageOutput({ ...base, confidence: 7 } as never, "t").confidence, 1);
  assert.equal(normalizeTriageOutput({ ...base, confidence: -2 } as never, "t").confidence, 0);
  assert.equal(normalizeTriageOutput({ ...base, confidence: 0.42 } as never, "t").confidence, 0.42);
  assert.equal(normalizeTriageOutput({ ...base } as never, "t").confidence, 0.5);
  assert.equal(normalizeTriageOutput({ ...base, confidence: NaN } as never, "t").confidence, 0.5);
  assert.equal(normalizeTriageOutput({ ...base, confidence: "0.9" } as never, "t").confidence, 0.5);
});

test("normalizeTriageOutput dedupes and filters skills, falls back to TYPE_SKILLS", () => {
  const base = { type: "flood_rescue", urgency: "critical" } as const;
  const out = normalizeTriageOutput(
    { ...base, skills: ["swimmer", "wizard", "swimmer", 42, "doctor"] } as never,
    "t",
  );
  assert.deepEqual(out.skills, [...TYPE_SKILLS.flood_rescue, "doctor"]); // curated defaults lead, valid extras follow
  assert.deepEqual(normalizeTriageOutput({ ...base, skills: [] } as never, "t").skills, TYPE_SKILLS.flood_rescue);
  assert.deepEqual(normalizeTriageOutput({ ...base, skills: "swimmer" } as never, "t").skills, TYPE_SKILLS.flood_rescue);
  assert.deepEqual(normalizeTriageOutput({ ...base, skills: ["nope"] } as never, "t").skills, TYPE_SKILLS.flood_rescue);
});

test("normalizeTriageOutput truncates summary / falls back to input text", () => {
  const base = { type: "fire", urgency: "high" } as const;
  const long = "a".repeat(300);
  assert.equal(normalizeTriageOutput({ ...base, summary: long } as never, "t").summary.length, 140);
  const text = "b".repeat(250);
  assert.equal(normalizeTriageOutput({ ...base } as never, text).summary, "b".repeat(100));
  assert.equal(normalizeTriageOutput({ ...base, summary: 12 } as never, "short text").summary, "short text");
});

test("triageSchema is built from the taxonomy and forces equipment + hazardAlert", () => {
  const schema = triageSchema() as {
    required: string[];
    properties: {
      type: { enum: string[] };
      urgency: { enum: string[] };
      skills: { items: { enum: string[] } };
      equipment: { type: string; items: { enum: string[] } };
      hazardAlert: { type: string; required: string[]; properties: Record<string, { type: string; enum?: string[] }> };
    };
  };
  assert.deepEqual([...schema.required].sort(), ["confidence", "equipment", "hazardAlert", "skills", "summary", "type", "urgency"]);
  assert.deepEqual(schema.properties.type.enum, [...NEED_TYPES]);
  assert.deepEqual(schema.properties.skills.items.enum, [...SKILLS]);
  assert.deepEqual(schema.properties.urgency.enum, ["critical", "high", "medium", "low"]);
  assert.equal(schema.properties.equipment.type, "array");
  assert.deepEqual(schema.properties.equipment.items.enum, [...EQUIPMENT]);
  const hz = schema.properties.hazardAlert;
  assert.equal(hz.type, "object");
  assert.deepEqual([...hz.required].sort(), ["hasHazard", "hazardKind"]);
  assert.equal(hz.properties.hasHazard.type, "boolean");
  assert.deepEqual(hz.properties.hazardKind.enum, [...HAZARD_KINDS]);
  // Latency decision (lib/triage.ts header): the model classifies the kind only; the words are curated.
  assert.equal("hazardTitle" in hz.properties, false);
  assert.equal("hazardAction" in hz.properties, false);
});

test("buildSystemPrompt lists every type, skill, equipment and hazard kind", () => {
  const p = buildSystemPrompt();
  for (const t of NEED_TYPES) assert.ok(p.includes(t), `prompt lacks ${t}`);
  for (const s of SKILLS) assert.ok(p.includes(s), `prompt lacks ${s}`);
  for (const e of EQUIPMENT) assert.ok(p.includes(e), `prompt lacks ${e}`);
  for (const k of HAZARD_KINDS) assert.ok(p.includes(`- ${k}: `), `prompt lacks hazard kind ${k}`);
  assert.ok(/JSON/.test(p));
  assert.ok(/HIDDEN ENVIRONMENTAL HAZARD/.test(p));
  assert.ok(p.includes("hazardAlert"));
  assert.ok(p.includes("evacuation_mobility when"));
  // The model is never asked to word the warning.
  assert.equal(p.includes("hazardTitle"), false);
  assert.equal(p.includes("hazardAction"), false);
});

// ---------------------------------------------------------------------------
// hazardAlert + equipment normalisation (docs/UPGRADE.md §2, §5)
// ---------------------------------------------------------------------------

const MODEL_TEXT = "MODEL TEXT";

test("readModelHazard keeps only the classification", () => {
  assert.deepEqual(readModelHazard({ hasHazard: true, hazardKind: "gas_leak", hazardTitle: MODEL_TEXT, hazardAction: MODEL_TEXT }), { hasHazard: true, kind: "gas_leak" });
  assert.deepEqual(readModelHazard({ hasHazard: "true", kind: "animal" }), { hasHazard: true, kind: "animal" }); // format:"json" fallback spellings
  assert.deepEqual(readModelHazard({ hasHazard: false, hazardKind: "gas_leak" }), { hasHazard: false, kind: "none" });
  assert.deepEqual(readModelHazard({ hasHazard: true, hazardKind: "volcano" }), { hasHazard: true, kind: "other" });
  assert.deepEqual(readModelHazard({ hasHazard: true, hazardKind: "none" }), { hasHazard: true, kind: "other" });
  assert.deepEqual(readModelHazard({ hasHazard: true }), { hasHazard: true, kind: "other" });
  for (const garbage of [undefined, null, "gas_leak", 7, true, [], ["gas_leak"], { hasHazard: 1, hazardKind: "gas_leak" }]) {
    assert.deepEqual(readModelHazard(garbage), { hasHazard: false, kind: "none" }, JSON.stringify(garbage));
  }
});

test("mergeEquipment: rules first, valid model extras, deduped, max 4", () => {
  assert.deepEqual(mergeEquipment(["water_pump"], ["oxygen_cylinder", "bogus", "oxygen_cylinder", "water_pump", 3, "car", "torch_powerbank", "life_jacket"]), [
    "water_pump",
    "oxygen_cylinder",
    "car",
    "torch_powerbank",
  ]);
  assert.deepEqual(mergeEquipment([], "water_pump"), []);
  assert.deepEqual(mergeEquipment([], undefined), []);
  assert.deepEqual(mergeEquipment(["car", "car"], null), ["car"]);
});

test("normalizeTriageOutput: model hazard kind → curated text, never the model's words", () => {
  const out = normalizeTriageOutput(
    { type: "fire", urgency: "high", hazardAlert: { hasHazard: true, hazardKind: "gas_leak", hazardTitle: MODEL_TEXT, hazardAction: MODEL_TEXT } } as never,
    "something smells odd in the kitchen", // no keyword rule fires, so the model's kind is used
  );
  assert.deepEqual(out.hazardAlert, { hasHazard: true, kind: "gas_leak", hazardTitle: HAZARDS.gas_leak.title, hazardAction: HAZARDS.gas_leak.action });
  assert.equal(JSON.stringify(out).includes(MODEL_TEXT), false);
});

test("normalizeTriageOutput: garbage hazardAlert → no hazard; unknown kind → other", () => {
  const base = { type: "bleeding", urgency: "high" } as const;
  for (const garbage of [undefined, null, "yes", 1, [], { hasHazard: "maybe" }]) {
    assert.deepEqual(normalizeTriageOutput({ ...base, hazardAlert: garbage } as never, "deep cut on the hand").hazardAlert, NO_HAZARD, JSON.stringify(garbage));
  }
  const other = normalizeTriageOutput({ ...base, hazardAlert: { hasHazard: true, hazardKind: "lava" } } as never, "deep cut on the hand").hazardAlert;
  assert.deepEqual(other, { hasHazard: true, kind: "other", hazardTitle: HAZARDS.other.title, hazardAction: HAZARDS.other.action });
});

test("normalizeTriageOutput: keyword rules beat the model on the hazard kind", () => {
  const out = normalizeTriageOutput(
    { type: "flood_rescue", urgency: "critical", hazardAlert: { hasHazard: true, hazardKind: "animal", hazardTitle: MODEL_TEXT, hazardAction: MODEL_TEXT } } as never,
    "Basement flooded, need pump",
  );
  assert.equal(out.hazardAlert.kind, "electrocution");
  assert.equal(out.hazardAlert.hazardTitle, HAZARDS.electrocution.title);
  const denied = normalizeTriageOutput({ type: "flood_rescue", urgency: "critical", hazardAlert: { hasHazard: false, hazardKind: "none" } } as never, "Basement flooded, need pump");
  assert.equal(denied.hazardAlert.kind, "electrocution"); // the model saying "no hazard" cannot switch the rules off
});

test("normalizeTriageOutput: equipment = rules ∪ model, deduped, max 4", () => {
  const base = { type: "flood_rescue", urgency: "critical" } as const;
  assert.deepEqual(normalizeTriageOutput({ ...base, equipment: ["life_jacket", "water_pump", "nope", "life_jacket"] } as never, "Basement flooded, need pump").equipment, ["water_pump", "life_jacket"]);
  assert.deepEqual(normalizeTriageOutput({ ...base } as never, "Basement flooded, need pump").equipment, ["water_pump"]);
  assert.deepEqual(normalizeTriageOutput({ ...base, equipment: "water_pump" } as never, "help").equipment, []);
  const many = normalizeTriageOutput({ ...base, equipment: ["oxygen_cylinder", "car", "torch_powerbank", "life_jacket", "first_aid_kit"] } as never, "need pump");
  assert.deepEqual(many.equipment, ["water_pump", "oxygen_cylinder", "car", "torch_powerbank"]);
});

// ---------------------------------------------------------------------------
// urgency floor
// ---------------------------------------------------------------------------

test("applyUrgencyFloor lifts cardiac to critical and leaves bleeding/medium alone", () => {
  assert.equal(applyUrgencyFloor("cardiac_no_breathing", "high"), "critical");
  assert.equal(applyUrgencyFloor("cardiac_no_breathing", "low"), "critical");
  assert.equal(applyUrgencyFloor("bleeding", "medium"), "medium");
  assert.equal(applyUrgencyFloor("fire", "low"), "high");
  assert.equal(applyUrgencyFloor("fire", "critical"), "critical");
  assert.equal(applyUrgencyFloor("flood_rescue", "medium"), "high");
  assert.equal(applyUrgencyFloor("other", "low"), "low");
});

// ---------------------------------------------------------------------------
// triage() end to end against fakes (never the real Ollama)
// ---------------------------------------------------------------------------

test("triage() falls back to rules when the port is closed, quickly", async () => {
  await withEnv({ OLLAMA_URL: "http://127.0.0.1:9", OLLAMA_TIMEOUT_MS: "4000" }, async () => {
    const t0 = Date.now();
    const r = await triage("father collapsed not breathing");
    const ms = Date.now() - t0;
    assert.equal(r.source, "rules");
    assert.ok(ms < 1000, `took ${ms} ms`);
  });
});

test("triage() returns source ollama for a valid fake response", async () => {
  const seen: Record<string, unknown>[] = [];
  const { server, url } = await startFake((body, res) => {
    seen.push(body);
    sendJson(res, 200, { response: JSON.stringify(GOOD_OUTPUT) });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000", OLLAMA_MODEL: "fake-model" }, async () => {
      const r = await triage("father collapsed not breathing");
      assert.equal(r.source, "ollama");
      assert.equal(r.type, "cardiac_no_breathing");
      assert.equal(r.urgency, "critical");
      assert.deepEqual(r.skills, TYPE_SKILLS.cardiac_no_breathing);
      assert.equal(r.summary, "x");
      assert.equal(r.confidence, 0.9);
      assert.equal(r.clarifyingQuestion, null);
      assert.deepEqual(r.equipment, []); // GOOD_OUTPUT has no equipment/hazardAlert: lenient
      assert.deepEqual(r.hazardAlert, NO_HAZARD);
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, "fake-model");
    assert.equal(seen[0].stream, false);
    assert.equal(seen[0].keep_alive, "30m");
    assert.equal(typeof seen[0].format, "object");
    assert.deepEqual(seen[0].options, { temperature: 0, num_predict: OLLAMA_NUM_PREDICT });
    assert.ok(OLLAMA_NUM_PREDICT >= 200);
    const fmt = seen[0].format as { required: string[] };
    assert.ok(fmt.required.includes("hazardAlert") && fmt.required.includes("equipment"));
  } finally {
    await closeServer(server);
  }
});

test("triage() applies the urgency floor to Ollama results", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 200, { response: JSON.stringify({ ...GOOD_OUTPUT, urgency: "high" }) });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("father collapsed not breathing");
      assert.equal(r.source, "ollama");
      assert.equal(r.urgency, "critical");
    });
  } finally {
    await closeServer(server);
  }
});

test("triage() falls back to rules when the fake returns garbage", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 200, { response: "this is not json {" });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("father collapsed not breathing");
      assert.equal(r.source, "rules");
    });
  } finally {
    await closeServer(server);
  }
});

test("triage() falls back to rules when the guard fails", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 200, { response: JSON.stringify({ type: "nonsense", urgency: "critical" }) });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("father collapsed not breathing");
      assert.equal(r.source, "rules");
    });
  } finally {
    await closeServer(server);
  }
});

test("triage() times out at OLLAMA_TIMEOUT_MS and falls back to rules", async () => {
  const pending: http.ServerResponse[] = [];
  const { server, url } = await startFake((_body, res) => {
    pending.push(res);
    setTimeout(() => {
      if (!res.writableEnded) sendJson(res, 200, { response: JSON.stringify(GOOD_OUTPUT) });
    }, 2000).unref();
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "300" }, async () => {
      const t0 = Date.now();
      const r = await triage("father collapsed not breathing");
      const ms = Date.now() - t0;
      assert.equal(r.source, "rules");
      assert.ok(ms >= 250 && ms < 700, `took ${ms} ms`);
    });
  } finally {
    for (const res of pending) if (!res.writableEnded) res.destroy();
    await closeServer(server);
  }
});

test("triage() falls back to rules when Ollama confidence < 0.5", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 200, { response: JSON.stringify({ ...GOOD_OUTPUT, confidence: 0.2 }) });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("father collapsed not breathing");
      assert.equal(r.source, "rules");
    });
  } finally {
    await closeServer(server);
  }
});

test("triage() retries with format json when the schema format gets HTTP 400", async () => {
  const formats: unknown[] = [];
  const { server, url } = await startFake((body, res) => {
    formats.push(body.format);
    if (typeof body.format === "object") {
      sendJson(res, 400, { error: "format must be json" });
      return;
    }
    if (body.format === "json") {
      sendJson(res, 200, { response: JSON.stringify(GOOD_OUTPUT) });
      return;
    }
    sendJson(res, 500, { error: "unexpected" });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("father collapsed not breathing");
      assert.equal(r.source, "ollama");
      assert.equal(r.type, "cardiac_no_breathing");
    });
    assert.equal(formats.length, 2);
    assert.equal(typeof formats[0], "object");
    assert.equal(formats[1], "json");
  } finally {
    await closeServer(server);
  }
});

test("triage() falls back to rules on a non-400 HTTP error", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 500, { error: "boom" });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("father collapsed not breathing");
      assert.equal(r.source, "rules");
    });
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// hazardAlert + equipment through triage() (fake Ollama, every merge branch)
// ---------------------------------------------------------------------------

const MODEL_HAZARD = { hasHazard: true, hazardKind: "gas_leak", hazardTitle: MODEL_TEXT, hazardAction: MODEL_TEXT };

test("triage(): model hazard kind is shown with curated text; the model's words never reach the response", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 200, { response: JSON.stringify({ type: "fire", urgency: "high", skills: ["volunteer"], equipment: ["fire_extinguisher"], summary: "x", confidence: 0.9, hazardAlert: MODEL_HAZARD }) });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("something smells odd in the kitchen"); // no keyword hazard, weak type rules
      assert.equal(r.source, "ollama");
      assert.equal(r.type, "fire");
      assert.deepEqual(r.hazardAlert, { hasHazard: true, kind: "gas_leak", hazardTitle: HAZARDS.gas_leak.title, hazardAction: HAZARDS.gas_leak.action });
      assert.deepEqual(r.equipment, ["fire_extinguisher"]);
      assert.equal(JSON.stringify(r).includes(MODEL_TEXT), false);
    });
  } finally {
    await closeServer(server);
  }
});

test("triage(): garbage hazardAlert from the model → no hazard, still source ollama", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 200, { response: JSON.stringify({ ...GOOD_OUTPUT, hazardAlert: "DANGER!!!", equipment: "all of it" }) });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("father collapsed not breathing");
      assert.equal(r.source, "ollama");
      assert.deepEqual(r.hazardAlert, NO_HAZARD);
      assert.deepEqual(r.equipment, []);
    });
  } finally {
    await closeServer(server);
  }
});

test("triage(): keyword rules beat the model's hazard when they fire (agreeing types)", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 200, {
      response: JSON.stringify({ type: "flood_rescue", urgency: "high", skills: ["swimmer"], equipment: ["life_jacket"], summary: "x", confidence: 0.9, hazardAlert: { hasHazard: true, hazardKind: "animal" } }),
    });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("Basement flooded, need pump");
      assert.equal(r.source, "ollama");
      assert.equal(r.type, "flood_rescue");
      assert.equal(r.hazardAlert.kind, "electrocution");
      assert.equal(r.hazardAlert.hazardTitle, HAZARDS.electrocution.title);
      assert.deepEqual(r.equipment, ["water_pump", "life_jacket"]); // rules first, model extra
    });
  } finally {
    await closeServer(server);
  }
});

test("triage(): when strong rules overrule the model's type, the model's hazard and equipment go too", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 200, {
      response: JSON.stringify({ type: "trapped_structural", urgency: "high", skills: ["volunteer"], equipment: ["chainsaw_cutter"], summary: "model summary", confidence: 0.9, hazardAlert: { hasHazard: true, hazardKind: "structural_collapse", hazardTitle: MODEL_TEXT } }),
    });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("my father collapsed, not breathing");
      assert.equal(r.source, "rules");
      assert.equal(r.type, "cardiac_no_breathing");
      assert.equal(r.summary, "model summary");
      assert.deepEqual(r.hazardAlert, NO_HAZARD); // no collapse banner on top of the CPR card
      assert.deepEqual(r.equipment, []);
      assert.equal(JSON.stringify(r).includes(MODEL_TEXT), false);
    });
  } finally {
    await closeServer(server);
  }
});

test("triage(): an unsure model (< 0.5) yields the rules result with rule hazard + equipment", async () => {
  const { server, url } = await startFake((_body, res) => {
    sendJson(res, 200, { response: JSON.stringify({ type: "other", urgency: "low", skills: [], equipment: ["car"], summary: "x", confidence: 0.2, hazardAlert: { hasHazard: true, hazardKind: "animal" } }) });
  });
  try {
    await withEnv({ OLLAMA_URL: url, OLLAMA_TIMEOUT_MS: "4000" }, async () => {
      const r = await triage("Basement flooded, need pump");
      assert.equal(r.source, "rules");
      assert.equal(r.hazardAlert.kind, "electrocution");
      assert.deepEqual(r.equipment, ["water_pump"]);
    });
  } finally {
    await closeServer(server);
  }
});

test("triage(): rules fallback on a closed port still carries hazard + equipment", async () => {
  await withEnv({ OLLAMA_URL: "http://127.0.0.1:9", OLLAMA_TIMEOUT_MS: "4000" }, async () => {
    const r = await triage("smell of gas in the kitchen, bring a torch");
    assert.equal(r.source, "rules");
    assert.equal(r.hazardAlert.kind, "gas_leak");
    assert.equal(r.hazardAlert.hazardAction, HAZARDS.gas_leak.action);
    assert.deepEqual(r.equipment, ["torch_powerbank"]);
  });
});

test("triage(): every demo phrase gets the contract's hazard from rules alone", async () => {
  await withEnv({ OLLAMA_URL: "http://127.0.0.1:9", OLLAMA_TIMEOUT_MS: "4000" }, async () => {
    assert.equal((await triage("Basement flooded, need pump")).hazardAlert.kind, "electrocution");
    assert.equal((await triage("smell of gas in the kitchen")).hazardAlert.kind, "gas_leak");
    assert.ok(["fast_water", "electrocution"].includes((await triage("house flooded, water rising fast outside")).hazardAlert.kind));
    assert.equal((await triage("my father collapsed, not breathing")).hazardAlert.kind, "none");
  });
});
