import { DEFAULT_SHELF, enabledShelf, productDisplayName, type ShelfProduct } from "./shelf.ts";

export type Concern = "breakouts" | "oily" | "sensitive" | "redness" | "dry" | "dull";

export type RoutineStep = {
  time: string;
  name: string;
  detail: string;
  tag?: string;
  product_id?: string;
};

export type RoutinePlan = {
  priority: string;
  note: string;
  morning: RoutineStep[];
  evening: RoutineStep[];
  warnings: string[];
  need_professional_help: boolean;
};

export type RoutineResponse = {
  plan: RoutinePlan;
  meta: {
    source: "ai" | "fallback";
    provider: "gemini" | "openai" | null;
    model: string | null;
    latency_ms: number;
    reason?: string;
  };
};

/** Seed names retained as a compatibility export for older history and integrations. */
export const PRODUCT_NAMES = Object.fromEntries(DEFAULT_SHELF.map((product) => [product.id, productDisplayName(product)])) as Record<string, string>;
export type ProductId = string;

const warningSignals = /persistent(?:ly)?\s+(?:stinging|burning)|(?:skin\s+)?(?:feels?\s+)?hot|damaged\s+skin|swelling|oozing|worsening\s+(?:rash|eczema)|持续.{0,3}(?:刺痛|发热)|明显(?:肿胀|渗液)|破损|加重.{0,3}(?:皮疹|湿疹)/i;
const categoryOrder = ["cleanser", "toner-essence", "serum", "treatment", "moisturizer", "other", "sunscreen"];

function isCalmDay(selected: Concern[], notes: string): boolean {
  return selected.includes("sensitive") || selected.includes("redness") || warningSignals.test(notes);
}

function allowedAt(product: ShelfProduct, period: "morning" | "evening"): boolean {
  return product.allowed_time === "both" || product.allowed_time === period;
}

function detailFor(product: ShelfProduct, period: "morning" | "evening"): string {
  if (product.usage_note) return product.usage_note;
  const copy: Record<ShelfProduct["category"], string> = {
    cleanser: "Cleanse gently without scrubbing or aiming for a squeaky finish.",
    "toner-essence": "Pat on one light layer.",
    serum: "Apply one thin layer.",
    treatment: "Use a small amount only on comfortable skin.",
    moisturizer: "Apply a light layer to seal in moisture.",
    sunscreen: "Apply generously as the final morning step.",
    other: `Use according to your saved ${period} note.`,
  };
  return copy[product.category];
}

function routineProducts(shelf: ShelfProduct[], selected: Concern[], notes: string, period: "morning" | "evening"): ShelfProduct[] {
  const calm = isCalmDay(selected, notes);
  return enabledShelf(shelf)
    .filter((product) => allowedAt(product, period))
    .filter((product) => !(calm && product.is_active))
    .filter((product) => !(product.is_active && !selected.includes("breakouts")))
    .filter((product) => period === "morning" || product.category !== "sunscreen")
    .sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category))
    .slice(0, 6);
}

function toSteps(products: ShelfProduct[], period: "morning" | "evening"): RoutineStep[] {
  return products.map((product, index) => ({
    time: String(index + 1).padStart(2, "0"),
    product_id: product.id,
    name: productDisplayName(product),
    detail: detailFor(product, period),
    ...(product.is_active ? { tag: "Active" } : product.category === "sunscreen" ? { tag: "Essential" } : {}),
  }));
}

function shelfLimitations(shelf: ShelfProduct[], selected: Concern[], notes: string): string[] {
  const enabled = enabledShelf(shelf).filter((product) => !(isCalmDay(selected, notes) && product.is_active));
  const missing: string[] = [];
  if (!enabled.some((product) => product.category === "cleanser" && allowedAt(product, "evening"))) missing.push("an evening cleanser");
  if (!enabled.some((product) => product.category === "moisturizer" && allowedAt(product, "evening"))) missing.push("an evening moisturizer");
  if (!enabled.some((product) => product.category === "sunscreen" && allowedAt(product, "morning"))) missing.push("a morning sunscreen");
  return missing;
}

export function generateFallbackPlan(selected: Concern[], sleep: number, notes = "", shelf: ShelfProduct[] = DEFAULT_SHELF): RoutinePlan {
  const calm = isCalmDay(selected, notes);
  const limitations = shelfLimitations(shelf, selected, notes);
  const morning = toSteps(routineProducts(shelf, selected, notes, "morning"), "morning");
  const evening = toSteps(routineProducts(shelf, selected, notes, "evening"), "evening");
  const priority = calm
    ? "Reduce irritation · Keep the routine gentle"
    : selected.includes("breakouts")
      ? "Gentle breakout care · Avoid over-layering"
      : selected.includes("dry")
        ? "Layer hydration · Ease tightness"
        : "Stay consistent · Use your enabled shelf";
  const baseNote = sleep <= 2
    ? "Sleep was limited. Keep the routine simple and avoid adding unfamiliar products."
    : calm
      ? "Sensitivity or irritation signals were selected, so active and treatment products are paused today."
      : "This deterministic routine uses only enabled products from your browser-private shelf.";
  const limitationNote = limitations.length
    ? ` Your enabled shelf is missing ${limitations.join(", ")}; the routine stays incomplete rather than inventing a product.`
    : "";
  return {
    priority,
    note: `${baseNote}${limitationNote}`,
    morning,
    evening,
    warnings: calm ? ["If irritation persists or worsens, stop active products and seek professional care."] : [],
    need_professional_help: warningSignals.test(notes),
  };
}

