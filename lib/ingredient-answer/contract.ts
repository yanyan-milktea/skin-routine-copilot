// Strict Milestone 2 contracts (design Sections 5.1, 6.2, 6.3): the request
// body, the model-output selection schema, the public response schema, and the
// reviewed limitation/care templates. The model never authors prose.

export const ANSWER_SCHEMA_VERSION = 1 as const;
export const MAX_SELECTED_CLAIM_UNITS = 8;
export const MAX_CITATIONS = 20;
export const MAX_DISCOVERY_EXCERPTS = 3;
export const MAX_EXCERPT_CHARACTERS = 1200;

export const LIMITATION_CODES = ["PARTIAL_EVIDENCE", "NO_ELIGIBLE_EVIDENCE", "OUT_OF_SCOPE", "PRODUCT_SPECIFIC_UNSUPPORTED", "PAIRWISE_COMPATIBILITY_UNSUPPORTED", "PROVIDER_UNAVAILABLE"] as const;
export type LimitationCode = (typeof LIMITATION_CODES)[number];
/** Codes the model may emit (Section 6.2); PROVIDER_UNAVAILABLE is server-only. */
export const MODEL_LIMITATION_CODES = LIMITATION_CODES.filter((code) => code !== "PROVIDER_UNAVAILABLE");

export const CARE_CODES = ["CONSULT_DERMATOLOGIST", "PREGNANCY_CLINICIAN", "URGENT_LOCAL_CARE"] as const;
export type CareCode = (typeof CARE_CODES)[number];

/** Reviewed, fixed copy. Limitations and care guidance are never model-authored. */
export const LIMITATION_TEMPLATES: Readonly<Record<LimitationCode, string>> = Object.freeze({
  PARTIAL_EVIDENCE: "The reviewed sources answer only part of this question; the rest is not covered.",
  NO_ELIGIBLE_EVIDENCE: "The reviewed source library does not contain enough evidence to answer that question.",
  OUT_OF_SCOPE: "This question is outside the reviewed ingredient topics this feature can answer.",
  PRODUCT_SPECIFIC_UNSUPPORTED: "The reviewed sources cannot confirm what a specific product contains; product names alone do not establish ingredient lists.",
  PAIRWISE_COMPATIBILITY_UNSUPPORTED: "The reviewed sources do not establish whether those products or ingredients are compatible. Product names alone also do not confirm their ingredient lists.",
  PROVIDER_UNAVAILABLE: "An answer could not be generated right now. Showing exact excerpts from reviewed sources instead.",
});

export const CARE_TEMPLATES: Readonly<Record<CareCode, string>> = Object.freeze({
  CONSULT_DERMATOLOGIST: "For questions about a reaction or a skin condition, talk with a board-certified dermatologist or another licensed clinician.",
  PREGNANCY_CLINICIAN: "If you are pregnant or breastfeeding, talk with your obstetrician, dermatologist, or another licensed clinician before starting or stopping skin care ingredients.",
  URGENT_LOCAL_CARE: "If you have swelling, blistering, trouble breathing, eye involvement, severe pain, or a rapidly worsening reaction, seek urgent local medical care now.",
});

export type AnswerRequest = { schema_version: 1; question: string };

export type ModelSelection = {
  schema_version: 1;
  selected_claim_unit_ids: string[];
  limitation_codes: LimitationCode[];
  care_guidance_code: CareCode | null;
};

export type PublicClaim = { claim_unit_id: string; text: string; canonical_text_hash: string; citation_numbers: number[] };

export type PublicCitation = {
  number: number;
  source_id: string;
  chunk_id: string;
  publisher: string;
  title: string;
  url: string;
  retrieved_at: string;
  section: string;
  excerpt: string;
  document_hash: string;
};

export type AnswerStatus = "supported" | "partial" | "insufficient" | "fallback";

