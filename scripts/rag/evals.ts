// Keyless retrieval eval runner for the locked synthetic retrieval dataset.
// Metrics follow design Section 9.3; answer/citation metrics belong to Milestone 2+.
import { readFileSync } from "node:fs";
import type { LoadedIndex } from "../../lib/ingredient-index.ts";
import type { RetrievalConfig, RetrievalResult, Retriever } from "../../lib/ingredient-retrieval.ts";
import { PATHS, loadSyntheticCorpus, loadSyntheticStack } from "./shared.ts";

export type EvalCase = {
  case_id: string;
  category: string;
  question: string;
  embedding: "ok" | "fail";
  expected_status: RetrievalResult["status"][];
  expected_question_class: string | null;
  expected_intent_ids: string[];
  expected_relevant: string[];
  /** In-class chunks a reviewer judged irrelevant: tracked as a precision metric (they may still pass a gate). */
  expected_irrelevant: string[];
  expected_states: Record<string, string>;
  must_exclude: string[];
  critical: boolean;
  adversarial: boolean;
  notes: string;
};

const CASE_KEYS = ["case_id", "category", "question", "embedding", "expected_status", "expected_question_class", "expected_intent_ids", "expected_relevant", "expected_irrelevant", "expected_states", "must_exclude", "critical", "adversarial", "notes"].sort().join(",");

export function loadCases(path = PATHS.evalCases): EvalCase[] {
  const cases = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => {
    const value = JSON.parse(line) as EvalCase;
    if (Object.keys(value).sort().join(",") !== CASE_KEYS) throw new Error(`EVAL_CASE_KEYS: line ${index + 1}`);
    return value;
  });
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.case_id)) throw new Error(`EVAL_CASE_DUPLICATE: ${item.case_id}`);
    ids.add(item.case_id);
  }
  return cases;
}

/** Resolve "doc-key#Section heading" to every chunk ID in that section. */
export function createRefResolver(index: LoadedIndex): (ref: string) => string[] {
  const { sourceIdByKey } = loadSyntheticCorpus();
  return (ref: string) => {
    const [key, section] = ref.split("#");
    const sourceId = sourceIdByKey.get(key);
    if (!sourceId) throw new Error(`EVAL_REF_UNKNOWN_DOC: ${ref}`);
    const ids = index.chunks.filter((chunk) => chunk.source_id === sourceId && chunk.section_path[chunk.section_path.length - 1] === section).map((chunk) => chunk.chunk_id);
    if (!ids.length) throw new Error(`EVAL_REF_UNKNOWN_SECTION: ${ref}`);
    return ids;
  };
}

export type CaseOutcome = {
  case_id: string;
  category: string;
  critical: boolean;
  passed: boolean;
  failures: string[];
  status: RetrievalResult["status"];
  rank_of_first_relevant: number | null;
};

export type EvalReport = {
  dataset: { cases: number; by_category: Record<string, number>; adversarial_share: number; abstention_share: number };
  versions: RetrievalResult["trace"]["versions"];
  config_thresholds: Pick<RetrievalConfig, "vector_answer_min_cosine" | "lexical_answer_min_bm25" | "vector_discovery_min_cosine" | "lexical_discovery_min_bm25" | "lexical_only_discovery_min_bm25">;
  retrieval: {
    answerable_cases: number;
    recall_at_1: number;
    recall_at_3: number;
    recall_at_5: number;
    mrr: number;
    ndcg_at_5: number;
    recall_at_5_by_class: Record<string, { hits: number; total: number; recall: number }>;
  };
  abstention: { must_abstain_cases: number; abstained: number; accuracy: number; false_eligible_rate: number; critical_false_eligible: number; out_of_scope_abstention: number };
  eligibility_states: { checks: number; correct: number; accuracy: number };
  lexical_only_discovery: { cases: number; correct: number; accuracy: number; synthesized_claims: number };
  exclusions: { violations: number };
  precision: { cases_with_evidence: number; cases_with_irrelevant_evidence: number; irrelevant_evidence_case_ids: string[] };
  status_accuracy: number;
  failures: CaseOutcome[];
};

