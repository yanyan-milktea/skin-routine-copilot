import { randomUUID } from "node:crypto";
import { sha256Hex, stableStringify } from "./ingredient-corpus.ts";
import type { IndexChunk } from "./ingredient-chunking.ts";
import type { Embedder } from "./ingredient-embedding.ts";
import type { IndexClaimUnit, LoadedIndex } from "./ingredient-index.ts";
import { containsPhrase, normalizeForMatch, tokenize } from "./ingredient-tokenizer.ts";
import type { CompiledAliases } from "./ingredient-tokenizer.ts";

// ---------------------------------------------------------------------------
// Frozen Phase 1 retrieval configuration (design Section 5.2). The checked-in
// config file must equal these constants exactly; production code never tunes
// them. Only offline calibration tooling may evaluate other threshold values.
// ---------------------------------------------------------------------------

export const PHASE1_RETRIEVAL_CONFIG = Object.freeze({
  schema_version: 1,
  fusion: "rrf",
  rrf_k: 60,
  component_candidate_limit: 40,
  fused_candidate_limit: 12,
  generation_chunk_limit: 6,
  per_source_limit: 2,
  tie_breakers: Object.freeze(["rrf_desc", "cosine_desc", "lexical_desc", "chunk_id_asc"]),
  eligibility_mode: "any",
  vector_answer_min_cosine: 0.62,
  vector_anchor_required: true,
  lexical_answer_min_bm25: 6.0,
  lexical_anchor_required: true,
  vector_discovery_min_cosine: 0.52,
  lexical_discovery_min_bm25: 3.5,
  lexical_only_discovery_min_bm25: 5.0,
  lexical_only_exact_anchor_required: true,
  bm25_implementation: "ingredient-bm25-v1",
  tokenizer_version: "ingredient-tokenizer-v1",
  threshold_calibration_dataset: "ingredient-rag-evals-v1",
});

export type RetrievalConfig = {
  schema_version: 1;
  fusion: "rrf";
  rrf_k: number;
  component_candidate_limit: number;
  fused_candidate_limit: number;
  generation_chunk_limit: number;
  per_source_limit: number;
  tie_breakers: readonly string[];
  eligibility_mode: "any";
  vector_answer_min_cosine: number;
  vector_anchor_required: true;
  lexical_answer_min_bm25: number;
  lexical_anchor_required: true;
  vector_discovery_min_cosine: number;
  lexical_discovery_min_bm25: number;
  lexical_only_discovery_min_bm25: number;
  lexical_only_exact_anchor_required: true;
  bm25_implementation: "ingredient-bm25-v1";
  tokenizer_version: "ingredient-tokenizer-v1";
  threshold_calibration_dataset: string;
};

const THRESHOLD_KEYS = ["vector_answer_min_cosine", "lexical_answer_min_bm25", "vector_discovery_min_cosine", "lexical_discovery_min_bm25", "lexical_only_discovery_min_bm25"] as const;
export const DISCOVERY_RESULT_LIMIT = 3;
export const BM25_PARAMETERS = Object.freeze({ k1: 1.2, b: 0.75 });

/**
 * Production: the value must equal PHASE1_RETRIEVAL_CONFIG exactly.
 * Calibration (offline grid report only): only the five numeric thresholds may differ.
 */
export function validateRetrievalConfig(value: unknown, options: { calibrationOverride?: boolean } = {}): RetrievalConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("RETRIEVAL_CONFIG_INVALID");
  const record = value as Record<string, unknown>;
  const expectedKeys = Object.keys(PHASE1_RETRIEVAL_CONFIG).sort().join(",");
  if (Object.keys(record).sort().join(",") !== expectedKeys) throw new Error("RETRIEVAL_CONFIG_KEYS_MISMATCH");
  if (options.calibrationOverride) {
    const fixed = { ...record };
    const frozen: Record<string, unknown> = { ...PHASE1_RETRIEVAL_CONFIG };
    for (const key of THRESHOLD_KEYS) {
      if (typeof record[key] !== "number" || !Number.isFinite(record[key] as number)) throw new Error(`RETRIEVAL_CONFIG_INVALID: ${key}`);
      delete fixed[key];
      delete frozen[key];
    }
    if (stableStringify(fixed) !== stableStringify(frozen)) throw new Error("RETRIEVAL_CONFIG_NON_THRESHOLD_CHANGE");
  } else if (stableStringify(record) !== stableStringify(PHASE1_RETRIEVAL_CONFIG)) {
    throw new Error("RETRIEVAL_CONFIG_NOT_PHASE1_CONSTANTS");
  }
  return Object.freeze({ ...(record as RetrievalConfig), tie_breakers: Object.freeze([...(record.tie_breakers as string[])]) });
}

