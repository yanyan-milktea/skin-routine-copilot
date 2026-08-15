import { createHash } from "node:crypto";

export const INGREDIENT_CORPUS_SCHEMA_VERSION = 1 as const;
export const CLAIM_UNIT_SCHEMA_VERSION = 1 as const;
export const SYNTHETIC_CORPUS_SCHEMA_VERSION = 1 as const;
export const INGREDIENT_QUESTION_SCHEMA_VERSION = 1 as const;
export const MAX_SOURCE_RESPONSE_BYTES = 1_000_000;
export const APPROVED_PARSER = Object.freeze({
  name: "readability-normalizer",
  version: "1.0.0",
  allow_scripts: false,
  allow_remote_resources: false,
});
export const QUESTION_CLASSES = ["Q1", "Q2", "Q3", "Q4", "Q5"] as const;
export type QuestionClass = (typeof QUESTION_CLASSES)[number];

export type ValidationIssue = { path: string; code: string; message: string };
export type ValidationResult = { valid: boolean; issues: ValidationIssue[] };

export type SourceManifestEntry = {
  source_id: string;
  publisher: "FDA" | "American Academy of Dermatology";
  title: string;
  canonical_url: string;
  allowed_hosts: string[];
  question_classes: QuestionClass[];
  topic_tags: string[];
  scope_note: string;
  parser: typeof APPROVED_PARSER;
  corpus_review: ReviewDecision;
  snapshot_storage_review: SnapshotReviewDecision;
  review_due_at: string;
  expiry_mode: "soft";
  emergency_disabled: boolean;
  emergency_disable_reason: string | null;
  retrieval_policy: "include" | "exclude";
  expected_content_type: "text/html";
};

export type ReviewDecision = {
  decision: "pending" | "approved" | "rejected";
  reviewed_by: string | null;
  reviewed_at: string | null;
};

export type SnapshotReviewDecision = ReviewDecision & {
  basis: string;
  permission_reference: string | null;
  max_public_excerpt_characters: number;
};

export type SourceManifest = {
  schema_version: typeof INGREDIENT_CORPUS_SCHEMA_VERSION;
  corpus_id: "ingredient-intelligence";
  corpus_version: string;
  approved_publishers: ["FDA", "American Academy of Dermatology"];
  sources: SourceManifestEntry[];
};

export type SyntheticChunk = {
  chunk_id: string;
  source_id: string;
  document_id: string;
  question_class: QuestionClass;
  section_path: string[];
  ordinal: number;
  text: string;
  start_char: number;
  end_char: number;
  content_hash: string;
  build_eligible: false;
};

export type SyntheticDocument = {
  source_id: string;
  publisher: "Synthetic Test Publisher";
  canonical_url: string;
  question_class: QuestionClass;
  title: string;
  normalized_text: string;
  document_id: string;
  document_hash: string;
  retrieved_at: string;
  build_eligible: false;
  chunks: SyntheticChunk[];
};

export type SyntheticCorpus = {
  schema_version: typeof SYNTHETIC_CORPUS_SCHEMA_VERSION;
  fixture_kind: "synthetic_only";
  corpus_version: string;
  build_eligible: false;
  documents: SyntheticDocument[];
};

export type ClaimUnitReview = {
  decision: "approved_for_synthetic_tests";
  reviewed_by: string;
  reviewed_at: string;
  review_version: "claim-review-v1";
  binding_hash: string;
};

export type CanonicalClaimUnit = {
  claim_unit_id: string;
  question_class: QuestionClass;
  supported_intent_ids: string[];
  canonical_claim_text: string;
  supporting_chunk_ids: string[];
  required_entities: string[];
  required_qualifiers: string[];
  required_negation: string[];
  required_exceptions: string[];
  required_populations: string[];
  required_numbers: string[];
  source_document_hashes: { source_id: string; document_hash: string }[];
  review: ClaimUnitReview;
  content_hash: string;
  enabled: true;
  build_eligible: false;
};

export type ClaimUnitFixture = {
  schema_version: typeof CLAIM_UNIT_SCHEMA_VERSION;
  fixture_kind: "synthetic_only";
  claim_units_version: string;
  build_eligible: false;
  claim_units: CanonicalClaimUnit[];
};

type ApprovedSource = {
  publisher: SourceManifestEntry["publisher"];
  questionClasses: QuestionClass[];
};

export const APPROVED_SOURCE_URLS: Readonly<Record<string, ApprovedSource>> = Object.freeze({
  "https://www.fda.gov/cosmetics/cosmetic-ingredients/alpha-hydroxy-acids": {
    publisher: "FDA",
    questionClasses: ["Q1"],
  },
  "https://www.fda.gov/regulatory-information/search-fda-guidance-documents/guidance-industry-labeling-cosmetics-containing-alpha-hydroxy-acids": {
    publisher: "FDA",
    questionClasses: ["Q1"],
  },
  "https://www.fda.gov/cosmetics/cosmetic-ingredients/beta-hydroxy-acids": {
    publisher: "FDA",
    questionClasses: ["Q2"],
  },
  "https://www.aad.org/public/everyday-care/skin-care-secrets/anti-aging/retinoid-retinol": {
    publisher: "American Academy of Dermatology",
    questionClasses: ["Q3"],
  },
  "https://www.fda.gov/cosmetics/cosmetic-products-ingredients/cosmetic-ingredients": {
    publisher: "FDA",
    questionClasses: ["Q4"],
  },
  "https://www.aad.org/public/everyday-care/skin-care-secrets/routine/pregnancy-skin-care": {
    publisher: "American Academy of Dermatology",
    questionClasses: ["Q5"],
  },
});