const round = (value: number) => Math.round(value * 10000) / 10000;

export async function runRetrievalEvals(options: { config?: RetrievalConfig; cases?: EvalCase[] } = {}): Promise<EvalReport> {
  const cases = options.cases ?? loadCases();
  const ok = loadSyntheticStack({ config: options.config });
  const failing = loadSyntheticStack({ config: options.config, failEmbedding: true });
  const resolve = createRefResolver(ok.index);
  const retrievers: Record<EvalCase["embedding"], Retriever> = { ok: ok.retriever, fail: failing.retriever };

  const outcomes: CaseOutcome[] = [];
  let recall1 = 0, recall3 = 0, recall5 = 0, mrrSum = 0, ndcgSum = 0, answerable = 0;
  const byClass: Record<string, { hits: number; total: number; recall: number }> = {};
  let mustAbstain = 0, abstained = 0, criticalFalseEligible = 0, oosTotal = 0, oosAbstained = 0;
  let stateChecks = 0, stateCorrect = 0, lexCases = 0, lexCorrect = 0, synthesizedClaims = 0, exclusionViolations = 0, statusCorrect = 0;
  let versions: RetrievalResult["trace"]["versions"] | null = null;
  let casesWithEvidence = 0;
  const irrelevantEvidenceIds: string[] = [];

  for (const item of cases) {
    const result = await retrievers[item.embedding].retrieve(item.question);
    versions ??= result.trace.versions;
    const failures: string[] = [];
    if (!item.expected_status.includes(result.status)) failures.push(`status ${result.status} not in [${item.expected_status.join(", ")}]`);
    else statusCorrect += 1;
    if (item.expected_question_class && result.question_class !== item.expected_question_class) failures.push(`class ${result.question_class} != ${item.expected_question_class}`);
    for (const intentId of item.expected_intent_ids) if (!result.intent_ids.includes(intentId)) failures.push(`missing intent ${intentId}`);

    const shown = [...result.evidence, ...result.discovery].map((chunk) => chunk.chunk_id);
    const excluded = new Set(item.must_exclude.flatMap(resolve));
    const leaked = shown.filter((chunkId) => excluded.has(chunkId));
    // Also enforce on the full fused list: excluded chunks must never enter fusion either.
    const fusedLeak = result.trace.fused.filter((entry) => excluded.has(entry.chunk_id));
    if (leaked.length || fusedLeak.length) { exclusionViolations += 1; failures.push(`excluded chunk surfaced (${leaked.length} shown, ${fusedLeak.length} fused)`); }

    const irrelevant = new Set(item.expected_irrelevant.flatMap(resolve));
    if (result.evidence.length) {
      casesWithEvidence += 1;
      if (result.evidence.some((chunk) => irrelevant.has(chunk.chunk_id))) irrelevantEvidenceIds.push(item.case_id);
    }
    const relevant = new Set(item.expected_relevant.flatMap(resolve));
    let firstRank: number | null = null;
    const ranked = item.embedding === "fail" ? result.discovery : result.evidence;
    ranked.forEach((chunk, position) => { if (firstRank === null && relevant.has(chunk.chunk_id)) firstRank = position + 1; });

    const expectsAnswer = item.expected_status.length === 1 && item.expected_status[0] === "eligible";
    if (expectsAnswer && relevant.size) {
      answerable += 1;
      const rank = firstRank as number | null;
      if (rank !== null && rank <= 1) recall1 += 1;
      if (rank !== null && rank <= 3) recall3 += 1;
      if (rank !== null && rank <= 5) recall5 += 1;
      mrrSum += rank === null ? 0 : 1 / rank;
      let dcg = 0;
      ranked.slice(0, 5).forEach((chunk, position) => { if (relevant.has(chunk.chunk_id)) dcg += 1 / Math.log2(position + 2); });
      let idcg = 0;
      for (let position = 0; position < Math.min(relevant.size, 5); position += 1) idcg += 1 / Math.log2(position + 2);
      ndcgSum += idcg ? dcg / idcg : 0;
      if (item.expected_question_class) {
        byClass[item.expected_question_class] ??= { hits: 0, total: 0, recall: 0 };
        byClass[item.expected_question_class].total += 1;
        if (rank !== null && rank <= 5) byClass[item.expected_question_class].hits += 1;
      }
      if (rank === null || rank > 5) failures.push("no expected relevant chunk in top 5");
    }

    const expectsNoAnswer = !item.expected_status.includes("eligible");
    if (expectsNoAnswer) {
      mustAbstain += 1;
      if (result.status !== "eligible" && result.evidence.length === 0 && result.available_claim_unit_ids.length === 0) abstained += 1;
      else if (item.critical) criticalFalseEligible += 1;
      if (item.category === "out_of_scope") { oosTotal += 1; if (result.status !== "eligible") oosAbstained += 1; }
    }

    for (const [ref, expected] of Object.entries(item.expected_states)) {
      for (const chunkId of resolve(ref)) {
        stateChecks += 1;
        const candidate = result.trace.candidates.find((entry) => entry.chunk_id === chunkId);
        const actual = candidate?.state ?? "excluded";
        if (actual === expected) stateCorrect += 1;
        else failures.push(`state ${ref}: ${actual} != ${expected}`);
      }
    }

    if (item.embedding === "fail") {
      lexCases += 1;
      synthesizedClaims += result.available_claim_unit_ids.length + result.evidence.length;
      const config = failing.config;
      const thresholdOk = result.discovery.every((chunk) => chunk.bm25 >= config.lexical_only_discovery_min_bm25 && chunk.anchor && chunk.rrf === null);
      const relevantOk = !relevant.size || result.status !== "lexical_only_discovery" || firstRank !== null;
      if (thresholdOk && relevantOk && result.evidence.length === 0 && result.available_claim_unit_ids.length === 0 && result.discovery.length <= 3 && item.expected_status.includes(result.status)) lexCorrect += 1;
      else failures.push("lexical-only discovery contract violated");
    }

    outcomes.push({ case_id: item.case_id, category: item.category, critical: item.critical, passed: failures.length === 0, failures, status: result.status, rank_of_first_relevant: firstRank });
  }

  for (const entry of Object.values(byClass)) entry.recall = round(entry.hits / entry.total);
  const byCategory: Record<string, number> = {};
  for (const item of cases) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  const thresholds = ok.config;
  return {
    dataset: {
      cases: cases.length,
      by_category: byCategory,
      adversarial_share: round(cases.filter((item) => item.adversarial).length / cases.length),
      abstention_share: round(cases.filter((item) => !item.expected_status.includes("eligible")).length / cases.length),
    },
    versions: versions!,
    config_thresholds: {
      vector_answer_min_cosine: thresholds.vector_answer_min_cosine,
      lexical_answer_min_bm25: thresholds.lexical_answer_min_bm25,
      vector_discovery_min_cosine: thresholds.vector_discovery_min_cosine,
      lexical_discovery_min_bm25: thresholds.lexical_discovery_min_bm25,
      lexical_only_discovery_min_bm25: thresholds.lexical_only_discovery_min_bm25,
    },
    retrieval: {
      answerable_cases: answerable,
      recall_at_1: round(recall1 / answerable),
      recall_at_3: round(recall3 / answerable),
      recall_at_5: round(recall5 / answerable),
      mrr: round(mrrSum / answerable),
      ndcg_at_5: round(ndcgSum / answerable),
      recall_at_5_by_class: byClass,
    },
    abstention: {
      must_abstain_cases: mustAbstain,
      abstained,
      accuracy: round(abstained / mustAbstain),
      false_eligible_rate: round((mustAbstain - abstained) / mustAbstain),
      critical_false_eligible: criticalFalseEligible,
      out_of_scope_abstention: round(oosAbstained / Math.max(oosTotal, 1)),
    },
    eligibility_states: { checks: stateChecks, correct: stateCorrect, accuracy: round(stateCorrect / Math.max(stateChecks, 1)) },
    lexical_only_discovery: { cases: lexCases, correct: lexCorrect, accuracy: round(lexCorrect / Math.max(lexCases, 1)), synthesized_claims: synthesizedClaims },
    exclusions: { violations: exclusionViolations },
    precision: { cases_with_evidence: casesWithEvidence, cases_with_irrelevant_evidence: irrelevantEvidenceIds.length, irrelevant_evidence_case_ids: irrelevantEvidenceIds },
    status_accuracy: round(statusCorrect / cases.length),
    failures: outcomes.filter((outcome) => !outcome.passed),
  };
}

