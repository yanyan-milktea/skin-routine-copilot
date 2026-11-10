import assert from "node:assert/strict";
import test from "node:test";
import { sortShelfByRoutineStep } from "../lib/shelf.ts";

const item = (id, category) => ({ id, category });

test("products are listed in application order, without changing what is stored", () => {
  const stored = [item("spf", "sunscreen"), item("cream", "moisturizer"), item("misc", "other"), item("serum-a", "serum"), item("wash", "cleanser"), item("azelaic", "treatment"), item("toner", "toner-essence"), item("serum-b", "serum")];
  const snapshot = JSON.stringify(stored);
  const sorted = sortShelfByRoutineStep(stored);
  assert.deepEqual(sorted.map(({ product }) => product.id), ["wash", "toner", "serum-a", "serum-b", "azelaic", "cream", "spf", "misc"]);
  assert.equal(JSON.stringify(stored), snapshot, "the stored shelf is not reordered");
});

test("same-step products keep the order they were added, and carry their stored position", () => {
  const sorted = sortShelfByRoutineStep([item("b", "serum"), item("a", "cleanser"), item("c", "serum")]);
  assert.deepEqual(sorted.map(({ product, storedIndex }) => [product.id, storedIndex]), [["a", 1], ["b", 0], ["c", 2]]);
  assert.deepEqual(sortShelfByRoutineStep([]), []);
});