export function retrievalConfigHash(config: RetrievalConfig): string {
  return `sha256:${sha256Hex(stableStringify(config))}`;
}

// ---------------------------------------------------------------------------
// Emergency deny list: checked before retrieval, no grace period.
// ---------------------------------------------------------------------------

export type DenyList = { schema_version: 1; deny_list_version: string; entries: { source_id: string; reason: string; disabled_at: string }[] };

export function validateDenyList(value: unknown): DenyList {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("DENY_LIST_INVALID");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "deny_list_version,entries,schema_version") throw new Error("DENY_LIST_INVALID");
  if (record.schema_version !== 1 || typeof record.deny_list_version !== "string" || !Array.isArray(record.entries)) throw new Error("DENY_LIST_INVALID");
  for (const entry of record.entries) {
    if (typeof entry !== "object" || entry === null) throw new Error("DENY_LIST_INVALID");
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "disabled_at,reason,source_id") throw new Error("DENY_LIST_INVALID");
    if (typeof item.source_id !== "string" || typeof item.reason !== "string" || !item.reason || typeof item.disabled_at !== "string") throw new Error("DENY_LIST_INVALID");
  }
  return value as DenyList;
}

// ---------------------------------------------------------------------------
// Deterministic question classification (no LLM rewriting).
// ---------------------------------------------------------------------------

export type Classification = {
  status: "classified" | "unclassified" | "ambiguous" | "blocked" | "invalid";
  question_class: string | null;
  intent_ids: string[];
  matched_classes: string[];
  blocked_families: string[];
  reason_code: string | null;
  query_tokens: string[];
};

export const MAX_QUESTION_CHARACTERS = 600;

export function prepareQuestion(question: unknown): string | null {
  if (typeof question !== "string") return null;
  const cleaned = question.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  const length = [...cleaned].length;
  return length >= 1 && length <= MAX_QUESTION_CHARACTERS ? cleaned : null;
}

export function classifyQuestion(question: string, aliases: CompiledAliases): Classification {
  const prepared = prepareQuestion(question);
  if (prepared === null) return { status: "invalid", question_class: null, intent_ids: [], matched_classes: [], blocked_families: [], reason_code: "QUESTION_INVALID", query_tokens: [] };
  const normalized = ` ${normalizeForMatch(prepared)} `;
  const tokens = tokenize(prepared, aliases);
  const blocked = Object.entries(aliases.blocked)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(normalized)))
    .map(([family]) => family)
    .sort();
  const matched = Object.keys(aliases.classes)
    .filter((classId) => aliases.classes[classId].class_anchors.some((anchor) => containsPhrase(tokens, anchor)))
    .sort();
  if (blocked.length) {
    return { status: "blocked", question_class: null, intent_ids: [], matched_classes: matched, blocked_families: blocked, reason_code: `BLOCKED_${blocked[0].toUpperCase()}`, query_tokens: tokens };
  }
  if (matched.length === 0) return { status: "unclassified", question_class: null, intent_ids: [], matched_classes: [], blocked_families: [], reason_code: "CLASS_UNMATCHED", query_tokens: tokens };
  let selected: string | null = matched.length === 1 ? matched[0] : null;
  if (!selected) selected = aliases.class_precedence.find((classId) => matched.includes(classId)) ?? null;
  if (!selected) return { status: "ambiguous", question_class: null, intent_ids: [], matched_classes: matched, blocked_families: [], reason_code: "CLASS_AMBIGUOUS", query_tokens: tokens };
  const rule = aliases.classes[selected];
  const triggered = Object.keys(rule.intents).filter((intentId) => rule.intents[intentId].query_triggers.some((trigger) => containsPhrase(tokens, trigger)));
  // No default intent: a class match without a reviewed intent trigger is not answerable.
  if (triggered.length === 0) return { status: "unclassified", question_class: null, intent_ids: [], matched_classes: matched, blocked_families: [], reason_code: "INTENT_UNMATCHED", query_tokens: tokens };
  return {
    status: "classified",
    question_class: selected,
    intent_ids: triggered,
    matched_classes: matched,
    blocked_families: [],
    reason_code: null,
    query_tokens: tokens,
  };
}

