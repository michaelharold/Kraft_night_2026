/**
 * Sahaya keyword-rules triage — the fallback when Ollama is slow, unreachable, returns
 * invalid JSON or is unsure (README §4, CONTRACTS §7 "lib/triage-rules.ts").
 *
 * `triageByRules(text)` is pure, synchronous, never throws and returns in microseconds:
 * a handful of anchored, backtracking-free regexes over a normalised string.
 *
 * Algorithm
 * 1. Normalise: lowercase, drop apostrophes ("can't" → "cant"), turn every other
 *    punctuation mark into a space, collapse whitespace. Latin and Malayalam letters
 *    survive; only Manglish (Latin-script Malayalam) is matched, which is what people in
 *    Kollam actually type in a hurry.
 * 2. Score every NeedType from RULES: each `{ pattern, weight }` that matches adds its
 *    weight. Multi-word phrases weigh 3 (PHRASE), single words 1–2.
 * 3. Winner = highest score; ties → the type with the more urgent default urgency, then
 *    taxonomy order.
 * 4. Combination rule (README §3 example "Water is rising, my grandmother can't walk"):
 *    when BOTH flood_rescue and evacuation_mobility scored AND a mobility/vulnerability
 *    word (MOBILITY) is present, the type is evacuation_mobility even if the flood score
 *    is higher — the person is not asking for a swim, they need to be carried out.
 * 5. Confidence (CONTRACTS §7): no hit → other / high / 0.2; winning type's total weight
 *    < 2 → 0.45; 2–3 → 0.6; ≥ 4 or any phrase (weight ≥ 3) hit → 0.8.
 * 6. Urgency: "critical" when any CRITICAL phrase appears anywhere in the text, else the
 *    type's default (TYPE_DEFAULT_URGENCY); the no-hit case is "high" so an unreadable
 *    plea still gets a fast wave.
 * 7. skills = TYPE_SKILLS[type] (copied); summary = TYPE_LABELS[type] + ": " + first ~80
 *    chars of the cleaned text; clarifyingQuestion = CLARIFYING_QUESTION iff confidence
 *    < 0.5 (it never blocks dispatch — CONTRACTS §6).
 * 8. Upgrade (docs/UPGRADE.md §2, §5): `equipment = detectEquipmentByRules(text)` and
 *    `hazardAlert = hazardAlertFor(detectHazardByRules(text))`. Both detectors are exported
 *    because lib/triage.ts runs them on EVERY request: when the hazard rules fire they win
 *    over the model (deterministic), and rule equipment is unioned with the model's list.
 */
import { hazardAlertFor } from "./hazards";
import type { HazardKind } from "./hazards";
import type { Equipment, NeedType, TriageResult, Urgency } from "./types";
import { CLARIFYING_QUESTION, NEED_TYPES, TYPE_LABELS, TYPE_SKILLS, URGENCIES } from "./taxonomy";

type Rule = { pattern: RegExp; weight: number };

/** Weight of a multi-word phrase; any hit at or above this counts as a "phrase hit". */
const PHRASE = 3;

/** Longest input we bother scanning; anything past this cannot change a keyword decision. */
const MAX_SCAN_CHARS = 4000;

/** Length of the description excerpt used in the summary. */
const SUMMARY_CHARS = 80;

const NO_HIT_CONFIDENCE = 0.2;
const WEAK_CONFIDENCE = 0.45;
const MEDIUM_CONFIDENCE = 0.6;
const STRONG_CONFIDENCE = 0.8;
const CLARIFY_BELOW = 0.5;

/** "cant" is what normalisation turns "can't" into; the other spellings are typed as-is. */
const CANT = "(?:cant|cannot|can not|couldnt|could not|unable to|not able to)";

/** Word-bounded alternation. No `g` flag, so `.test()` carries no lastIndex state. */
function re(alternatives: string): RegExp {
  return new RegExp(`\\b(?:${alternatives})\\b`);
}

function rule(alternatives: string, weight: number): Rule {
  return { pattern: re(alternatives), weight };
}

/**
 * Keyword table. Single words: 1 (weak / ambiguous) or 2 (strong). Phrases: PHRASE (3).
 * Manglish entries are marked with the Malayalam meaning.
 */
