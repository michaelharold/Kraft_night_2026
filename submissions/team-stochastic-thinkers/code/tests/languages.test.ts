import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LANGUAGE, FALLBACK_LANGUAGE, LANGUAGES, LANGUAGE_MENU, MAX_SPEECH_SECONDS,
  isLanguage, languageForDigit, languageLabel, languageOf,
} from "../lib/languages";

test("every language carries the three codes a call needs", () => {
  for (const l of LANGUAGES) {
    assert.match(l.code, /^[a-z]{2}-IN$/, `${l.code} is not a BCP-47 India tag`);
    assert.equal(l.stt, l.code, `${l.code}: Twilio <Gather> language must match the tag`);
    assert.equal(l.sayLang, l.code, `${l.code}: <Say> language must match the tag`);
    // A wrong voice id yields a SILENT call, which is the worst possible failure here.
    assert.match(l.voice, /^Google\.[a-z]{2}-IN-(Standard|Wavenet|Neural2|Chirp3-HD)-/, `${l.code}: ${l.voice} is not a Google voice id`);
    assert.ok(l.voice.includes(l.code), `${l.code}: voice ${l.voice} belongs to another language`);
    assert.ok(l.endonym.length > 0 && l.english.length > 0);
  }
});

test("codes are unique and the defaults are real languages", () => {
  const codes = LANGUAGES.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length, "duplicate language code");
  assert.ok(isLanguage(DEFAULT_LANGUAGE));
  assert.ok(isLanguage(FALLBACK_LANGUAGE));
  assert.equal(DEFAULT_LANGUAGE, "ml-IN", "Sahaya is built for Kerala first");
});

test("an unknown or missing code never throws — it falls back", () => {
  assert.equal(languageOf(null).code, DEFAULT_LANGUAGE);
  assert.equal(languageOf(undefined).code, DEFAULT_LANGUAGE);
  assert.equal(languageOf("").code, DEFAULT_LANGUAGE);
  assert.equal(languageOf("klingon").code, DEFAULT_LANGUAGE);
  assert.equal(languageOf("ta-IN").code, "ta-IN");
});

test("guards reject junk", () => {
  for (const junk of [null, undefined, 42, {}, "en", "ml", "ML-IN"]) assert.equal(isLanguage(junk), false, `${String(junk)}`);
});

test("the phone menu is 1..n in order and maps back", () => {
  assert.equal(LANGUAGE_MENU.length, LANGUAGES.length);
  LANGUAGE_MENU.forEach((l, i) => assert.equal(l.digit, String(i + 1)));
  assert.equal(languageForDigit("1"), "ml-IN", "press 1 is always Malayalam");
  assert.equal(languageForDigit(" 2 "), "ta-IN", "Twilio digits can arrive padded");
  for (const junk of ["0", "9", "", "#", null, undefined]) assert.equal(languageForDigit(junk), null, `${String(junk)}`);
});

test("labels lead with the endonym, and English does not read twice", () => {
  assert.equal(languageLabel("ml-IN"), "മലയാളം (Malayalam)");
  assert.equal(languageLabel("en-IN"), "English");
  assert.equal(languageLabel("nonsense"), languageLabel(DEFAULT_LANGUAGE));
});

test("the 60 second speech ceiling is stated, because prompts must promise it", () => {
  assert.equal(MAX_SPEECH_SECONDS, 60, "Twilio caps <Gather input=speech> at 60s");
});