export function enforceGuardrails(plan: RoutinePlan, selected: Concern[], notes: string, shelf: ShelfProduct[] = DEFAULT_SHELF): RoutinePlan {
  const calm = isCalmDay(selected, notes);
  const enabled = enabledShelf(shelf);
  const byId = new Map(enabled.map((product) => [product.id, product]));
  const byName = new Map<string, ShelfProduct | null>();
  for (const product of enabled) {
    const name = productDisplayName(product);
    byName.set(name, byName.has(name) ? null : product);
  }
  const clean = (steps: RoutineStep[], period: "morning" | "evening") => {
    const used = new Set<string>();
    return steps.flatMap((step) => {
      const product = (step.product_id ? byId.get(step.product_id) : undefined) ?? byName.get(step.name);
      if (!product || used.has(product.id) || !allowedAt(product, period)) return [];
      if ((calm && product.is_active) || (period === "evening" && product.category === "sunscreen")) return [];
      used.add(product.id);
      return [{
        ...step,
        product_id: product.id,
        name: productDisplayName(product),
        detail: typeof step.detail === "string" ? step.detail.slice(0, 500) : detailFor(product, period),
        ...(step.tag ? { tag: step.tag.slice(0, 80) } : {}),
      }];
    }).slice(0, 6);
  };

  let morning = clean(plan.morning, "morning");
  const evening = clean(plan.evening, "evening");
  const sunscreen = enabled.find((product) => product.category === "sunscreen" && allowedAt(product, "morning") && !(calm && product.is_active));
  if (sunscreen) {
    const existing = morning.find((step) => step.product_id === sunscreen.id);
    const sunscreenStep = existing ?? {
      time: "00",
      product_id: sunscreen.id,
      name: productDisplayName(sunscreen),
      detail: detailFor(sunscreen, "morning"),
      tag: "Essential",
    };
    morning = [...morning.filter((step) => step.product_id !== sunscreen.id && byId.get(step.product_id ?? "")?.category !== "sunscreen"), sunscreenStep];
  } else {
    morning = morning.filter((step) => byId.get(step.product_id ?? "")?.category !== "sunscreen");
  }
  const number = (step: RoutineStep, index: number) => ({ ...step, time: String(index + 1).padStart(2, "0") });
  const limitations = shelfLimitations(shelf, selected, notes);
  const limitation = limitations.length ? ` Your enabled shelf is missing ${limitations.join(", ")}; no replacement was invented.` : "";
  return {
    ...plan,
    note: `${plan.note.slice(0, 1_000)}${plan.note.includes("no replacement was invented") ? "" : limitation}`.slice(0, 1_000),
    morning: morning.map(number),
    evening: evening.map(number),
    warnings: Array.from(new Set([
      ...plan.warnings,
      ...(calm ? ["Barrier protection is on: active and treatment products are paused."] : []),
    ])).slice(0, 3),
    need_professional_help: plan.need_professional_help || warningSignals.test(notes),
  };
}

const hanCharacters = /[\u3400-\u9fff]/;
export function normalizePlanToEnglish(plan: RoutinePlan, selected: Concern[], sleep: number, notes: string, shelf: ShelfProduct[] = DEFAULT_SHELF): RoutinePlan {
  const fallback = generateFallbackPlan(selected, sleep, notes, shelf);
  const legacyId = (name: string): string | null => {
    if (/beplain|绿豆洁面/i.test(name)) return "beplain-cleanser";
    if (/micro essence|微精华/i.test(name)) return "micro-essence";
    if (/torriden/i.test(name)) return "torriden-serum";
    if (/壬二酸|azelaic/i.test(name)) return "azelaic-acid";
    if (/lanc.me|青春面霜/i.test(name)) return "lancome-cream";
    if (/eltamd|uv clear|centella sunscreen/i.test(name)) return "centella-sunscreen";
    return null;
  };
  const normalizeSteps = (steps: RoutineStep[]) => steps.map((step) => {
    if (step.product_id) return step;
    const id = legacyId(step.name);
    const product = id ? shelf.find((item) => item.id === id) : null;
    return product ? { ...step, product_id: product.id, name: productDisplayName(product) } : step;
  });
  return {
    ...plan,
    priority: hanCharacters.test(plan.priority) ? fallback.priority : plan.priority,
    note: hanCharacters.test(plan.note) ? fallback.note : plan.note,
    warnings: plan.warnings.map((warning) => hanCharacters.test(warning)
      ? "Stop any product that causes persistent stinging, heat, swelling, or a worsening rash, and seek professional care."
      : warning),
    morning: normalizeSteps(plan.morning),
    evening: normalizeSteps(plan.evening),
  };
}