const INTENTS_BY_CLASS: Readonly<Record<QuestionClass, readonly string[]>> = Object.freeze({
  Q1: ["q1_aha_definition", "q1_sun_sensitivity_relationship", "q1_sun_protection_caution"],
  Q2: ["q2_bha_definition", "q2_fda_cosmetic_scope", "q2_reviewed_safety_context"],
  Q3: ["q3_retinoid_retinol_distinction", "q3_general_introduction", "q3_irritation_caution"],
  Q4: ["q4_premarket_approval_rule", "q4_color_additive_exception", "q4_fda_role"],
  Q5: ["q5_general_pregnancy_scope", "q5_discuss_with_clinician", "q5_reviewed_avoidance_context"],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(issues: ValidationIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issue(issues, `${path}.${key}`, "UNEXPECTED_PROPERTY", "Unexpected property.");
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) issue(issues, `${path}.${key}`, "MISSING_PROPERTY", "Required property is missing.");
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function stringArray(value: unknown, minItems = 0): value is string[] {
  return Array.isArray(value) && value.length >= minItems && value.every((item) => typeof item === "string" && item.length > 0);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeCorpusText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slugify(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "section";
}

export function createSourceId(publisher: SourceManifestEntry["publisher"], canonicalUrl: string): string {
  return `src_${publisher === "FDA" ? "fda" : "aad"}_${sha256Hex(canonicalUrl).slice(0, 8)}`;
}

export function createSyntheticSourceId(questionClass: QuestionClass, canonicalUrl: string): string {
  return `syn_src_${questionClass.toLowerCase()}_${sha256Hex(canonicalUrl).slice(0, 8)}`;
}

export function createDocumentHash(text: string): string {
  return `sha256:${sha256Hex(normalizeCorpusText(text))}`;
}

export function createDocumentId(sourceId: string, text: string): string {
  return `doc_${sourceId}_${sha256Hex(normalizeCorpusText(text)).slice(0, 8)}`;
}

export function createChunkContentHash(text: string): string {
  return `sha256:${sha256Hex(normalizeCorpusText(text))}`;
}

export function createChunkId(sourceId: string, sectionPath: string[], ordinal: number, text: string): string {
  const section = slugify(sectionPath.join("_"));
  return `chk_${sourceId}_${section}_${String(ordinal).padStart(2, "0")}_${sha256Hex(normalizeCorpusText(text)).slice(0, 8)}`;
}

function claimBindingPayload(unit: Omit<CanonicalClaimUnit, "claim_unit_id" | "review" | "content_hash" | "enabled" | "build_eligible">): unknown {
  return {
    question_class: unit.question_class,
    supported_intent_ids: unit.supported_intent_ids,
    canonical_claim_text: normalizeCorpusText(unit.canonical_claim_text),
    supporting_chunk_ids: unit.supporting_chunk_ids,
    required_entities: unit.required_entities,
    required_qualifiers: unit.required_qualifiers,
    required_negation: unit.required_negation,
    required_exceptions: unit.required_exceptions,
    required_populations: unit.required_populations,
    required_numbers: unit.required_numbers,
    source_document_hashes: unit.source_document_hashes,
  };
}

export function createClaimBindingHash(unit: Omit<CanonicalClaimUnit, "claim_unit_id" | "review" | "content_hash" | "enabled" | "build_eligible">): string {
  return `sha256:${sha256Hex(stableStringify(claimBindingPayload(unit)))}`;
}

export function createClaimUnitId(
  questionClass: QuestionClass,
  canonicalClaimText: string,
  supportingChunkIds: string[],
): string {
  const seed = stableStringify({ canonical_claim_text: normalizeCorpusText(canonicalClaimText), supporting_chunk_ids: supportingChunkIds });
  return `cu_${questionClass.toLowerCase()}_${slugify(canonicalClaimText)}_${sha256Hex(seed).slice(0, 8)}`;
}

function validateReviewDecision(value: unknown, path: string, issues: ValidationIssue[]): value is ReviewDecision {
  if (!isRecord(value)) {
    issue(issues, path, "INVALID_REVIEW", "Review must be an object.");
    return false;
  }
  exactKeys(value, ["decision", "reviewed_by", "reviewed_at"], path, issues);
  if (!["pending", "approved", "rejected"].includes(String(value.decision))) issue(issues, `${path}.decision`, "INVALID_REVIEW_DECISION", "Unknown review decision.");
  const completed = value.decision === "approved" || value.decision === "rejected";
  if (completed && (typeof value.reviewed_by !== "string" || value.reviewed_by.length < 2)) issue(issues, `${path}.reviewed_by`, "MISSING_REVIEWER", "Completed review requires a reviewer.");
  if (completed && !isIsoDate(value.reviewed_at)) issue(issues, `${path}.reviewed_at`, "MISSING_REVIEW_DATE", "Completed review requires an ISO date.");
  if (!completed && (value.reviewed_by !== null || value.reviewed_at !== null)) issue(issues, path, "PENDING_REVIEW_METADATA", "Pending review must not claim reviewer approval.");
  return true;
}

function validateSourceEntry(value: unknown, index: number, issues: ValidationIssue[]): value is SourceManifestEntry {
  const path = `sources[${index}]`;
  if (!isRecord(value)) {
    issue(issues, path, "INVALID_SOURCE", "Source must be an object.");
    return false;
  }
  exactKeys(value, [
    "source_id", "publisher", "title", "canonical_url", "allowed_hosts", "question_classes", "topic_tags", "scope_note",
    "parser", "corpus_review", "snapshot_storage_review", "review_due_at", "expiry_mode", "emergency_disabled",
    "emergency_disable_reason", "retrieval_policy", "expected_content_type",
  ], path, issues);

  if (typeof value.canonical_url !== "string") {
    issue(issues, `${path}.canonical_url`, "INVALID_URL", "Canonical URL must be a string.");
    return false;
  }
  const approved = APPROVED_SOURCE_URLS[value.canonical_url];
  let url: URL | null = null;
  try { url = new URL(value.canonical_url); } catch { /* validated below */ }
  if (!url || url.protocol !== "https:" || !approved) issue(issues, `${path}.canonical_url`, "SOURCE_NOT_ALLOWLISTED", "Source must be an exact approved HTTPS URL.");
  if (!approved || value.publisher !== approved.publisher) issue(issues, `${path}.publisher`, "PUBLISHER_MISMATCH", "Publisher must match the URL allow-list.");
  if (!approved || !stringArray(value.question_classes, 1) || value.question_classes.some((item) => !approved.questionClasses.includes(item as QuestionClass))) {
    issue(issues, `${path}.question_classes`, "QUESTION_CLASS_MISMATCH", "Question classes must match the approved URL.");
  }
  if (approved && typeof value.publisher === "string" && value.source_id !== createSourceId(approved.publisher, value.canonical_url)) issue(issues, `${path}.source_id`, "SOURCE_ID_MISMATCH", "Source ID is not deterministic.");
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 180) issue(issues, `${path}.title`, "INVALID_TITLE", "Title length is invalid.");
  if (!url || !Array.isArray(value.allowed_hosts) || value.allowed_hosts.length !== 1 || value.allowed_hosts[0] !== url.hostname) issue(issues, `${path}.allowed_hosts`, "HOST_MISMATCH", "Allowed host must exactly match the canonical host.");
  if (!stringArray(value.topic_tags, 1) || new Set(value.topic_tags).size !== value.topic_tags.length) issue(issues, `${path}.topic_tags`, "INVALID_TAGS", "Topic tags must be unique non-empty strings.");
  if (typeof value.scope_note !== "string" || value.scope_note.length < 10 || value.scope_note.length > 500) issue(issues, `${path}.scope_note`, "INVALID_SCOPE", "Scope note length is invalid.");

  if (!isRecord(value.parser)) issue(issues, `${path}.parser`, "INVALID_PARSER", "Parser configuration is required.");
  else {
    exactKeys(value.parser, ["name", "version", "allow_scripts", "allow_remote_resources"], `${path}.parser`, issues);
    for (const [key, expected] of Object.entries(APPROVED_PARSER)) {
      if (value.parser[key] !== expected) issue(issues, `${path}.parser.${key}`, "UNSAFE_PARSER_CONFIGURATION", "Parser configuration must match the pinned safe configuration.");
    }
  }
  validateReviewDecision(value.corpus_review, `${path}.corpus_review`, issues);
  if (!isRecord(value.snapshot_storage_review)) issue(issues, `${path}.snapshot_storage_review`, "INVALID_SNAPSHOT_REVIEW", "Snapshot review is required.");
  else {
    exactKeys(value.snapshot_storage_review, ["decision", "reviewed_by", "reviewed_at", "basis", "permission_reference", "max_public_excerpt_characters"], `${path}.snapshot_storage_review`, issues);
    validateReviewDecision({ decision: value.snapshot_storage_review.decision, reviewed_by: value.snapshot_storage_review.reviewed_by, reviewed_at: value.snapshot_storage_review.reviewed_at }, `${path}.snapshot_storage_review`, issues);
    if (typeof value.snapshot_storage_review.basis !== "string" || value.snapshot_storage_review.basis.length < 10) issue(issues, `${path}.snapshot_storage_review.basis`, "MISSING_REVIEW_BASIS", "Snapshot review basis is required.");
    if (!Number.isInteger(value.snapshot_storage_review.max_public_excerpt_characters) || Number(value.snapshot_storage_review.max_public_excerpt_characters) < 1 || Number(value.snapshot_storage_review.max_public_excerpt_characters) > 1200) issue(issues, `${path}.snapshot_storage_review.max_public_excerpt_characters`, "INVALID_EXCERPT_LIMIT", "Excerpt limit must be 1-1200 characters.");
    if (value.snapshot_storage_review.decision === "approved" && (typeof value.snapshot_storage_review.permission_reference !== "string" || value.snapshot_storage_review.permission_reference.length < 3)) issue(issues, `${path}.snapshot_storage_review.permission_reference`, "MISSING_PERMISSION_REFERENCE", "Approved redistribution requires an explicit permission reference.");
    if (value.snapshot_storage_review.decision !== "approved" && value.snapshot_storage_review.permission_reference !== null) issue(issues, `${path}.snapshot_storage_review.permission_reference`, "UNVERIFIED_PERMISSION_REFERENCE", "Non-approved review cannot claim a permission reference.");
  }
  if (!isIsoDate(value.review_due_at)) issue(issues, `${path}.review_due_at`, "INVALID_REVIEW_DUE_DATE", "Review due date must be YYYY-MM-DD.");
  if (value.expiry_mode !== "soft") issue(issues, `${path}.expiry_mode`, "INVALID_EXPIRY_MODE", "Only soft expiry is supported.");
  if (typeof value.emergency_disabled !== "boolean") issue(issues, `${path}.emergency_disabled`, "INVALID_DISABLED_FLAG", "Emergency disabled must be boolean.");
  if (value.emergency_disabled === true && (typeof value.emergency_disable_reason !== "string" || value.emergency_disable_reason.length < 3)) issue(issues, `${path}.emergency_disable_reason`, "MISSING_DISABLE_REASON", "Disabled source requires a reason.");
  if (value.emergency_disabled === false && value.emergency_disable_reason !== null) issue(issues, `${path}.emergency_disable_reason`, "UNEXPECTED_DISABLE_REASON", "Enabled source must have a null disable reason.");
  if (!["include", "exclude"].includes(String(value.retrieval_policy))) issue(issues, `${path}.retrieval_policy`, "INVALID_RETRIEVAL_POLICY", "Retrieval policy is invalid.");
  const reviewsApproved = isRecord(value.corpus_review) && value.corpus_review.decision === "approved" && isRecord(value.snapshot_storage_review) && value.snapshot_storage_review.decision === "approved";
  if (!reviewsApproved && value.retrieval_policy !== "exclude") issue(issues, `${path}.retrieval_policy`, "UNAPPROVED_SOURCE_INCLUDED", "Pending or rejected reviews must remain excluded.");
  if (value.expected_content_type !== "text/html") issue(issues, `${path}.expected_content_type`, "UNSUPPORTED_CONTENT_TYPE", "Only text/html is supported.");
  return true;
}

export function validateSourceManifest(value: unknown, requireComplete = true): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: "$", code: "INVALID_MANIFEST", message: "Manifest must be an object." }] };
  exactKeys(value, ["schema_version", "corpus_id", "corpus_version", "approved_publishers", "sources"], "$", issues);
  if (value.schema_version !== INGREDIENT_CORPUS_SCHEMA_VERSION) issue(issues, "$.schema_version", "SCHEMA_VERSION_MISMATCH", "Unsupported manifest schema version.");
  if (value.corpus_id !== "ingredient-intelligence") issue(issues, "$.corpus_id", "INVALID_CORPUS_ID", "Corpus ID is invalid.");
  if (typeof value.corpus_version !== "string" || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(value.corpus_version)) issue(issues, "$.corpus_version", "INVALID_CORPUS_VERSION", "Corpus version is invalid.");
  if (!Array.isArray(value.approved_publishers) || stableStringify(value.approved_publishers) !== stableStringify(["FDA", "American Academy of Dermatology"])) issue(issues, "$.approved_publishers", "INVALID_PUBLISHER_ALLOWLIST", "Publisher allow-list must be exact and ordered.");
  if (!Array.isArray(value.sources)) issue(issues, "$.sources", "INVALID_SOURCES", "Sources must be an array.");
  else {
    const ids = new Set<string>();
    const urls = new Set<string>();
    const covered = new Set<QuestionClass>();
    value.sources.forEach((source, index) => {
      validateSourceEntry(source, index, issues);
      if (isRecord(source)) {
        if (typeof source.source_id === "string") {
          if (ids.has(source.source_id)) issue(issues, `sources[${index}].source_id`, "DUPLICATE_SOURCE_ID", "Source ID must be unique.");
          ids.add(source.source_id);
        }
        if (typeof source.canonical_url === "string") {
          if (urls.has(source.canonical_url)) issue(issues, `sources[${index}].canonical_url`, "DUPLICATE_SOURCE_URL", "Source URL must be unique.");
          urls.add(source.canonical_url);
        }
        if (Array.isArray(source.question_classes)) source.question_classes.forEach((item) => { if (QUESTION_CLASSES.includes(item as QuestionClass)) covered.add(item as QuestionClass); });
      }
    });
    if (requireComplete) for (const questionClass of QUESTION_CLASSES) if (!covered.has(questionClass)) issue(issues, "$.sources", "MISSING_QUESTION_CLASS", `Manifest does not cover ${questionClass}.`);
  }
  return { valid: issues.length === 0, issues };
}