export type GateResult = { gate: string; kind: "safety" | "quality"; threshold: string; actual: string; pass: boolean };

/**
 * Milestone 1 retrieval gates (design Section 9.6, retrieval rows only).
 * "safety" gates are hard CI gates. "quality" gates measure ranking quality on
 * the fixture embedder; see the threshold report for why they are not
 * calibration evidence for gemini-embedding-2.
 */
export function retrievalGateResults(report: EvalReport): GateResult[] {
  const classes = Object.entries(report.retrieval.recall_at_5_by_class);
  const rows: Omit<GateResult, "kind">[] = [
    { gate: "Recall@5 overall", threshold: ">= 0.90", actual: String(report.retrieval.recall_at_5), pass: report.retrieval.recall_at_5 >= 0.9 },
    { gate: "Recall@5 per Q1-Q5 class", threshold: ">= 0.875 each", actual: classes.map(([classId, entry]) => `${classId} ${entry.hits}/${entry.total}`).join(", "), pass: classes.length === 5 && classes.every(([, entry]) => entry.recall >= 0.875) },
    { gate: "MRR", threshold: ">= 0.80", actual: String(report.retrieval.mrr), pass: report.retrieval.mrr >= 0.8 },
    { gate: "Critical false-eligible", threshold: "0", actual: String(report.abstention.critical_false_eligible), pass: report.abstention.critical_false_eligible === 0 },
    { gate: "Out-of-scope abstention", threshold: ">= 0.95", actual: String(report.abstention.out_of_scope_abstention), pass: report.abstention.out_of_scope_abstention >= 0.95 },
    { gate: "Overall false-eligible rate", threshold: "<= 0.02", actual: String(report.abstention.false_eligible_rate), pass: report.abstention.false_eligible_rate <= 0.02 },
    { gate: "Component eligibility states", threshold: "1.00", actual: String(report.eligibility_states.accuracy), pass: report.eligibility_states.accuracy === 1 },
    { gate: "Lexical-only discovery contract", threshold: "1.00, zero claims", actual: `${report.lexical_only_discovery.accuracy}, ${report.lexical_only_discovery.synthesized_claims} claims`, pass: report.lexical_only_discovery.accuracy === 1 && report.lexical_only_discovery.synthesized_claims === 0 },
    { gate: "Denied / unmapped / ineligible chunks never surface or fuse", threshold: "0 violations", actual: String(report.exclusions.violations), pass: report.exclusions.violations === 0 },
    { gate: "Irrelevant in-class chunks kept out of evidence", threshold: "0 cases", actual: `${report.precision.cases_with_irrelevant_evidence}/${report.precision.cases_with_evidence}`, pass: report.precision.cases_with_irrelevant_evidence === 0 },
  ];
  const quality = new Set(["Recall@5 overall", "Recall@5 per Q1-Q5 class", "MRR", "Irrelevant in-class chunks kept out of evidence"]);
  return rows.map((row) => ({ ...row, kind: quality.has(row.gate) ? "quality" : "safety" }));
}

/** Regression baseline recorded in reports/baseline.json. */
export function baselineOf(report: EvalReport) {
  return {
    dataset_cases: report.dataset.cases,
    recall_at_5: report.retrieval.recall_at_5,
    recall_at_5_by_class: Object.fromEntries(Object.entries(report.retrieval.recall_at_5_by_class).map(([key, value]) => [key, value.recall])),
    mrr: report.retrieval.mrr,
    critical_false_eligible: report.abstention.critical_false_eligible,
    false_eligible_rate: report.abstention.false_eligible_rate,
    out_of_scope_abstention: report.abstention.out_of_scope_abstention,
    cases_with_irrelevant_evidence: report.precision.cases_with_irrelevant_evidence,
    failing_case_ids: report.failures.map((failure) => failure.case_id),
  };
}

