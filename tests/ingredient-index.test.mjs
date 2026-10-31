import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { CHUNKING, chunkDocument, estimateTokens } from "../lib/ingredient-chunking.ts";
import { createDocumentHash, normalizeCorpusText } from "../lib/ingredient-corpus.ts";
import { EMBEDDING_DIMENSIONS, createGeminiEmbedder, createSyntheticEmbedder, validateEmbeddingBatch } from "../lib/ingredient-embedding.ts";
import { INDEX_BUDGETS, buildIndex, decodeVectors, encodeVectors, verifyIndex } from "../lib/ingredient-index.ts";
import { createRetriever } from "../lib/ingredient-retrieval.ts";
import { PATHS, buildSyntheticIndex, loadAliases, loadConfig, loadDenyList, loadSyntheticStack, readIndexFiles, sameFiles } from "../scripts/rag/shared.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const checkedIn = readIndexFiles(PATHS.evalIndex);
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const codeOf = (fn) => {
  try { fn(); } catch (error) { return error.code ?? error.message; }
  return "NO_ERROR";
};

/** Edit one artifact and re-bind the manifest hash so the deeper check is what fails. */
function tamper(files, edit) {
  const next = { ...files, vectors: new Uint8Array(files.vectors) };
  const manifest = JSON.parse(next.manifest);
  edit(next, manifest);
  manifest.chunks_sha256 = sha(next.chunks);
  manifest.vectors_sha256 = sha(next.vectors);
  manifest.claim_units_sha256 = sha(next.claimUnits);
  next.manifest = `${JSON.stringify(manifest, null, 2)}\n`;
  return next;
}

// --- Reproducibility -----------------------------------------------------------

test("the checked-in synthetic index verifies and matches a fresh deterministic build", async () => {
  const index = verifyIndex(checkedIn, { corpusKind: "synthetic_only" });
  assert.equal(index.manifest.chunk_count, index.chunks.length);
  const fresh = await buildSyntheticIndex();
  assert.ok(sameFiles(fresh, checkedIn), "run `npm run rag:build` after changing corpus, chunker, aliases or embedder");
  const again = await buildSyntheticIndex();
  assert.ok(sameFiles(fresh, again), "two builds from the same input are byte-identical");
});

test("vectors round-trip through float32 little-endian encoding", () => {
  const index = verifyIndex(checkedIn);
  const bytes = encodeVectors(index.vectors, EMBEDDING_DIMENSIONS);
  assert.deepEqual(decodeVectors(bytes, index.vectors.length, EMBEDDING_DIMENSIONS), index.vectors);
});

// --- Verification fails closed ---------------------------------------------------

