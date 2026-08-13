import type { Concern, RoutinePlan, RoutineResponse } from "./routine.ts";

export const HISTORY_STORAGE_KEY = "skin-routine-copilot.history";
export const HISTORY_SCHEMA_VERSION = 1 as const;
export const MAX_HISTORY_ENTRIES = 30;
export const TREND_HISTORY_LIMIT = 7;

export type HistoryEntry = {
  id: string;
  created_at: string;
  concerns: Concern[];
  sleep: number;
  notes: string;
  plan: RoutinePlan;
  meta: RoutineResponse["meta"];
};

export type HistoryStore = {
  version: typeof HISTORY_SCHEMA_VERSION;
  entries: HistoryEntry[];
};

export type TrendSummary = {
  headline: string;
  overview: string;
  patterns: string[];
  gentle_next_steps: string[];
  disclaimer: string;
};

export type TrendSummaryResponse = {
  summary: TrendSummary;
  meta: RoutineResponse["meta"];
};

const validConcerns = new Set<Concern>(["breakouts", "oily", "sensitive", "redness", "dry", "dull"]);
const nonDiagnosticDisclaimer = "This summary describes your saved check-ins only. It is not a diagnosis or medical advice.";
const medicalClaimPattern = /\b(?:diagnos(?:e|ed|is|tic)|prescrib(?:e|ed|ing)|cure[sd]?|medical condition|disease|disorder|treat(?:s|ed|ment|ing)?|you have|indicates?\s+(?:acne|rosacea|eczema))\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.trim().length > 0);
}

function isRoutinePlan(value: unknown): value is RoutinePlan {
  if (!isRecord(value)) return false;
  const validStep = (step: unknown) => isRecord(step)
    && isBoundedString(step.time, 8)
    && isBoundedString(step.name, 80)
    && isBoundedString(step.detail, 500)
    && (step.tag === undefined || isBoundedString(step.tag, 80))
    && (step.product_id === undefined || isBoundedString(step.product_id, 80));

  return isBoundedString(value.priority, 300)
    && isBoundedString(value.note, 1_000)
    && Array.isArray(value.morning)
    && value.morning.length <= 6
    && value.morning.every(validStep)
    && Array.isArray(value.evening)
    && value.evening.length <= 6
    && value.evening.every(validStep)
    && Array.isArray(value.warnings)
    && value.warnings.length <= 3
    && value.warnings.every((warning) => isBoundedString(warning, 500))
    && typeof value.need_professional_help === "boolean";
}

function isRoutineMeta(value: unknown): value is RoutineResponse["meta"] {
  if (!isRecord(value)) return false;
  return (value.source === "ai" || value.source === "fallback")
    && (value.provider === "gemini" || value.provider === "openai" || value.provider === null)
    && (value.model === null || isBoundedString(value.model, 120))
    && typeof value.latency_ms === "number"
    && Number.isFinite(value.latency_ms)
    && value.latency_ms >= 0
    && (value.reason === undefined || isBoundedString(value.reason, 120));
}

export function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!isRecord(value)) return false;
  const timestamp = typeof value.created_at === "string" ? Date.parse(value.created_at) : Number.NaN;
  return isBoundedString(value.id, 120)
    && Number.isFinite(timestamp)
    && Array.isArray(value.concerns)
    && value.concerns.length <= 6
    && value.concerns.every((concern) => typeof concern === "string" && validConcerns.has(concern as Concern))
    && typeof value.sleep === "number"
    && Number.isInteger(value.sleep)
    && value.sleep >= 1
    && value.sleep <= 5
    && isBoundedString(value.notes, 500, true)
    && isRoutinePlan(value.plan)
    && isRoutineMeta(value.meta);
}

export function limitHistory(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries]
    .filter(isHistoryEntry)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MAX_HISTORY_ENTRIES);
}

export function createEmptyHistoryStore(): HistoryStore {
  return { version: HISTORY_SCHEMA_VERSION, entries: [] };
}