const RULES: Record<NeedType, Rule[]> = {
  flood_rescue: [
    rule("flood|flooded|flooding|floods", 2),
    rule("vellapokkam|vellappokkam", 2), // flood
    rule("vellam|vellom", 2), // water
    rule("boat|boats|vallam", 2), // vallam = boat
    rule("drowning|drowned|drown", 2),
    rule("submerged|underwater|overflowing|overflow", 2),
    rule("water", 1),
    rule("rising|swim|current|river|canal|dam", 1),
    rule("water (?:is |level )?(?:rising|coming|entering|increasing|rose)", PHRASE),
    rule("rising (?:flood )?water|water rising fast|water till (?:neck|chest|waist)", PHRASE),
    rule("water (?:inside|in|entered|entering) (?:the |my |our )?(?:house|home|room)", PHRASE),
    rule("house (?:is )?flooded|home (?:is )?flooded|road (?:is )?flooded", PHRASE),
    rule("(?:on|at) the (?:roof|terrace)|stuck on (?:the )?(?:roof|terrace)", PHRASE),
    rule("swept away|washed away|need (?:a )?boat|vellam keri|vellam kayari", PHRASE), // vellam keri = water came in
  ],
  cardiac_no_breathing: [
    rule("unconscious|unresponsive|collapsed|fainted|cpr|cardiac", 2),
    rule("heart|pulse|breathing|breath|shwasam|swasam", 1), // shwasam = breath
    rule("not breathing|no breathing|isnt breathing|stopped breathing|breathing illa|breathing stopped", PHRASE),
    rule("shwasam illa|swasam illa|shwasam kittunnilla|swasam kittunnilla|shwasam mutti|swasam mutti", PHRASE), // no breath
    rule(`${CANT} breathe|no pulse|heart attack|chest pain|nenju vedana|passed out|not waking up|wont wake up|bodham illa`, PHRASE), // nenju vedana = chest pain, bodham illa = unconscious
    rule("breathing (?:difficulty|trouble|problem)|difficulty breathing|trouble breathing|short of breath|shortness of breath", PHRASE),
  ],
  bleeding: [
    rule("bleeding|bleeds|bleed|blood|wound|wounded|stabbed|stab|gash|laceration", 2),
    rule("raktham|rektham|chora|choora|murivu", 2), // raktham/chora = blood, murivu = wound
    rule("cut|injured|injury|accident", 1),
    rule("heavy bleeding|bleeding a lot|bleeding heavily|bleeding badly|lot of blood|lots of blood|too much blood", PHRASE),
    rule("deep cut|wont stop bleeding|not stopping|blood (?:is )?(?:coming|pouring|flowing)|chora varunnu|raktham varunnu", PHRASE), // chora varunnu = blood is coming
  ],
  fracture: [
    rule("fracture|fractured|broken|bone|bones|dislocated|dislocation", 2),
    rule("ellu|odinju|pottiyo|pottipoyi", 2), // ellu = bone, odinju = broke
    rule("bent|twisted", 2),
    rule("broke|fell|fall|sprain|sprained|swollen|swelling|bike|scooter|ladder", 1),
    rule("kaal odinju|kai odinju|ellu odinju|ellu potti", PHRASE), // leg/arm/bone broke
    rule("fell (?:from|off|down)|fallen (?:from|off|down)", PHRASE),
    rule("(?:leg|arm|hand|foot|ankle|wrist|hip|bone) (?:is )?(?:bent|broken|twisted|swollen)|broken (?:leg|arm|hand|foot|bone|hip)", PHRASE),
  ],
  electrical: [
    rule("electrocuted|electrocution|electric|electrical|electricity|shock|wire|wires|sparks|sparking|transformer", 2),
    rule("current|kambi|fuse|socket|plug|voltage|shocked", 1), // kambi = wire
    rule("live wire|short circuit|meter box|power line|electric pole|current pole|got (?:a |an )?(?:electric )?shock", PHRASE),
    rule("current adichu|shock adichu|current kayari|electric shock", PHRASE), // adichu = got hit
    rule("wire (?:is )?(?:down|fallen|hanging|broken)|fallen (?:wire|line|pole)", PHRASE),
  ],
  fire: [
    rule("fire|fires|smoke|burning|flames|flame|blaze|explosion|exploded", 2),
    rule("thee|theeyanu|theepiduthu|theepiduttham|kathunnu|puka", 2), // thee = fire, kathunnu = burning, puka = smoke
    rule("burn|burnt|burned|burns|gas", 1),
    rule("on fire|caught fire|fire spreading|gas leak|gas leaking|cylinder (?:blast|burst|exploded)|house (?:is )?burning", PHRASE),
    rule("thee pidichu|thee padarunnu|thee aanu|puka varunnu", PHRASE), // fire caught / spreading / smoke coming
  ],
  trapped_structural: [
    rule("trapped|rubble|debris|buried|landslide|landslip|collapse|pinned", 2),
    rule("kudungi|kudungiyirikkunnu|kudungippoyi|mannidichil|urulpottal", 2), // kudungi = stuck/trapped, mannidichil = landslide
    rule("stuck|crushed|wall|roof|ceiling|building|under", 1),
    rule("(?:building|house|wall|roof|ceiling|bridge|tree|slab) (?:has )?(?:collapsed|fell|fallen|came down|caved in)", PHRASE),
    rule(`trapped (?:under|inside|in|between)|stuck under|buried under|${CANT} get out|${CANT} come out|no way out`, PHRASE),
    rule("under (?:the )?(?:rubble|debris|wall|roof|building|tree)|mannu idinju|veedu idinju", PHRASE), // mannu idinju = earth collapsed, veedu idinju = house collapsed
  ],
  snakebite: [
    rule("snake|snakebite|cobra|viper|krait|venom|venomous", 2),
    rule("paambu|pambu|pamb|paamb|aravam", 2), // paambu = snake
    rule("bite|bitten|kadichu|kadi", 1), // kadichu = bit
    rule("snake bite|snake bit|bitten by (?:a )?snake|bit by (?:a )?snake|snake (?:has )?bitten", PHRASE),
    rule("paambu kadichu|pambu kadichu|paambu kadi|pambu kadi|paamb kadichu|pamb kadichu", PHRASE),
  ],
  evacuation_mobility: [
    rule("evacuate|evacuation|wheelchair|bedridden|paralysed|paralyzed|paralysis|pregnant|disabled|stretcher|ambulance|newborn|dialysis", 2),
    rule("muthassi|muthassan|ammoomma|ammumma|appooppan|appuppan|vayasan|vayasayi|garbhini", 2), // grandma / grandpa / old / pregnant
    rule("grandmother|grandfather|granny|grandma|grandpa|elderly|baby|infant|patient|carry|shift|vehicle|transport|amma|achan|ammachi|achachan", 1),
    rule("(?<!year )(?<!years )(?<!yr )(?<!yrs )old", 1), // "old lady" yes, "6 year old" no
    rule(`${CANT} walk|${CANT} move|${CANT} stand|${CANT} climb|not walking|nadakkan pattilla|nadakkan vayya|anangan pattilla`, PHRASE), // nadakkan pattilla = can't walk
    rule("bed ridden|ground floor|stuck on (?:the )?(?:\\w+ )?floor|on (?:the )?ground floor|need (?:a |an )?(?:vehicle|ambulance|transport|jeep|car)", PHRASE),
    rule("old (?:man|woman|lady|people|person|mother|father|age|aged)|very old|too old|(?:move|shift|carry) (?:him|her|them|the patient|my mother|my father)", PHRASE),
  ],
  supplies_oxygen_meds: [
    rule("oxygen|medicine|medicines|meds|medication|medications|insulin|inhaler|asthma|generator|supplies|marunnu", 2), // marunnu = medicine
    rule("tablets|tablet|prescription|pharmacy|cylinder|food|milk|diapers|sanitary|candles|torch|ration|diabetic|nebulizer|nebuliser", 1),
    rule("oxygen cylinder|oxygen (?:is )?(?:over|finished|running out|low|empty)|need oxygen|o2 cylinder", PHRASE),
    rule("drinking water|no food|baby food|no water to drink|power cut|no power|no electricity|no current|current illa|current poyi", PHRASE),
    rule("(?:bp|sugar|heart|pressure|thyroid|epilepsy) (?:medicine|tablets|tablet|meds)|medicine (?:is )?(?:over|finished|out)|marunnu illa|marunnu theernnu", PHRASE), // marunnu theernnu = medicine finished
  ],
  missing_person: [
    rule("missing|disappeared|wandered|lost", 2),
    rule("kaanunilla|kaanunnilla|kanunilla|kanunnilla|kaanmanilla|kanmanilla|kaanilla|kanilla", 2), // can't see / not found
    rule("search|searching|find|dementia|unreachable", 1),
    rule(`is missing|are missing|went missing|gone missing|${CANT} find|not found|nowhere|last seen`, PHRASE),
    rule("not (?:come|came) back|hasnt come back|havent come back|didnt (?:come|return)|not returned|no contact|not reachable|not answering|kaanan illa|kanan illa|kaanaanilla", PHRASE),
    rule("since (?:morning|evening|night|noon|afternoon|yesterday|last night|hours|\\d+ hours)", 2),
  ],
  other: [],
};

