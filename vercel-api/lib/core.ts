export type Concern = "breakouts" | "oily" | "sensitive" | "redness" | "dry" | "dull";
export type ProviderMeta = { source: "ai" | "fallback"; provider: "gemini" | null; model: string | null; latency_ms: number; reason?: string };
export type ProductCategory = "cleanser" | "toner-essence" | "serum" | "treatment" | "moisturizer" | "sunscreen" | "other";
export type ProductTime = "morning" | "evening" | "both";
export type ShelfProduct = { id: string; brand: string; name: string; category: ProductCategory; allowed_time: ProductTime; is_active: boolean; usage_note: string; enabled: boolean };
export type RoutineStep = { time: string; name: string; detail: string; tag?: string; product_id?: string };
export type RoutinePlan = { priority: string; note: string; morning: RoutineStep[]; evening: RoutineStep[]; warnings: string[]; need_professional_help: boolean };
export type HistoryEntry = { id: string; created_at: string; concerns: Concern[]; sleep: number; notes: string; plan: RoutinePlan; meta: ProviderMeta };
export type TrendSummary = { headline: string; overview: string; patterns: string[]; gentle_next_steps: string[]; disclaimer: string };

export const LIVE_SITE_ORIGIN = "https://skin-routine-copilot.gogogoyan.chatgpt.site";
export const MAX_PRODUCTS = 30;
const concerns = new Set<Concern>(["breakouts", "oily", "sensitive", "redness", "dry", "dull"]);
const categories = new Set<ProductCategory>(["cleanser", "toner-essence", "serum", "treatment", "moisturizer", "sunscreen", "other"]);
const times = new Set<ProductTime>(["morning", "evening", "both"]);
const warningSignals = /persistent(?:ly)?\s+(?:stinging|burning)|(?:skin\s+)?(?:feels?\s+)?hot|damaged\s+skin|swelling|oozing|worsening\s+(?:rash|eczema)/i;
const medicalClaim = /\b(?:diagnos(?:e|ed|is|tic)|prescrib(?:e|ed|ing)|cure[sd]?|medical condition|disease|disorder|treat(?:s|ed|ment|ing)?|you have|indicates?\s+(?:acne|rosacea|eczema))\b/i;
const disclaimer = "This summary describes your saved check-ins only. It is not a diagnosis or medical advice.";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const bounded = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && value.length <= max && (empty || value.trim().length > 0);
const clean = (value: unknown, max: number, empty = false): string | null => {
  if (typeof value !== "string") return null;
  const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return result || empty ? result : null;
};

export function corsHeaders(request: Request, preflightRequest = false): Headers {
  const headers = new Headers({ Vary: "Origin" });
  if (request.headers.get("origin") !== LIVE_SITE_ORIGIN) return headers;
  headers.set("Access-Control-Allow-Origin", LIVE_SITE_ORIGIN);
  if (preflightRequest) { headers.set("Access-Control-Allow-Methods", "POST,OPTIONS"); headers.set("Access-Control-Allow-Headers", "Content-Type"); headers.set("Access-Control-Max-Age", "86400"); }
  return headers;
}
export const preflight = (request: Request) => new Response(null, { status: 204, headers: corsHeaders(request, true) });
export const json = (request: Request, value: unknown, status = 200) => Response.json(value, { status, headers: corsHeaders(request) });

export function displayName(product: ShelfProduct): string {
  return !product.brand || product.name.toLowerCase().startsWith(product.brand.toLowerCase()) ? product.name : `${product.brand} ${product.name}`;
}

export function validateProducts(value: unknown): ShelfProduct[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const products: ShelfProduct[] = [];
  for (const item of value.slice(0, MAX_PRODUCTS)) {
    if (!isRecord(item)) continue;
    const id = clean(item.id, 80), brand = clean(item.brand, 60, true), name = clean(item.name, 100), note = clean(item.usage_note, 180, true);
    if (!id || brand === null || !name || note === null || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(id) || seen.has(id)) continue;
    if (typeof item.category !== "string" || !categories.has(item.category as ProductCategory) || typeof item.allowed_time !== "string" || !times.has(item.allowed_time as ProductTime) || typeof item.is_active !== "boolean" || typeof item.enabled !== "boolean") continue;
    seen.add(id); products.push({ id, brand, name, category: item.category as ProductCategory, allowed_time: item.allowed_time as ProductTime, is_active: item.is_active, usage_note: note, enabled: item.enabled });
  }
  return products;
}

export function parseRoutineInput(value: unknown) {
  const body = isRecord(value) ? value : {};
  const selected = Array.isArray(body.concerns) ? body.concerns.filter((item): item is Concern => typeof item === "string" && concerns.has(item as Concern)).slice(0, 6) : [];
  const sleep = typeof body.sleep === "number" && body.sleep >= 1 && body.sleep <= 5 ? Math.round(body.sleep) : 3;
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";
  return { selected, sleep, notes, products: validateProducts(body.products) };
}