export type FetchEnvelope = {
  content_type: string;
  content_length: number;
  redirect_chain: string[];
  final_url: string;
};

export function validateFetchEnvelope(source: SourceManifestEntry, value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: "$", code: "INVALID_FETCH_ENVELOPE", message: "Fetch envelope must be an object." }] };
  exactKeys(value, ["content_type", "content_length", "redirect_chain", "final_url"], "$", issues);
  const contentType = typeof value.content_type === "string" ? value.content_type.split(";", 1)[0].trim().toLowerCase() : "";
  if (contentType !== source.expected_content_type) issue(issues, "$.content_type", "UNSUPPORTED_CONTENT_TYPE", "Fetched content type is not supported.");
  if (!Number.isInteger(value.content_length) || Number(value.content_length) < 0 || Number(value.content_length) > MAX_SOURCE_RESPONSE_BYTES) issue(issues, "$.content_length", "SOURCE_TOO_LARGE", "Fetched source exceeds the byte limit.");
  if (value.final_url !== source.canonical_url) issue(issues, "$.final_url", "FINAL_URL_MISMATCH", "Final URL must equal the approved canonical URL.");
  if (!Array.isArray(value.redirect_chain) || !value.redirect_chain.every((item) => typeof item === "string")) issue(issues, "$.redirect_chain", "INVALID_REDIRECT_CHAIN", "Redirect chain must be an array of URLs.");
  else {
    for (const [index, item] of value.redirect_chain.entries()) {
      let redirect: URL | null = null;
      try { redirect = new URL(item); } catch { /* validated below */ }
      if (!redirect || redirect.protocol !== "https:") issue(issues, `$.redirect_chain[${index}]`, "UNSAFE_REDIRECT", "Redirect must use HTTPS.");
      else if (!source.allowed_hosts.includes(redirect.hostname)) issue(issues, `$.redirect_chain[${index}]`, "CROSS_HOST_REDIRECT", "Cross-host redirects are forbidden.");
      else if (!APPROVED_SOURCE_URLS[item]) issue(issues, `$.redirect_chain[${index}]`, "UNAPPROVED_REDIRECT_PATH", "Redirect path is not allow-listed.");
    }
  }
  return { valid: issues.length === 0, issues };
}

