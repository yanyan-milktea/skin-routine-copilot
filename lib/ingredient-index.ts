import { createHash } from "node:crypto";
import { createChunkContentHash, createChunkId, createDocumentHash, normalizeCorpusText, sha256Hex, stableStringify } from "./ingredient-corpus.ts";
import { CHUNKER_VERSION, TOKEN_ESTIMATOR_VERSION, chunkDocument } from "./ingredient-chunking.ts";
import type { ChunkSourceDocument, IndexChunk } from "./ingredient-chunking.ts";
import { EMBEDDING_DIMENSIONS, PRODUCTION_EMBEDDING_MODEL, SYNTHETIC_EMBEDDING_MODEL } from "./ingredient-embedding.ts";
import type { Embedder } from "./ingredient-embedding.ts";
import { TOKENIZER_VERSION } from "./ingredient-tokenizer.ts";

export const INDEX_SCHEMA_VERSION = 1 as const;
export const BUILDER_VERSION = "rag-build-v1" as const;

/** Section 10.4 hard budgets for the checked-in exact-search artifact. */
export const INDEX_BUDGETS = Object.freeze({
  max_chunks: 250,
  max_uncompressed_bytes: 4 * 1024 * 1024,
  max_compressed_bytes: Math.floor(1.5 * 1024 * 1024),
});

const NORM_TOLERANCE = 1e-3;

export type IndexSource = {
  source_id: string;
  document_id: string;
  document_hash: string;
  publisher: string;
  title: string;
  canonical_url: string;
  retrieved_at: string;
  question_classes: string[];
};

export type IndexClaimUnit = {
  schema_version: 1;
  claim_unit_id: string;
  question_class: string;
  supported_intent_ids: string[];
  canonical_claim_text: string;
  supporting_chunk_ids: string[];
  source_document_hashes: { source_id: string; document_hash: string }[];
  content_hash: string;
  enabled: boolean;
  review: { decision: string; reviewed_by: string; reviewed_at: string; review_version: string };
};

export type IndexManifest = {
  schema_version: 1;
  index_version: string;
  corpus_version: string;
  corpus_kind: "synthetic_only" | "production";
  embedding_model: string;
  embedding_dimensions: number;
  embedding_fixture_only: boolean;
  distance: "cosine";
  normalized: true;
  vector_encoding: "float32-le";
  chunk_count: number;
  claim_unit_count: number;
  chunks_sha256: string;
  vectors_sha256: string;
  claim_units_sha256: string;
  chunker_version: typeof CHUNKER_VERSION;
  token_estimator_version: typeof TOKEN_ESTIMATOR_VERSION;
  tokenizer_version: typeof TOKENIZER_VERSION;
  built_at: string;
  builder_version: typeof BUILDER_VERSION;
  sources: IndexSource[];
};

export type IndexFiles = { manifest: string; chunks: string; vectors: Uint8Array; claimUnits: string };

export type LoadedIndex = {
  manifest: IndexManifest;
  chunks: readonly IndexChunk[];
  vectors: readonly Float32Array[];
  claimUnits: readonly IndexClaimUnit[];
};

export type BuildDocumentInput = Omit<ChunkSourceDocument, "document_id" | "document_hash"> & { document_id?: string; document_hash?: string };

export type ClaimUnitSource = {
  question_class: string;
  supported_intent_ids: string[];
  canonical_claim_text: string;
  /** Each support reference names a source and the last heading of the section that contains the exact claim text. */
  support: { source_id: string; section: string }[];
  enabled: boolean;
  review: IndexClaimUnit["review"];
};

function sha(text: string | Uint8Array): string {
  if (typeof text === "string") return `sha256:${sha256Hex(text)}`;
  return `sha256:${sha256BytesHex(text)}`;
}

function sha256BytesHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function encodeVectors(vectors: readonly Float32Array[], dimensions: number): Uint8Array {
  const bytes = new Uint8Array(vectors.length * dimensions * 4);
  const view = new DataView(bytes.buffer);
  vectors.forEach((vector, row) => {
    if (vector.length !== dimensions) throw new Error("INDEX_VECTOR_DIMENSION_MISMATCH");
    for (let column = 0; column < dimensions; column += 1) view.setFloat32((row * dimensions + column) * 4, vector[column], true);
  });
  return bytes;
}