export type PublicAnswer = {
  schema_version: 1;
  status: AnswerStatus;
  answer: string;
  claims: PublicClaim[];
  citations: PublicCitation[];
  limitations: string[];
  care_guidance: string | null;
  provenance: {
    source: "gemini" | "deterministic_fallback";
    trace_id: string;
    corpus_version: string;
    index_version: string;
    claim_units_version: string;
    schema_version: 1;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export type RequestValidation = { ok: true; value: AnswerRequest } | { ok: false; code: string };

/** Phase 1 request: exactly schema_version and question. Unknown fields (shelf, history, product…) are rejected. */
export function validateAnswerRequest(value: unknown): RequestValidation {
  if (!isRecord(value)) return { ok: false, code: "REQUEST_NOT_OBJECT" };
  if (!exactKeys(value, ["schema_version", "question"])) return { ok: false, code: "REQUEST_UNKNOWN_FIELDS" };
  if (value.schema_version !== ANSWER_SCHEMA_VERSION) return { ok: false, code: "REQUEST_SCHEMA_VERSION" };
  if (typeof value.question !== "string") return { ok: false, code: "REQUEST_QUESTION_TYPE" };
  const cleaned = value.question.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  const length = [...cleaned].length;
  if (length < 1 || length > 600) return { ok: false, code: "REQUEST_QUESTION_LENGTH" };
  return { ok: true, value: { schema_version: 1, question: cleaned } };
}

export const CLAIM_UNIT_ID_PATTERN = /^cu_q[1-5]_[a-z0-9_]+_[a-f0-9]{8}$/;

/** JSON schema sent to the provider for structured output. Selections only. */
export function modelOutputJsonSchema(availableIds: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "selected_claim_unit_ids", "limitation_codes", "care_guidance_code"],
    properties: {
      schema_version: { type: "integer", enum: [1] },
      selected_claim_unit_ids: { type: "array", maxItems: MAX_SELECTED_CLAIM_UNITS, items: availableIds.length ? { type: "string", enum: [...availableIds] } : { type: "string", maxLength: 180 } },
      limitation_codes: { type: "array", maxItems: 3, items: { type: "string", enum: [...MODEL_LIMITATION_CODES] } },
      care_guidance_code: { type: ["string", "null"], enum: [...CARE_CODES, null] },
    },
  };
}

export type ModelOutputValidation = { ok: true; value: ModelSelection } | { ok: false; code: string };

/** Structural validation of provider output. Per-ID membership/grounding happens in the verifier. */
export function validateModelOutput(value: unknown): ModelOutputValidation {
  if (!isRecord(value)) return { ok: false, code: "MODEL_OUTPUT_NOT_OBJECT" };
  if (!exactKeys(value, ["schema_version", "selected_claim_unit_ids", "limitation_codes", "care_guidance_code"])) return { ok: false, code: "MODEL_OUTPUT_KEYS" };
  if (value.schema_version !== 1) return { ok: false, code: "MODEL_OUTPUT_SCHEMA_VERSION" };
  const ids = value.selected_claim_unit_ids;
  if (!Array.isArray(ids) || ids.length > MAX_SELECTED_CLAIM_UNITS || !ids.every((id) => typeof id === "string" && id.length <= 180)) return { ok: false, code: "MODEL_OUTPUT_SELECTIONS" };
  const codes = value.limitation_codes;
  if (!Array.isArray(codes) || codes.length > 3 || !codes.every((code) => typeof code === "string" && (MODEL_LIMITATION_CODES as readonly string[]).includes(code)) || new Set(codes).size !== codes.length) return { ok: false, code: "MODEL_OUTPUT_LIMITATIONS" };
  const care = value.care_guidance_code;
  if (!(care === null || (typeof care === "string" && (CARE_CODES as readonly string[]).includes(care)))) return { ok: false, code: "MODEL_OUTPUT_CARE" };
  return { ok: true, value: { schema_version: 1, selected_claim_unit_ids: ids as string[], limitation_codes: codes as LimitationCode[], care_guidance_code: care as CareCode | null } };
}

