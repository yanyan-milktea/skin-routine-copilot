import { detectActives, type ActiveFamily } from "./product-identify.ts";
import { allowedAt, categoryOrder } from "./routine.ts";
import { dayFromNumber, dayNumber } from "./schedule.ts";
import { productDisplayName, type ActiveGroup, type ProductTime, type ShelfProduct } from "./shelf.ts";

/**
 * Keeps actives that should not share a routine on different days.
 *
 * Pairs and reasons follow the British Skin Foundation's guidance on mixing
 * skincare, and a stability study showing benzoyl peroxide degrades tretinoin
 * (Br J Dermatol 1998). Deliberately short: common myths (e.g. niacinamide with
 * vitamin C) are not flagged.
 */
export const ACTIVE_GROUP_LABELS: Record<ActiveGroup, string> = {
  retinoid: "Retinoid",
  acid: "Exfoliating acid (AHA/BHA/PHA)",
  "vitamin-c": "Vitamin C (L-ascorbic acid)",
  "benzoyl-peroxide": "Benzoyl peroxide",
  azelaic: "Azelaic acid",
};

export const CONFLICTS: readonly { groups: [ActiveGroup, ActiveGroup]; reason: string }[] = [
  { groups: ["retinoid", "acid"], reason: "a retinoid and an exfoliating acid on the same day often irritate" },
  { groups: ["retinoid", "benzoyl-peroxide"], reason: "benzoyl peroxide can break down some retinoids, and together they are drying" },
  { groups: ["retinoid", "vitamin-c"], reason: "vitamin C and a retinoid together can cause redness" },
  { groups: ["vitamin-c", "acid"], reason: "vitamin C with an exfoliating acid can cause dryness and flaking" },
  { groups: ["vitamin-c", "benzoyl-peroxide"], reason: "benzoyl peroxide breaks down vitamin C" },
  { groups: ["azelaic", "acid"], reason: "azelaic acid with another acid can be too much at once" },
];

const FAMILY_GROUP: Record<ActiveFamily, ActiveGroup> = {
  AHA: "acid",
  BHA: "acid",
  PHA: "acid",
  Retinoid: "retinoid",
  "Azelaic acid": "azelaic",
  "Benzoyl peroxide": "benzoyl-peroxide",
  "Vitamin C (L-ascorbic acid)": "vitamin-c",
};

export function groupsFromFamilies(families: readonly ActiveFamily[]): ActiveGroup[] {
  return [...new Set(families.map((family) => FAMILY_GROUP[family]))];
}

/** Saved groups if the user (or auto-fill) set them; otherwise detected from brand and name. */
export function productGroups(product: Pick<ShelfProduct, "brand" | "name" | "actives">): ActiveGroup[] {
  if (product.actives) return product.actives;
  return groupsFromFamilies(detectActives(`${product.brand} ${product.name}`).map((active) => active.family));
}

function clash(a: readonly ActiveGroup[], b: readonly ActiveGroup[]): string | null {
  for (const { groups: [x, y], reason } of CONFLICTS) {
    if ((a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x))) return reason;
  }
  return null;
}

export type Period = "morning" | "evening";
export type ConflictNote = { product: ShelfProduct; period: Period; partners: string[]; reason: string; next: string | null; movedToMorning: boolean };

function withoutPeriod(time: ProductTime, period: Period): ProductTime | null {
  if (time === "both") return period === "morning" ? "evening" : "morning";
  return time === period ? null : time;
}

/**
 * Today's shelf with clashing actives split up, plus a note per product held
 * back. Vitamin C that may be used in the morning simply leaves the evening.
 * Otherwise clashing products are given fixed turns (stable across days, by
 * routine order then id) and today's date picks whose turn it is. Calm days
 * pause actives elsewhere, so nothing is split then.
 */
export function separateConflicts(shelf: readonly ShelfProduct[], today: string, calm: boolean): { shelf: ShelfProduct[]; notes: ConflictNote[] } {
  if (calm || !today) return { shelf: [...shelf], notes: [] };
  const times = new Map(shelf.map((product) => [product.id, product.allowed_time as ProductTime | null]));
  const notes: ConflictNote[] = [];
  const groups = new Map(shelf.map((product) => [product.id, productGroups(product)]));
  const usable = (product: ShelfProduct, period: Period) => product.enabled && times.get(product.id) !== null && allowedAt({ ...product, allowed_time: times.get(product.id)! }, period);
  const partnersOf = (product: ShelfProduct, period: Period) => shelf.filter((other) => other.id !== product.id && usable(other, period) && clash(groups.get(product.id)!, groups.get(other.id)!));

  for (const period of ["evening", "morning"] as const) {
    // Vitamin C that is also allowed in the morning just moves there.
    if (period === "evening") {
      for (const product of shelf) {
        if (!usable(product, "evening") || times.get(product.id) !== "both" || !groups.get(product.id)!.includes("vitamin-c")) continue;
        const partners = partnersOf(product, "evening");
        if (!partners.length) continue;
        times.set(product.id, "morning");
        notes.push({ product, period, partners: partners.map(productDisplayName), reason: clash(groups.get(product.id)!, groups.get(partners[0].id)!)!, next: null, movedToMorning: true });
      }
    }
    // Greedy turn assignment among the rest.
    const involved = shelf
      .filter((product) => usable(product, period) && partnersOf(product, period).length > 0)
      .sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || a.id.localeCompare(b.id));
    if (!involved.length) continue;
    const turn = new Map<string, number>();
    for (const product of involved) {
      const taken = new Set(partnersOf(product, period).map((other) => turn.get(other.id)).filter((value): value is number => value !== undefined));
      let slot = 0;
      while (taken.has(slot)) slot += 1;
      turn.set(product.id, slot);
    }
    const turns = Math.max(...turn.values()) + 1;
    const todayN = dayNumber(today);
    const current = todayN % turns;
    // Today's turn goes first; any other product joins if it clashes with nothing already in.
    const kept: ShelfProduct[] = involved.filter((product) => turn.get(product.id) === current);
    for (const product of involved) {
      const slot = turn.get(product.id)!;
      if (slot === current) continue;
      const blockers = kept.filter((other) => clash(groups.get(product.id)!, groups.get(other.id)!));
      if (!blockers.length) { kept.push(product); continue; }
      times.set(product.id, withoutPeriod(times.get(product.id)!, period));
      notes.push({
        product,
        period,
        partners: blockers.map(productDisplayName),
        reason: clash(groups.get(product.id)!, groups.get(blockers[0].id)!)!,
        next: dayFromNumber(todayN + ((slot - current + turns) % turns)),
        movedToMorning: false,
      });
    }
  }

  const adjusted = shelf.flatMap((product) => {
    const time = times.get(product.id);
    if (time === null || time === undefined) return [];
    return [time === product.allowed_time ? product : { ...product, allowed_time: time }];
  });
  return { shelf: adjusted, notes };
}
