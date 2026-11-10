import assert from "node:assert/strict";
import test from "node:test";
import { localDateKey, parseUsageStore, scheduleStatus, serializeUsageStore, setUsed, shelfDueToday } from "../lib/schedule.ts";
import { parseShelfProduct } from "../lib/shelf.ts";

const mask = { id: "sheet-mask", per_week: 3 };
const log = (...days) => ({ "sheet-mask": days });

test("a product without a weekly schedule is always due", () => {
  const status = scheduleStatus({ id: "serum" }, {}, "2026-11-10");
  assert.equal(status.scheduled, false);
  assert.equal(status.due, true);
});

test("3×/week: due at first, rests the day after a use, due again after one rest day", () => {
  assert.equal(scheduleStatus(mask, {}, "2026-11-10").due, true, "never used");
  const afterMonday = log("2026-11-09");
  assert.equal(scheduleStatus(mask, afterMonday, "2026-11-10").due, false, "not two days in a row");
  assert.equal(scheduleStatus(mask, afterMonday, "2026-11-10").nextDue, "2026-11-11");
  assert.equal(scheduleStatus(mask, afterMonday, "2026-11-11").due, true);
});

test("3×/week: never more than 3 uses in any 7 days", () => {
  const week = log("2026-11-09", "2026-11-11", "2026-11-13");
  assert.equal(scheduleStatus(mask, week, "2026-11-15").due, false, "3 uses already in the last 7 days");
  assert.equal(scheduleStatus(mask, week, "2026-11-15").nextDue, "2026-11-16", "Mon drops out of the window");
  assert.equal(scheduleStatus(mask, week, "2026-11-16").due, true);
  assert.equal(scheduleStatus(mask, week, "2026-11-15").usesLast7Days, 3);
});

test("2×/week: at least every third day", () => {
  const twice = { id: "sheet-mask", per_week: 2 };
  assert.equal(scheduleStatus(twice, log("2026-11-09"), "2026-11-11").due, false);
  assert.equal(scheduleStatus(twice, log("2026-11-09"), "2026-11-12").due, true);
});

test("a missed day carries over: the product stays due until it is used", () => {
  const lastWeek = log("2026-11-01");
  for (const day of ["2026-11-10", "2026-11-11", "2026-11-12"]) assert.equal(scheduleStatus(mask, lastWeek, day).due, true, day);
});

test("a product used today stays in today's routine, marked as used", () => {
  const status = scheduleStatus(mask, log("2026-11-10"), "2026-11-10");
  assert.equal(status.due, true);
  assert.equal(status.usedToday, true);
});

test("only due products reach today's shelf", () => {
  const shelf = [{ id: "serum", category: "serum" }, { id: "sheet-mask", category: "mask", per_week: 3 }];
  assert.deepEqual(shelfDueToday(shelf, log("2026-11-09"), "2026-11-10").map((p) => p.id), ["serum"]);
  assert.deepEqual(shelfDueToday(shelf, log("2026-11-09"), "2026-11-11").map((p) => p.id), ["serum", "sheet-mask"]);
});

test("ticking off records and unrecords a day; storage round-trips and rejects junk", () => {
  let usage = setUsed({}, "sheet-mask", "2026-11-10", true);
  usage = setUsed(usage, "sheet-mask", "2026-11-10", true);
  assert.deepEqual(usage, log("2026-11-10"), "no duplicates");
  assert.deepEqual(setUsed(usage, "sheet-mask", "2026-11-10", false), {}, "unticking removes it");
  assert.deepEqual(parseUsageStore(serializeUsageStore(log("2026-11-12", "2026-11-10"))), log("2026-11-10", "2026-11-12"));
  assert.deepEqual(parseUsageStore(JSON.stringify({ version: 1, uses: { "bad id!": ["2026-11-10"], ok: ["not-a-date", 5] } })), {});
  assert.deepEqual(parseUsageStore("not json"), {});
  assert.deepEqual(parseUsageStore(JSON.stringify({ version: 2, uses: {} })), {});
  const old = setUsed(log("2026-08-01"), "sheet-mask", "2026-11-10", true);
  assert.deepEqual(old, log("2026-11-10"), "uses older than 60 days are pruned");
});

test("local date keys use the device's calendar day", () => {
  assert.equal(localDateKey(new Date(2026, 10, 9, 23, 59)), "2026-11-09");
});

test("per_week is optional on a saved product and only 1–6 is kept", () => {
  const base = { id: "m1", brand: "", name: "Sheet Mask", category: "mask", allowed_time: "evening", is_active: false, usage_note: "", enabled: true };
  assert.equal(parseShelfProduct({ ...base, per_week: 3 }).per_week, 3);
  assert.equal("per_week" in parseShelfProduct(base), false);
  assert.equal("per_week" in parseShelfProduct({ ...base, per_week: 9 }), false);
  assert.equal("per_week" in parseShelfProduct({ ...base, per_week: "3" }), false);
});
