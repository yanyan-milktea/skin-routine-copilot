import type { ShelfProduct } from "./shelf";

/**
 * Products used a few times a week (e.g. a sheet mask 3×/week). Each day the
 * routine includes such a product only when it is due, based on the days the
 * user ticked it off. Everything stays in this browser.
 */
export const USAGE_STORAGE_KEY = "skin-routine-copilot.product-usage";
export const USAGE_SCHEMA_VERSION = 1 as const;
export const MAX_PER_WEEK = 6;
const KEEP_DAYS = 60;

/** product id → local calendar days (YYYY-MM-DD) it was used, oldest first */
export type UsageLog = Record<string, string[]>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;

export function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

function dayFromNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

export function parseUsageStore(raw: string | null): UsageLog {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== USAGE_SCHEMA_VERSION) return {};
    const uses = (parsed as { uses?: unknown }).uses;
    if (typeof uses !== "object" || uses === null || Array.isArray(uses)) return {};
    const log: UsageLog = {};
    for (const [id, days] of Object.entries(uses).slice(0, 60)) {
      if (!ID.test(id) || !Array.isArray(days)) continue;
      const valid = [...new Set(days.filter((day): day is string => typeof day === "string" && DAY.test(day)))].sort().slice(-KEEP_DAYS);
      if (valid.length) log[id] = valid;
    }
    return log;
  } catch {
    return {};
  }
}

export function serializeUsageStore(log: UsageLog): string {
  return JSON.stringify({ version: USAGE_SCHEMA_VERSION, uses: log });
}

/** Marks or unmarks a product as used on a day; old entries are pruned. */
export function setUsed(log: UsageLog, productId: string, day: string, used: boolean): UsageLog {
  const cutoff = dayNumber(day) - KEEP_DAYS;
  const days = new Set((log[productId] ?? []).filter((d) => dayNumber(d) > cutoff));
  if (used) days.add(day); else days.delete(day);
  const next = { ...log };
  if (days.size) next[productId] = [...days].sort(); else delete next[productId];
  return next;
}

export type ScheduleStatus = {
  scheduled: boolean;
  due: boolean;
  usedToday: boolean;
  usesLast7Days: number;
  lastUsed: string | null;
  nextDue: string | null;
};

/**
 * Due when fewer than `per_week` uses fall in the last 7 days (today included)
 * and enough days have passed since the last use: 7 / per_week, rounded down
 * (3×/week → at least every other day, 2×/week → every 3rd day). A product
 * already used today stays in today's routine so it can be unticked.
 */
export function scheduleStatus(product: Pick<ShelfProduct, "id" | "per_week">, log: UsageLog, today: string): ScheduleStatus {
  const perWeek = product.per_week;
  const days = (log[product.id] ?? []).map(dayNumber).filter((n) => n <= dayNumber(today));
  const lastUsedN = days.length ? Math.max(...days) : null;
  const base = { usedToday: lastUsedN === dayNumber(today), usesLast7Days: 0, lastUsed: lastUsedN === null ? null : dayFromNumber(lastUsedN) };
  if (!perWeek) return { ...base, scheduled: false, due: true, nextDue: null };
  const dueOn = (n: number) => {
    const inWindow = days.filter((d) => d > n - 7 && d <= n).length;
    return inWindow < perWeek && (lastUsedN === null || n - lastUsedN >= Math.floor(7 / perWeek));
  };
  const t = dayNumber(today);
  const usesLast7Days = days.filter((d) => d > t - 7).length;
  if (base.usedToday) return { ...base, usesLast7Days, scheduled: true, due: true, nextDue: null };
  if (dueOn(t)) return { ...base, usesLast7Days, scheduled: true, due: true, nextDue: today };
  let next: string | null = null;
  for (let n = t + 1; n <= t + 7; n += 1) if (dueOn(n)) { next = dayFromNumber(n); break; }
  return { ...base, usesLast7Days, scheduled: true, due: false, nextDue: next };
}

/** The shelf as it applies today: products on a weekly schedule are left out when not due. */
export function shelfDueToday(shelf: readonly ShelfProduct[], log: UsageLog, today: string): ShelfProduct[] {
  return shelf.filter((product) => scheduleStatus(product, log, today).due);
}