export type ChangeReview = { decision: "pending" | "approved" | "rejected"; reviewed_by: string | null; reviewed_at: string | null; document_hash: string | null };

export function validateChangedPageReview(previousDocumentHash: string, nextDocumentHash: string, corpusReview: ChangeReview, snapshotReview: ChangeReview): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (previousDocumentHash === nextDocumentHash) return { valid: true, issues };
  for (const [name, review] of [["corpus_review", corpusReview], ["snapshot_review", snapshotReview]] as const) {
    if (review.decision !== "approved") issue(issues, `$.${name}.decision`, "CHANGE_REVIEW_NOT_APPROVED", "Changed page requires both approvals.");
    if (typeof review.reviewed_by !== "string" || review.reviewed_by.length < 2) issue(issues, `$.${name}.reviewed_by`, "MISSING_REVIEWER", "Changed page review requires a reviewer.");
    if (!isIsoDate(review.reviewed_at)) issue(issues, `$.${name}.reviewed_at`, "MISSING_REVIEW_DATE", "Changed page review requires an ISO date.");
    if (review.document_hash !== nextDocumentHash) issue(issues, `$.${name}.document_hash`, "CHANGE_HASH_MISMATCH", "Approval must bind to the new document hash.");
  }
  return { valid: issues.length === 0, issues };
}

