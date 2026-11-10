// Product auto-fill: deterministic suggestions from a product name and, when
// available, an Open Beauty Facts ingredient list. No AI is involved.
//
// Every suggestion is a draft the user must confirm. `is_active` is decided only
// by the reviewed active-ingredient table below, never by a model.
//
// SYNCED FILE: vercel-api/lib/product-identify.ts must be byte-identical
// (enforced by tests/product-identify.test.mjs). Edit here, then run
// `cp lib/product-identify.ts vercel-api/lib/product-identify.ts`.

export const IDENTIFY_SCHEMA_VERSION = 1 as const;
export const MAX_IDENTIFY_NAME_LENGTH = 120;
export const OBF_SEARCH_URL = "https://world.openbeautyfacts.org/cgi/search.pl";
export const OBF_USER_AGENT = "SkinRoutineCopilot/1.0 (+https://github.com/yanyan-milktea/skin-routine-copilot)";
export const OBF_TIMEOUT_MS = 4000;

export type IdentifyCategory = "cleanser" | "toner-essence" | "serum" | "treatment" | "moisturizer" | "sunscreen" | "other";
export type IdentifyTime = "morning" | "evening" | "both";

export type ActiveFamily = "AHA" | "BHA" | "PHA" | "Retinoid" | "Azelaic acid" | "Benzoyl peroxide" | "Vitamin C (L-ascorbic acid)";

export type DetectedActive = { family: ActiveFamily; ingredient: string };

export type IdentifySuggestion = {
  brand: string;
  name: string;
  category: IdentifyCategory;
  allowed_time: IdentifyTime;
  is_active: boolean;
  key_actives: DetectedActive[];
  ingredients_text: string | null;
};

export type IdentifySource = { provider: "Open Beauty Facts"; product_name: string; url: string; license: "ODbL" };

export type IdentifyResult = {
  schema_version: 1;
  status: "database_match" | "name_rules";
  suggestion: IdentifySuggestion;
  source: IdentifySource | null;
  reasons: string[];
  notes: string[];
};

// --- Reviewed active-ingredient table ------------------------------------------
// Matched as whole words, case-insensitive, against an ingredient list or name.
// Citric/malic acid are excluded on purpose: they are usually pH adjusters.
const ACTIVE_PATTERNS: readonly { family: ActiveFamily; ingredient: string; pattern: RegExp }[] = [
  { family: "AHA", ingredient: "Glycolic acid", pattern: /\bglycolic\s+acid\b/i },
  { family: "AHA", ingredient: "Lactic acid", pattern: /\blactic\s+acid\b/i },
  { family: "AHA", ingredient: "Mandelic acid", pattern: /\bmandelic\s+acid\b/i },
  { family: "AHA", ingredient: "AHA", pattern: /\bAHAs?\b|\balpha[-\s]hydroxy\s+acids?\b/i },
  { family: "BHA", ingredient: "Salicylic acid", pattern: /\bsalicylic\s+acid\b/i },
  { family: "BHA", ingredient: "Betaine salicylate", pattern: /\bbetaine\s+salicylate\b/i },
  { family: "BHA", ingredient: "BHA", pattern: /\bBHAs?\b|\bbeta[-\s]hydroxy\s+acids?\b/i },
  { family: "PHA", ingredient: "Gluconolactone", pattern: /\bgluconolactone\b/i },
  { family: "PHA", ingredient: "Lactobionic acid", pattern: /\blactobionic\s+acid\b/i },
  { family: "PHA", ingredient: "PHA", pattern: /\bPHAs?\b|\bpoly[-\s]hydroxy\s+acids?\b/i },
  { family: "Retinoid", ingredient: "Retinol", pattern: /\bretinol\b/i },
  { family: "Retinoid", ingredient: "Retinal", pattern: /\bretinal(?:dehyde)?\b/i },
  { family: "Retinoid", ingredient: "Retinyl ester", pattern: /\bretinyl\s+(?:palmitate|acetate|propionate|retinoate)\b/i },
  { family: "Retinoid", ingredient: "Hydroxypinacolone retinoate", pattern: /\bhydroxypinacolone\s+retinoate\b/i },
  { family: "Retinoid", ingredient: "Adapalene", pattern: /\badapalene\b/i },
  { family: "Retinoid", ingredient: "Tretinoin", pattern: /\btretinoin\b/i },
  { family: "Azelaic acid", ingredient: "Azelaic acid", pattern: /\bazelaic\s+acid\b|\bazelaic\b/i },
  { family: "Benzoyl peroxide", ingredient: "Benzoyl peroxide", pattern: /\bbenzoyl\s+peroxide\b/i },
  { family: "Vitamin C (L-ascorbic acid)", ingredient: "L-ascorbic acid", pattern: /(?<![\w-])(?<!ethyl\s)(?:l-)?ascorbic\s+acid\b/i },
];

