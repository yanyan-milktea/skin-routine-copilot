import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  OBF_USER_AGENT,
  bestObfMatch,
  buildSuggestion,
  categoryFromName,
  categoryFromTags,
  cleanProductName,
  detectActives,
  identifyLogLine,
  identifyProduct,
  matchScore,
  productMatchScore,
  parseObfSearch,
  relaxedQuery,
  searchObf,
  spellingKey,
  timeFor,
} from "../lib/product-identify.ts";
import identifyApi from "../vercel-api/api/identify-product.ts";

const root = new URL("../", import.meta.url);
const ORIGIN = "https://skin-routine-copilot.gogogoyan.chatgpt.site";
const ingredients = (...names) => names.join(", ");
const families = (text) => detectActives(text).map((active) => active.ingredient);
const obfProduct = (overrides = {}) => ({ code: "8809000000001", product_name: "Dive-In Low Molecular Hyaluronic Acid Serum", brands: "Torriden", ingredients_text: ingredients("Water", "Butylene Glycol", "Glycerin", "Sodium Hyaluronate", "Panthenol"), categories_tags: ["en:serums"], ...overrides });
const okFetch = (body) => async (url, init) => ({ ok: true, status: 200, json: async () => body, url, init });

test("the API package copy is byte-identical to lib/product-identify.ts", async () => {
  const [main, copy] = await Promise.all([readFile(new URL("lib/product-identify.ts", root), "utf8"), readFile(new URL("vercel-api/lib/product-identify.ts", root), "utf8")]);
  assert.equal(copy, main, "run: cp lib/product-identify.ts vercel-api/lib/product-identify.ts");
});

test("active-ingredient table: named actives, generic labels, and deliberate exclusions", () => {
  assert.deepEqual(families(ingredients("Water", "Glycolic Acid", "Sodium Hydroxide")), ["Glycolic acid"]);
  assert.deepEqual(families("Paula's Choice 2% BHA Liquid Exfoliant"), ["BHA"]);
  assert.deepEqual(families(ingredients("Water", "Salicylic Acid", "Butylene Glycol")), ["Salicylic acid"]);
  assert.deepEqual(families("Salicylic Acid 2% BHA"), ["Salicylic acid"], "generic BHA is redundant once salicylic acid is named");
  assert.deepEqual(families("Retinol 0.3% in Squalane"), ["Retinol"]);
  assert.deepEqual(families(ingredients("Hydroxypinacolone Retinoate", "Retinyl Palmitate")), ["Retinyl ester", "Hydroxypinacolone retinoate"]);
  assert.deepEqual(families("Azelaic Acid 10%"), ["Azelaic acid"]);
  assert.deepEqual(families(ingredients("Water", "Gluconolactone")), ["Gluconolactone"]);
  assert.deepEqual(families(ingredients("Water", "Ascorbic Acid", "Ferulic Acid")), ["L-ascorbic acid"]);
  // Exclusions: pH adjusters and gentle vitamin C derivatives are not "potentially irritating actives".
  for (const text of [
    ingredients("Water", "Citric Acid", "Malic Acid"),
    ingredients("Water", "Sodium Ascorbyl Phosphate", "Ascorbyl Glucoside"),
    ingredients("Water", "3-O-Ethyl Ascorbic Acid"),
    ingredients("Water", "Niacinamide", "Sodium Hyaluronate", "Bakuchiol"),
    "Beauty of Joseon Relief Sun SPF50+",
  ]) assert.deepEqual(detectActives(text), [], text);
});

test("category from name covers the default shelf and common product names", () => {
  const cases = [
    ["Beplain Mung Bean Cleanser", "cleanser"],
    ["CeraVe Foaming Facial Cleanser", "cleanser"],
    ["Micro Essence", "toner-essence"],
    ["Anua Heartleaf 77% Soothing Toner", "toner-essence"],
    ["Torriden Dive-In Serum", "serum"],
    ["Tower 28 Beauty SOS Daily Hypochlorous Acid Spray for Breakouts & Redness", "spray"],
    ["Avène Thermal Spring Water Face Mist", "spray"],
    ["Heartleaf Toner Mist", "toner-essence"],
    ["Mediheal N.M.F Aquaring Sheet Mask", "mask"],
    ["Hydrating Face Masque", "mask"],
    ["Laneige Water Sleeping Mask", "moisturizer"],
    ["Supergoop Glow Screen Mist SPF 50", "sunscreen"],
    ["Azelaic Acid 10%", "treatment"],
    ["Paula's Choice 2% BHA Liquid Exfoliant", "treatment"],
    ["Lancôme Youth Activating Cream", "moisturizer"],
    ["Centella Sunscreen", "sunscreen"],
    ["Beauty of Joseon Relief Sun SPF50+", "sunscreen"],
    ["Torriden Dive-In", null],
  ];
  for (const [name, category] of cases) assert.equal(categoryFromName(name), category, name);
  assert.equal(categoryFromTags(["en:beauty", "en:sunscreens"]), "sunscreen");
  assert.equal(categoryFromTags(["en:beauty"]), null);
});