test("verification rejects corrupted bytes and every broken binding", () => {
  const flipped = { ...checkedIn, vectors: new Uint8Array(checkedIn.vectors) };
  flipped.vectors[10] ^= 0xff;
  assert.equal(codeOf(() => verifyIndex(flipped)), "INDEX_VECTORS_HASH_MISMATCH");
  assert.equal(codeOf(() => verifyIndex({ ...checkedIn, chunks: checkedIn.chunks.replace("synthetic", "Synthetic") })), "INDEX_CHUNKS_HASH_MISMATCH");
  assert.equal(codeOf(() => verifyIndex({ ...checkedIn, claimUnits: `${checkedIn.claimUnits} ` })), "INDEX_CLAIM_UNITS_HASH_MISMATCH");
  assert.equal(codeOf(() => verifyIndex({ ...checkedIn, manifest: "{" })), "INDEX_JSON_INVALID");

  const nan = tamper(checkedIn, (files) => new DataView(files.vectors.buffer).setFloat32(0, Number.NaN, true));
  assert.equal(codeOf(() => verifyIndex(nan)), "INDEX_VECTOR_NONFINITE");
  const unnormalized = tamper(checkedIn, (files) => new DataView(files.vectors.buffer).setFloat32(0, 5, true));
  assert.equal(codeOf(() => verifyIndex(unnormalized)), "INDEX_VECTOR_NOT_NORMALIZED");
  const truncated = tamper(checkedIn, (files) => { files.vectors = files.vectors.slice(0, files.vectors.length - 4); });
  assert.equal(codeOf(() => verifyIndex(truncated)), "INDEX_VECTOR_BYTES_MISMATCH");
  const wrongDimension = tamper(checkedIn, (_files, manifest) => { manifest.embedding_dimensions = 512; });
  assert.equal(codeOf(() => verifyIndex(wrongDimension)), "INDEX_EMBEDDING_MODEL_NOT_ALLOWED");
  const wrongCount = tamper(checkedIn, (_files, manifest) => { manifest.chunk_count += 1; });
  assert.equal(codeOf(() => verifyIndex(wrongCount)), "INDEX_CHUNK_COUNT_MISMATCH");
  const extraKey = tamper(checkedIn, (_files, manifest) => { manifest.notes = "x"; });
  assert.equal(codeOf(() => verifyIndex(extraKey)), "INDEX_MANIFEST_KEYS");
  const tokenizer = tamper(checkedIn, (_files, manifest) => { manifest.tokenizer_version = "ingredient-tokenizer-v2"; });
  assert.equal(codeOf(() => verifyIndex(tokenizer)), "INDEX_TOKENIZER_MISMATCH");

  const editedText = tamper(checkedIn, (files) => {
    const chunks = JSON.parse(files.chunks);
    chunks[0].text = chunks[0].text.replace(/\.$/, "!");
    files.chunks = `${JSON.stringify(chunks, null, 2)}\n`;
  });
  assert.equal(codeOf(() => verifyIndex(editedText)), "INDEX_CHUNK_CONTENT_HASH_MISMATCH");

  const docHash = tamper(checkedIn, (files) => {
    const chunks = JSON.parse(files.chunks);
    chunks[0].document_hash = `sha256:${"0".repeat(64)}`;
    files.chunks = `${JSON.stringify(chunks, null, 2)}\n`;
  });
  assert.equal(codeOf(() => verifyIndex(docHash)), "INDEX_CHUNK_DOCUMENT_MISMATCH");

  const notVerbatim = tamper(checkedIn, (files) => {
    const units = JSON.parse(files.claimUnits);
    units[0].canonical_claim_text = `${units[0].canonical_claim_text} Always.`;
    files.claimUnits = `${JSON.stringify(units, null, 2)}\n`;
  });
  assert.equal(codeOf(() => verifyIndex(notVerbatim)), "INDEX_CLAIM_UNIT_ID_MISMATCH");
});

test("model and corpus-kind policy: the fixture embedder can never back a production index", async () => {
  const relabelled = tamper(checkedIn, (_files, manifest) => { manifest.corpus_kind = "production"; });
  assert.equal(codeOf(() => verifyIndex(relabelled)), "INDEX_EMBEDDING_MODEL_NOT_ALLOWED");
  const swapped = tamper(checkedIn, (_files, manifest) => { manifest.embedding_model = "gemini-embedding-2"; });
  assert.equal(codeOf(() => verifyIndex(swapped)), "INDEX_EMBEDDING_MODEL_NOT_ALLOWED");
  assert.equal(codeOf(() => verifyIndex(checkedIn, { corpusKind: "production" })), "INDEX_CORPUS_KIND_MISMATCH");
  assert.equal(codeOf(() => verifyIndex(checkedIn, { queryEmbeddingModel: "gemini-embedding-2" })), "INDEX_QUERY_MODEL_MISMATCH");
  await assert.rejects(
    buildIndex({ corpusVersion: "x", corpusKind: "production", indexVersion: "x", builtAt: "2026-10-31T00:00:00Z", documents: [], claimUnits: [], embedder: createSyntheticEmbedder(loadAliases()) }),
    /INDEX_FIXTURE_EMBEDDER_FOR_PRODUCTION/,
  );
});

test("claim units that are not verbatim in their supporting section cannot be built", async () => {
  await assert.rejects(
    buildIndex({
      corpusVersion: "x", corpusKind: "synthetic_only", indexVersion: "x", builtAt: "2026-10-31T00:00:00Z",
      documents: [{ source_id: "syn_a", publisher: "Synthetic Test Publisher", title: "A", canonical_url: "https://a.fixture.invalid/", retrieved_at: "2026-10-31T00:00:00Z", question_classes: ["Q1"], normalized_text: "# A\n\n## S\n\nAlpha hydroxy acids may increase sun sensitivity." }],
      claimUnits: [{ question_class: "Q1", supported_intent_ids: ["q1_sun_sensitivity_relationship"], canonical_claim_text: "Alpha hydroxy acids always increase sun sensitivity.", support: [{ source_id: "syn_a", section: "S" }], enabled: true, review: { decision: "approved_for_synthetic_tests", reviewed_by: "r", reviewed_at: "2026-10-31", review_version: "v" } }],
      embedder: createSyntheticEmbedder(loadAliases()),
    }),
    /CLAIM_UNIT_UNSUPPORTED/,
  );
});

