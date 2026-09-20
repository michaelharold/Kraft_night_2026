import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TRANSLATE_CHARS, translate } from "../lib/translate";

/** Stand in for Ollama. `reply` is whatever /api/generate should hand back this time. */
function stubOllama(reply: (body: Record<string, unknown>) => unknown | Promise<unknown>) {
  const real = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push(body);
    const out = await reply(body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ response: JSON.stringify(out) }), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** Each test uses a unique phrase: lib/translate.ts caches by from|to|text across the process. */
const uniq = (s: string) => `${s} ${Math.random().toString(36).slice(2)}`;

test("same language and empty text never reach the model", async () => {
  const s = stubOllama(() => ({ translation: "should not be called" }));
  try {
    const same = await translate({ text: "സിങ്ക് ചോരുന്നു", from: "ml-IN", to: "ml-IN" });
    assert.equal(same.source, "passthrough");
    assert.equal(same.text, "സിങ്ക് ചോരുന്നു");

    const empty = await translate({ text: "   ", from: "ml-IN", to: "ta-IN" });
    assert.equal(empty.source, "passthrough");
    assert.equal(empty.text, "");

    assert.equal(s.calls.length, 0, "no model round trip for a no-op");
  } finally { s.restore(); }
});

test("a good translation comes back tagged with the model that produced it", async () => {
  const s = stubOllama(() => ({ translation: "The kitchen sink is leaking" }));
  try {
    const r = await translate({ text: uniq("അടുക്കളയിലെ സിങ്ക് ചോരുന്നു"), from: "ml-IN", to: "en-IN" });
    assert.equal(r.source, "ollama");
    assert.equal(r.text, "The kitchen sink is leaking");
    assert.equal(r.note, null);
    assert.ok(r.model, "the model is recorded so a bad translation can be traced");
    assert.equal(s.calls[0].format !== undefined, true, "a JSON schema is enforced");
    assert.equal((s.calls[0].options as { temperature: number }).temperature, 0, "translation is not a creative task");
  } finally { s.restore(); }
});

test("model pleasantries and code fences are stripped", async () => {
  const cases = [
    '```json\n{"x":1}\n```',   // handled by the JSON parse, not stripNoise
    "Sure! Here is the translation: The tap is broken",
    "Translation: The tap is broken",
    '"The tap is broken"',
  ];
  for (const raw of cases.slice(1)) {
    const s = stubOllama(() => ({ translation: raw }));
    try {
      const r = await translate({ text: uniq("tap"), from: "ml-IN", to: "en-IN" });
      assert.equal(r.text, "The tap is broken", `failed to strip: ${raw}`);
    } finally { s.restore(); }
  }
});

test("a model that comments instead of translating is discarded, and the original survives", async () => {
  const original = uniq("പൈപ്പ് പൊട്ടി");
  const s = stubOllama(() => ({ translation: "I cannot translate this, but it seems like the user has a plumbing problem and should call someone." }));
  try {
    const r = await translate({ text: original, from: "ml-IN", to: "en-IN" });
    assert.equal(r.source, "failed", "commentary must not be presented as a translation");
    assert.equal(r.text, original, "the original is always preserved");
    assert.ok(r.note && r.note.length > 0, "the reader is told the translation is missing");
  } finally { s.restore(); }
});

test("when Ollama is unreachable the original is delivered with an honest note", async () => {
  const original = uniq("വെള്ളം നിറയുന്നു");
  const s = stubOllama(() => { throw new Error("ECONNREFUSED"); });
  try {
    const r = await translate({ text: original, from: "ml-IN", to: "ta-IN" });
    assert.equal(r.source, "failed");
    assert.equal(r.text, original);
    assert.equal(r.original, original);
    assert.match(r.note ?? "", /could not translate/i);
  } finally { s.restore(); }
});

test("a missing model falls through to the second model rather than failing", async () => {
  let n = 0;
  const s = stubOllama(() => {
    n += 1;
    if (n === 1) return new Response("not found", { status: 404 });
    return { translation: "Second model answered" };
  });
  try {
    const r = await translate({ text: uniq("fallback"), from: "ml-IN", to: "en-IN" });
    assert.equal(r.source, "ollama");
    assert.equal(r.text, "Second model answered");
    assert.equal(n, 2, "exactly one retry, on the smaller model");
  } finally { s.restore(); }
});