export function getSourceAvailability(source: SourceManifestEntry, now: Date): "emergency_disabled" | "pending_review" | "available" | "soft_expired" | "hard_expired" {
  if (source.emergency_disabled) return "emergency_disabled";
  if (source.corpus_review.decision !== "approved" || source.snapshot_storage_review.decision !== "approved" || source.retrieval_policy !== "include") return "pending_review";
  const due = Date.parse(`${source.review_due_at}T00:00:00Z`);
  const nowMs = now.getTime();
  if (nowMs <= due) return "available";
  if (nowMs <= due + 30 * 24 * 60 * 60 * 1000) return "soft_expired";
  return "hard_expired";
}

function validateSyntheticChunk(value: unknown, document: SyntheticDocument, index: number, issues: ValidationIssue[]): value is SyntheticChunk {
  const path = `documents.${document.source_id}.chunks[${index}]`;
  if (!isRecord(value)) { issue(issues, path, "INVALID_CHUNK", "Chunk must be an object."); return false; }
  exactKeys(value, ["chunk_id", "source_id", "document_id", "question_class", "section_path", "ordinal", "text", "start_char", "end_char", "content_hash", "build_eligible"], path, issues);
  if (value.source_id !== document.source_id || value.document_id !== document.document_id || value.question_class !== document.question_class) issue(issues, path, "CHUNK_PARENT_MISMATCH", "Chunk parent metadata does not match its document.");
  if (!stringArray(value.section_path, 1) || !Number.isInteger(value.ordinal) || Number(value.ordinal) < 0 || typeof value.text !== "string") issue(issues, path, "INVALID_CHUNK_FIELDS", "Chunk fields are invalid.");
  else {
    const normalized = normalizeCorpusText(value.text);
    if (normalized !== value.text) issue(issues, `${path}.text`, "NON_NORMALIZED_TEXT", "Chunk text is not normalized.");
    if (value.content_hash !== createChunkContentHash(value.text)) issue(issues, `${path}.content_hash`, "CHUNK_HASH_MISMATCH", "Chunk hash is invalid.");
    if (value.chunk_id !== createChunkId(document.source_id, value.section_path as string[], Number(value.ordinal), value.text)) issue(issues, `${path}.chunk_id`, "CHUNK_ID_MISMATCH", "Chunk ID is not deterministic.");
    if (!Number.isInteger(value.start_char) || !Number.isInteger(value.end_char) || Number(value.start_char) < 0 || Number(value.end_char) > document.normalized_text.length || document.normalized_text.slice(Number(value.start_char), Number(value.end_char)) !== value.text) issue(issues, path, "CHUNK_OFFSET_MISMATCH", "Chunk offsets do not select the exact text.");
  }
  if (value.build_eligible !== false) issue(issues, `${path}.build_eligible`, "SYNTHETIC_BUILD_ELIGIBLE", "Synthetic chunks must never be build eligible.");
  return true;
}