// ---------------------------------------------------------------------------
// ingredient-bm25-v1 over title + heading breadcrumb + passage.
// ---------------------------------------------------------------------------

type LexicalDoc = { tokens: string[]; tf: Map<string, number>; length: number };

export type Bm25Model = { docs: LexicalDoc[]; df: Map<string, number>; averageLength: number; count: number };

export function lexicalText(chunk: Pick<IndexChunk, "title" | "section_path" | "text">): string {
  return `${chunk.title}\n${chunk.section_path.slice(1).join("\n")}\n${chunk.text}`;
}

export function buildBm25(chunks: readonly Pick<IndexChunk, "title" | "section_path" | "text">[], aliases: CompiledAliases): Bm25Model {
  const docs = chunks.map((chunk) => {
    const tokens = tokenize(lexicalText(chunk), aliases);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return { tokens, tf, length: tokens.length };
  });
  const df = new Map<string, number>();
  for (const doc of docs) for (const token of doc.tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.length, 1);
  return { docs, df, averageLength, count: docs.length };
}

export function bm25Score(model: Bm25Model, docIndex: number, queryTokens: readonly string[]): number {
  const doc = model.docs[docIndex];
  const { k1, b } = BM25_PARAMETERS;
  let score = 0;
  for (const term of [...new Set(queryTokens)].sort()) {
    const frequency = doc.tf.get(term) ?? 0;
    if (!frequency) continue;
    const df = model.df.get(term) ?? 0;
    const idf = Math.log(1 + (model.count - df + 0.5) / (df + 0.5));
    score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * doc.length) / model.averageLength)));
  }
  return score;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

// ---------------------------------------------------------------------------
// Pre-fusion eligibility and exact RRF.
// ---------------------------------------------------------------------------

export type EligibilityState = "vector_only" | "lexical_only" | "both" | "neither";

export type ScoredCandidate = {
  chunk_id: string;
  cosine: number | null;
  bm25: number;
  anchor: boolean;
  vector_eligible: boolean;
  lexical_eligible: boolean;
  state: EligibilityState;
  gate_codes: string[];
};

export type FusedCandidate = ScoredCandidate & { rank_vector: number | null; rank_lexical: number | null; rrf: number; fused_rank: number };

export function eligibilityState(vector: boolean, lexical: boolean): EligibilityState {
  if (vector && lexical) return "both";
  if (vector) return "vector_only";
  if (lexical) return "lexical_only";
  return "neither";
}

/**
 * Component answer gates (Section 5.2), ANY mode. Both gates require the
 * reviewed class + intent anchor: a chunk that is only semantically "close"
 * (for example a keyword-stuffed navigation page) cannot reach model evidence.
 */
export function componentGates(cosineScore: number, bm25: number, anchor: boolean, config: Pick<RetrievalConfig, "vector_answer_min_cosine" | "vector_anchor_required" | "lexical_answer_min_bm25" | "lexical_anchor_required">) {
  const vectorScorePass = cosineScore >= config.vector_answer_min_cosine;
  const vectorEligible = vectorScorePass && (!config.vector_anchor_required || anchor);
  const lexicalScorePass = bm25 >= config.lexical_answer_min_bm25;
  const lexicalEligible = lexicalScorePass && (!config.lexical_anchor_required || anchor);
  const gateCodes = [
    vectorEligible ? "VECTOR_GATE_PASS" : vectorScorePass ? "VECTOR_ANCHOR_MISSING" : "VECTOR_GATE_FAIL",
    lexicalEligible ? "LEXICAL_GATE_PASS" : lexicalScorePass ? "LEXICAL_ANCHOR_MISSING" : "LEXICAL_SCORE_FAIL",
  ];
  return { vector_eligible: vectorEligible, lexical_eligible: lexicalEligible, state: eligibilityState(vectorEligible, lexicalEligible), gate_codes: gateCodes };
}