export function decodeVectors(bytes: Uint8Array, count: number, dimensions: number): Float32Array[] {
  if (bytes.byteLength !== count * dimensions * 4) throw new Error("INDEX_VECTOR_BYTES_MISMATCH");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Float32Array[] = [];
  for (let row = 0; row < count; row += 1) {
    const vector = new Float32Array(dimensions);
    for (let column = 0; column < dimensions; column += 1) vector[column] = view.getFloat32((row * dimensions + column) * 4, true);
    out.push(vector);
  }
  return out;
}

function slug(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "claim";
}

export function createIndexClaimUnitId(unit: Pick<IndexClaimUnit, "question_class" | "canonical_claim_text" | "supporting_chunk_ids" | "supported_intent_ids">): string {
  const binding = stableStringify({
    question_class: unit.question_class,
    canonical_claim_text: unit.canonical_claim_text,
    supporting_chunk_ids: [...unit.supporting_chunk_ids].sort(),
    supported_intent_ids: [...unit.supported_intent_ids].sort(),
  });
  return `cu_${unit.question_class.toLowerCase()}_${slug(unit.canonical_claim_text)}_${sha256Hex(binding).slice(0, 8)}`;
}

/** Text embedded for a chunk: heading breadcrumb plus exact passage, sent as data. */
export function chunkEmbeddingText(chunk: Pick<IndexChunk, "section_path" | "text">): string {
  return `${chunk.section_path.join(" > ")}\n\n${chunk.text}`;
}

export type BuildOptions = {
  corpusVersion: string;
  corpusKind: IndexManifest["corpus_kind"];
  indexVersion: string;
  builtAt: string;
  documents: readonly BuildDocumentInput[];
  claimUnits: readonly ClaimUnitSource[];
  embedder: Embedder;
};

