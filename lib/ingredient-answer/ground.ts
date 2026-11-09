import { createChunkContentHash } from "../ingredient-corpus.ts";
import type { IndexChunk } from "../ingredient-chunking.ts";
import { claimTermFailures, claimUnitReviewBindingHash } from "../ingredient-index.ts";
import type { IndexClaimUnit, LoadedIndex } from "../ingredient-index.ts";
import type { RetrievedChunk } from "../ingredient-retrieval.ts";
import { MAX_CITATIONS, MAX_DISCOVERY_EXCERPTS, MAX_EXCERPT_CHARACTERS } from "./contract.ts";
import type { PublicCitation, PublicClaim } from "./contract.ts";
import { claimPolicyFailures } from "./safety.ts";

// Deterministic claim-unit grounding and server-owned citation hydration
// (design Sections 7.1-7.3). Every gate is pass/fail with a stable rule code.

export type GroundingContext = {
  index: LoadedIndex;
  questionClass: string;
  intentIds: readonly string[];
  /** Exact claim-unit IDs sent to the model in AVAILABLE_CLAIM_UNITS for this request. */
  availableIds: ReadonlySet<string>;
  /** Chunk IDs that passed an answer-level gate and were sent in EVIDENCE_BLOCKS. */
  evidenceIds: ReadonlySet<string>;
  allowedPublishers: ReadonlySet<string>;
};

export type Rejection = { claim_unit_id: string; rule: string };

export type GroundedAnswer = {
  accepted: IndexClaimUnit[];
  rejected: Rejection[];
  coveredIntentIds: string[];
  uncoveredIntentIds: string[];
  claims: PublicClaim[];
  citations: PublicCitation[];
  answer: string;
  citationRejections: string[];
};

/** Claim units the prompt may offer: retriever-available, and every supporting chunk is in the supplied evidence. */
export function promptClaimUnits(index: LoadedIndex, availableIds: readonly string[], evidenceIds: ReadonlySet<string>): IndexClaimUnit[] {
  const byId = new Map(index.claimUnits.map((unit) => [unit.claim_unit_id, unit]));
  return availableIds
    .map((id) => byId.get(id))
    .filter((unit): unit is IndexClaimUnit => Boolean(unit) && unit!.supporting_chunk_ids.every((chunkId) => evidenceIds.has(chunkId)));
}

function chunkMap(index: LoadedIndex): Map<string, IndexChunk> {
  return new Map(index.chunks.map((chunk) => [chunk.chunk_id, chunk]));
}

/** Gates 1-10 for one selected ID. Returns the first failing rule code, or null when the unit is accepted. */
export function verifySelection(id: string, context: GroundingContext, chunks: Map<string, IndexChunk>): string | null {
  if (!context.availableIds.has(id)) return "CLAIM_UNIT_NOT_AVAILABLE";
  const unit = context.index.claimUnits.find((item) => item.claim_unit_id === id);
  if (!unit) return "CLAIM_UNIT_UNKNOWN";
  if (!unit.enabled) return "CLAIM_UNIT_DISABLED";
  if (createChunkContentHash(unit.canonical_claim_text) !== unit.content_hash) return "CLAIM_UNIT_CONTENT_HASH";
  if (claimUnitReviewBindingHash(unit) !== unit.review_binding_hash) return "CLAIM_UNIT_REVIEW_BINDING";
  if (unit.question_class !== context.questionClass) return "CLAIM_UNIT_WRONG_CLASS";
  if (!unit.supported_intent_ids.some((intentId) => context.intentIds.includes(intentId))) return "CLAIM_UNIT_WRONG_INTENT";
  const supporting: IndexChunk[] = [];
  for (const chunkId of unit.supporting_chunk_ids) {
    if (!context.evidenceIds.has(chunkId)) return "CLAIM_UNIT_SUPPORT_NOT_SUPPLIED";
    const chunk = chunks.get(chunkId);
    if (!chunk) return "CITATION_CHUNK_UNKNOWN";
    if (createChunkContentHash(chunk.text) !== chunk.content_hash) return "CITATION_CHUNK_HASH";
    const binding = unit.source_document_hashes.find((item) => item.source_id === chunk.source_id);
    const source = context.index.manifest.sources.find((item) => item.source_id === chunk.source_id);
    if (!binding || !source || binding.document_hash !== chunk.document_hash || source.document_hash !== chunk.document_hash) return "CITATION_DOCUMENT_HASH";
    if (!chunk.text.includes(unit.canonical_claim_text)) return "CITATION_NOT_VERBATIM";
    supporting.push(chunk);
  }
  const termFailure = claimTermFailures(unit, supporting.map((chunk) => chunk.text))[0];
  if (termFailure) return termFailure;
  const policyFailure = claimPolicyFailures(unit.canonical_claim_text)[0];
  if (policyFailure) return policyFailure;
  return null;
}