export function parseHistoryStore(raw: string | null): HistoryStore {
  if (!raw) return createEmptyHistoryStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== HISTORY_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      return createEmptyHistoryStore();
    }
    return { version: HISTORY_SCHEMA_VERSION, entries: limitHistory(parsed.entries.filter(isHistoryEntry)) };
  } catch {
    return createEmptyHistoryStore();
  }
}

export function addHistoryEntry(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return isHistoryEntry(entry) ? limitHistory([entry, ...entries]) : limitHistory(entries);
}

export function recentHistory(entries: HistoryEntry[]): HistoryEntry[] {
  return limitHistory(entries).slice(0, TREND_HISTORY_LIMIT);
}

export function isTrendSummary(value: unknown): value is TrendSummary {
  if (!isRecord(value)) return false;
  const shortList = (items: unknown) => Array.isArray(items)
    && items.length >= 1
    && items.length <= 4
    && items.every((item) => isBoundedString(item, 220));
  return isBoundedString(value.headline, 120)
    && isBoundedString(value.overview, 600)
    && shortList(value.patterns)
    && shortList(value.gentle_next_steps)
    && isBoundedString(value.disclaimer, 240);
}

export function isNonDiagnosticTrendSummary(summary: TrendSummary): boolean {
  return !medicalClaimPattern.test([
    summary.headline,
    summary.overview,
    ...summary.patterns,
    ...summary.gentle_next_steps,
  ].join(" "));
}

export function generateFallbackTrendSummary(entries: HistoryEntry[]): TrendSummary {
  const recent = recentHistory(entries);
  if (recent.length === 0) {
    return {
      headline: "Your weekly pattern will appear here",
      overview: "Save at least one daily routine to create a browser-only trend summary.",
      patterns: ["No saved check-ins are available yet."],
      gentle_next_steps: ["Keep using the daily check-in when it is useful."],
      disclaimer: nonDiagnosticDisclaimer,
    };
  }

  const labels: Record<Concern, string> = {
    breakouts: "Breakouts",
    oily: "Oiliness",
    sensitive: "Sensitivity",
    redness: "Redness",
    dry: "Dryness",
    dull: "Dullness",
  };
  const counts = new Map<Concern, number>();
  for (const entry of recent) {
    for (const concern of entry.concerns) counts.set(concern, (counts.get(concern) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const leading = ranked[0];
  const averageSleep = recent.reduce((sum, entry) => sum + entry.sleep, 0) / recent.length;
  const aiCount = recent.filter((entry) => entry.meta.source === "ai").length;
  const signalPattern = leading
    ? `${labels[leading[0]]} appeared most often (${leading[1]} of ${recent.length} check-ins).`
    : "No skin signal appeared consistently across the saved check-ins.";

  return {
    headline: leading ? `A week led by ${labels[leading[0]].toLowerCase()}` : "A steady week of simple check-ins",
    overview: `Across ${recent.length} saved check-in${recent.length === 1 ? "" : "s"}, the average sleep score was ${averageSleep.toFixed(1)}/5. This is a descriptive pattern, not a medical conclusion.`,
    patterns: [
      signalPattern,
      `${aiCount} routine${aiCount === 1 ? " was" : "s were"} generated by AI; ${recent.length - aiCount} used the deterministic fallback.`,
    ],
    gentle_next_steps: [
      "Keep routines simple and compare changes over several check-ins rather than reacting to one day.",
      "Pause active products if persistent stinging, heat, swelling, or a worsening rash appears.",
    ],
    disclaimer: nonDiagnosticDisclaimer,
  };
}

export function guardTrendSummary(value: unknown, entries: HistoryEntry[]): TrendSummary {
  if (!isTrendSummary(value) || !isNonDiagnosticTrendSummary(value)) return generateFallbackTrendSummary(entries);
  return { ...value, disclaimer: nonDiagnosticDisclaimer };
}