test("junk from the model never reaches a user", async () => {
  for (const bad of [{ nope: 1 }, { translation: 42 }, { translation: "   " }]) {
    const original = uniq("junk");
    const s = stubOllama(() => bad);
    try {
      const r = await translate({ text: original, from: "ml-IN", to: "en-IN" });
      assert.equal(r.source, "failed", `${JSON.stringify(bad)} should not be shown`);
      assert.equal(r.text, original);
    } finally { s.restore(); }
  }
});

test("an over-long message is not sent to the model at all", async () => {
  const s = stubOllama(() => ({ translation: "nope" }));
  try {
    const long = "അ".repeat(MAX_TRANSLATE_CHARS + 1);
    const r = await translate({ text: long, from: "ml-IN", to: "en-IN" });
    assert.equal(r.source, "failed");
    assert.equal(r.text, long);
    assert.equal(s.calls.length, 0);
  } finally { s.restore(); }
});

test("the same sentence is only translated once", async () => {
  let n = 0;
  // The stub must answer in the TARGET script, or the script guard rejects it and a fallback call is made —
  // which is exactly what this test is counting.
  const s = stubOllama(() => { n += 1; return { translation: "இது சேமிக்கப்பட்ட பதில்" }; });
  try {
    const phrase = uniq("repeat me");
    await translate({ text: phrase, from: "ml-IN", to: "ta-IN" });
    await translate({ text: phrase, from: "ml-IN", to: "ta-IN" });
    assert.equal(n, 1, "two workers on one job get the same sentence without a second round trip");
  } finally { s.restore(); }
});

test("a model that echoes the original back is not accepted as a translation", async () => {
  // The bug this guards, caught by running the app: qwen2.5:3b handed a Malayalam sentence for ml-IN -> ta-IN
  // returned it VERBATIM. Nothing else noticed — not commentary, not empty, not over-long — so the relay
  // labelled Malayalam as "தமிழ்" and read it down the phone to a Tamil speaker. Tamil with no Tamil letters
  // in it is not Tamil, and that is cheap to check.
  const malayalam = uniq("പൈപ്പ് മാറ്റി. ചോർച്ച നിന്നു.");
  const s = stubOllama(() => ({ translation: malayalam }));
  try {
    const r = await translate({ text: malayalam, from: "ml-IN", to: "ta-IN" });
    assert.equal(r.source, "failed", "echoed input must not be presented as a translation");
    assert.equal(r.text, malayalam, "the original still gets through");
    assert.ok(r.note, "and the reader is told it was not translated");
  } finally { s.restore(); }
});

test("a real translation into another script is accepted", async () => {
  const s = stubOllama(() => ({ translation: "குழாயை மாற்றிவிட்டேன். கசிவு நின்றுவிட்டது." }));
  try {
    const r = await translate({ text: uniq("പൈപ്പ് മാറ്റി"), from: "ml-IN", to: "ta-IN" });
    assert.equal(r.source, "ollama");
    assert.match(r.text, /[஀-௿]/, "output is in Tamil script");
  } finally { s.restore(); }
});

test("the script check covers every pair of scripts we support, and never fires within one script", async () => {
  const samples = {
    "ml-IN": "പൈപ്പ് ചോർച്ച", "ta-IN": "குழாய் கசிவு", "kn-IN": "ಕೊಳವೆ ಸೋರಿಕೆ",
    "te-IN": "పైపు లీకేజీ", "hi-IN": "पाइप रिसाव", "en-IN": "pipe leak",
  } as const;
  const codes = Object.keys(samples) as (keyof typeof samples)[];
  for (const from of codes) {
    for (const to of codes) {
      if (from === to) continue;
      // Echoing the source back must always be refused...
      const echo = stubOllama(() => ({ translation: samples[from] }));
      try {
        const r = await translate({ text: uniq(samples[from]), from, to });
        assert.equal(r.source, "failed", `${from}->${to}: an echo slipped through`);
      } finally { echo.restore(); }
      // ...and a genuine target-script answer must always be accepted.
      const good = stubOllama(() => ({ translation: samples[to] }));
      try {
        const r = await translate({ text: uniq(samples[from]), from, to });
        assert.equal(r.source, "ollama", `${from}->${to}: a good translation was rejected`);
      } finally { good.restore(); }
    }
  }
});

