export type Concern = "breakouts" | "oily" | "sensitive" | "redness" | "dry" | "dull";
export type ProviderMeta = { source: "ai" | "fallback"; provider: "gemini" | null; model: string | null; latency_ms: number; reason?: string };
export type RoutineStep = { time: string; name: string; detail: string; tag?: string };
export type RoutinePlan = { priority: string; note: string; morning: RoutineStep[]; evening: RoutineStep[]; warnings: string[]; need_professional_help: boolean };
export type HistoryEntry = { id: string; created_at: string; concerns: Concern[]; sleep: number; notes: string; plan: RoutinePlan; meta: ProviderMeta };
export type TrendSummary = { headline: string; overview: string; patterns: string[]; gentle_next_steps: string[]; disclaimer: string };

export const LIVE_SITE_ORIGIN = "https://skin-routine-copilot.gogogoyan.chatgpt.site";
export const PRODUCT_NAMES = {
  "water-cleanse": "Water rinse",
  "beplain-cleanser": "beplain Mung Bean Cleanser",
  "micro-essence": "Micro Essence",
  "torriden-serum": "Torriden Dive-In",
  "azelaic-acid": "Azelaic Acid 10%",
  "lancome-cream": "Lancôme Youth Activating Cream",
  "eltamd-sunscreen": "EltaMD UV Clear",
} as const;
export type ProductId = keyof typeof PRODUCT_NAMES;

const concerns = new Set<Concern>(["breakouts", "oily", "sensitive", "redness", "dry", "dull"]);
const allowedProducts = new Set<string>(Object.values(PRODUCT_NAMES));
const warningSignals = /persistent(?:ly)?\s+(?:stinging|burning)|(?:skin\s+)?(?:feels?\s+)?hot|damaged\s+skin|swelling|oozing|worsening\s+(?:rash|eczema)/i;
const medicalClaim = /\b(?:diagnos(?:e|ed|is|tic)|prescrib(?:e|ed|ing)|cure[sd]?|medical condition|disease|disorder|treat(?:s|ed|ment|ing)?|you have|indicates?\s+(?:acne|rosacea|eczema))\b/i;
const disclaimer = "This summary describes your saved check-ins only. It is not a diagnosis or medical advice.";