/** Deterministic build: same documents, claim units, embedder and builtAt produce byte-identical artifacts. */
export async function buildIndex(options: BuildOptions): Promise<IndexFiles> {
  if (options.corpusKind === "production" && options.embedder.fixtureOnly) throw new Error("INDEX_FIXTURE_EMBEDDER_FOR_PRODUCTION");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(options.builtAt)) throw new Error("INDEX_BUILT_AT_INVALID");
  const sources: IndexSource[] = [];
  const chunks: IndexChunk[] = [];
  const seenSources = new Set<string>();
  for (const input of [...options.documents].sort((a, b) => a.source_id.localeCompare(b.source_id))) {
    if (seenSources.has(input.source_id)) throw new Error(`INDEX_DUPLICATE_SOURCE: ${input.source_id}`);
    seenSources.add(input.source_id);
    const normalized = normalizeCorpusText(input.normalized_text);
    const documentHash = createDocumentHash(normalized);
    if (input.document_hash && input.document_hash !== documentHash) throw new Error(`INDEX_DOCUMENT_HASH_MISMATCH: ${input.source_id}`);
    const documentId = input.document_id ?? `doc_${input.source_id}_${documentHash.slice(7, 15)}`;
    const document: ChunkSourceDocument = { ...input, normalized_text: normalized, document_hash: documentHash, document_id: documentId, question_classes: [...input.question_classes].sort() };
    sources.push({
      source_id: document.source_id,
      document_id: document.document_id,
      document_hash: document.document_hash,
      publisher: document.publisher,
      title: document.title,
      canonical_url: document.canonical_url,
      retrieved_at: document.retrieved_at,
      question_classes: [...document.question_classes],
    });
    chunks.push(...chunkDocument(document));
  }
  const ids = new Set<string>();
  for (const chunk of chunks) {
    if (ids.has(chunk.chunk_id)) throw new Error(`INDEX_DUPLICATE_CHUNK: ${chunk.chunk_id}`);
    ids.add(chunk.chunk_id);
  }
  if (chunks.length > INDEX_BUDGETS.max_chunks) throw new Error("INDEX_BUDGET_CHUNKS_EXCEEDED");

  const rawVectors = await options.embedder.embed(chunks.map(chunkEmbeddingText), "retrieval_document");
  if (rawVectors.length !== chunks.length) throw new Error("INDEX_VECTOR_COUNT_MISMATCH");
  for (const vector of rawVectors) assertUnitVector(vector, options.embedder.dimensions);

  const sourceById = new Map(sources.map((source) => [source.source_id, source]));
  const claimUnits: IndexClaimUnit[] = options.claimUnits.map((spec) => {
    const supporting: IndexChunk[] = [];
    for (const reference of spec.support) {
      const match = chunks.filter((chunk) => chunk.source_id === reference.source_id && chunk.section_path[chunk.section_path.length - 1] === reference.section && chunk.text.includes(spec.canonical_claim_text));
      if (match.length === 0) throw new Error(`CLAIM_UNIT_UNSUPPORTED: "${spec.canonical_claim_text.slice(0, 60)}" not found verbatim in ${reference.source_id} § ${reference.section}`);
      supporting.push(...match);
    }
    const supportingIds = [...new Set(supporting.map((chunk) => chunk.chunk_id))].sort();
    const sourceHashes = [...new Set(supporting.map((chunk) => chunk.source_id))].sort().map((sourceId) => ({ source_id: sourceId, document_hash: sourceById.get(sourceId)!.document_hash }));
    const base = {
      question_class: spec.question_class,
      supported_intent_ids: [...spec.supported_intent_ids].sort(),
      canonical_claim_text: spec.canonical_claim_text,
      supporting_chunk_ids: supportingIds,
    };
    return {
      schema_version: 1 as const,
      claim_unit_id: createIndexClaimUnitId(base),
      ...base,
      source_document_hashes: sourceHashes,
      content_hash: createChunkContentHash(spec.canonical_claim_text),
      enabled: spec.enabled,
      review: spec.review,
    };
  }).sort((a, b) => a.claim_unit_id.localeCompare(b.claim_unit_id));

  const chunksText = serializeJson(chunks);
  const vectorBytes = encodeVectors(rawVectors, options.embedder.dimensions);
  const claimUnitsText = serializeJson(claimUnits);
  const manifest: IndexManifest = {
    schema_version: INDEX_SCHEMA_VERSION,
    index_version: options.indexVersion,
    corpus_version: options.corpusVersion,
    corpus_kind: options.corpusKind,
    embedding_model: options.embedder.model,
    embedding_dimensions: options.embedder.dimensions,
    embedding_fixture_only: options.embedder.fixtureOnly,
    distance: "cosine",
    normalized: true,
    vector_encoding: "float32-le",
    chunk_count: chunks.length,
    claim_unit_count: claimUnits.length,
    chunks_sha256: sha(chunksText),
    vectors_sha256: sha(vectorBytes),
    claim_units_sha256: sha(claimUnitsText),
    chunker_version: CHUNKER_VERSION,
    token_estimator_version: TOKEN_ESTIMATOR_VERSION,
    tokenizer_version: TOKENIZER_VERSION,
    built_at: options.builtAt,
    builder_version: BUILDER_VERSION,
    sources,
  };
  return { manifest: serializeJson(manifest), chunks: chunksText, vectors: vectorBytes, claimUnits: claimUnitsText };
}

function assertUnitVector(vector: Float32Array, dimensions: number): void {
  if (vector.length !== dimensions) throw new Error("INDEX_VECTOR_DIMENSION_MISMATCH");
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) throw new Error("INDEX_VECTOR_NONFINITE");
    sum += vector[index] * vector[index];
  }
  if (Math.abs(Math.sqrt(sum) - 1) > NORM_TOLERANCE) throw new Error("INDEX_VECTOR_NOT_NORMALIZED");
}

const MANIFEST_KEYS = [
  "schema_version", "index_version", "corpus_version", "corpus_kind", "embedding_model", "embedding_dimensions", "embedding_fixture_only",
  "distance", "normalized", "vector_encoding", "chunk_count", "claim_unit_count", "chunks_sha256", "vectors_sha256", "claim_units_sha256",
  "chunker_version", "token_estimator_version", "tokenizer_version", "built_at", "builder_version", "sources",
] as const;