function citationFor(chunk: IndexChunk, excerpt: string, number: number, context: Pick<GroundingContext, "index" | "allowedPublishers">): PublicCitation | string {
  const source = context.index.manifest.sources.find((item) => item.source_id === chunk.source_id);
  if (!source) return "CITATION_SOURCE_UNKNOWN";
  if (!context.allowedPublishers.has(source.publisher)) return "CITATION_PUBLISHER_NOT_ALLOWED";
  if (!/^https:\/\//.test(source.canonical_url)) return "CITATION_URL_NOT_HTTPS";
  if (!excerpt || !chunk.text.includes(excerpt)) return "CITATION_EXCERPT_NOT_EXACT";
  if (excerpt.length > MAX_EXCERPT_CHARACTERS) return "CITATION_EXCERPT_TOO_LONG";
  return {
    number,
    source_id: source.source_id,
    chunk_id: chunk.chunk_id,
    publisher: source.publisher,
    title: source.title,
    url: source.canonical_url,
    retrieved_at: source.retrieved_at,
    section: chunk.section_path[chunk.section_path.length - 1],
    excerpt,
    document_hash: chunk.document_hash,
  };
}

/** Smallest exact span of the chunk covering every claim text that cites it (Section 7.3). */
function coveringExcerpt(chunk: IndexChunk, claimTexts: readonly string[]): string {
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  for (const text of claimTexts) {
    const at = chunk.text.indexOf(text);
    if (at < 0) return "";
    start = Math.min(start, at);
    end = Math.max(end, at + text.length);
  }
  return chunk.text.slice(start, end);
}

/**
 * Verify the model's selections, then build claims, citations, and the
 * deterministic answer string from canonical text in model-selected order.
 */
export function groundSelections(selectedIds: readonly string[], context: GroundingContext): GroundedAnswer {
  const chunks = chunkMap(context.index);
  const rejected: Rejection[] = [];
  const accepted: IndexClaimUnit[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (seen.has(id)) { rejected.push({ claim_unit_id: id, rule: "CLAIM_UNIT_DUPLICATE" }); continue; }
    seen.add(id);
    const rule = verifySelection(id, context, chunks);
    if (rule) rejected.push({ claim_unit_id: id, rule });
    else accepted.push(context.index.claimUnits.find((unit) => unit.claim_unit_id === id)!);
  }

  // Citation numbering by first appearance; one numbered source per chunk.
  const citationTexts = new Map<string, string[]>();
  const order: string[] = [];
  for (const unit of accepted) {
    for (const chunkId of unit.supporting_chunk_ids.slice(0, 3)) {
      if (!citationTexts.has(chunkId)) { citationTexts.set(chunkId, []); order.push(chunkId); }
      citationTexts.get(chunkId)!.push(unit.canonical_claim_text);
    }
  }
  const citationRejections: string[] = [];
  const numberByChunk = new Map<string, number>();
  const citations: PublicCitation[] = [];
  for (const chunkId of order.slice(0, MAX_CITATIONS)) {
    const chunk = chunks.get(chunkId)!;
    const built = citationFor(chunk, coveringExcerpt(chunk, citationTexts.get(chunkId)!), citations.length + 1, context);
    if (typeof built === "string") { citationRejections.push(built); continue; }
    citations.push(built);
    numberByChunk.set(chunkId, built.number);
  }

  // A claim survives only if every one of its supporting chunks hydrated into a citation.
  const claims: PublicClaim[] = [];
  const finalUnits: IndexClaimUnit[] = [];
  for (const unit of accepted) {
    const numbers = unit.supporting_chunk_ids.slice(0, 3).map((chunkId) => numberByChunk.get(chunkId));
    if (numbers.some((number) => number === undefined) || unit.supporting_chunk_ids.length > 3) {
      rejected.push({ claim_unit_id: unit.claim_unit_id, rule: "CITATION_HYDRATION_FAILED" });
      continue;
    }
    finalUnits.push(unit);
    claims.push({ claim_unit_id: unit.claim_unit_id, text: unit.canonical_claim_text, canonical_text_hash: unit.content_hash, citation_numbers: numbers as number[] });
  }
  // Drop citations no surviving claim references, then renumber densely by first appearance.
  const used = new Set(claims.flatMap((claim) => claim.citation_numbers));
  const kept = citations.filter((citation) => used.has(citation.number));
  const renumber = new Map(kept.map((citation, index) => [citation.number, index + 1]));
  const finalCitations = kept.map((citation) => ({ ...citation, number: renumber.get(citation.number)! }));
  const finalClaims = claims.map((claim) => ({ ...claim, citation_numbers: claim.citation_numbers.map((number) => renumber.get(number)!) }));

  const covered = new Set(finalUnits.flatMap((unit) => unit.supported_intent_ids).filter((intentId) => context.intentIds.includes(intentId)));
  return {
    accepted: finalUnits,
    rejected,
    coveredIntentIds: context.intentIds.filter((intentId) => covered.has(intentId)),
    uncoveredIntentIds: context.intentIds.filter((intentId) => !covered.has(intentId)),
    claims: finalClaims,
    citations: finalCitations,
    answer: finalClaims.map((claim) => `${claim.text} ${claim.citation_numbers.map((number) => `[${number}]`).join("")}`).join("\n"),
    citationRejections,
  };
}

/** Longest whole-sentence prefix of a chunk within the excerpt limit (always an exact substring). */
export function boundedExcerpt(text: string): string {
  if (text.length <= MAX_EXCERPT_CHARACTERS) return text;
  const head = text.slice(0, MAX_EXCERPT_CHARACTERS);
  const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return lastStop > 0 ? head.slice(0, lastStop + 1) : head;
}

/** Evidence-only excerpts for fallback/insufficient responses (Section 6.4). Zero claims. */
export function excerptCitations(retrieved: readonly RetrievedChunk[], context: Pick<GroundingContext, "index" | "allowedPublishers">): { citations: PublicCitation[]; rejections: string[] } {
  const chunks = chunkMap(context.index);
  const citations: PublicCitation[] = [];
  const rejections: string[] = [];
  for (const item of retrieved.slice(0, MAX_DISCOVERY_EXCERPTS)) {
    const chunk = chunks.get(item.chunk_id);
    if (!chunk || createChunkContentHash(chunk.text) !== chunk.content_hash) { rejections.push("CITATION_CHUNK_UNKNOWN"); continue; }
    const built = citationFor(chunk, boundedExcerpt(chunk.text), citations.length + 1, context);
    if (typeof built === "string") rejections.push(built);
    else citations.push(built);
  }
  return { citations, rejections };
}