/** Lexical-only discovery gate used when the query embedding fails (Section 5.3). */
export function lexicalOnlyDiscoveryEligible(bm25: number, anchor: boolean, config: Pick<RetrievalConfig, "lexical_only_discovery_min_bm25" | "lexical_only_exact_anchor_required">): boolean {
  return bm25 >= config.lexical_only_discovery_min_bm25 && (!config.lexical_only_exact_anchor_required || anchor);
}

export function compareFused(a: Pick<FusedCandidate, "rrf" | "cosine" | "bm25" | "chunk_id">, b: Pick<FusedCandidate, "rrf" | "cosine" | "bm25" | "chunk_id">): number {
  if (a.rrf !== b.rrf) return b.rrf - a.rrf;
  const ac = a.cosine ?? Number.NEGATIVE_INFINITY;
  const bc = b.cosine ?? Number.NEGATIVE_INFINITY;
  if (ac !== bc) return bc - ac;
  if (a.bm25 !== b.bm25) return b.bm25 - a.bm25;
  return a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0;
}

/**
 * Exact Reciprocal Rank Fusion over two independently ranked, already-eligible
 * lists. `inVector` / `inLexical` decide list membership; RRF never decides relevance.
 * rrf(d) = 1/(k + rank_vector(d)) + 1/(k + rank_lexical(d)); absent lists contribute 0.
 */
export function fuseRrf(
  candidates: readonly ScoredCandidate[],
  config: Pick<RetrievalConfig, "rrf_k" | "component_candidate_limit">,
  membership: { inVector: (c: ScoredCandidate) => boolean; inLexical: (c: ScoredCandidate) => boolean } = { inVector: (c) => c.vector_eligible, inLexical: (c) => c.lexical_eligible },
): FusedCandidate[] {
  const byId = (a: ScoredCandidate, b: ScoredCandidate) => (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0);
  const vectorList = candidates
    .filter(membership.inVector)
    .sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0) || byId(a, b))
    .slice(0, config.component_candidate_limit);
  const lexicalList = candidates
    .filter(membership.inLexical)
    .sort((a, b) => b.bm25 - a.bm25 || byId(a, b))
    .slice(0, config.component_candidate_limit);
  const vectorRank = new Map(vectorList.map((candidate, index) => [candidate.chunk_id, index + 1]));
  const lexicalRank = new Map(lexicalList.map((candidate, index) => [candidate.chunk_id, index + 1]));
  const union = new Map<string, ScoredCandidate>();
  for (const candidate of [...vectorList, ...lexicalList]) union.set(candidate.chunk_id, candidate);
  const fused = [...union.values()].map((candidate) => {
    const rankVector = vectorRank.get(candidate.chunk_id) ?? null;
    const rankLexical = lexicalRank.get(candidate.chunk_id) ?? null;
    const rrf = (rankVector === null ? 0 : 1 / (config.rrf_k + rankVector)) + (rankLexical === null ? 0 : 1 / (config.rrf_k + rankLexical));
    return { ...candidate, rank_vector: rankVector, rank_lexical: rankLexical, rrf, fused_rank: 0 };
  });
  fused.sort(compareFused);
  fused.forEach((candidate, index) => { candidate.fused_rank = index + 1; });
  return fused;
}

// ---------------------------------------------------------------------------
// Retriever
// ---------------------------------------------------------------------------

export type RetrievalStatus = "eligible" | "discovery" | "lexical_only_discovery" | "insufficient";

export type RetrievedChunk = {
  chunk_id: string;
  source_id: string;
  document_id: string;
  section_path: string[];
  text: string;
  cosine: number | null;
  bm25: number;
  anchor: boolean;
  state: EligibilityState;
  rank_vector: number | null;
  rank_lexical: number | null;
  rrf: number | null;
};

