import assert from "node:assert/strict";
import test from "node:test";
import { productGroups, separateConflicts } from "../lib/conflicts.ts";
import { enforceGuardrails, generateFallbackPlan } from "../lib/routine.ts";

const p = (id, name, category, extra = {}) => ({ id, brand: "", name, category, allowed_time: "evening", is_active: true, usage_note: "", enabled: true, ...extra });
const wash = p("wash", "Gentle Cleanser", "cleanser", { allowed_time: "both", is_active: false });
const cream = p("cream", "Night Cream", "moisturizer", { allowed_time: "both", is_active: false });
const retinol = p("retinol", "Retinol 0.3% Serum", "serum");
const glycolic = p("glycolic", "Glycolic Acid 7% Toning Solution", "toner-essence");
const ids = (shelf, period) => shelf.filter((x) => x.allowed_time === "both" || x.allowed_time === period).map((x) => x.id);
const MON = "2026-11-09", TUE = "2026-11-10", WED = "2026-11-11";

test("active groups come from the name unless the product has its own list", () => {
  assert.deepEqual(productGroups(retinol), ["retinoid"]);
  assert.deepEqual(productGroups(glycolic), ["acid"]);
  assert.deepEqual(productGroups(p("x", "Vitamin C Serum with L-Ascorbic Acid", "serum")), ["vitamin-c"]);
  assert.deepEqual(productGroups(p("x", "Niacinamide 10% + Zinc", "serum")), [], "no group, no conflicts");
  assert.deepEqual(productGroups({ ...retinol, actives: [] }), [], "the saved list wins, even when empty");
  assert.deepEqual(productGroups(p("x", "Liquid Exfoliant", "treatment", { actives: ["acid"] })), ["acid"]);
});

test("retinoid and exfoliating acid alternate evenings; each one's turn is stable", () => {
  const shelf = [wash, retinol, glycolic, cream];
  const days = [MON, TUE, WED].map((day) => separateConflicts(shelf, day, false));
  const evening = days.map(({ shelf: s }) => ids(s, "evening").filter((id) => id === "retinol" || id === "glycolic"));
  assert.deepEqual(evening.map((list) => list.length), [1, 1, 1], "never both on one evening");
  assert.notDeepEqual(evening[0], evening[1], "they take turns");
  assert.deepEqual(evening[0], evening[2], "same turn every other day");
  const note = days[0].notes[0];
  assert.equal(note.period, "evening");
  assert.match(note.reason, /retinoid and an exfoliating acid/);
  assert.equal(note.next, TUE);
  assert.deepEqual(ids(days[0].shelf, "evening").filter((id) => id === "wash" || id === "cream"), ["wash", "cream"], "other products untouched");
});

test("vitamin C that is allowed in the morning just leaves the evening, every day", () => {
  const vitc = p("vitc", "Vitamin C 15% L-Ascorbic Acid Serum", "serum", { allowed_time: "both" });
  for (const day of [MON, TUE]) {
    const { shelf, notes } = separateConflicts([wash, vitc, retinol, cream], day, false);
    assert.deepEqual(ids(shelf, "morning").includes("vitc"), true);
    assert.equal(ids(shelf, "evening").includes("vitc"), false);
    assert.equal(ids(shelf, "evening").includes("retinol"), true);
    assert.equal(notes[0].movedToMorning, true);
  }
});

test("myths are not flagged, calm days split nothing, and paused products don't count", () => {
  const niacinamide = p("nia", "Niacinamide 10% Serum", "serum", { is_active: false });
  const vitc = p("vitc", "L-Ascorbic Acid Serum", "serum");
  assert.equal(separateConflicts([niacinamide, vitc], MON, false).notes.length, 0, "niacinamide + vitamin C is fine");
  assert.equal(separateConflicts([retinol, glycolic], MON, true).notes.length, 0, "calm day: actives are paused anyway");
  assert.equal(separateConflicts([retinol, { ...glycolic, enabled: false }], MON, false).notes.length, 0);
});

test("three clashing products: nothing that clashes shares a day, and a product is only held back for a real clash", () => {
  const bpo = p("bpo", "Benzoyl Peroxide 5% Gel", "treatment");
  const azelaic = p("aza", "Azelaic Acid 10% Booster", "treatment");
  // retinol↔glycolic, retinol↔bpo, azelaic↔glycolic clash; azelaic and bpo don't clash with retinol? (azelaic+retinoid is fine)
  const shelf = [wash, retinol, glycolic, bpo, azelaic, cream];
  for (const day of ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]) {
    const kept = separateConflicts(shelf, day, false).shelf.filter((x) => x.allowed_time !== "morning" && x.is_active).map((x) => x.id);
    const has = (id) => kept.includes(id);
    assert.ok(!(has("retinol") && has("glycolic")), day);
    assert.ok(!(has("retinol") && has("bpo")), day);
    assert.ok(!(has("aza") && has("glycolic")), day);
    assert.ok(kept.length >= 2, `${day}: products without a clash with today's set still run (${kept})`);
  }
});

test("the AI cannot bring a held-back product back: guardrails use the adjusted shelf", () => {
  const { shelf } = separateConflicts([wash, retinol, glycolic, cream], MON, false);
  const held = ["retinol", "glycolic"].find((id) => !ids(shelf, "evening").includes(id));
  const step = (id) => ({ time: "01", product_id: id, name: id, detail: "x" });
  const aiPlan = { priority: "p", note: "n", warnings: [], need_professional_care: false, morning: [step("wash")], evening: [step("wash"), step("retinol"), step("glycolic"), step("cream")] };
  const guarded = enforceGuardrails(aiPlan, ["breakouts"], "", shelf);
  assert.equal(guarded.evening.some((s) => s.product_id === held), false);
  assert.equal(generateFallbackPlan(["breakouts"], 3, "", shelf).evening.some((s) => s.product_id === held), false);
});