test("timing: sunscreen morning; acids, retinoids, azelaic acid evening; vitamin C alone stays flexible", () => {
  assert.equal(timeFor("sunscreen", detectActives("glycolic acid")), "morning");
  assert.equal(timeFor("serum", detectActives("retinol")), "evening");
  assert.equal(timeFor("treatment", detectActives("azelaic acid")), "evening");
  assert.equal(timeFor("serum", detectActives("ascorbic acid")), "both");
  assert.equal(timeFor("moisturizer", []), "both");
});

test("name-only suggestions mark actives deterministically and always ask the user to verify", () => {
  const retinol = buildSuggestion("The Ordinary Retinol 0.5% in Squalane", null);
  assert.equal(retinol.status, "name_rules");
  assert.equal(retinol.source, null);
  assert.deepEqual(retinol.suggestion.key_actives, [{ family: "Retinoid", ingredient: "Retinol" }]);
  assert.equal(retinol.suggestion.is_active, true);
  assert.equal(retinol.suggestion.allowed_time, "evening");
  assert.equal(retinol.suggestion.category, "treatment", "a % strength in the name reads as a treatment");
  assert.ok(retinol.notes[0].includes("Check it against your product's label"));
  assert.ok(retinol.notes.some((note) => note.includes("Without a database entry")));

  const unknown = buildSuggestion("Torriden Dive-In", null);
  assert.equal(unknown.suggestion.category, "other");
  assert.equal(unknown.suggestion.is_active, false);
  assert.ok(unknown.notes.some((note) => note.includes("choose one")));
});

test("a database match uses its category tags and ingredient list, and cites the source under ODbL", () => {
  const hidden = obfProduct({ product_name: "Gentle Renewing Cleanser", brands: "Example Brand, Parent Co", ingredients_text: ingredients("Water", "Glycerin", "Salicylic Acid", "Citric Acid"), categories_tags: ["en:face-cleansers"] });
  const result = buildSuggestion("Example Brand Gentle Renewing Cleanser", hidden);
  assert.equal(result.status, "database_match");
  assert.equal(result.suggestion.brand, "Example Brand");
  assert.equal(result.suggestion.category, "cleanser");
  assert.deepEqual(result.suggestion.key_actives, [{ family: "BHA", ingredient: "Salicylic acid" }], "found in the ingredient list, not the name");
  assert.equal(result.suggestion.is_active, true);
  assert.equal(result.suggestion.allowed_time, "evening");
  assert.deepEqual(result.source, { provider: "Open Beauty Facts", product_name: "Gentle Renewing Cleanser", url: "https://world.openbeautyfacts.org/product/8809000000001", license: "ODbL" });
  assert.ok(result.notes.some((note) => note.includes("concentration")));
});

test("database matching requires most query words; unrelated products are ignored", () => {
  const products = [obfProduct(), obfProduct({ code: "123456", product_name: "Hydrating Cleanser", brands: "Other" })];
  assert.equal(bestObfMatch("Torriden Dive-In Serum", products)?.code, "8809000000001");
  assert.equal(bestObfMatch("Torriden Dive-In", products)?.code, "8809000000001");
  assert.equal(bestObfMatch("Beplain Mung Bean Cleanser", products), null);
});

test("search response parsing drops malformed entries and bounds every field", () => {
  const parsed = parseObfSearch({ products: [obfProduct(), { code: "abc", product_name: "x" }, { code: "99999", product_name: "" }, null, { code: "55555", product_name: "Fine", ingredients_text: "a".repeat(9000), categories_tags: ["en:serums", 7] }] });
  assert.deepEqual(parsed.map((item) => item.code), ["8809000000001", "55555"]);
  assert.equal(parsed[1].ingredients_text.length, 4000);
  assert.deepEqual(parsed[1].categories_tags, ["en:serums"]);
  assert.deepEqual(parseObfSearch({ error: "x" }), []);
  assert.deepEqual(parseObfSearch("not json"), []);
});