// --- Chunking --------------------------------------------------------------------

const longDocument = (() => {
  const paragraph = (n) => Array.from({ length: 6 }, (_, s) => `Paragraph ${n} sentence ${s} describes a synthetic ingredient property in plain words for testing.`).join(" ");
  const body = Array.from({ length: 12 }, (_, n) => paragraph(n)).join("\n\n");
  const text = normalizeCorpusText(`# Long synthetic page\n\nIntro text before any subheading.\n\n## Long section\n\n${body}\n\nHowever, this qualifier must stay with the statement before it.\n\n## Short section\n\nOne short closing statement.`);
  return { source_id: "syn_long", document_id: "doc_syn_long", document_hash: createDocumentHash(text), publisher: "Synthetic Test Publisher", title: "Long synthetic page", canonical_url: "https://l.fixture.invalid/", retrieved_at: "2026-10-31T00:00:00Z", question_classes: ["Q1"], normalized_text: text };
})();

test("chunker follows headings, stays within token limits, and slices the normalized document exactly", () => {
  const chunks = chunkDocument(longDocument);
  const sections = new Set(chunks.map((chunk) => chunk.section_path.join(" > ")));
  assert.deepEqual([...sections], ["Long synthetic page", "Long synthetic page > Long section", "Long synthetic page > Short section"]);
  for (const chunk of chunks) {
    assert.equal(longDocument.normalized_text.slice(chunk.start_char, chunk.end_char), chunk.text);
    assert.ok(chunk.token_estimate <= CHUNKING.max_tokens, `${chunk.token_estimate} tokens`);
    assert.ok(!chunk.text.includes("## "), "no chunk spans a heading");
  }
  const long = chunks.filter((chunk) => chunk.section_path.at(-1) === "Long section");
  assert.ok(long.length >= 2);
  for (const chunk of long.slice(0, -1)) assert.ok(chunk.token_estimate >= CHUNKING.target_min_tokens && chunk.token_estimate <= CHUNKING.target_max_tokens, `${chunk.token_estimate}`);
});

test("chunk overlap is 60-80 tokens of whole sentences within the same section only", () => {
  const chunks = chunkDocument(longDocument);
  const long = chunks.filter((chunk) => chunk.section_path.at(-1) === "Long section");
  for (let index = 1; index < long.length; index += 1) {
    assert.ok(long[index].overlaps_previous);
    const overlap = longDocument.normalized_text.slice(long[index].start_char, long[index - 1].end_char);
    const tokens = estimateTokens(overlap);
    assert.ok(tokens >= CHUNKING.overlap_min_tokens && tokens <= CHUNKING.overlap_max_tokens, `${tokens} overlap tokens`);
    assert.match(overlap, /^Paragraph \d+ sentence \d+/);
  }
  const short = chunks.filter((chunk) => chunk.section_path.at(-1) === "Short section");
  assert.equal(short[0].overlaps_previous, false, "no overlap across sections");
});

test("a qualifier paragraph is kept with the statement it qualifies", () => {
  const chunks = chunkDocument(longDocument);
  const withQualifier = chunks.find((chunk) => chunk.text.includes("However, this qualifier"));
  assert.ok(withQualifier.text.includes("Paragraph 11 sentence 5"));
});

test("chunk IDs and hashes are stable and the chunker rejects unnormalized input", () => {
  assert.deepEqual(chunkDocument(longDocument), chunkDocument(structuredClone(longDocument)));
  assert.throws(() => chunkDocument({ ...longDocument, normalized_text: `${longDocument.normalized_text}\n\n\n` }), /NOT_NORMALIZED/);
});

// --- Embedding adapters ------------------------------------------------------------

test("embedding batches are validated for count, dimension and finiteness, then normalized", () => {
  assert.throws(() => validateEmbeddingBatch([[1, 0]], 2, 2), /COUNT_MISMATCH/);
  assert.throws(() => validateEmbeddingBatch([[1, 0, 0]], 1, 2), /DIMENSION_MISMATCH/);
  assert.throws(() => validateEmbeddingBatch([[1, Number.NaN]], 1, 2), /NONFINITE/);
  assert.throws(() => validateEmbeddingBatch([[0, 0]], 1, 2), /ZERO_OR_NONFINITE/);
  const [vector] = validateEmbeddingBatch([[3, 4]], 1, 2);
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-6 && Math.abs(vector[1] - 0.8) < 1e-6);
});

