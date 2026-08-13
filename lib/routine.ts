export type Concern = "breakouts" | "oily" | "sensitive" | "redness" | "dry" | "dull";

export type RoutineStep = {
  time: string;
  name: string;
  detail: string;
  tag?: string;
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

export const PRODUCT_NAMES = {
  "water-cleanse": "Water rinse",
  "beplain-cleanser": "Beplain Mung Bean Cleanser",
  "micro-essence": "Micro Essence",
  "torriden-serum": "Torriden Dive-In",
  "azelaic-acid": "Azelaic Acid 10%",
  "lancome-cream": "Lancôme Youth Activating Cream",
  "eltamd-sunscreen": "Centella Sunscreen",
} as const;

export type ProductId = keyof typeof PRODUCT_NAMES;

const warningSignals = /persistent(?:ly)?\s+(?:stinging|burning)|(?:skin\s+)?(?:feels?\s+)?hot|damaged\s+skin|swelling|oozing|worsening\s+(?:rash|eczema)|持续.{0,3}(?:刺痛|发热)|明显(?:肿胀|渗液)|破损|加重.{0,3}(?:皮疹|湿疹)/i;

export function generateFallbackPlan(selected: Concern[], sleep: number, notes = ""): RoutinePlan {
  const isCalmDay = selected.includes("sensitive") || selected.includes("redness") || warningSignals.test(notes);
  const isDry = selected.includes("dry");
  const isOily = selected.includes("oily");
  const hasBreakouts = selected.includes("breakouts");

  const morning: RoutineStep[] = [
    {
      time: "01",
      name: isOily && !isCalmDay ? PRODUCT_NAMES["beplain-cleanser"] : PRODUCT_NAMES["water-cleanse"],
      detail: isOily && !isCalmDay ? "Cleanse gently for 30–45 seconds without aiming for a squeaky finish." : "Keep it barrier-friendly today with a simple lukewarm water rinse.",
      tag: isOily && !isCalmDay ? "Light cleanse" : "Gentle",
    },
    { time: "02", name: PRODUCT_NAMES["micro-essence"], detail: "Pat on one light layer to prep for hydration." },
    { time: "03", name: PRODUCT_NAMES["torriden-serum"], detail: isDry ? "Apply two thin layers, focusing on tight areas." : "Apply one thin layer and avoid over-layering.", tag: "Hydrate" },
    { time: "04", name: PRODUCT_NAMES["eltamd-sunscreen"], detail: "Apply a generous final layer and let it set before heading out.", tag: "Essential" },
  ];

  const evening: RoutineStep[] = [
    { time: "01", name: PRODUCT_NAMES["beplain-cleanser"], detail: "Gently remove sunscreen and the day’s residue." },
    { time: "02", name: PRODUCT_NAMES["micro-essence"], detail: "One light layer is enough—your skin does not need to be drenched." },
    { time: "03", name: PRODUCT_NAMES["torriden-serum"], detail: "Apply a thin layer to slightly damp skin to ease dryness.", tag: "Hydrate" },
  ];

  if (isCalmDay) {
    evening.push({ time: "04", name: PRODUCT_NAMES["lancome-cream"], detail: "Skip azelaic acid tonight. Focus on moisture and monitor redness.", tag: "Barrier night" });
  } else if (hasBreakouts) {
    evening.push(
      { time: "04", name: PRODUCT_NAMES["azelaic-acid"], detail: "Apply a thin layer to dry skin, avoiding damaged or irritated areas.", tag: "Active" },
      { time: "05", name: PRODUCT_NAMES["lancome-cream"], detail: "Finish with a small amount if your skin feels tight." },
    );
  } else {
    evening.push({ time: "04", name: PRODUCT_NAMES["lancome-cream"], detail: "Apply a thin layer to seal in moisture and keep the routine steady." });
  }

  const priority = isCalmDay
    ? "Reduce irritation · Support the barrier"
    : hasBreakouts
      ? "Gentle breakout care · Avoid over-layering"
      : isDry
        ? "Layer hydration · Ease tightness"
        : "Stay consistent · Prioritize sunscreen";

  const note = sleep <= 2
    ? "Sleep was limited last night. Use fewer active layers today and avoid adding unfamiliar products in response to a temporary change."
    : isCalmDay
      ? "Sensitivity, redness, or irritation signals were detected, so azelaic acid has been removed tonight. Monitor your skin before bringing it back."
      : "There are no clear barrier warnings today, so you can continue with familiar products. Stop any product that causes persistent stinging.";

  return {
    morning,
    evening,
    priority,
    note,
    warnings: isCalmDay ? ["If stinging persists, your skin feels hot, or a rash worsens, stop active products and seek professional care."] : [],
    need_professional_help: warningSignals.test(notes),
  };
}

export function enforceGuardrails(plan: RoutinePlan, selected: Concern[], notes: string): RoutinePlan {
  const calmRequired = selected.includes("sensitive") || selected.includes("redness") || warningSignals.test(notes);
  const allowedNames = new Set(Object.values(PRODUCT_NAMES));
  const clean = (steps: RoutineStep[], period: "morning" | "evening") => steps
    .filter((step) => allowedNames.has(step.name as (typeof PRODUCT_NAMES)[ProductId]))
    .filter((step) => !(calmRequired && step.name === PRODUCT_NAMES["azelaic-acid"]))
    .filter((step) => !(period === "morning" && step.name === PRODUCT_NAMES["azelaic-acid"]))
    .slice(0, 6)
    .map((step, index) => ({ ...step, time: String(index + 1).padStart(2, "0") }));

  const cleanMorning = clean(plan.morning, "morning");
  const evening = clean(plan.evening, "evening");
  const sunscreen = cleanMorning.find((step) => step.name === PRODUCT_NAMES["eltamd-sunscreen"])
    ?? { time: "00", name: PRODUCT_NAMES["eltamd-sunscreen"], detail: "Apply a generous final layer of sunscreen.", tag: "Essential" };
  const morning = [...cleanMorning.filter((step) => step.name !== PRODUCT_NAMES["eltamd-sunscreen"]), sunscreen]
    .map((step, index) => ({ ...step, time: String(index + 1).padStart(2, "0") }));

  return {
    ...plan,
    morning,
    evening,
    warnings: calmRequired
      ? Array.from(new Set([...plan.warnings, "Barrier protection is on: azelaic acid and other active treatments are paused."])).slice(0, 3)
      : plan.warnings.slice(0, 3),
    need_professional_help: plan.need_professional_help || warningSignals.test(notes),
  };
}

const hanCharacters = /[\u3400-\u9fff]/;

const englishStepCopy: Record<ProductId, Pick<RoutineStep, "detail" | "tag">> = {
  "water-cleanse": { detail: "Rinse gently with lukewarm water to keep the skin barrier comfortable.", tag: "Gentle" },
  "beplain-cleanser": { detail: "Cleanse gently without scrubbing or aiming for a squeaky finish.", tag: "Cleanse" },
  "micro-essence": { detail: "Pat on one light layer to prepare skin for hydration.", tag: "Prep" },
  "torriden-serum": { detail: "Apply one thin layer to support steady hydration.", tag: "Hydrate" },
  "azelaic-acid": { detail: "Apply a thin layer to dry, comfortable skin and avoid irritated areas.", tag: "Active" },
  "lancome-cream": { detail: "Apply a light layer to seal in moisture.", tag: "Moisturize" },
  "eltamd-sunscreen": { detail: "Apply a generous final morning layer and let it set before heading out.", tag: "Essential" },
};

function normalizeLegacyProductName(name: string): string {
  if (Object.values(PRODUCT_NAMES).includes(name as (typeof PRODUCT_NAMES)[ProductId])) return name;
  if (/beplain|绿豆洁面/i.test(name)) return PRODUCT_NAMES["beplain-cleanser"];
  if (/清水|water rinse/i.test(name)) return PRODUCT_NAMES["water-cleanse"];
  if (/micro essence|微精华/i.test(name)) return PRODUCT_NAMES["micro-essence"];
  if (/torriden/i.test(name)) return PRODUCT_NAMES["torriden-serum"];
  if (/壬二酸|azelaic/i.test(name)) return PRODUCT_NAMES["azelaic-acid"];
  if (/lanc.me|青春面霜/i.test(name)) return PRODUCT_NAMES["lancome-cream"];
  if (/eltamd|uv clear|centella sunscreen/i.test(name)) return PRODUCT_NAMES["eltamd-sunscreen"];
  return name;
}

/**
 * Keeps the Sites frontend compatible with the existing production Gemini proxy,
 * which can still return legacy Chinese labels. AI-selected products are retained,
 * while user-facing legacy copy is replaced with deterministic English copy before
 * the normal safety guardrails run.
 */
export function normalizePlanToEnglish(plan: RoutinePlan, selected: Concern[], sleep: number, notes: string): RoutinePlan {
  const fallback = generateFallbackPlan(selected, sleep, notes);
  const normalizeSteps = (steps: RoutineStep[]) => steps.map((step) => {
    const name = normalizeLegacyProductName(step.name);
    const productId = (Object.entries(PRODUCT_NAMES) as [ProductId, string][])
      .find(([, productName]) => productName === name)?.[0];
    const copy = productId ? englishStepCopy[productId] : null;

    return {
      ...step,
      name,
      detail: hanCharacters.test(step.detail) && copy ? copy.detail : step.detail,
      tag: step.tag && hanCharacters.test(step.tag) && copy ? copy.tag : step.tag,
    };
  });

  return {
    ...plan,
    priority: hanCharacters.test(plan.priority) ? fallback.priority : plan.priority,
    note: hanCharacters.test(plan.note) ? fallback.note : plan.note,
    morning: normalizeSteps(plan.morning),
    evening: normalizeSteps(plan.evening),
    warnings: plan.warnings.map((warning) => hanCharacters.test(warning)
      ? "Stop any product that causes persistent stinging, heat, swelling, or a worsening rash, and seek professional care."
      : warning),
  };
}