export function corsHeaders(request: Request, preflight = false): Headers {
  const headers = new Headers({ Vary: "Origin" });
  if (request.headers.get("origin") !== LIVE_SITE_ORIGIN) return headers;
  headers.set("Access-Control-Allow-Origin", LIVE_SITE_ORIGIN);
  if (preflight) {
    headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}
export const preflight = (request: Request) => new Response(null, { status: 204, headers: corsHeaders(request, true) });
export const json = (request: Request, value: unknown, status = 200) => Response.json(value, { status, headers: corsHeaders(request) });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const bounded = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && value.length <= max && (empty || value.trim().length > 0);

export function parseRoutineInput(value: unknown) {
  const body = isRecord(value) ? value : {};
  const selected = Array.isArray(body.concerns) ? body.concerns.filter((item): item is Concern => typeof item === "string" && concerns.has(item as Concern)).slice(0, 6) : [];
  const sleep = typeof body.sleep === "number" && body.sleep >= 1 && body.sleep <= 5 ? Math.round(body.sleep) : 3;
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";
  return { selected, sleep, notes };
}

export function fallbackRoutine(selected: Concern[], sleep: number, notes = ""): RoutinePlan {
  const calm = selected.includes("sensitive") || selected.includes("redness") || warningSignals.test(notes);
  const dry = selected.includes("dry");
  const oily = selected.includes("oily");
  const breakouts = selected.includes("breakouts");
  const morning: RoutineStep[] = [
    { time: "01", name: oily && !calm ? PRODUCT_NAMES["beplain-cleanser"] : PRODUCT_NAMES["water-cleanse"], detail: "Cleanse gently without disrupting the skin barrier.", tag: "Gentle" },
    { time: "02", name: PRODUCT_NAMES["micro-essence"], detail: "Pat on one light layer." },
    { time: "03", name: PRODUCT_NAMES["torriden-serum"], detail: dry ? "Apply two thin layers to tight areas." : "Apply one thin layer.", tag: "Hydrate" },
    { time: "04", name: PRODUCT_NAMES["eltamd-sunscreen"], detail: "Apply a generous final morning layer.", tag: "Essential" },
  ];
  const evening: RoutineStep[] = [
    { time: "01", name: PRODUCT_NAMES["beplain-cleanser"], detail: "Gently remove sunscreen and residue." },
    { time: "02", name: PRODUCT_NAMES["micro-essence"], detail: "Pat on one light layer." },
    { time: "03", name: PRODUCT_NAMES["torriden-serum"], detail: "Apply a thin hydrating layer.", tag: "Hydrate" },
  ];
  if (!calm && breakouts) evening.push({ time: "04", name: PRODUCT_NAMES["azelaic-acid"], detail: "Apply a thin layer to dry, comfortable skin.", tag: "Active" });
  evening.push({ time: String(evening.length + 1).padStart(2, "0"), name: PRODUCT_NAMES["lancome-cream"], detail: "Finish with a light moisturizing layer." });
  return {
    priority: calm ? "Reduce irritation · Support the barrier" : breakouts ? "Gentle breakout care · Avoid over-layering" : dry ? "Layer hydration · Ease tightness" : "Stay consistent · Prioritize sunscreen",
    note: sleep <= 2 ? "Sleep was limited. Keep the routine simple and avoid unfamiliar products." : calm ? "Sensitivity or redness was selected, so active treatment is paused." : "Continue with familiar products and stop anything that causes persistent stinging.",
    morning, evening,
    warnings: calm ? ["If irritation persists or worsens, stop active products and seek professional care."] : [],
    need_professional_help: warningSignals.test(notes),
  };
}

export function guardRoutine(plan: RoutinePlan, selected: Concern[], notes: string): RoutinePlan {
  const calm = selected.includes("sensitive") || selected.includes("redness") || warningSignals.test(notes);
  const clean = (steps: RoutineStep[], morning: boolean) => steps.filter((step) => allowedProducts.has(step.name)).filter((step) => !(step.name === PRODUCT_NAMES["azelaic-acid"] && (morning || calm))).slice(0, 6);
  const am = clean(plan.morning, true);
  const sunscreen = am.find((step) => step.name === PRODUCT_NAMES["eltamd-sunscreen"]) ?? { time: "00", name: PRODUCT_NAMES["eltamd-sunscreen"], detail: "Apply a generous final layer.", tag: "Essential" };
  return { ...plan, morning: [...am.filter((step) => step.name !== sunscreen.name), sunscreen].map(numberStep), evening: clean(plan.evening, false).map(numberStep), warnings: plan.warnings.slice(0, 3), need_professional_help: plan.need_professional_help || warningSignals.test(notes) };
}
const numberStep = (step: RoutineStep, index: number) => ({ ...step, time: String(index + 1).padStart(2, "0") });

function isStep(value: unknown): value is RoutineStep { return isRecord(value) && bounded(value.time, 8) && bounded(value.name, 80) && allowedProducts.has(value.name) && bounded(value.detail, 500) && (value.tag === undefined || bounded(value.tag, 80)); }
function isPlan(value: unknown): value is RoutinePlan { return isRecord(value) && bounded(value.priority, 300) && bounded(value.note, 1000) && Array.isArray(value.morning) && value.morning.length <= 6 && value.morning.every(isStep) && Array.isArray(value.evening) && value.evening.length <= 6 && value.evening.every(isStep) && Array.isArray(value.warnings) && value.warnings.length <= 3 && value.warnings.every((x) => bounded(x, 500)) && typeof value.need_professional_help === "boolean"; }
function isMeta(value: unknown): value is ProviderMeta { return isRecord(value) && (value.source === "ai" || value.source === "fallback") && (value.provider === "gemini" || value.provider === null) && (value.model === null || bounded(value.model, 120)) && typeof value.latency_ms === "number" && Number.isFinite(value.latency_ms) && value.latency_ms >= 0 && (value.reason === undefined || bounded(value.reason, 120)); }
export function isHistoryEntry(value: unknown): value is HistoryEntry { return isRecord(value) && bounded(value.id, 120) && typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at)) && Array.isArray(value.concerns) && value.concerns.length <= 6 && value.concerns.every((x) => typeof x === "string" && concerns.has(x as Concern)) && Number.isInteger(value.sleep) && Number(value.sleep) >= 1 && Number(value.sleep) <= 5 && bounded(value.notes, 500, true) && isPlan(value.plan) && isMeta(value.meta); }
export function parseHistoryInput(value: unknown): HistoryEntry[] { const body = isRecord(value) ? value : {}; return Array.isArray(body.entries) ? body.entries.filter(isHistoryEntry).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 7) : []; }

export function fallbackSummary(entries: HistoryEntry[]): TrendSummary {
  if (!entries.length) return { headline: "Your weekly pattern will appear here", overview: "No valid saved check-ins were supplied.", patterns: ["No saved patterns are available yet."], gentle_next_steps: ["Keep using the daily check-in when useful."], disclaimer };
  const counts = new Map<Concern, number>(); for (const entry of entries) for (const signal of entry.concerns) counts.set(signal, (counts.get(signal) ?? 0) + 1);
  const leading = [...counts].sort((a, b) => b[1] - a[1])[0];
  const average = entries.reduce((sum, entry) => sum + entry.sleep, 0) / entries.length;
  return { headline: leading ? `A week led by ${leading[0]}` : "A steady week of check-ins", overview: `Across ${entries.length} saved check-ins, the average sleep score was ${average.toFixed(1)}/5. This is descriptive, not a medical conclusion.`, patterns: [leading ? `${leading[0]} appeared most often (${leading[1]} of ${entries.length}).` : "No signal appeared consistently."], gentle_next_steps: ["Keep routines simple and compare patterns across several days."], disclaimer };
}
export function isTrendSummary(value: unknown): value is TrendSummary { const list = (x: unknown) => Array.isArray(x) && x.length >= 1 && x.length <= 4 && x.every((y) => bounded(y, 220)); return isRecord(value) && bounded(value.headline, 120) && bounded(value.overview, 600) && list(value.patterns) && list(value.gentle_next_steps) && bounded(value.disclaimer, 240); }
export function guardSummary(value: unknown, entries: HistoryEntry[]): TrendSummary { if (!isTrendSummary(value) || medicalClaim.test([value.headline, value.overview, ...value.patterns, ...value.gentle_next_steps].join(" "))) return fallbackSummary(entries); return { ...value, disclaimer }; }
