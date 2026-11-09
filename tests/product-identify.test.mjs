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
  identifyProduct,
  parseObfSearch,
  searchObf,
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
  assert.ok(retinol.notes.some((note) => note.includes("No database match")));

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