/**
 * Mobility / vulnerability words for the flood + mobility combination rule (step 4 in the
 * header). Kept as one regex so the rule reads as a single test.
 */
const MOBILITY = re(
  [
    `${CANT} walk`,
    `${CANT} move`,
    `${CANT} stand`,
    "not walking",
    "wheelchair",
    "bedridden",
    "bed ridden",
    "paralysed",
    "paralyzed",
    "paralysis",
    "grandmother",
    "grandfather",
    "granny",
    "grandma",
    "grandpa",
    "elderly",
    "(?<!year )(?<!years )(?<!yr )(?<!yrs )old",
    "baby",
    "infant",
    "newborn",
    "pregnant",
    "disabled",
    "patient",
    "dialysis",
    "stretcher",
    "stuck on (?:the )?(?:\\w+ )?floor",
    "muthassi",
    "muthassan",
    "ammoomma",
    "ammumma",
    "appooppan",
    "appuppan",
    "vayasan",
    "vayasayi",
    "garbhini",
    "nadakkan pattilla",
    "nadakkan vayya",
  ].join("|"),
);

/**
 * Phrases that force urgency "critical" regardless of type (CONTRACTS §7 list plus the
 * obvious spellings and Manglish forms). "water (is) rising" is included without "fast":
 * README §3 classifies "Water is rising, my grandmother can't walk" as critical.
 */