test("numbers and prices survive the script check", async () => {
  // A Tamil reply that quotes "800" and a name in Latin is still Tamil.
  const s = stubOllama(() => ({ translation: "குழாய் மாற்றப்பட்டது. ரூ 800 ஆகும். - Anjali" }));
  try {
    const r = await translate({ text: uniq("എണ്ണൂറ് രൂപ"), from: "ml-IN", to: "ta-IN" });
    assert.equal(r.source, "ollama", "digits and a Latin name must not trip the guard");
  } finally { s.restore(); }
});

test("answering in a THIRD language is refused, not passed off as the target", async () => {
  // Measured with gemma2:2b: asked for Malayalam -> Tamil it replies in ENGLISH. That output has no Tamil
  // letters and no Malayalam letters either, so a check that only compared the two scripts scored 0 vs 0 and
  // waved it through. A Tamil speaker would have been read English down the phone, labelled தமிழ்.
  const s = stubOllama(() => ({ translation: "I will be there in ten minutes." }));
  try {
    const r = await translate({ text: uniq("ഞാൻ പത്ത് മിനിറ്റിനുള്ളിൽ എത്തും"), from: "ml-IN", to: "ta-IN" });
    assert.equal(r.source, "failed", "English is not Tamil");
    assert.ok(r.note);
  } finally { s.restore(); }
});

test("a scriptless answer such as a bare price is still allowed through", async () => {
  const s = stubOllama(() => ({ translation: "450" }));
  try {
    const r = await translate({ text: uniq("നാനൂറ്റി അമ്പത്"), from: "ml-IN", to: "ta-IN" });
    assert.equal(r.source, "ollama", "digits belong to no script and must not be rejected");
  } finally { s.restore(); }
});

test("Malayalam to English gets a prompt that knows about Manglish", async () => {
  // Measured: told only "translate from Malayalam", gemma2:2b saw Latin letters, assumed the text was already
  // English, and invented a request — "almara vathil ilaki" (cupboard door loose) became "I need a plumber to
  // fix the tap", which dispatches the wrong trade. Naming Manglish took that set from 1/8 to 8/8.
  const s = stubOllama(() => ({ translation: "My pipe is leaking." }));
  try {
    const r = await translate({ text: uniq("ente pipe leak avunu"), from: "ml-IN", to: "en-IN" });
    assert.equal(r.source, "ollama");
    const sys = String(s.calls[0].system);
    assert.match(sys, /MANGLISH/, "the prompt must name Manglish explicitly");
    assert.match(sys, /ente pipe leak avunu/, "with worked examples of the common verbs");
    assert.match(sys, /same object/i, "and the rule that stops a cupboard becoming a window");
    assert.match(sys, /പൈപ്പ്/, "while still covering Malayalam script, which is what the mic produces");
  } finally { s.restore(); }
});

test("other language pairs keep the generic prompt", async () => {
  const s = stubOllama(() => ({ translation: "குழாய் கசிவு" }));
  try {
    await translate({ text: uniq("പൈപ്പ് ചോർച്ച"), from: "ml-IN", to: "ta-IN" });
    const sys = String(s.calls[0].system);
    assert.doesNotMatch(sys, /MANGLISH/, "the Manglish glossary is specific to the English pivot");
    assert.match(sys, /into Tamil/);
  } finally { s.restore(); }
});

test("Manglish passes the script guard, since both sides are Latin", async () => {
  // The guard compares scripts; Manglish in and English out are both Latin, so it must not fire here.
  const s = stubOllama(() => ({ translation: "The power is out, the fuse box is blown" }));
  try {
    const r = await translate({ text: uniq("current poyi, fuse pottiyennu thonnunnu"), from: "ml-IN", to: "en-IN" });
    assert.equal(r.source, "ollama", "a Latin-script answer to a Latin-script question is fine");
  } finally { s.restore(); }
});