test("search sends an identifying User-Agent, encodes the name, and degrades to name rules on any failure", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ products: [obfProduct()] }) }; };
  const { products, error } = await searchObf("Torriden & Co = serum?", fetchImpl);
  assert.equal(error, null);
  assert.equal(products.length, 1);
  assert.equal(calls[0].init.headers["User-Agent"], OBF_USER_AGENT);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://world.openbeautyfacts.org/cgi/search.pl");
  assert.equal(url.searchParams.get("search_terms"), "Torriden & Co = serum?");
  assert.equal(url.searchParams.get("page_size"), "5");

  assert.equal((await searchObf("x y", async () => ({ ok: false, status: 429, json: async () => ({}) }))).error, "OBF_HTTP_429");
  assert.equal((await searchObf("x y", async () => { throw new TypeError("network"); })).error, "OBF_UNAVAILABLE");
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  assert.equal((await searchObf("x y", hang, 10)).error, "OBF_TIMEOUT");

  const degraded = await identifyProduct("Azelaic Acid 10%", async () => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.equal(degraded.ok, true);
  assert.equal(degraded.result.status, "name_rules");
  assert.equal(degraded.result.suggestion.is_active, true);
  assert.equal(degraded.lookup_error, "OBF_HTTP_503");
  assert.equal(degraded.candidates, 0);
});