export type RetrievalTrace = {
  trace_id: string;
  versions: {
    corpus_version: string;
    index_version: string;
    embedding_model: string;
    retrieval_config_sha256: string;
    aliases_version: string;
    tokenizer_version: string;
    bm25_implementation: string;
    deny_list_version: string | null;
  };
  classification: Omit<Classification, "query_tokens">;
  mode: "hybrid" | "lexical_only" | "none";
  excluded: { source_class_mismatch: number; source_denied: number };
  candidates: (Omit<ScoredCandidate, "state"> & { state: EligibilityState })[];
  fused: { chunk_id: string; rank_vector: number | null; rank_lexical: number | null; rrf: number; fused_rank: number }[];
  dropped: { chunk_id: string; reason: string }[];
  selected_chunk_ids: string[];
  discovery_chunk_ids: string[];
  available_claim_unit_ids: string[];
  rejected_claim_units: { claim_unit_id: string; reason: string }[];
  uncovered_intent_ids: string[];
  durations_ms: { embedding: number; retrieval: number };
  fallback_reason: string | null;
};

export type RetrievalResult = {
  status: RetrievalStatus;
  question_class: string | null;
  intent_ids: string[];
  reason_code: string | null;
  /** Answer-eligible evidence for generation (max generation_chunk_limit). Empty unless status is "eligible". */
  evidence: RetrievedChunk[];
  /** Exact-excerpt discovery aids. Never sent to a model and never support a claim. */
  discovery: RetrievedChunk[];
  available_claim_unit_ids: string[];
  uncovered_intent_ids: string[];
  trace: RetrievalTrace;
};

export interface Retriever {
  retrieve(question: string): Promise<RetrievalResult>;
}

export type QueryEmbedder = Pick<Embedder, "model" | "dimensions" | "embed">;

export type RetrieverOptions = {
  index: LoadedIndex;
  config: RetrievalConfig;
  aliases: CompiledAliases;
  embedder: QueryEmbedder;
  denyList?: DenyList | null;
  clock?: () => number;
  traceId?: () => string;
};

type CandidateRow = { index: number; chunk: IndexChunk };