const allowedAt = (product: ShelfProduct, period: "morning" | "evening") => product.allowed_time === "both" || product.allowed_time === period;
const calmDay = (selected: Concern[], notes: string) => selected.includes("sensitive") || selected.includes("redness") || warningSignals.test(notes);
const categoryOrder: ProductCategory[] = ["cleanser", "toner-essence", "serum", "treatment", "moisturizer", "other", "sunscreen"];
const productDetail = (product: ShelfProduct) => product.usage_note || ({ cleanser: "Cleanse gently without scrubbing.", "toner-essence": "Pat on one light layer.", serum: "Apply one thin layer.", treatment: "Use a small amount only on comfortable skin.", moisturizer: "Apply a light layer to seal in moisture.", sunscreen: "Apply generously as the final morning step.", other: "Use according to your saved note." } satisfies Record<ProductCategory, string>)[product.category];

function eligible(products: ShelfProduct[], selected: Concern[], notes: string, period: "morning" | "evening") {
  const calm = calmDay(selected, notes);
  return products.filter((product) => product.enabled && allowedAt(product, period) && !(calm && product.is_active) && !(product.is_active && !selected.includes("breakouts")) && (period === "morning" || product.category !== "sunscreen")).sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category)).slice(0, 6);
}
const steps = (products: ShelfProduct[]) => products.map((product, index) => ({ time: String(index + 1).padStart(2, "0"), product_id: product.id, name: displayName(product), detail: productDetail(product), ...(product.is_active ? { tag: "Active" } : product.category === "sunscreen" ? { tag: "Essential" } : {}) }));
function limitations(products: ShelfProduct[], selected: Concern[], notes: string) {
  const active = products.filter((product) => product.enabled && !(calmDay(selected, notes) && product.is_active));
  const missing: string[] = [];
  if (!active.some((product) => product.category === "cleanser" && allowedAt(product, "evening"))) missing.push("an evening cleanser");
  if (!active.some((product) => product.category === "moisturizer" && allowedAt(product, "evening"))) missing.push("an evening moisturizer");
  if (!active.some((product) => product.category === "sunscreen" && allowedAt(product, "morning"))) missing.push("a morning sunscreen");
  return missing;
}

export function fallbackRoutine(selected: Concern[], sleep: number, notes: string, products: ShelfProduct[]): RoutinePlan {
  const calm = calmDay(selected, notes), missing = limitations(products, selected, notes);
  const base = sleep <= 2 ? "Sleep was limited. Keep the routine simple and avoid unfamiliar products." : calm ? "Sensitivity or irritation signals were selected, so active products are paused." : "This deterministic routine uses only enabled products from your browser-private shelf.";
  return { priority: calm ? "Reduce irritation · Keep the routine gentle" : selected.includes("breakouts") ? "Gentle breakout care · Avoid over-layering" : selected.includes("dry") ? "Layer hydration · Ease tightness" : "Stay consistent · Use your enabled shelf", note: `${base}${missing.length ? ` Your enabled shelf is missing ${missing.join(", ")}; the routine stays incomplete rather than inventing a product.` : ""}`, morning: steps(eligible(products, selected, notes, "morning")), evening: steps(eligible(products, selected, notes, "evening")), warnings: calm ? ["If irritation persists or worsens, stop active products and seek professional care."] : [], need_professional_help: warningSignals.test(notes) };
}

export function guardRoutine(plan: RoutinePlan, selected: Concern[], notes: string, products: ShelfProduct[]): RoutinePlan {
  const enabled = products.filter((product) => product.enabled), byId = new Map(enabled.map((product) => [product.id, product]));
  const byName = new Map<string, ShelfProduct | null>(); for (const product of enabled) { const name = displayName(product); byName.set(name, byName.has(name) ? null : product); }
  const cleanSteps = (input: RoutineStep[], period: "morning" | "evening") => { const used = new Set<string>(); return input.flatMap((step) => { const product = (step.product_id ? byId.get(step.product_id) : undefined) ?? byName.get(step.name); if (!product || used.has(product.id) || !allowedAt(product, period) || (calmDay(selected, notes) && product.is_active) || (period === "evening" && product.category === "sunscreen")) return []; used.add(product.id); return [{ ...step, product_id: product.id, name: displayName(product), detail: step.detail.slice(0, 500), ...(step.tag ? { tag: step.tag.slice(0, 80) } : {}) }]; }).slice(0, 6); };
  let morning = cleanSteps(plan.morning, "morning"); const evening = cleanSteps(plan.evening, "evening");
  const sunscreen = enabled.find((product) => product.category === "sunscreen" && allowedAt(product, "morning") && !(calmDay(selected, notes) && product.is_active));
  if (sunscreen) { const found = morning.find((step) => step.product_id === sunscreen.id) ?? { time: "00", product_id: sunscreen.id, name: displayName(sunscreen), detail: productDetail(sunscreen), tag: "Essential" }; morning = [...morning.filter((step) => byId.get(step.product_id ?? "")?.category !== "sunscreen"), found]; } else morning = morning.filter((step) => byId.get(step.product_id ?? "")?.category !== "sunscreen");
  const number = (step: RoutineStep, index: number) => ({ ...step, time: String(index + 1).padStart(2, "0") });
  return { ...plan, morning: morning.map(number), evening: evening.map(number), warnings: Array.from(new Set([...plan.warnings, ...(calmDay(selected, notes) ? ["Barrier protection is on: active and treatment products are paused."] : [])])).slice(0, 3), need_professional_help: plan.need_professional_help || warningSignals.test(notes) };
}