export function validateSyntheticCorpus(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: "$", code: "INVALID_SYNTHETIC_CORPUS", message: "Synthetic corpus must be an object." }] };
  exactKeys(value, ["schema_version", "fixture_kind", "corpus_version", "build_eligible", "documents"], "$", issues);
  if (value.schema_version !== SYNTHETIC_CORPUS_SCHEMA_VERSION || value.fixture_kind !== "synthetic_only" || value.build_eligible !== false) issue(issues, "$", "INVALID_SYNTHETIC_BOUNDARY", "Synthetic corpus boundary is invalid.");
  if (typeof value.corpus_version !== "string" || !/^synthetic-v\d+$/.test(value.corpus_version)) issue(issues, "$.corpus_version", "INVALID_SYNTHETIC_VERSION", "Synthetic corpus version is invalid.");
  if (!Array.isArray(value.documents)) issue(issues, "$.documents", "INVALID_DOCUMENTS", "Documents must be an array.");
  else {
    const classes = new Set<QuestionClass>();
    const sourceIds = new Set<string>();
    for (const [index, raw] of value.documents.entries()) {
      const path = `documents[${index}]`;
      if (!isRecord(raw)) { issue(issues, path, "INVALID_DOCUMENT", "Document must be an object."); continue; }
      exactKeys(raw, ["source_id", "publisher", "canonical_url", "question_class", "title", "normalized_text", "document_id", "document_hash", "retrieved_at", "build_eligible", "chunks"], path, issues);
      if (!QUESTION_CLASSES.includes(raw.question_class as QuestionClass)) issue(issues, `${path}.question_class`, "INVALID_QUESTION_CLASS", "Question class is invalid.");
      else classes.add(raw.question_class as QuestionClass);
      if (raw.publisher !== "Synthetic Test Publisher") issue(issues, `${path}.publisher`, "REAL_PUBLISHER_IN_SYNTHETIC_FIXTURE", "Synthetic corpus must use its fictional publisher.");
      let url: URL | null = null;
      try { url = new URL(String(raw.canonical_url)); } catch { /* validated below */ }
      if (!url || url.protocol !== "https:" || !url.hostname.endsWith(".fixture.invalid")) issue(issues, `${path}.canonical_url`, "INVALID_SYNTHETIC_URL", "Synthetic URLs must use HTTPS under .fixture.invalid.");
      if (url && QUESTION_CLASSES.includes(raw.question_class as QuestionClass) && raw.source_id !== createSyntheticSourceId(raw.question_class as QuestionClass, url.toString())) issue(issues, `${path}.source_id`, "SYNTHETIC_SOURCE_ID_MISMATCH", "Synthetic source ID is not deterministic.");
      if (typeof raw.source_id === "string") {
        if (sourceIds.has(raw.source_id)) issue(issues, `${path}.source_id`, "DUPLICATE_SOURCE_ID", "Synthetic source ID must be unique.");
        sourceIds.add(raw.source_id);
      }
      if (typeof raw.normalized_text !== "string" || normalizeCorpusText(raw.normalized_text) !== raw.normalized_text) issue(issues, `${path}.normalized_text`, "NON_NORMALIZED_TEXT", "Document text must be normalized.");
      else {
        if (raw.document_hash !== createDocumentHash(raw.normalized_text)) issue(issues, `${path}.document_hash`, "DOCUMENT_HASH_MISMATCH", "Document hash is invalid.");
        if (typeof raw.source_id === "string" && raw.document_id !== createDocumentId(raw.source_id, raw.normalized_text)) issue(issues, `${path}.document_id`, "DOCUMENT_ID_MISMATCH", "Document ID is not deterministic.");
      }
      if (!isIsoDateTime(raw.retrieved_at)) issue(issues, `${path}.retrieved_at`, "INVALID_RETRIEVAL_DATE", "Retrieval date must be an ISO UTC timestamp.");
      if (raw.build_eligible !== false) issue(issues, `${path}.build_eligible`, "SYNTHETIC_BUILD_ELIGIBLE", "Synthetic documents must never be build eligible.");
      if (!Array.isArray(raw.chunks)) issue(issues, `${path}.chunks`, "INVALID_CHUNKS", "Chunks must be an array.");
      else raw.chunks.forEach((chunk, chunkIndex) => validateSyntheticChunk(chunk, raw as unknown as SyntheticDocument, chunkIndex, issues));
    }
    for (const questionClass of QUESTION_CLASSES) if (!classes.has(questionClass)) issue(issues, "$.documents", "MISSING_QUESTION_CLASS", `Synthetic corpus does not cover ${questionClass}.`);
  }
  return { valid: issues.length === 0, issues };
}