test("the diagnostic log line records the lookup outcome but never the product name", async () => {
  const found = await identifyProduct("Torriden Dive-In Serum", okFetch({ products: [obfProduct(), obfProduct({ code: "123456", product_name: "Other" })] }));
  const line = JSON.parse(identifyLogLine(found, 812.4));
  assert.deepEqual(line, { event: "identify_product", lookup_error: null, candidates: 2, relaxed: false, matched: true, elapsed_ms: 812 });

  const timedOut = await identifyProduct("Secret Brand Retinol Night Serum", async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
  const text = identifyLogLine(timedOut, 4001);
  assert.deepEqual(JSON.parse(text), { event: "identify_product", lookup_error: "OBF_TIMEOUT", candidates: 0, relaxed: false, matched: false, elapsed_ms: 4001 });
  for (const word of ["Secret", "Retinol", "Night", "Serum"]) assert.ok(!text.includes(word), `log must not contain "${word}"`);
});

test("names are bounded and cleaned", () => {
  assert.equal(cleanProductName("  Retinol\u0000 Serum  "), "Retinol Serum");
  assert.equal(cleanProductName("x"), null);
  assert.equal(cleanProductName("y".repeat(121)), null);
  assert.equal(cleanProductName(42), null);
});

test("API endpoint: CORS, method and body validation, and a full suggestion", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = okFetch({ products: [obfProduct()] });
  try {
    const post = (body, origin = ORIGIN) => identifyApi.fetch(new Request("http://localhost/api/identify-product", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const response = await post({ name: "Torriden Dive-In" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    const body = await response.json();
    assert.equal(body.result.status, "database_match");
    assert.equal(body.result.suggestion.category, "serum");
    assert.equal(body.result.suggestion.is_active, false);
    assert.equal(body.lookup_error, null);

    assert.equal((await post({ name: "Retinol", products: [] })).status, 400, "extra fields rejected");
    assert.equal((await post({ name: "" })).status, 400);
    assert.equal((await post({ name: "Retinol" }, "https://evil.example")).headers.get("access-control-allow-origin"), null);
    assert.equal((await identifyApi.fetch(new Request("http://localhost/api/identify-product", { method: "GET", headers: { origin: ORIGIN } }))).status, 405);
    const preflight = await identifyApi.fetch(new Request("http://localhost/api/identify-product", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    assert.equal(preflight.status, 204);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("British and American spellings compare equal; short words are left alone", () => {
  assert.equal(spellingKey("moisturising"), "moisturizing");
  assert.equal(spellingKey("moisturiser"), "moisturizer");
  assert.equal(spellingKey("colour"), "color");
  assert.equal(spellingKey("rise"), "rise");
  assert.equal(spellingKey("pm"), "pm");
  assert.equal(matchScore("CeraVe PM Facial Moisturizing Lotion", "CeraVe PM Facial Moisturising Lotion"), 1);
});

test("relaxed query keeps the first two words, and only when that is shorter", () => {
  assert.equal(relaxedQuery("CeraVe PM Daily Facial Moisturizing Lotion 52ml"), "cerave pm");
  assert.equal(relaxedQuery("Beplain Cleanser"), null);
  assert.equal(relaxedQuery("Retinol"), null);
});

const cerave = (code, product_name) => obfProduct({ code, product_name, brands: "CeraVe", ingredients_text: ingredients("Aqua", "Glycerin", "Niacinamide", "Ceramide NP"), categories_tags: ["en:face-moisturizers"] });
const scripted = (...responses) => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(new URL(url)); const next = responses[calls.length - 1]; if (next instanceof Error) throw next; return { ok: true, status: 200, json: async () => ({ products: next ?? [] }) }; };
  return { calls, fetchImpl };
};

test("an extra word or other spelling no longer hides a product: one relaxed retry finds it", async () => {
  const { calls, fetchImpl } = scripted([], [cerave("3337875597180", "Facial Moisturising Lotion AM SPF 30"), cerave("3337875597197", "PM Facial Moisturising Lotion")]);
  const outcome = await identifyProduct("CeraVe PM Daily Facial Moisturizing", fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get("search_terms"), "cerave pm");
  assert.equal(calls[1].searchParams.get("page_size"), "10");
  assert.equal(outcome.relaxed, true);
  assert.equal(outcome.candidates, 2);
  assert.equal(outcome.result.status, "database_match");
  assert.equal(outcome.result.source.product_name, "PM Facial Moisturising Lotion", "the PM lotion, not the AM sunscreen lotion");
  assert.equal(outcome.result.suggestion.category, "moisturizer");
  assert.equal(outcome.result.suggestion.is_active, false);
});

test("the relaxed retry is held to a stricter match, so a sibling product is not accepted", async () => {
  // Only the AM lotion comes back: it shares 3 of 5 words (0.6), enough for the first search but not the retry.
  const { calls, fetchImpl } = scripted([], [cerave("3337875597180", "Facial Moisturising Lotion AM SPF 30")]);
  const outcome = await identifyProduct("CeraVe PM Daily Facial Moisturizing", fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(outcome.result.status, "name_rules");
  assert.equal(outcome.result.suggestion.category, "moisturizer");
});

test("no retry when the first search matched, failed, or the name is already short", async () => {
  const matched = scripted([obfProduct()]);
  assert.equal((await identifyProduct("Torriden Dive-In Low Molecular Serum", matched.fetchImpl)).relaxed, false);
  assert.equal(matched.calls.length, 1);

  const failed = scripted(new TypeError("network"));
  const outcome = await identifyProduct("CeraVe PM Daily Facial Moisturizing", failed.fetchImpl);
  assert.equal(failed.calls.length, 1, "a database that is down is not asked twice");
  assert.equal(outcome.lookup_error, "OBF_UNAVAILABLE");

  const short = scripted([]);
  await identifyProduct("Beplain Cleanser", short.fetchImpl);
  assert.equal(short.calls.length, 1);
});

test("brand words alone never make a match: the product-name words must agree", () => {
  const fab = (code, product_name) => obfProduct({ code, product_name, brands: "First Aid Beauty" });
  const deep = fab("851939000001", "Deep Cleanser with Red Clay");
  const pure = fab("851939000002", "Pure Skin Face Cleanser");
  assert.ok(productMatchScore("First Aid Beauty Face Cleanser Face Cleanser", deep) < 0.6, "only 'cleanser' of face/cleanser agrees");
  assert.equal(bestObfMatch("First Aid Beauty Face Cleanser", [deep]), null);
  assert.equal(bestObfMatch("First Aid Beauty Face Cleanser", [deep, pure])?.code, "851939000002");
  assert.equal(bestObfMatch("First Aid Beauty", [deep, pure]), null, "a brand alone identifies nothing");
  const cerave = obfProduct({ code: "3337875597197", product_name: "PM Facial Moisturising Lotion", brands: "CeraVe" });
  assert.equal(productMatchScore("cerave pm", cerave), 1);
  assert.equal(productMatchScore("CeraVe PM Daily Facial Moisturizing", cerave), 0.75);
});

test("the sharper 400px database photo is preferred over the 200px one", () => {
  const big = "https://images.openbeautyfacts.org/images/products/851/939/000/0002/front_en.7.400.jpg";
  const small = "https://images.openbeautyfacts.org/images/products/851/939/000/0002/front_en.7.200.jpg";
  const [both, onlySmall, badBig] = parseObfSearch({ products: [
    { code: "1111", product_name: "A", image_front_url: big, image_front_small_url: small },
    { code: "2222", product_name: "B", image_front_small_url: small },
    { code: "3333", product_name: "C", image_front_url: "https://evil.example/a.jpg", image_front_small_url: small },
  ] });
  assert.equal(both.image_url, big);
  assert.equal(onlySmall.image_url, small);
  assert.equal(badBig.image_url, small, "an off-host URL is skipped, not trusted");
});
