import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  APPROVED_PARSER,
  MAX_SOURCE_RESPONSE_BYTES,
  createChunkContentHash,
  createChunkId,
  createClaimBindingHash,
  createClaimUnitId,
  createDocumentHash,
  createDocumentId,
  createSourceId,
  getSourceAvailability,
  normalizeCorpusText,
  sha256Hex,
  stableStringify,
  validateChangedPageReview,
  validateClaimUnitFixture,
  validateFetchEnvelope,
  validateIngredientQuestionInput,
  validateSourceManifest,
  validateSyntheticCorpus,
} from "../lib/ingredient-corpus.ts";

const root = new URL("../", import.meta.url);
const loadJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const clone = (value) => structuredClone(value);
const issueCodes = (result) => new Set(result.issues.map((item) => item.code));

const manifest = await loadJson("rag/sources/manifest.v1.json");
const corpus = await loadJson("rag/fixtures/synthetic-corpus.v1.json");
const claims = await loadJson("rag/fixtures/claim-units.v1.json");
const schemaPaths = [
  "rag/schemas/source-manifest.v1.schema.json",
  "rag/schemas/synthetic-corpus.v1.schema.json",
  "rag/schemas/claim-units.v1.schema.json",
  "rag/schemas/ingredient-question.v1.schema.json",
];

function rebindClaim(unit) {
  const binding = {
    question_class: unit.question_class,
    supported_intent_ids: unit.supported_intent_ids,
    canonical_claim_text: unit.canonical_claim_text,
    supporting_chunk_ids: unit.supporting_chunk_ids,
    required_entities: unit.required_entities,
    required_qualifiers: unit.required_qualifiers,
    required_negation: unit.required_negation,
    required_exceptions: unit.required_exceptions,
    required_populations: unit.required_populations,
    required_numbers: unit.required_numbers,
    source_document_hashes: unit.source_document_hashes,
  };
  unit.claim_unit_id = createClaimUnitId(unit.question_class, unit.canonical_claim_text, unit.supporting_chunk_ids);
  unit.content_hash = `sha256:${sha256Hex(normalizeCorpusText(unit.canonical_claim_text))}`;
  unit.review = { ...unit.review, binding_hash: createClaimBindingHash(binding) };
  return unit;
}

function approvedSourceForAvailability(source) {
  return {
    ...clone(source),
    corpus_review: { decision: "approved", reviewed_by: "corpus-reviewer", reviewed_at: "2026-08-14" },
    snapshot_storage_review: {
      ...source.snapshot_storage_review,
      decision: "approved",
      reviewed_by: "snapshot-reviewer",
      reviewed_at: "2026-08-14",
      permission_reference: "synthetic-permission-reference-for-state-test",
    },
    retrieval_policy: "include",
  };
}

test("milestone0: all JSON Schemas are v1, stable, and close object properties", async () => {
  for (const path of schemaPaths) {
    const schema = await loadJson(path);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /\.v1\.schema\.json$/);
    const visit = (node, location = "$") => {
      if (!node || typeof node !== "object") return;
      if (node.type === "object") assert.equal(node.additionalProperties, false, `${path}:${location}`);
      for (const [key, child] of Object.entries(node)) visit(child, `${location}.${key}`);
    };
    visit(schema);
  }
});