export function createRetriever(options: RetrieverOptions): Retriever {
  const { index, config, aliases, embedder } = options;
  if (config.tokenizer_version !== aliases.tokenizer_version || index.manifest.tokenizer_version !== aliases.tokenizer_version) throw new Error("RETRIEVER_TOKENIZER_MISMATCH");
  if (embedder.model !== index.manifest.embedding_model || embedder.dimensions !== index.manifest.embedding_dimensions) throw new Error("RETRIEVER_EMBEDDING_MODEL_MISMATCH");
  const clock = options.clock ?? (() => performance.now());
  const nextTraceId = options.traceId ?? (() => randomUUID());
  const denied = new Set((options.denyList?.entries ?? []).map((entry) => entry.source_id));
  const bm25 = buildBm25(index.chunks, aliases);
  const chunkPosition = new Map(index.chunks.map((chunk, position) => [chunk.chunk_id, position]));
  const configHash = retrievalConfigHash(config);

  const hasAnchors = (position: number, classId: string, intentIds: readonly string[]): boolean => {
    const tokens = bm25.docs[position].tokens;
    const rule = aliases.classes[classId];
    if (!rule.class_anchors.some((anchor) => containsPhrase(tokens, anchor))) return false;
    return intentIds.some((intentId) => rule.intents[intentId]?.chunk_anchors.some((anchor) => containsPhrase(tokens, anchor)));
  };

  const toRetrieved = (chunk: IndexChunk, scored: ScoredCandidate, fused?: FusedCandidate): RetrievedChunk => ({
    chunk_id: chunk.chunk_id,
    source_id: chunk.source_id,
    document_id: chunk.document_id,
    section_path: [...chunk.section_path],
    text: chunk.text,
    cosine: scored.cosine,
    bm25: scored.bm25,
    anchor: scored.anchor,
    state: scored.state,
    rank_vector: fused?.rank_vector ?? null,
    rank_lexical: fused?.rank_lexical ?? null,
    rrf: fused?.rrf ?? null,
  });

  /** Overlap dedupe then per-source cap, in the given order. */
  const diversify = (ordered: readonly string[], limit: number, dropped: { chunk_id: string; reason: string }[]): string[] => {
    const kept: IndexChunk[] = [];
    const perSource = new Map<string, number>();
    for (const chunkId of ordered) {
      if (kept.length >= limit) { dropped.push({ chunk_id: chunkId, reason: "RESULT_LIMIT" }); continue; }
      const chunk = index.chunks[chunkPosition.get(chunkId)!];
      if (kept.some((other) => other.content_hash === chunk.content_hash)) { dropped.push({ chunk_id: chunkId, reason: "DEDUPE_DUPLICATE_CONTENT" }); continue; }
      if (kept.some((other) => other.document_id === chunk.document_id && other.start_char < chunk.end_char && chunk.start_char < other.end_char)) {
        dropped.push({ chunk_id: chunkId, reason: "DEDUPE_OVERLAP" });
        continue;
      }
      const count = perSource.get(chunk.source_id) ?? 0;
      if (count >= config.per_source_limit) {
        const adjacentQualifier = chunk.qualifier_continuation && kept.some((other) => other.document_id === chunk.document_id && other.section_path.join("\u0000") === chunk.section_path.join("\u0000") && other.ordinal === chunk.ordinal - 1);
        if (!adjacentQualifier) { dropped.push({ chunk_id: chunkId, reason: "SOURCE_CAP" }); continue; }
      }
      perSource.set(chunk.source_id, count + 1);
      kept.push(chunk);
    }
    return kept.map((chunk) => chunk.chunk_id);
  };

  const claimAvailability = (classId: string, intentIds: readonly string[], eligibleIds: ReadonlySet<string>) => {
    const available: IndexClaimUnit[] = [];
    const rejected: { claim_unit_id: string; reason: string }[] = [];
    for (const unit of index.claimUnits) {
      if (unit.question_class !== classId) continue;
      if (!unit.enabled) { rejected.push({ claim_unit_id: unit.claim_unit_id, reason: "CLAIM_UNIT_DISABLED" }); continue; }
      if (!unit.supported_intent_ids.some((intentId) => intentIds.includes(intentId))) { rejected.push({ claim_unit_id: unit.claim_unit_id, reason: "CLAIM_UNIT_WRONG_INTENT" }); continue; }
      if (unit.source_document_hashes.some((binding) => denied.has(binding.source_id))) { rejected.push({ claim_unit_id: unit.claim_unit_id, reason: "CLAIM_UNIT_SOURCE_DENIED" }); continue; }
      if (!unit.supporting_chunk_ids.every((chunkId) => eligibleIds.has(chunkId))) { rejected.push({ claim_unit_id: unit.claim_unit_id, reason: "CLAIM_UNIT_SUPPORT_NOT_ELIGIBLE" }); continue; }
      available.push(unit);
    }
    const covered = new Set(available.flatMap((unit) => unit.supported_intent_ids));
    return { available, rejected, uncovered: intentIds.filter((intentId) => !covered.has(intentId)) };
  };

  return {
    async retrieve(question: string): Promise<RetrievalResult> {
      const started = clock();
      const classification = classifyQuestion(question, aliases);
      const { query_tokens: queryTokens, ...classificationTrace } = classification;
      const trace: RetrievalTrace = {
        trace_id: nextTraceId(),
        versions: {
          corpus_version: index.manifest.corpus_version,
          index_version: index.manifest.index_version,
          embedding_model: index.manifest.embedding_model,
          retrieval_config_sha256: configHash,
          aliases_version: aliases.aliases_version,
          tokenizer_version: aliases.tokenizer_version,
          bm25_implementation: config.bm25_implementation,
          deny_list_version: options.denyList?.deny_list_version ?? null,
        },
        classification: classificationTrace,
        mode: "none",
        excluded: { source_class_mismatch: 0, source_denied: 0 },
        candidates: [],
        fused: [],
        dropped: [],
        selected_chunk_ids: [],
        discovery_chunk_ids: [],
        available_claim_unit_ids: [],
        rejected_claim_units: [],
        uncovered_intent_ids: [],
        durations_ms: { embedding: 0, retrieval: 0 },
        fallback_reason: null,
      };
      const finish = (status: RetrievalStatus, reason: string | null, evidence: RetrievedChunk[], discovery: RetrievedChunk[], available: string[], uncovered: string[]): RetrievalResult => {
        trace.selected_chunk_ids = evidence.map((chunk) => chunk.chunk_id);
        trace.discovery_chunk_ids = discovery.map((chunk) => chunk.chunk_id);
        trace.available_claim_unit_ids = available;
        trace.uncovered_intent_ids = uncovered;
        trace.durations_ms.retrieval = Math.max(0, clock() - started - trace.durations_ms.embedding);
        return { status, question_class: classification.question_class, intent_ids: classification.intent_ids, reason_code: reason, evidence, discovery, available_claim_unit_ids: available, uncovered_intent_ids: uncovered, trace };
      };

      if (classification.status !== "classified" || !classification.question_class) {
        return finish("insufficient", classification.reason_code, [], [], [], []);
      }
      const classId = classification.question_class;
      const intentIds = classification.intent_ids;

      // Mandatory filters before any score is eligible: class source mapping and emergency deny list.
      // Hash/enable integrity was enforced when the index was verified and loaded.
      const rows: CandidateRow[] = [];
      index.chunks.forEach((chunk, position) => {
        if (!chunk.question_classes.includes(classId)) { trace.excluded.source_class_mismatch += 1; return; }
        if (denied.has(chunk.source_id)) { trace.excluded.source_denied += 1; return; }
        rows.push({ index: position, chunk });
      });

      const lexical = rows.map((row) => ({ row, bm25: bm25Score(bm25, row.index, queryTokens), anchor: hasAnchors(row.index, classId, intentIds) }));

      let queryVector: Float32Array | null = null;
      const embedStarted = clock();
      try {
        // The bounded, prepared question is embedded as data; classification already proved it valid.
        const [vector] = await embedder.embed([prepareQuestion(question) ?? ""], "retrieval_query");
        if (!vector || vector.length !== index.manifest.embedding_dimensions) throw new Error("EMBEDDING_DIMENSION_MISMATCH");
        let norm = 0;
        for (let i = 0; i < vector.length; i += 1) {
          if (!Number.isFinite(vector[i])) throw new Error("EMBEDDING_NONFINITE");
          norm += vector[i] * vector[i];
        }
        if (Math.abs(Math.sqrt(norm) - 1) > 1e-3) throw new Error("EMBEDDING_NOT_NORMALIZED");
        queryVector = vector;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        trace.fallback_reason = /^EMBEDDING_[A-Z0-9_]+$/.test(message) ? message : "EMBEDDING_FAILED";
      }
      trace.durations_ms.embedding = Math.max(0, clock() - embedStarted);

      if (!queryVector) {
        // Lexical-only discovery: BM25 >= 5.0 with an exact reviewed anchor. No RRF, no claims.
        trace.mode = "lexical_only";
        const passing = lexical
          .filter((item) => lexicalOnlyDiscoveryEligible(item.bm25, item.anchor, config))
          .sort((a, b) => b.bm25 - a.bm25 || (a.row.chunk.chunk_id < b.row.chunk.chunk_id ? -1 : 1));
        trace.candidates = lexical.map((item) => ({
          chunk_id: item.row.chunk.chunk_id, cosine: null, bm25: item.bm25, anchor: item.anchor, vector_eligible: false, lexical_eligible: false, state: "neither" as EligibilityState,
          gate_codes: [item.bm25 >= config.lexical_only_discovery_min_bm25 ? (item.anchor ? "LEXICAL_ONLY_DISCOVERY_PASS" : "LEXICAL_ANCHOR_MISSING") : "LEXICAL_ONLY_SCORE_FAIL"],
        }));
        const kept = diversify(passing.map((item) => item.row.chunk.chunk_id), DISCOVERY_RESULT_LIMIT, trace.dropped);
        const byId = new Map(lexical.map((item) => [item.row.chunk.chunk_id, item]));
        const discovery = kept.map((chunkId) => {
          const item = byId.get(chunkId)!;
          return toRetrieved(item.row.chunk, { chunk_id: chunkId, cosine: null, bm25: item.bm25, anchor: item.anchor, vector_eligible: false, lexical_eligible: false, state: "neither", gate_codes: [] });
        });
        return finish(discovery.length ? "lexical_only_discovery" : "insufficient", trace.fallback_reason, [], discovery, [], intentIds.slice());
      }

      trace.mode = "hybrid";
      const scored: ScoredCandidate[] = lexical.map((item) => {
        const cos = cosine(queryVector!, index.vectors[item.row.index]);
        return { chunk_id: item.row.chunk.chunk_id, cosine: cos, bm25: item.bm25, anchor: item.anchor, ...componentGates(cos, item.bm25, item.anchor, config) };
      });
      trace.candidates = scored.map((candidate) => ({ ...candidate, gate_codes: [...candidate.gate_codes] }));
      const scoredById = new Map(scored.map((candidate) => [candidate.chunk_id, candidate]));
      const chunkOf = (chunkId: string) => index.chunks[chunkPosition.get(chunkId)!];

      // Ineligible chunks never enter fusion.
      const fused = fuseRrf(scored.filter((candidate) => candidate.state !== "neither"), config);
      trace.fused = fused.map(({ chunk_id, rank_vector, rank_lexical, rrf, fused_rank }) => ({ chunk_id, rank_vector, rank_lexical, rrf, fused_rank }));
      const retained = fused.slice(0, config.fused_candidate_limit);
      for (const candidate of fused.slice(config.fused_candidate_limit)) trace.dropped.push({ chunk_id: candidate.chunk_id, reason: "FUSED_CANDIDATE_LIMIT" });
      const fusedById = new Map(fused.map((candidate) => [candidate.chunk_id, candidate]));
      const selectedIds = diversify(retained.map((candidate) => candidate.chunk_id), config.generation_chunk_limit, trace.dropped);
      const evidence = selectedIds.map((chunkId) => toRetrieved(chunkOf(chunkId), scoredById.get(chunkId)!, fusedById.get(chunkId)));

      if (evidence.length) {
        const eligibleIds = new Set(fused.map((candidate) => candidate.chunk_id));
        const claims = claimAvailability(classId, intentIds, eligibleIds);
        trace.rejected_claim_units = claims.rejected;
        if (claims.available.length) {
          return finish("eligible", null, evidence, [], claims.available.map((unit) => unit.claim_unit_id).sort(), claims.uncovered);
        }
        // Evidence exists but no reviewed claim unit covers a requested intent: show it only as discovery.
        return finish("discovery", "NO_CLAIM_UNIT_FOR_INTENT", [], evidence.slice(0, DISCOVERY_RESULT_LIMIT), [], claims.uncovered);
      }

      // Near-miss discovery: failed both answer gates but passed a discovery gate.
      const discoveryCandidates = scored.filter((candidate) =>
        (candidate.cosine ?? 0) >= config.vector_discovery_min_cosine || (candidate.bm25 >= config.lexical_discovery_min_bm25 && candidate.anchor));
      const discoveryFused = fuseRrf(discoveryCandidates, config, {
        inVector: (candidate) => (candidate.cosine ?? 0) >= config.vector_discovery_min_cosine,
        inLexical: (candidate) => candidate.bm25 >= config.lexical_discovery_min_bm25 && candidate.anchor,
      });
      const discoveryIds = diversify(discoveryFused.map((candidate) => candidate.chunk_id), DISCOVERY_RESULT_LIMIT, trace.dropped);
      const discoveryById = new Map(discoveryFused.map((candidate) => [candidate.chunk_id, candidate]));
      const discovery = discoveryIds.map((chunkId) => toRetrieved(chunkOf(chunkId), scoredById.get(chunkId)!, discoveryById.get(chunkId)));
      return finish(discovery.length ? "discovery" : "insufficient", "NO_ANSWER_GATE_PASSED", [], discovery, [], intentIds.slice());
    },
  };
}