const CRITICAL = re(
  [
    "not breathing",
    "no breathing",
    "isnt breathing",
    "stopped breathing",
    "breathing illa",
    "shwasam illa",
    "swasam illa",
    `${CANT} breathe`,
    "unconscious",
    "unresponsive",
    "bodham illa",
    "collapsed",
    "no pulse",
    "heart attack",
    "chest pain",
    "nenju vedana",
    "passed out",
    "not waking up",
    "drowning",
    "drowned",
    "swept away",
    "washed away",
    "water rising fast",
    "water (?:is |level )?(?:rising|coming|entering|increasing)",
    "rising (?:flood )?water",
    "trapped",
    "kudungi",
    "buried",
    "landslide",
    "mannidichil",
    "fire",
    "on fire",
    "thee",
    "theepiduthu",
    "gas leak",
    "explosion",
    "heavy bleeding",
    "bleeding a lot",
    "bleeding heavily",
    "bleeding badly",
    "wont stop bleeding",
    "electrocuted",
    "current adichu",
    "shock adichu",
    "snake bite",
    "snake bit",
    "snakebite",
    "bitten by (?:a )?snake",
    "paambu kadichu",
    "pambu kadichu",
  ].join("|"),
);

/** Default urgency per type when no CRITICAL phrase is present (CONTRACTS §7). */
export const TYPE_DEFAULT_URGENCY: Record<NeedType, Urgency> = {
  cardiac_no_breathing: "critical",
  fire: "critical",
  flood_rescue: "critical",
  trapped_structural: "critical",
  snakebite: "critical",
  electrical: "critical",
  bleeding: "high",
  evacuation_mobility: "high",
  missing_person: "high",
  fracture: "medium",
  supplies_oxygen_meds: "medium",
  other: "medium",
};

/**
 * Lowercase, drop apostrophes (so "can't" → "cant", "won't" → "wont"), replace every other
 * punctuation mark with a space, collapse whitespace, trim. Exported for tests and for the
 * landmark matcher to reuse if it wants identical behaviour.
 */