function exactTermPresent(term: string, haystack: string): boolean {
  return normalizeCorpusText(haystack).toLocaleLowerCase().includes(normalizeCorpusText(term).toLocaleLowerCase());
}

function isAtomicClaim(text: string): boolean {
  const normalized = normalizeCorpusText(text);
  const sentenceEnds = normalized.match(/[.!?](?=\s|$)/g)?.length ?? 0;
  if (sentenceEnds !== 1 || !/[.!?]$/.test(normalized) || /[;\n]/.test(normalized)) return false;
  return !/\b(?:and|but)\s+(?:it|they|the|fda|aad|people|users|readers)\b/i.test(normalized);
}

export function validateClaimUnitFixture(value: unknown, corpus: SyntheticCorpus): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: "$", code: "INVALID_CLAIM_FIXTURE", message: "Claim fixture must be an object." }] };
  exactKeys(value, ["schema_version", "fixture_kind", "claim_units_version", "build_eligible", "claim_units"], "$", issues);
  if (value.schema_version !== CLAIM_UNIT_SCHEMA_VERSION || value.fixture_kind !== "synthetic_only" || value.build_eligible !== false) issue(issues, "$", "INVALID_SYNTHETIC_BOUNDARY", "Claim fixture boundary is invalid.");
  if (typeof value.claim_units_version !== "string" || !/^synthetic-claims-v\d+$/.test(value.claim_units_version)) issue(issues, "$.claim_units_version", "INVALID_CLAIM_VERSION", "Claim fixture version is invalid.");
  const chunks = new Map<string, SyntheticChunk>();
  const documents = new Map<string, SyntheticDocument>();
  for (const document of corpus.documents) {
    documents.set(document.source_id, document);
    for (const chunk of document.chunks) chunks.set(chunk.chunk_id, chunk);
  }
  if (!Array.isArray(value.claim_units)) issue(issues, "$.claim_units", "INVALID_CLAIM_UNITS", "Claim units must be an array.");
  else {
    const ids = new Set<string>();
    const classes = new Set<QuestionClass>();
    for (const [index, raw] of value.claim_units.entries()) {
      const path = `claim_units[${index}]`;
      if (!isRecord(raw)) { issue(issues, path, "INVALID_CLAIM_UNIT", "Claim unit must be an object."); continue; }
      exactKeys(raw, ["claim_unit_id", "question_class", "supported_intent_ids", "canonical_claim_text", "supporting_chunk_ids", "required_entities", "required_qualifiers", "required_negation", "required_exceptions", "required_populations", "required_numbers", "source_document_hashes", "review", "content_hash", "enabled", "build_eligible"], path, issues);
      if (!QUESTION_CLASSES.includes(raw.question_class as QuestionClass)) issue(issues, `${path}.question_class`, "INVALID_QUESTION_CLASS", "Claim question class is invalid.");
      else classes.add(raw.question_class as QuestionClass);
      const questionClass = raw.question_class as QuestionClass;
      if (!stringArray(raw.supported_intent_ids, 1) || !QUESTION_CLASSES.includes(questionClass) || raw.supported_intent_ids.some((intent) => !INTENTS_BY_CLASS[questionClass].includes(intent))) issue(issues, `${path}.supported_intent_ids`, "WRONG_INTENT", "Claim intent is not approved for its question class.");
      if (typeof raw.canonical_claim_text !== "string" || normalizeCorpusText(raw.canonical_claim_text) !== raw.canonical_claim_text || !isAtomicClaim(raw.canonical_claim_text)) issue(issues, `${path}.canonical_claim_text`, "NON_ATOMIC_CLAIM", "Canonical claim must be one normalized atomic assertion.");
      if (!stringArray(raw.supporting_chunk_ids, 1) || new Set(raw.supporting_chunk_ids).size !== raw.supporting_chunk_ids.length) issue(issues, `${path}.supporting_chunk_ids`, "INVALID_SUPPORTING_CHUNKS", "Supporting chunk IDs must be unique and non-empty.");
      const supportChunks = stringArray(raw.supporting_chunk_ids, 1) ? raw.supporting_chunk_ids.map((id) => chunks.get(id)).filter((item): item is SyntheticChunk => Boolean(item)) : [];
      if (!stringArray(raw.supporting_chunk_ids, 1) || supportChunks.length !== raw.supporting_chunk_ids.length) issue(issues, `${path}.supporting_chunk_ids`, "UNKNOWN_SUPPORTING_CHUNK", "Every supporting chunk must exist.");
      if (supportChunks.some((chunk) => chunk.question_class !== questionClass)) issue(issues, `${path}.supporting_chunk_ids`, "OUT_OF_CLASS_SUPPORT", "Supporting chunks must match the claim class.");
      const evidence = supportChunks.map((chunk) => chunk.text).join("\n");
      if (typeof raw.canonical_claim_text === "string" && !exactTermPresent(raw.canonical_claim_text, evidence)) issue(issues, `${path}.canonical_claim_text`, "SEMANTIC_SUPPORT_MISMATCH", "Synthetic evidence must contain the reviewed canonical claim exactly.");
      for (const field of ["required_entities", "required_qualifiers", "required_negation", "required_exceptions", "required_populations", "required_numbers"] as const) {
        if (!stringArray(raw[field], field === "required_entities" ? 1 : 0)) issue(issues, `${path}.${field}`, "INVALID_REQUIRED_TERMS", "Required-term metadata must be a string array.");
        else for (const [termIndex, term] of raw[field].entries()) {
          if (typeof raw.canonical_claim_text !== "string" || !exactTermPresent(term, raw.canonical_claim_text)) issue(issues, `${path}.${field}[${termIndex}]`, "CLAIM_REQUIRED_TERM_MISSING", "Required term is missing from canonical claim text.");
          if (!exactTermPresent(term, evidence)) issue(issues, `${path}.${field}[${termIndex}]`, "EVIDENCE_REQUIRED_TERM_MISSING", "Required term is missing from supporting evidence.");
        }
      }
      if (!Array.isArray(raw.source_document_hashes) || raw.source_document_hashes.length < 1) issue(issues, `${path}.source_document_hashes`, "INVALID_SOURCE_HASHES", "Source/document hashes are required.");
      else {
        const expectedSources = new Map(supportChunks.map((chunk) => [chunk.source_id, documents.get(chunk.source_id)?.document_hash]));
        const actualSources = new Map<string, string>();
        raw.source_document_hashes.forEach((item, hashIndex) => {
          if (!isRecord(item)) { issue(issues, `${path}.source_document_hashes[${hashIndex}]`, "INVALID_SOURCE_HASH", "Source hash must be an object."); return; }
          exactKeys(item, ["source_id", "document_hash"], `${path}.source_document_hashes[${hashIndex}]`, issues);
          if (typeof item.source_id === "string" && typeof item.document_hash === "string") actualSources.set(item.source_id, item.document_hash);
        });
        if (stableStringify([...actualSources.entries()].sort()) !== stableStringify([...expectedSources.entries()].sort())) issue(issues, `${path}.source_document_hashes`, "SOURCE_DOCUMENT_HASH_MISMATCH", "Source/document hash binding is invalid.");
      }
      if (raw.enabled !== true || raw.build_eligible !== false) issue(issues, path, "INVALID_CLAIM_FIXTURE_STATE", "Synthetic claim must be enabled for tests and excluded from builds.");
      if (typeof raw.canonical_claim_text === "string" && raw.content_hash !== `sha256:${sha256Hex(normalizeCorpusText(raw.canonical_claim_text))}`) issue(issues, `${path}.content_hash`, "CLAIM_CONTENT_HASH_MISMATCH", "Claim content hash is invalid.");
      if (typeof raw.canonical_claim_text === "string" && stringArray(raw.supporting_chunk_ids, 1) && raw.claim_unit_id !== createClaimUnitId(questionClass, raw.canonical_claim_text, raw.supporting_chunk_ids)) issue(issues, `${path}.claim_unit_id`, "CLAIM_UNIT_ID_MISMATCH", "Claim unit ID is not deterministic.");
      if (typeof raw.claim_unit_id === "string") {
        if (ids.has(raw.claim_unit_id)) issue(issues, `${path}.claim_unit_id`, "DUPLICATE_CLAIM_UNIT_ID", "Claim unit ID must be unique.");
        ids.add(raw.claim_unit_id);
      }
      if (!isRecord(raw.review)) issue(issues, `${path}.review`, "INVALID_CLAIM_REVIEW", "Claim review is required.");
      else {
        exactKeys(raw.review, ["decision", "reviewed_by", "reviewed_at", "review_version", "binding_hash"], `${path}.review`, issues);
        if (raw.review.decision !== "approved_for_synthetic_tests" || typeof raw.review.reviewed_by !== "string" || !isIsoDate(raw.review.reviewed_at) || raw.review.review_version !== "claim-review-v1") issue(issues, `${path}.review`, "INVALID_CLAIM_REVIEW", "Synthetic claim review metadata is invalid.");
        const payload = raw as unknown as CanonicalClaimUnit;
        const expectedBinding = createClaimBindingHash(payload);
        if (raw.review.binding_hash !== expectedBinding) issue(issues, `${path}.review.binding_hash`, "CLAIM_REVIEW_BINDING_MISMATCH", "Claim review is not bound to the exact unit metadata.");
      }
    }
    for (const questionClass of QUESTION_CLASSES) if (!classes.has(questionClass)) issue(issues, "$.claim_units", "MISSING_QUESTION_CLASS", `Claim fixtures do not cover ${questionClass}.`);
  }
  return { valid: issues.length === 0, issues };
}

export function validateIngredientQuestionInput(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: "$", code: "INVALID_REQUEST", message: "Request must be an object." }] };
  exactKeys(value, ["schema_version", "question"], "$", issues);
  if (value.schema_version !== INGREDIENT_QUESTION_SCHEMA_VERSION) issue(issues, "$.schema_version", "SCHEMA_VERSION_MISMATCH", "Unsupported request schema version.");
  if (typeof value.question !== "string" || value.question.trim().length < 1 || [...value.question.trim()].length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.question)) issue(issues, "$.question", "INVALID_QUESTION", "Question must be 1-600 safe Unicode characters.");
  return { valid: issues.length === 0, issues };
}
