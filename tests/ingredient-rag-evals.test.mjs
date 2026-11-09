import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { baselineOf, loadCases, retrievalGateResults, runRetrievalEvals } from "../scripts/rag/evals.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const loadJson = async (path) => JSON.parse(await readFile(new URL(path, new URL("../", import.meta.url)), "utf8"));
const manifest = await loadJson("evals/ingredient-rag/v1/manifest.json");
const baseline = await loadJson("evals/ingredient-rag/v1/reports/baseline.json");
const cases = loadCases();
const report = await runRetrievalEvals({ cases });

test("eval manifest pins the exact runtime versions", () => {
  for (const key of ["corpus_version", "index_version", "embedding_model", "retrieval_config_sha256", "aliases_version", "tokenizer_version", "bm25_implementation", "deny_list_version"]) {
    assert.equal(report.versions[key], manifest[key], key);
  }
  assert.equal(manifest.fixture_kind, "synthetic_only");
});

test("dataset is synthetic, unique, and covers every class and abstention family", () => {
  assert.equal(new Set(cases.map((item) => item.case_id)).size, cases.length);
  for (const item of cases) {
    assert.ok(item.notes.toLowerCase().includes("synthetic") || item.category !== "supported", item.case_id);
    assert.ok(!/@|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(item.question), `no personal data in ${item.case_id}`);
  }
  const classes = new Set(cases.filter((item) => item.category === "supported").map((item) => item.expected_question_class));
  assert.deepEqual([...classes].sort(), ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  for (const category of ["out_of_scope", "in_class_no_answer", "ambiguous_class", "blocked_pairwise_compatibility", "blocked_product_composition", "blocked_personal_medical", "injection_question", "eligibility_state", "embedding_failure"]) {
    assert.ok(cases.some((item) => item.category === category), category);
  }
  assert.ok(report.dataset.abstention_share >= 0.3, "at least 30% abstention");
  assert.ok(report.dataset.adversarial_share >= 0.25, "at least 25% adversarial");
});

test("every safety gate passes on the fixed Phase 1 constants", () => {
  const failures = retrievalGateResults(report).filter((gate) => gate.kind === "safety" && !gate.pass);
  assert.deepEqual(failures, []);
  const criticalFailures = report.failures.filter((outcome) => outcome.critical);
  assert.deepEqual(criticalFailures.map((outcome) => `${outcome.case_id}: ${outcome.failures.join("; ")}`), []);
});

test("ranking quality does not regress below the recorded baseline", () => {
  const current = baselineOf(report);
  assert.ok(current.recall_at_5 >= baseline.recall_at_5, `Recall@5 ${current.recall_at_5} < ${baseline.recall_at_5}`);
  assert.ok(current.mrr >= baseline.mrr, `MRR ${current.mrr} < ${baseline.mrr}`);
  for (const [classId, recall] of Object.entries(baseline.recall_at_5_by_class)) assert.ok(current.recall_at_5_by_class[classId] >= recall, classId);
  assert.ok(current.cases_with_irrelevant_evidence <= baseline.cases_with_irrelevant_evidence);
  const newlyFailing = current.failing_case_ids.filter((id) => !baseline.failing_case_ids.includes(id));
  assert.deepEqual(newlyFailing, [], "a previously passing case now fails");
});

test("checked-in eval reports are current", () => {
  const result = spawnSync(process.execPath, ["scripts/rag/eval-report.ts", "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