function isStep(value: unknown): value is RoutineStep { return isRecord(value) && bounded(value.time, 8) && bounded(value.name, 100) && bounded(value.detail, 500) && (value.tag === undefined || bounded(value.tag, 80)) && (value.product_id === undefined || bounded(value.product_id, 80)); }
function isPlan(value: unknown): value is RoutinePlan { return isRecord(value) && bounded(value.priority, 300) && bounded(value.note, 1000) && Array.isArray(value.morning) && value.morning.length <= 6 && value.morning.every(isStep) && Array.isArray(value.evening) && value.evening.length <= 6 && value.evening.every(isStep) && Array.isArray(value.warnings) && value.warnings.length <= 3 && value.warnings.every((x) => bounded(x, 500)) && typeof value.need_professional_help === "boolean"; }
function isMeta(value: unknown): value is ProviderMeta { return isRecord(value) && (value.source === "ai" || value.source === "fallback") && (value.provider === "gemini" || value.provider === null) && (value.model === null || bounded(value.model, 120)) && typeof value.latency_ms === "number" && Number.isFinite(value.latency_ms) && value.latency_ms >= 0 && (value.reason === undefined || bounded(value.reason, 120)); }
export function isHistoryEntry(value: unknown): value is HistoryEntry { return isRecord(value) && bounded(value.id, 120) && typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at)) && Array.isArray(value.concerns) && value.concerns.length <= 6 && value.concerns.every((x) => typeof x === "string" && concerns.has(x as Concern)) && Number.isInteger(value.sleep) && Number(value.sleep) >= 1 && Number(value.sleep) <= 5 && bounded(value.notes, 500, true) && isPlan(value.plan) && isMeta(value.meta); }
export function parseHistoryInput(value: unknown): HistoryEntry[] { const body = isRecord(value) ? value : {}; return Array.isArray(body.entries) ? body.entries.filter(isHistoryEntry).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 7) : []; }

export function fallbackSummary(entries: HistoryEntry[]): TrendSummary { if (!entries.length) return { headline: "Your weekly pattern will appear here", overview: "No valid saved check-ins were supplied.", patterns: ["No saved patterns are available yet."], gentle_next_steps: ["Keep using the daily check-in when useful."], disclaimer }; const counts = new Map<Concern, number>(); for (const entry of entries) for (const signal of entry.concerns) counts.set(signal, (counts.get(signal) ?? 0) + 1); const leading = [...counts].sort((a, b) => b[1] - a[1])[0]; const average = entries.reduce((sum, entry) => sum + entry.sleep, 0) / entries.length; return { headline: leading ? `A week led by ${leading[0]}` : "A steady week of check-ins", overview: `Across ${entries.length} saved check-ins, the average sleep score was ${average.toFixed(1)}/5. This is descriptive, not a medical conclusion.`, patterns: [leading ? `${leading[0]} appeared most often (${leading[1]} of ${entries.length}).` : "No signal appeared consistently."], gentle_next_steps: ["Keep routines simple and compare patterns across several days."], disclaimer }; }
export function isTrendSummary(value: unknown): value is TrendSummary { const list = (x: unknown) => Array.isArray(x) && x.length >= 1 && x.length <= 4 && x.every((y) => bounded(y, 220)); return isRecord(value) && bounded(value.headline, 120) && bounded(value.overview, 600) && list(value.patterns) && list(value.gentle_next_steps) && bounded(value.disclaimer, 240); }
export function guardSummary(value: unknown, entries: HistoryEntry[]): TrendSummary { if (!isTrendSummary(value) || medicalClaim.test([value.headline, value.overview, ...value.patterns, ...value.gentle_next_steps].join(" "))) return fallbackSummary(entries); return { ...value, disclaimer }; }