const PUBLIC_KEYS = ["schema_version", "status", "answer", "claims", "citations", "limitations", "care_guidance", "provenance"];

/**
 * Validate a public response against the Section 6.3 schema before it leaves the
 * server. `allowedPublishers` comes from the loaded index (FDA/AAD in production,
 * the synthetic publisher only for a synthetic_only index).
 */
export function validatePublicAnswer(value: PublicAnswer, allowedPublishers: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const add = (code: string) => issues.push(code);
  if (!exactKeys(value as unknown as Record<string, unknown>, PUBLIC_KEYS)) add("PUBLIC_KEYS");
  if (value.schema_version !== 1) add("PUBLIC_SCHEMA_VERSION");
  if (!["supported", "partial", "insufficient", "fallback"].includes(value.status)) add("PUBLIC_STATUS");
  if (typeof value.answer !== "string" || value.answer.length > 2800) add("PUBLIC_ANSWER_LENGTH");
  if (!Array.isArray(value.claims) || value.claims.length > MAX_SELECTED_CLAIM_UNITS) add("PUBLIC_CLAIMS");
  if (!Array.isArray(value.citations) || value.citations.length > MAX_CITATIONS) add("PUBLIC_CITATIONS");
  const numbers = new Set(value.citations.map((citation) => citation.number));
  value.citations.forEach((citation, index) => {
    if (!exactKeys(citation as unknown as Record<string, unknown>, ["number", "source_id", "chunk_id", "publisher", "title", "url", "retrieved_at", "section", "excerpt", "document_hash"])) add("PUBLIC_CITATION_KEYS");
    if (citation.number !== index + 1) add("PUBLIC_CITATION_NUMBERING");
    if (!allowedPublishers.has(citation.publisher)) add("PUBLIC_CITATION_PUBLISHER");
    if (!/^https:\/\//.test(citation.url)) add("PUBLIC_CITATION_URL");
    if (!citation.excerpt || citation.excerpt.length > MAX_EXCERPT_CHARACTERS) add("PUBLIC_CITATION_EXCERPT");
    if (!/^sha256:/.test(citation.document_hash)) add("PUBLIC_CITATION_HASH");
  });
  for (const claim of value.claims) {
    if (!exactKeys(claim as unknown as Record<string, unknown>, ["claim_unit_id", "text", "canonical_text_hash", "citation_numbers"])) add("PUBLIC_CLAIM_KEYS");
    if (!/^cu_q[1-5]_/.test(claim.claim_unit_id) || claim.text.length > 360 || !/^sha256:/.test(claim.canonical_text_hash)) add("PUBLIC_CLAIM_FIELDS");
    if (claim.citation_numbers.length < 1 || claim.citation_numbers.length > 3 || claim.citation_numbers.some((number) => !numbers.has(number))) add("PUBLIC_CLAIM_CITATIONS");
  }
  if (value.status === "supported" || value.status === "partial") {
    if (value.claims.length === 0) add("PUBLIC_STATUS_WITHOUT_CLAIMS");
  } else if (value.claims.length > 0 || value.answer !== "") {
    add("PUBLIC_CLAIMS_WITHOUT_ANSWER_STATUS");
  }
  if (!Array.isArray(value.limitations) || value.limitations.length > 3 || value.limitations.some((item) => !item || item.length > 240)) add("PUBLIC_LIMITATIONS");
  if (!(value.care_guidance === null || (typeof value.care_guidance === "string" && value.care_guidance.length <= 360))) add("PUBLIC_CARE");
  const provenance = value.provenance as unknown as Record<string, unknown>;
  if (!isRecord(provenance) || !exactKeys(provenance, ["source", "trace_id", "corpus_version", "index_version", "claim_units_version", "schema_version"]) || !["gemini", "deterministic_fallback"].includes(value.provenance.source)) add("PUBLIC_PROVENANCE");
  if (value.provenance.source === "deterministic_fallback" && value.claims.length > 0) add("PUBLIC_FALLBACK_WITH_CLAIMS");
  return [...new Set(issues)];
}