export function normalizeText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .slice(0, MAX_SCAN_CHARS)
    .toLowerCase()
    .replace(/['‘’ʼ]/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Hidden scene hazards (docs/UPGRADE.md §2)
// ---------------------------------------------------------------------------

/**
 * Like normalizeText, but sentence punctuation survives as the clause marker " | " so that a
 * pattern can never join two clauses: "My father collapsed. Building 4" must not read as
 * "collapsed building". Hyphens become spaces ("first-aid kit", "fast-moving water").
 * Voice transcripts have no punctuation at all, so the patterns below are also written to be
 * safe without the marker.
 */
export function normalizeForScan(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .slice(0, MAX_SCAN_CHARS)
    .toLowerCase()
    .replace(/['‘’ʼ]/gu, "")
    .replace(/[.,;:!?\n\r]+/gu, " | ")
    .replace(/[^\p{L}\p{N}\s|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Same alternation as `re`, global, for stripping phrases before a cross-check. */
function reAll(alternatives: string): RegExp {
  return new RegExp(`\\b(?:${alternatives})\\b`, "g");
}

/** Places that are indoors: water in any of these means water around wiring and sockets. */
const INDOOR =
  "(?:basement|cellar|house|home|room|rooms|kitchen|bedroom|bathroom|hall|flat|apartment|shop|office|garage|godown|hostel|building|ground floor|first floor)";

/** Anything wet. Manglish: vellam = water, vellapokkam = flood. */
const WATER = re(
  "water|waters|flood|flooded|flooding|floods|waterlogged|submerged|wet|damp|leak|leaks|leaking|leakage|rainwater|vellam|vellom|vellapokkam|vellappokkam",
);

/**
 * Anything electrical. "current" is the Indian-English word for electricity, but in a flood it
 * also means the pull of the water, so it only counts when it is not "strong current" /
 * "water current" / "current is strong". "meter" does not count after a number ("2 meter deep").
 */
const ELECTRICAL = re(
  [
    "switch|switches|switchboard|socket|sockets|plug|plugs|plug point|wire|wires|wiring|cable|cables",
    "power(?! bank| banks)|inverter|fuse|breaker|mcb|transformer|electric|electrical|electricity|kambi", // kambi = wire
    "(?<!\\d )(?<!\\d)meter",
    "(?<!strong )(?<!fast )(?<!heavy )(?<!water )(?<!river )(?<!rivers )current(?! is (?:strong|fast|heavy|too)| too strong)",
  ].join("|"),
);

/** "No drinking water and no power" is a supplies request, not water near electricity. */
const NOT_A_WET_SCENE = reAll(
  [
    "drinking water|water to drink|water bottle|water bottles|water supply|no water",
    "power cut|power cuts|power outage|power failure|no power|no current|no electricity|without power|without electricity",
    "current illa|current poyi|(?:power|electricity|current) (?:is |has )?(?:gone|out|off)", // current illa = no electricity
  ].join("|"),
);

/** Live-electricity dangers that need no water at all. */
const LIVE_ELECTRICITY = re(
  [
    "live wire|live wires|live line|short circuit|electric shock|electrocuted|electrocution",
    "sparks|sparking|got (?:a |an )?(?:electric )?shock|current adichu|shock adichu|current kayari", // adichu = got hit
    "(?:wire|wires|line|cable) (?:is |are |has |have )?(?:down|fallen|hanging|broken|snapped)",
    "(?:fallen|snapped|broken|hanging) (?:electric |power )?(?:wire|wires|line|lines|cable|pole)",
  ].join("|"),
);

const INDOOR_FLOODING = re(
  [
    `${INDOOR} (?:\\w+ ){0,2}(?:flooded|flooding|waterlogged|submerged|under water|underwater)`,
    `(?:flooded|flooding|waterlogged|submerged) (?:\\w+ ){0,1}${INDOOR}`,
    `water (?:\\w+ ){0,3}(?:inside|in|into|entered|entering|filled|filling) (?:the |my |our |their )?${INDOOR}`,
    `${INDOOR} (?:\\w+ ){0,2}(?:full of|filled with|filling with) water`,
    "standing water|stagnant water|water on the floor|wet floor|water inside",
    "vellam keri|vellam kayari", // water came in
  ].join("|"),
);

/** Words allowed between a structure and its verb: "the wall HAS JUST collapsed", never "house FATHER collapsed". */
const AUX = "(?:(?:has|have|had|is|are|was|were|just|partly|partially|completely|fully|may|might|will|could|about|going|to|be|been) ){0,3}";
const STRUCTURE = "(?:building|buildings|house|wall|walls|roof|ceiling|pillar|pillars|beam|slab|bridge|balcony|foundation|compound wall|structure)";
/** No "house": "in my house father fell" is a fall, not a collapse. */
const STRUCTURE_PART = "(?:building|wall|walls|roof|ceiling|pillar|pillars|beam|slab|bridge|balcony|compound wall|structure)";
const VEHICLE = "(?:car|bike|bus|lorry|truck|vehicle|scooter|auto|autorickshaw|jeep|van|motorcycle|tempo|tipper)";

/**
 * Ordered hazard table: the FIRST kind whose pattern matches wins, so the order is a deliberate,
 * reviewable safety decision:
 *   1. fire_smoke before gas_leak — once something is burning, "get out, close doors" must not be
 *      replaced by the gas-leak advice to open doors and windows.
 *   2. gas_leak, then electrocution — the two hazards people cannot see.
 *   3. electrocution before fast_water — a flooded room with the power on is the hidden killer;
 *      moving water outside is at least visible.
 *   4. contaminated_water last — it is the only one that is not immediately life-threatening.
 * A PERSON collapsing is a medical emergency, never structural_collapse: "collapsed" only counts
 * right after a structure ("wall has collapsed") or as "the/under/in … collapsed building".
 */
const HAZARD_RULES: { kind: Exclude<HazardKind, "none" | "other">; patterns: RegExp[] }[] = [
  {
    kind: "fire_smoke",
    patterns: [
      re("(?<!no )(?<!not on )(?:fire|fires)(?! force| station| engine| brigade| service| department)"),
      re("smoke|smoky|flames|flame|blaze|ablaze|explosion|exploded|blast"),
      re("burning(?! sensation| pain| feeling)|caught fire"),
      re("thee|theeyanu|theepiduthu|theepiduttham|thee pidichu|kathunnu|puka"), // thee = fire, puka = smoke
    ],
  },
  {
    kind: "gas_leak",
    patterns: [
      re("lpg"),
      re("gas smell|smell(?:s|ing|ed)? (?:of |like )?(?:cooking |lpg )?gas|smell (?:\\w+ ){1,2}gas"),
      re("gas (?:is |was |has )?(?:leak|leaks|leaking|leakage|leaked)|leaking gas|leak of gas"),
      re("cylinder (?:is |was |has )?(?:leak|leaks|leaking|leakage|leaked)|gas cylinder (?:\\w+ ){0,2}leak\\w*"),
    ],
  },
  { kind: "electrocution", patterns: [INDOOR_FLOODING, LIVE_ELECTRICITY] }, // plus WATER × ELECTRICAL, see hazardOfScan
  {
    kind: "fast_water",
    patterns: [
      re("water (?:is |level |levels )?(?:rising|raising|increasing|rose)|rising (?:flood )?water|rising (?:fast|quickly|rapidly)"),
      re("(?:fast|strong|heavy|swift) (?:moving |flowing )?(?:water|current|currents|flow)|water current|river current|current is (?:strong|fast|heavy|too)"),
      // A river named as a landmark ("near the river bridge") is not a hazard. puzha = river.
      re("(?<!near )(?<!near the )(?<!by the )(?<!beside the )(?:river|rivers|canal|dam|puzha)(?! side| bridge| road| view)"),
      re("swept|washed away|carried away|flash flood|flash floods"),
    ],
  },
  {
    kind: "structural_collapse",
    patterns: [
      re(`${STRUCTURE} ${AUX}(?:collapse|collapsed|collapsing|caved in|giving way|tilting|leaning|sinking|crack|cracks|cracked|cracking)`),
      re(`${STRUCTURE_PART} ${AUX}(?:fell|fallen|came down)`),
      new RegExp(`(?:^|\\| |\\b(?:the|a|an|under|in|inside|from|of|partially|partly|half|fully) )(?:collapsed|collapsing) ${STRUCTURE}\\b`),
      re(`(?:fallen|damaged|cracked) ${STRUCTURE_PART}`),
      re(`(?:crack|cracks) (?:\\w+ ){0,3}(?:${STRUCTURE}|floor|ground|road)|(?:big|large|huge|new|wide|deep|long) (?:crack|cracks)|(?:crack|cracks) (?:is |are )?(?:appearing|widening|growing|spreading|developing)`),
      re("landslide|landslides|landslip|mudslide|rubble|debris|caved in|mannidichil|urulpottal|mannu idinju|veedu idinju"), // landslide / house collapsed
    ],
  },
  {
    kind: "chemical",
    patterns: [re("acid|chemical|chemicals|fumes|pesticide|pesticides|insecticide|ammonia|chlorine|toxic")],
  },
  {
    kind: "traffic",
    patterns: [
      re(`(?:road|highway|bypass|traffic|${VEHICLE}) accident|met with (?:an )?accident`),
      re("accident (?:\\w+ ){0,3}(?:road|highway|bypass|junction|nh)"),
      re(`${VEHICLE} (?:\\w+ ){0,2}(?:hit|crash|crashed|collided|collision|overturned|skidded|ran over)`),
      re(`hit by (?:a |an |the )?${VEHICLE}|hit and run|run over|knocked down by`),
    ],
  },
  {
    kind: "animal",
    patterns: [
      re("snake|snakes|snakebite|cobra|viper|krait|paambu|pambu|pamb|paamb"),
      re("(?:stray|street|mad|rabid|wild) dogs?|dogs? (?:bite|bit|bitten|attack|attacked|attacking|chasing|chased)|(?:bitten|attacked|chased) by (?:a |the )?dogs?|pack of dogs"),
      re("bee|bees|beehive|wasp|wasps|hornet|hornets|kadannal"), // kadannal = wasp
      re("elephant|elephants|kaattana|wild boar|leopard|tiger|crocodile"),
    ],
  },
  {
    kind: "contaminated_water",
    patterns: [
      re("sewage|sewer|septic|manhole|contaminated"),
      re("(?:drain|drains|drainage|gutter) (?:is |are |has |have )?(?:overflow|overflowing|overflowed|overflown|blocked|water)|overflowing (?:drain|drains|drainage|gutter)"),
      re("dirty (?:flood )?water|(?:flood )?water (?:is )?(?:dirty|black|stinking|smelly|contaminated)"),
    ],
  },
];

/** Hazard of a normalizeForScan() string. */
function hazardOfScan(scan: string): HazardKind {
  if (scan.length === 0) return "none";
  for (const { kind, patterns } of HAZARD_RULES) {
    if (patterns.some((p) => p.test(scan))) return kind;
    if (kind === "electrocution") {
      // Water anywhere near electricity: "rain water is dripping on the switchboard".
      const wet = scan.replace(NOT_A_WET_SCENE, " ");
      if (WATER.test(wet) && ELECTRICAL.test(wet)) return kind;
    }
  }
  return "none";
}

/**
 * Keyword hazard classifier (docs/UPGRADE.md §2). Pure, synchronous, never throws; "none" when
 * nothing fires. It never returns "other": that kind exists only for a model that reports a
 * hazard it cannot name. The words shown to the user come from lib/hazards.ts, never from here.
 */
export function detectHazardByRules(text: string): HazardKind {
  try {
    return hazardOfScan(normalizeForScan(text));
  } catch {
    return "none";
  }
}

// ---------------------------------------------------------------------------
// Equipment the situation specifically calls for (docs/UPGRADE.md §5)
// ---------------------------------------------------------------------------

/** Most equipment a request may ask for; keeps capabilityMatch's denominator honest. */
export const MAX_EQUIPMENT = 4;

/** A vehicle that is part of the accident ("car hit a tree") is not a request for transport. */
const NOT_THE_CASUALTY =
  "(?! accident| crash| crashed| hit| collided| overturned| skidded| fell| is stuck| stuck| sinking| sank| submerged| on fire| caught fire)";

/** "Trapped in the car", "wall fell on my car", "hit by a car": a car that is already in the story, not one to send. */
const NOT_SOMEONES = ["by", "on", "in", "under", "inside", "from"]
  .flatMap((prep) => [`(?<!${prep} a )`, `(?<!${prep} the )`])
  .concat(["(?<!my )", "(?<!his )", "(?<!her )", "(?<!our )", "(?<!their )"])
  .join("");

/** Checked in this order; the first MAX_EQUIPMENT hits are kept. */
const EQUIPMENT_RULES: { item: Equipment; pattern: RegExp }[] = [
  { item: "water_pump", pattern: re("(?<!petrol )(?<!diesel )(?<!fuel )(?:pump|pumps|pumpset|motor pump|dewatering)") }, // "near the petrol pump" is a landmark
  { item: "oxygen_cylinder", pattern: re("oxygen|o2") },
  { item: "stretcher_wheelchair", pattern: re("stretcher|stretchers|wheelchair|wheelchairs|wheel chair") },
  { item: "life_jacket", pattern: re("life jacket|life jackets|lifejacket|lifejackets|life vest|life vests|lifebuoy|life buoy|life ring") },
  { item: "rope_ladder", pattern: re("rope|ropes|(?<!from )(?<!from a )(?<!from the )(?<!off )(?<!off a )(?<!off the )(?:ladder|ladders)") }, // "fell from a ladder" needs a nurse, not a ladder
  { item: "chainsaw_cutter", pattern: re("chainsaw|chain saw|cutter|cutters|fallen tree|fallen trees|uprooted|tree (?:has |is |had |just )?(?:fell|fallen|came down)|tree (?:\\w+ ){0,2}blocking") },
  { item: "fire_extinguisher", pattern: re("extinguisher|extinguishers") },
  { item: "first_aid_kit", pattern: re("first aid (?:kit|box)|firstaid (?:kit|box)|medical kit|med kit|bandage|bandages|gauze|dressing") },
  { item: "torch_powerbank", pattern: re("torch|torches|flashlight|emergency light|power bank|power banks|powerbank|low battery|battery (?:is )?(?:dying|dead|low)") },
  {
    item: "car",
    pattern: re(
      `${NOT_SOMEONES}(?:car|cars|vehicle|vehicles|taxi|jeep)${NOT_THE_CASUALTY}|transport|transportation|ambulance`,
    ),
  },
];

function equipmentOfScan(scan: string): Equipment[] {
  const out: Equipment[] = [];
  if (scan.length === 0) return out;
  for (const { item, pattern } of EQUIPMENT_RULES) {
    if (out.length >= MAX_EQUIPMENT) break;
    if (pattern.test(scan)) out.push(item);
  }
  return out;
}

/**
 * Equipment named in the text ("need a pump" → water_pump). Pure, synchronous, never throws.
 * Only what the message asks for — the per-type defaults live in TYPE_EQUIPMENT (lib/taxonomy.ts).
 */
export function detectEquipmentByRules(text: string): Equipment[] {
  try {
    return equipmentOfScan(normalizeForScan(text));
  } catch {
    return [];
  }
}

type Score = { total: number; phrase: boolean };

function scoreType(text: string, rules: Rule[]): Score {
  let total = 0;
  let phrase = false;
  for (const r of rules) {
    if (r.pattern.test(text)) {
      total += r.weight;
      if (r.weight >= PHRASE) phrase = true;
    }
  }
  return { total, phrase };
}

/** Lower index = more urgent; used to break score ties in favour of the more urgent type. */
function urgencyRank(t: NeedType): number {
  return URGENCIES.indexOf(TYPE_DEFAULT_URGENCY[t]);
}

function pickType(scores: Record<NeedType, Score>): NeedType | null {
  let best: NeedType | null = null;
  for (const t of NEED_TYPES) {
    const s = scores[t].total;
    if (s <= 0) continue;
    if (best === null) {
      best = t;
      continue;
    }
    const b = scores[best].total;
    if (s > b || (s === b && urgencyRank(t) < urgencyRank(best))) best = t;
  }
  return best;
}

function confidenceFor(s: Score): number {
  if (s.phrase || s.total >= 4) return STRONG_CONFIDENCE;
  if (s.total >= 2) return MEDIUM_CONFIDENCE;
  return WEAK_CONFIDENCE;
}

function summaryFor(type: NeedType, cleaned: string): string {
  const label = TYPE_LABELS[type];
  if (cleaned.length === 0) return label;
  const excerpt = cleaned.length > SUMMARY_CHARS ? `${cleaned.slice(0, SUMMARY_CHARS).trimEnd()}…` : cleaned;
  return `${label}: ${excerpt}`;
}

function build(type: NeedType, urgency: Urgency, confidence: number, cleaned: string, raw: string): TriageResult {
  return {
    type,
    urgency,
    skills: [...TYPE_SKILLS[type]],
    summary: summaryFor(type, cleaned),
    confidence,
    source: "rules",
    clarifyingQuestion: confidence < CLARIFY_BELOW ? CLARIFYING_QUESTION : null,
    equipment: detectEquipmentByRules(raw),
    hazardAlert: hazardAlertFor(detectHazardByRules(raw)),
  };
}

function noHit(cleaned: string, raw: string): TriageResult {
  // Unreadable plea: still dispatch generalists fast and ask the one fixed question.
  return build("other", "high", NO_HIT_CONFIDENCE, cleaned, raw);
}

/**
 * Keyword-rules triage (README §4 fallback). Pure, synchronous, never throws.
 * Any non-string or empty input yields the no-hit result (`other` / `high` / 0.2).
 */
export function triageByRules(text: string): TriageResult {
  let cleaned = "";
  try {
    cleaned = normalizeText(text);
    if (cleaned.length === 0) return noHit(cleaned, text);

    const scores = {} as Record<NeedType, Score>;
    for (const t of NEED_TYPES) scores[t] = scoreType(cleaned, RULES[t]);

    let type = pickType(scores);
    if (type === null) {
      // No keyword hit; a critical phrase alone (unlikely, they are all keywords too) still lifts urgency.
      const r = noHit(cleaned, text);
      return CRITICAL.test(cleaned) ? { ...r, urgency: "critical" } : r;
    }

    // Combination rule (README §3): flood + mobility words → evacuation, not a swim.
    if (
      scores.flood_rescue.total > 0 &&
      scores.evacuation_mobility.total > 0 &&
      MOBILITY.test(cleaned)
    ) {
      type = "evacuation_mobility";
    }

    const urgency: Urgency = CRITICAL.test(cleaned) ? "critical" : TYPE_DEFAULT_URGENCY[type];
    return build(type, urgency, confidenceFor(scores[type]), cleaned, text);
  } catch {
    // Defensive only: nothing above should throw, but the fallback must never fail the request.
    return noHit(cleaned, text);
  }
}