/** Deduplicated actives found in `text`, in table order. */
export function detectActives(text: string): DetectedActive[] {
  const found: DetectedActive[] = [];
  for (const { family, ingredient, pattern } of ACTIVE_PATTERNS) {
    if (!pattern.test(text)) continue;
    // A generic "AHA"/"BHA"/"PHA" entry is redundant once a named ingredient of that family is found.
    if (ingredient === family && found.some((item) => item.family === family)) continue;
    if (!found.some((item) => item.ingredient === ingredient)) found.push({ family, ingredient });
  }
  return found;
}

// --- Category rules ------------------------------------------------------------
const NAME_CATEGORY_RULES: readonly { category: IdentifyCategory; pattern: RegExp }[] = [
  { category: "sunscreen", pattern: /\b(?:spf\s*\d*|sunscreen|sun\s*screen|sun\s*cream|sunblock|sun\s*block|sun\s*fluid|sun\s*stick|uv\s*(?:protect\w*|shield|defen[cs]e))\b/i },
  { category: "cleanser", pattern: /\b(?:cleanser|cleansing|face\s*wash|facial\s*wash|wash|foam|micellar|cleansing\s*(?:oil|balm))\b/i },
  { category: "toner-essence", pattern: /\b(?:toner|essence|tonic|lotion\s*toner|skin\s*softener|first\s*treatment\s*essence|mist)\b/i },
  { category: "serum", pattern: /\b(?:serum|ampoule|ampule|booster|concentrate)\b/i },
  { category: "treatment", pattern: /\b(?:treatment|spot|peel(?:ing)?|exfoliant|exfoliator)\b|\b\d+(?:\.\d+)?\s?%/i },
  { category: "moisturizer", pattern: /\b(?:moisturi[sz]er|moisturi[sz]ing|cream|creme|crème|lotion|emulsion|gel[-\s]?cream|balm|sleeping\s*(?:mask|pack))\b/i },
];

const OBF_CATEGORY_RULES: readonly { category: IdentifyCategory; tags: readonly string[] }[] = [
  { category: "sunscreen", tags: ["en:sunscreens", "en:sun-care", "en:sun-protection", "en:sunscreen"] },
  { category: "cleanser", tags: ["en:face-cleansers", "en:cleansers", "en:facial-cleansers", "en:makeup-removers", "en:micellar-waters"] },
  { category: "toner-essence", tags: ["en:toners", "en:facial-toners", "en:essences"] },
  { category: "serum", tags: ["en:serums", "en:face-serums", "en:facial-serums"] },
  { category: "moisturizer", tags: ["en:moisturizers", "en:face-creams", "en:moisturising-creams", "en:day-creams", "en:night-creams", "en:facial-creams"] },
];

/** First matching rule wins. Returns null when nothing matches. */
export function categoryFromName(name: string): IdentifyCategory | null {
  return NAME_CATEGORY_RULES.find((rule) => rule.pattern.test(name))?.category ?? null;
}

export function categoryFromTags(tags: readonly string[]): IdentifyCategory | null {
  const set = new Set(tags.map((tag) => tag.toLowerCase()));
  return OBF_CATEGORY_RULES.find((rule) => rule.tags.some((tag) => set.has(tag)))?.category ?? null;
}

/** Sunscreen is morning-only; retinoids, acids, azelaic acid, and benzoyl peroxide default to evening. */
export function timeFor(category: IdentifyCategory, actives: readonly DetectedActive[]): IdentifyTime {
  if (category === "sunscreen") return "morning";
  if (actives.some((active) => active.family !== "Vitamin C (L-ascorbic acid)")) return "evening";
  return "both";
}

// --- Input and matching --------------------------------------------------------

export function cleanProductName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length >= 2 && cleaned.length <= MAX_IDENTIFY_NAME_LENGTH ? cleaned : null;
}

const STOP = new Set(["the", "a", "an", "and", "for", "with", "of", "by", "de", "la", "le", "ml", "oz", "g", "fl"]);
export function nameTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((token) => token.length > 1 && !STOP.has(token) && !/^\d+(ml|g|oz)?$/.test(token));
}

/** Share of the query's tokens that appear in the candidate's brand + name. */
export function matchScore(query: string, candidate: string): number {
  const wanted = [...new Set(nameTokens(query))];
  if (wanted.length === 0) return 0;
  const have = new Set(nameTokens(candidate));
  return wanted.filter((token) => have.has(token)).length / wanted.length;
}

export const MIN_MATCH_SCORE = 0.6;

export type ObfProduct = { code: string; product_name: string; brands: string; ingredients_text: string; categories_tags: string[] };