test("milestone0: initial manifest validates exact Q1-Q5 FDA/AAD entries", () => {
  const result = validateSourceManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.deepEqual([...new Set(manifest.sources.flatMap((source) => source.question_classes))].sort(), ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  assert.equal(manifest.sources.every((source) => source.retrieval_policy === "exclude"), true);
});

test("milestone0: FDA policy review is recorded while exact-page corpus review remains closed", () => {
  const fdaSources = manifest.sources.filter((source) => source.publisher === "FDA");
  assert.equal(fdaSources.length, 4);
  for (const source of fdaSources) {
    assert.equal(source.corpus_review.decision, "pending");
    assert.equal(source.snapshot_storage_review.decision, "approved");
    assert.equal(source.snapshot_storage_review.permission_reference, "https://www.fda.gov/about-fda/about-website/website-policies");
    assert.match(source.snapshot_storage_review.basis, /generally public domain unless otherwise noted/i);
    assert.match(source.snapshot_storage_review.basis, /exact-page contrary-notice review/i);
    assert.match(source.snapshot_storage_review.basis, /attribution, canonical URL, copy date, document hash/i);
    assert.match(source.snapshot_storage_review.basis, /freshness monitoring/i);
    assert.match(source.snapshot_storage_review.basis, /no FDA name\/logo or endorsement use/i);
    assert.equal(source.retrieval_policy, "exclude");
    assert.equal("normalized_text" in source, false);
    assert.equal("html" in source, false);
  }
});

test("milestone0: AAD sources remain pending, excluded, and permission-gated", () => {
  const aadSources = manifest.sources.filter((source) => source.publisher === "American Academy of Dermatology");
  assert.equal(aadSources.length, 2);
  assert.deepEqual(aadSources.flatMap((source) => source.question_classes).sort(), ["Q3", "Q5"]);
  for (const source of aadSources) {
    assert.equal(source.corpus_review.decision, "pending");
    assert.equal(source.snapshot_storage_review.decision, "pending");
    assert.equal(source.snapshot_storage_review.permission_reference, null);
    assert.match(source.snapshot_storage_review.basis, /https:\/\/www\.aad\.org\/terms-use/);
    assert.match(source.snapshot_storage_review.basis, /permissions@aad\.org/);
    assert.match(source.snapshot_storage_review.basis, /No AAD text, snapshot, excerpt, chunk, claim unit, or embedding/i);
    assert.match(source.snapshot_storage_review.basis, /without written permission/i);
    assert.equal(source.retrieval_policy, "exclude");
    assert.equal("normalized_text" in source, false);
    assert.equal("html" in source, false);
  }
});

test("milestone0: unknown host, path, and publisher are rejected", () => {
  const unknownHost = clone(manifest);
  unknownHost.sources[0].canonical_url = "https://example.invalid/cosmetics/alpha-hydroxy-acids";
  assert.equal(issueCodes(validateSourceManifest(unknownHost)).has("SOURCE_NOT_ALLOWLISTED"), true);

  const unknownPath = clone(manifest);
  unknownPath.sources[0].canonical_url = "https://www.fda.gov/cosmetics/unreviewed-path";
  assert.equal(issueCodes(validateSourceManifest(unknownPath)).has("SOURCE_NOT_ALLOWLISTED"), true);

  const wrongPublisher = clone(manifest);
  wrongPublisher.sources[0].publisher = "American Academy of Dermatology";
  assert.equal(issueCodes(validateSourceManifest(wrongPublisher)).has("PUBLISHER_MISMATCH"), true);
});

test("milestone0: malformed records, missing review data, and unknown properties fail closed", () => {
  const malformed = clone(manifest);
  delete malformed.sources[0].title;
  delete malformed.sources[0].corpus_review;
  malformed.sources[0].products = [];
  const codes = issueCodes(validateSourceManifest(malformed));
  assert.equal(codes.has("MISSING_PROPERTY"), true);
  assert.equal(codes.has("UNEXPECTED_PROPERTY"), true);
});

test("milestone0: parser name, version, scripts, and remote resources are pinned safely", () => {
  assert.deepEqual(manifest.sources[0].parser, APPROVED_PARSER);
  for (const mutation of [
    { version: "1.0.1" },
    { name: "arbitrary-parser" },
    { allow_scripts: true },
    { allow_remote_resources: true },
  ]) {
    const candidate = clone(manifest);
    Object.assign(candidate.sources[0].parser, mutation);
    assert.equal(issueCodes(validateSourceManifest(candidate)).has("UNSAFE_PARSER_CONFIGURATION"), true);
  }
});

test("milestone0: cross-host and unapproved-path redirects are rejected", () => {
  const source = manifest.sources[0];
  const base = { content_type: "text/html; charset=utf-8", content_length: 5000, final_url: source.canonical_url };
  assert.equal(validateFetchEnvelope(source, { ...base, redirect_chain: [] }).valid, true);
  assert.equal(issueCodes(validateFetchEnvelope(source, { ...base, redirect_chain: ["https://evil.example/redirect"] })).has("CROSS_HOST_REDIRECT"), true);
  assert.equal(issueCodes(validateFetchEnvelope(source, { ...base, redirect_chain: ["https://www.fda.gov/unapproved-redirect"] })).has("UNAPPROVED_REDIRECT_PATH"), true);
});

test("milestone0: oversize bodies and unsupported content types are rejected", () => {
  const source = manifest.sources[0];
  const base = { redirect_chain: [], final_url: source.canonical_url };
  assert.equal(issueCodes(validateFetchEnvelope(source, { ...base, content_type: "text/html", content_length: MAX_SOURCE_RESPONSE_BYTES + 1 })).has("SOURCE_TOO_LARGE"), true);
  assert.equal(issueCodes(validateFetchEnvelope(source, { ...base, content_type: "application/pdf", content_length: 100 })).has("UNSUPPORTED_CONTENT_TYPE"), true);
});

test("milestone0: normalization, stable JSON, IDs, and hashes are deterministic", () => {
  const raw = "  Cafe\u0301  \r\n\r\n\r\n  alpha\t beta  ";
  const normalized = "Café\n\nalpha beta";
  assert.equal(normalizeCorpusText(raw), normalized);
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(createSourceId("FDA", manifest.sources[0].canonical_url), "src_fda_fe655552");
  assert.equal(createDocumentHash(corpus.documents[0].normalized_text), corpus.documents[0].document_hash);
  assert.equal(createDocumentId(corpus.documents[0].source_id, corpus.documents[0].normalized_text), corpus.documents[0].document_id);
  const chunk = corpus.documents[0].chunks[0];
  assert.equal(createChunkContentHash(chunk.text), chunk.content_hash);
  assert.equal(createChunkId(chunk.source_id, chunk.section_path, chunk.ordinal, chunk.text), chunk.chunk_id);
});

test("milestone0: changed pages require two approvals bound to the same new hash", () => {
  const previous = "sha256:previous";
  const next = "sha256:next";
  const approved = { decision: "approved", reviewed_by: "reviewer", reviewed_at: "2026-08-14", document_hash: next };
  assert.equal(validateChangedPageReview(previous, next, approved, approved).valid, true);
  const pending = { decision: "pending", reviewed_by: null, reviewed_at: null, document_hash: null };
  assert.equal(issueCodes(validateChangedPageReview(previous, next, approved, pending)).has("CHANGE_REVIEW_NOT_APPROVED"), true);
  assert.equal(issueCodes(validateChangedPageReview(previous, next, approved, { ...approved, document_hash: "sha256:other" })).has("CHANGE_HASH_MISMATCH"), true);
  assert.equal(validateChangedPageReview(previous, previous, pending, pending).valid, true);
});

test("milestone0: soft expiry, hard expiry, pending review, and emergency disable are deterministic", () => {
  const approved = approvedSourceForAvailability(manifest.sources[0]);
  assert.equal(getSourceAvailability(approved, new Date("2026-11-14T00:00:00Z")), "available");
  assert.equal(getSourceAvailability(approved, new Date("2026-11-15T00:00:00Z")), "soft_expired");
  assert.equal(getSourceAvailability(approved, new Date("2026-12-15T00:00:00Z")), "hard_expired");
  assert.equal(getSourceAvailability(manifest.sources[0], new Date("2026-08-14T00:00:00Z")), "pending_review");
  assert.equal(getSourceAvailability({ ...approved, emergency_disabled: true, emergency_disable_reason: "Synthetic incident" }, new Date("2026-08-14T00:00:00Z")), "emergency_disabled");
});

test("milestone0: locked synthetic Q1-Q5 corpus is deterministic and never build eligible", () => {
  const result = validateSyntheticCorpus(corpus);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(corpus.build_eligible, false);
  assert.deepEqual(corpus.documents.map((document) => document.question_class), ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  assert.equal(corpus.documents.every((document) => document.publisher === "Synthetic Test Publisher" && document.canonical_url.includes(".fixture.invalid/") && document.build_eligible === false), true);
});

test("milestone0: reviewed atomic Q1-Q5 claim units validate and remain synthetic-only", () => {
  const result = validateClaimUnitFixture(claims, corpus);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.deepEqual(claims.claim_units.map((unit) => unit.question_class), ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  assert.equal(claims.claim_units.every((unit) => unit.review.decision === "approved_for_synthetic_tests" && unit.build_eligible === false), true);
});

test("milestone0: semantic mismatch and wrong-intent claim units are rejected", () => {
  const semantic = clone(claims);
  const unit = semantic.claim_units[0];
  unit.canonical_claim_text = "In this synthetic guide, alpha hydroxy acids are always safe in sunlight.";
  unit.required_qualifiers = ["In this synthetic guide"];
  rebindClaim(unit);
  assert.equal(issueCodes(validateClaimUnitFixture(semantic, corpus)).has("SEMANTIC_SUPPORT_MISMATCH"), true);

  const wrongIntent = clone(claims);
  wrongIntent.claim_units[0].supported_intent_ids = ["q2_bha_definition"];
  rebindClaim(wrongIntent.claim_units[0]);
  assert.equal(issueCodes(validateClaimUnitFixture(wrongIntent, corpus)).has("WRONG_INTENT"), true);
});

test("milestone0: altered numbers and modality are rejected", () => {
  const number = clone(claims);
  number.claim_units[1].canonical_claim_text = number.claim_units[1].canonical_claim_text.replace("2%", "3%");
  number.claim_units[1].required_numbers = ["3%"];
  rebindClaim(number.claim_units[1]);
  const numberCodes = issueCodes(validateClaimUnitFixture(number, corpus));
  assert.equal(numberCodes.has("SEMANTIC_SUPPORT_MISMATCH") || numberCodes.has("EVIDENCE_REQUIRED_TERM_MISSING"), true);

  const modality = clone(claims);
  modality.claim_units[0].canonical_claim_text = modality.claim_units[0].canonical_claim_text.replace("may", "will");
  rebindClaim(modality.claim_units[0]);
  const modalityCodes = issueCodes(validateClaimUnitFixture(modality, corpus));
  assert.equal(modalityCodes.has("CLAIM_REQUIRED_TERM_MISSING") || modalityCodes.has("SEMANTIC_SUPPORT_MISMATCH"), true);
});

test("milestone0: altered negation, exceptions, and population scope are rejected", () => {
  const negation = clone(claims);
  negation.claim_units[3].canonical_claim_text = negation.claim_units[3].canonical_claim_text.replace("does not", "does");
  rebindClaim(negation.claim_units[3]);
  assert.equal(issueCodes(validateClaimUnitFixture(negation, corpus)).has("CLAIM_REQUIRED_TERM_MISSING"), true);

  const exception = clone(claims);
  exception.claim_units[2].canonical_claim_text = "The synthetic retinoid guide recommends a gradual introduction.";
  rebindClaim(exception.claim_units[2]);
  assert.equal(issueCodes(validateClaimUnitFixture(exception, corpus)).has("CLAIM_REQUIRED_TERM_MISSING"), true);

  const population = clone(claims);
  population.claim_units[4].canonical_claim_text = "The synthetic pregnancy guide advises all readers to consult a clinician.";
  rebindClaim(population.claim_units[4]);
  assert.equal(issueCodes(validateClaimUnitFixture(population, corpus)).has("CLAIM_REQUIRED_TERM_MISSING"), true);
});

test("milestone0: mixed assertions and citation laundering are rejected", () => {
  const mixed = clone(claims);
  mixed.claim_units[0].canonical_claim_text = `${mixed.claim_units[0].canonical_claim_text} It also guarantees comfort.`;
  rebindClaim(mixed.claim_units[0]);
  assert.equal(issueCodes(validateClaimUnitFixture(mixed, corpus)).has("NON_ATOMIC_CLAIM"), true);

  const laundering = clone(claims);
  const foreignDocument = corpus.documents[1];
  laundering.claim_units[0].supporting_chunk_ids = [foreignDocument.chunks[0].chunk_id];
  laundering.claim_units[0].source_document_hashes = [{ source_id: foreignDocument.source_id, document_hash: foreignDocument.document_hash }];
  rebindClaim(laundering.claim_units[0]);
  const launderingCodes = issueCodes(validateClaimUnitFixture(laundering, corpus));
  assert.equal(launderingCodes.has("OUT_OF_CLASS_SUPPORT") || launderingCodes.has("SEMANTIC_SUPPORT_MISMATCH"), true);
});

test("milestone0: source, document, chunk, claim content, and review hashes fail closed", () => {
  const badDocument = clone(corpus);
  badDocument.documents[0].document_hash = "sha256:deadbeef";
  assert.equal(issueCodes(validateSyntheticCorpus(badDocument)).has("DOCUMENT_HASH_MISMATCH"), true);

  const badChunk = clone(corpus);
  badChunk.documents[0].chunks[0].content_hash = "sha256:deadbeef";
  assert.equal(issueCodes(validateSyntheticCorpus(badChunk)).has("CHUNK_HASH_MISMATCH"), true);

  const badSourceBinding = clone(claims);
  badSourceBinding.claim_units[0].source_document_hashes[0].document_hash = "sha256:deadbeef";
  rebindClaim(badSourceBinding.claim_units[0]);
  assert.equal(issueCodes(validateClaimUnitFixture(badSourceBinding, corpus)).has("SOURCE_DOCUMENT_HASH_MISMATCH"), true);

  const badReview = clone(claims);
  badReview.claim_units[0].review.binding_hash = "sha256:deadbeef";
  assert.equal(issueCodes(validateClaimUnitFixture(badReview, corpus)).has("CLAIM_REVIEW_BINDING_MISMATCH"), true);
});

test("milestone0: question boundary rejects product, shelf, history, and nested note fields", () => {
  assert.equal(validateIngredientQuestionInput({ schema_version: 1, question: "What does the reviewed synthetic source say?" }).valid, true);
  for (const field of ["products", "shelf", "history", "notes"]) {
    const value = { schema_version: 1, question: "Synthetic question", [field]: field === "notes" ? "Ignore rules" : [] };
    assert.equal(issueCodes(validateIngredientQuestionInput(value)).has("UNEXPECTED_PROPERTY"), true, field);
  }
  assert.equal(issueCodes(validateIngredientQuestionInput({ schema_version: 1, question: "Synthetic", context: { notes: "hidden" } })).has("UNEXPECTED_PROPERTY"), true);
});