test("the Gemini adapter sends the key only in a header, requests 768 dimensions, and redacts failures", async () => {
  const calls = [];
  const values = Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
  const ok = createGeminiEmbedder({ apiKey: "test-key-not-real", fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ embeddings: [{ values }] }) }; } });
  const [vector] = await ok.embed(["a question"], "retrieval_query");
  assert.equal(vector.length, 768);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "test-key-not-real");
  assert.ok(!calls[0].url.includes("test-key-not-real") && !calls[0].init.body.includes("test-key-not-real"));
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.requests[0].outputDimensionality, 768);
  assert.equal(body.requests[0].taskType, "RETRIEVAL_QUERY");

  const http = createGeminiEmbedder({ apiKey: "k", fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: "secret detail" }) }) });
  await assert.rejects(http.embed(["q"], "retrieval_query"), /^Error: EMBEDDING_PROVIDER_HTTP_5XX$/);
  const short = createGeminiEmbedder({ apiKey: "k", fetch: async () => ({ ok: true, status: 200, json: async () => ({ embeddings: [{ values: [1, 0] }] }) }) });
  await assert.rejects(short.embed(["q"], "retrieval_query"), /EMBEDDING_DIMENSION_MISMATCH/);
  assert.throws(() => createGeminiEmbedder({ apiKey: "" }), /CREDENTIAL_MISSING/);
});

// --- Section 10.4 operational budgets -------------------------------------------

test("artifact count and byte budgets", () => {
  const manifest = JSON.parse(checkedIn.manifest);
  const raw = Buffer.concat([Buffer.from(checkedIn.manifest), Buffer.from(checkedIn.chunks), Buffer.from(checkedIn.vectors), Buffer.from(checkedIn.claimUnits)]);
  assert.ok(manifest.chunk_count <= INDEX_BUDGETS.max_chunks);
  assert.ok(raw.byteLength <= INDEX_BUDGETS.max_uncompressed_bytes);
  assert.ok(gzipSync(raw, { level: 9 }).byteLength <= INDEX_BUDGETS.max_compressed_bytes);
});

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1)];

test("index parse, verify and load stays within the 100 ms p95 budget (local measurement)", () => {
  const aliases = loadAliases();
  const config = loadConfig();
  const denyList = loadDenyList(PATHS.evalDenyList);
  const samples = [];
  for (let run = 0; run < 30; run += 1) {
    const started = performance.now();
    const index = verifyIndex(readIndexFiles(PATHS.evalIndex), { corpusKind: "synthetic_only" });
    createRetriever({ index, config, aliases, embedder: createSyntheticEmbedder(aliases), denyList });
    samples.push(performance.now() - started);
  }
  assert.ok(percentile(samples, 95) <= 100, `p95 ${percentile(samples, 95).toFixed(1)} ms`);
});

test("exact hybrid retrieval stays within p95 50 ms and p99 100 ms over 1,000 queries", async () => {
  const { retriever } = loadSyntheticStack();
  const questions = ["Can AHAs make my skin more sensitive to the sun?", "What is a BHA?", "How should I start using retinol?", "Do color additives need approval?", "Which ingredients should be avoided during pregnancy?", "What is niacinamide?", "Can I mix retinol and AHA?", "Is a salicylic acid acne product a cosmetic or a drug?"];
  const samples = [];
  for (let run = 0; run < 1000; run += 1) {
    const started = performance.now();
    await retriever.retrieve(questions[run % questions.length]);
    samples.push(performance.now() - started);
  }
  assert.ok(percentile(samples, 95) <= 50, `p95 ${percentile(samples, 95).toFixed(2)} ms`);
  assert.ok(percentile(samples, 99) <= 100, `p99 ${percentile(samples, 99).toFixed(2)} ms`);
});

// --- Build scripts ------------------------------------------------------------------

test("production build refuses while no source is build eligible", () => {
  const result = spawnSync(process.execPath, ["scripts/rag/build-index.ts", "production"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GEMINI_API_KEY: "" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No build-eligible sources/);
});

test("synthetic build --check and verify-index pass on the checked-in artifacts", () => {
  for (const args of [["scripts/rag/build-index.ts", "synthetic", "--check"], ["scripts/rag/verify-index.ts", "synthetic"]]) {
    const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