/** Defensive parse of a search.pl JSON body; malformed entries are dropped. */
export function parseObfSearch(body: unknown): ObfProduct[] {
  const products = (body as { products?: unknown })?.products;
  if (!Array.isArray(products)) return [];
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
  return products.slice(0, 10).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const code = text(record.code, 32);
    const productName = text(record.product_name, 200);
    if (!/^\d{4,32}$/.test(code) || !productName) return [];
    const tags = Array.isArray(record.categories_tags) ? record.categories_tags.filter((tag): tag is string => typeof tag === "string").slice(0, 50) : [];
    return [{ code, product_name: productName, brands: text(record.brands, 200), ingredients_text: text(record.ingredients_text, 4000), categories_tags: tags }];
  });
}

export function bestObfMatch(query: string, products: readonly ObfProduct[]): ObfProduct | null {
  let best: { product: ObfProduct; score: number } | null = null;
  for (const product of products) {
    const score = matchScore(query, `${product.brands} ${product.product_name}`);
    if (score >= MIN_MATCH_SCORE && (!best || score > best.score)) best = { product, score };
  }
  return best?.product ?? null;
}

// --- Suggestion ----------------------------------------------------------------

const VERIFY_NOTE = "Suggested automatically. Check it against your product's label before saving.";

/** Builds the suggestion. With a database match, actives come from the ingredient list; otherwise from the name only. */
export function buildSuggestion(name: string, match: ObfProduct | null): IdentifyResult {
  const reasons: string[] = [];
  const notes = [VERIFY_NOTE];
  const ingredients = match?.ingredients_text || null;
  const activeText = ingredients ? `${ingredients} ${name}` : name;
  const actives = detectActives(activeText);
  let category = (match ? categoryFromTags(match.categories_tags) : null);
  if (category) reasons.push("Category from the database entry.");
  if (!category) {
    category = categoryFromName(match ? `${match.product_name} ${name}` : name);
    if (category) reasons.push("Category from words in the product name.");
  }
  if (!category && actives.length) { category = "treatment"; reasons.push("Category set to treatment because an active ingredient was found."); }
  if (!category) { category = "other"; notes.push("Could not tell the category from the name. Please choose one."); }
  if (actives.length) reasons.push(`Active ingredients found in the ${ingredients ? "ingredient list" : "product name"}: ${actives.map((active) => active.ingredient).join(", ")}.`);
  if (!ingredients) notes.push(match ? "The database entry has no ingredient list, so actives were checked from the name only." : "No database match was found, so actives were checked from the name only. Check the label for exfoliating acids, retinoids, or azelaic acid.");
  if (ingredients && actives.length) notes.push("Ingredient lists do not show concentration; an acid listed near the end may be a small pH adjuster.");
  const allowedTime = timeFor(category, actives);
  if (allowedTime === "morning") reasons.push("Sunscreen is used in the morning.");
  if (allowedTime === "evening") reasons.push("Exfoliating acids, retinoids, azelaic acid, and benzoyl peroxide default to evening use.");

  const brand = match?.brands.split(",")[0]?.trim().slice(0, 60) ?? "";
  return {
    schema_version: IDENTIFY_SCHEMA_VERSION,
    status: match ? "database_match" : "name_rules",
    suggestion: {
      brand,
      name: (match ? match.product_name : name).slice(0, 100),
      category,
      allowed_time: allowedTime,
      is_active: actives.length > 0,
      key_actives: actives,
      ingredients_text: ingredients ? ingredients.slice(0, 1200) : null,
    },
    source: match ? { provider: "Open Beauty Facts", product_name: match.product_name, url: `https://world.openbeautyfacts.org/product/${match.code}`, license: "ODbL" } : null,
    reasons,
    notes,
  };
}

type FetchLike = (input: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Searches Open Beauty Facts; any error, timeout, or non-200 returns [] so name rules still apply. */
export async function searchObf(name: string, fetchImpl: FetchLike, timeoutMs = OBF_TIMEOUT_MS): Promise<{ products: ObfProduct[]; error: string | null }> {
  const url = `${OBF_SEARCH_URL}?${new URLSearchParams({ search_terms: name, search_simple: "1", action: "process", json: "1", page_size: "5", fields: "code,product_name,brands,ingredients_text,categories_tags" })}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { "User-Agent": OBF_USER_AGENT, Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return { products: [], error: `OBF_HTTP_${response.status}` };
    return { products: parseObfSearch(await response.json()), error: null };
  } catch (error) {
    return { products: [], error: error instanceof Error && error.name === "AbortError" ? "OBF_TIMEOUT" : "OBF_UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
}

/** End to end: validate the name, search the database, and build a deterministic suggestion. */
export async function identifyProduct(rawName: unknown, fetchImpl: FetchLike): Promise<{ ok: true; result: IdentifyResult; lookup_error: string | null } | { ok: false; error: string }> {
  const name = cleanProductName(rawName);
  if (!name) return { ok: false, error: "Enter a product name between 2 and 120 characters." };
  const { products, error } = await searchObf(name, fetchImpl);
  return { ok: true, result: buildSuggestion(name, bestObfMatch(name, products)), lookup_error: error };
}