export type VerifyExpectations = {
  /** When set, the index must have been built for exactly this corpus kind. */
  corpusKind?: IndexManifest["corpus_kind"];
  /** When set, the runtime embedder model the caller will use for queries. */
  queryEmbeddingModel?: string;
};

export class IndexVerificationError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

function fail(code: string, detail?: string): never {
  throw new IndexVerificationError(code, detail);
}

/** Verify every artifact byte, hash, relationship and budget. Fails closed: throws IndexVerificationError. */
export function verifyIndex(files: IndexFiles, expectations: VerifyExpectations = {}): LoadedIndex {
  let manifest: IndexManifest;
  let chunks: IndexChunk[];
  let claimUnits: IndexClaimUnit[];
  try {
    manifest = JSON.parse(files.manifest);
    chunks = JSON.parse(files.chunks);
    claimUnits = JSON.parse(files.claimUnits);
  } catch {
    fail("INDEX_JSON_INVALID");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) fail("INDEX_MANIFEST_INVALID");
  const keys = Object.keys(manifest).sort();
  if (keys.join(",") !== [...MANIFEST_KEYS].sort().join(",")) fail("INDEX_MANIFEST_KEYS", keys.join(","));
  if (manifest.schema_version !== INDEX_SCHEMA_VERSION) fail("INDEX_SCHEMA_VERSION_MISMATCH");
  if (manifest.distance !== "cosine" || manifest.normalized !== true || manifest.vector_encoding !== "float32-le") fail("INDEX_DISTANCE_CONTRACT");
  if (manifest.tokenizer_version !== TOKENIZER_VERSION) fail("INDEX_TOKENIZER_MISMATCH");
  if (manifest.chunker_version !== CHUNKER_VERSION || manifest.token_estimator_version !== TOKEN_ESTIMATOR_VERSION) fail("INDEX_CHUNKER_MISMATCH");
  if (manifest.builder_version !== BUILDER_VERSION) fail("INDEX_BUILDER_MISMATCH");
  if (expectations.corpusKind && manifest.corpus_kind !== expectations.corpusKind) fail("INDEX_CORPUS_KIND_MISMATCH");

  // Model policy: production indexes use only the pinned production model; the fixture model is synthetic-only.
  if (manifest.corpus_kind === "production") {
    if (manifest.embedding_model !== PRODUCTION_EMBEDDING_MODEL || manifest.embedding_dimensions !== EMBEDDING_DIMENSIONS || manifest.embedding_fixture_only) fail("INDEX_EMBEDDING_MODEL_NOT_ALLOWED");
  } else if (manifest.corpus_kind === "synthetic_only") {
    if (manifest.embedding_model !== SYNTHETIC_EMBEDDING_MODEL || manifest.embedding_dimensions !== EMBEDDING_DIMENSIONS || !manifest.embedding_fixture_only) fail("INDEX_EMBEDDING_MODEL_NOT_ALLOWED");
  } else {
    fail("INDEX_CORPUS_KIND_INVALID");
  }
  if (expectations.queryEmbeddingModel !== undefined && expectations.queryEmbeddingModel !== manifest.embedding_model) fail("INDEX_QUERY_MODEL_MISMATCH");

  if (sha(files.chunks) !== manifest.chunks_sha256) fail("INDEX_CHUNKS_HASH_MISMATCH");
  if (sha(files.vectors) !== manifest.vectors_sha256) fail("INDEX_VECTORS_HASH_MISMATCH");
  if (sha(files.claimUnits) !== manifest.claim_units_sha256) fail("INDEX_CLAIM_UNITS_HASH_MISMATCH");

  if (!Array.isArray(chunks) || chunks.length !== manifest.chunk_count) fail("INDEX_CHUNK_COUNT_MISMATCH");
  if (!Array.isArray(claimUnits) || claimUnits.length !== manifest.claim_unit_count) fail("INDEX_CLAIM_UNIT_COUNT_MISMATCH");
  if (chunks.length > INDEX_BUDGETS.max_chunks) fail("INDEX_BUDGET_CHUNKS_EXCEEDED");
  const totalBytes = new TextEncoder().encode(files.manifest).byteLength + new TextEncoder().encode(files.chunks).byteLength + files.vectors.byteLength + new TextEncoder().encode(files.claimUnits).byteLength;
  if (totalBytes > INDEX_BUDGETS.max_uncompressed_bytes) fail("INDEX_BUDGET_BYTES_EXCEEDED");

  let vectors: Float32Array[];
  try {
    vectors = decodeVectors(files.vectors, manifest.chunk_count, manifest.embedding_dimensions);
  } catch {
    fail("INDEX_VECTOR_BYTES_MISMATCH");
  }
  vectors.forEach((vector, index) => {
    try {
      assertUnitVector(vector, manifest.embedding_dimensions);
    } catch (error) {
      fail((error as Error).message, `row ${index}`);
    }
  });

  const sources = new Map(manifest.sources.map((source) => [source.source_id, source]));
  if (sources.size !== manifest.sources.length) fail("INDEX_DUPLICATE_SOURCE");
  const chunkIds = new Set<string>();
  for (const chunk of chunks) {
    if (chunkIds.has(chunk.chunk_id)) fail("INDEX_DUPLICATE_CHUNK", chunk.chunk_id);
    chunkIds.add(chunk.chunk_id);
    const source = sources.get(chunk.source_id);
    if (!source) fail("INDEX_CHUNK_SOURCE_UNKNOWN", chunk.chunk_id);
    if (chunk.document_hash !== source.document_hash || chunk.document_id !== source.document_id) fail("INDEX_CHUNK_DOCUMENT_MISMATCH", chunk.chunk_id);
    if (chunk.question_classes.join(",") !== source.question_classes.join(",")) fail("INDEX_CHUNK_CLASS_MISMATCH", chunk.chunk_id);
    if (createChunkContentHash(chunk.text) !== chunk.content_hash) fail("INDEX_CHUNK_CONTENT_HASH_MISMATCH", chunk.chunk_id);
    if (createChunkId(chunk.source_id, chunk.section_path, chunk.ordinal, chunk.text) !== chunk.chunk_id) fail("INDEX_CHUNK_ID_MISMATCH", chunk.chunk_id);
    if (!(chunk.start_char >= 0 && chunk.end_char > chunk.start_char && chunk.end_char - chunk.start_char === chunk.text.length)) fail("INDEX_CHUNK_OFFSETS_INVALID", chunk.chunk_id);
  }
  const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const unitIds = new Set<string>();
  for (const unit of claimUnits) {
    if (unitIds.has(unit.claim_unit_id)) fail("INDEX_DUPLICATE_CLAIM_UNIT", unit.claim_unit_id);
    unitIds.add(unit.claim_unit_id);
    if (createIndexClaimUnitId(unit) !== unit.claim_unit_id) fail("INDEX_CLAIM_UNIT_ID_MISMATCH", unit.claim_unit_id);
    if (createChunkContentHash(unit.canonical_claim_text) !== unit.content_hash) fail("INDEX_CLAIM_UNIT_CONTENT_HASH_MISMATCH", unit.claim_unit_id);
    if (unit.supporting_chunk_ids.length === 0) fail("INDEX_CLAIM_UNIT_UNSUPPORTED", unit.claim_unit_id);
    for (const chunkId of unit.supporting_chunk_ids) {
      const chunk = chunkById.get(chunkId);
      if (!chunk) fail("INDEX_CLAIM_UNIT_CHUNK_UNKNOWN", unit.claim_unit_id);
      if (!chunk.text.includes(unit.canonical_claim_text)) fail("INDEX_CLAIM_UNIT_NOT_VERBATIM", unit.claim_unit_id);
      if (!chunk.question_classes.includes(unit.question_class)) fail("INDEX_CLAIM_UNIT_CLASS_MISMATCH", unit.claim_unit_id);
      const binding = unit.source_document_hashes.find((item) => item.source_id === chunk.source_id);
      if (!binding || binding.document_hash !== chunk.document_hash) fail("INDEX_CLAIM_UNIT_DOCUMENT_HASH_MISMATCH", unit.claim_unit_id);
    }
  }
  return Object.freeze({ manifest, chunks: Object.freeze(chunks), vectors: Object.freeze(vectors), claimUnits: Object.freeze(claimUnits) });
}
