// Usage: node scripts/rag/normalize-snapshots.ts <fetch-dir>
// Turns a reviewed raw fetch (from the "RAG source fetch" workflow) into
// normalized Markdown snapshots in rag/sources/snapshots/, plus REVIEW.md with
// hashes, headings, chunk previews and anything a reviewer must look at.
// It does not approve anything: manifest reviews stay as they are.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDocumentHash, createDocumentId, sha256Hex, validateFetchEnvelope, validateSourceManifest } from "../../lib/ingredient-corpus.ts";
import type { SourceManifest } from "../../lib/ingredient-corpus.ts";
import { chunkDocument } from "../../lib/ingredient-chunking.ts";
import { NORMALIZER, normalizeHtml } from "../../lib/ingredient-normalize.ts";
import { FETCHER_VERSION } from "../../lib/ingredient-fetch.ts";
import { PATHS, readJson } from "./shared.ts";

const fetchDir = process.argv[2];
if (!fetchDir || !existsSync(fetchDir)) {
  console.error("Usage: node scripts/rag/normalize-snapshots.ts <fetch-dir>");
  process.exit(2);
}
const manifest = readJson(PATHS.sourceManifest) as SourceManifest;
const validation = validateSourceManifest(manifest);
if (!validation.valid) throw new Error(`Manifest invalid: ${validation.issues.map((issue) => issue.code).join(", ")}`);
mkdirSync(PATHS.snapshots, { recursive: true });

const review: string[] = [
  "# Snapshot review (FDA sources)",
  "",
  `Normalizer: ${NORMALIZER.name}@${NORMALIZER.version} · fetcher: ${FETCHER_VERSION}`,
  "",
  "Review decisions are recorded in `rag/sources/manifest.v1.json` and `rag/sources/claim-units.v1.json`, not by this script.",
  "",
];

for (const source of manifest.sources) {
  const recordPath = join(fetchDir, `${source.source_id}.fetch.json`);
  if (!existsSync(recordPath)) continue;
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const html = readFileSync(join(fetchDir, `${source.source_id}.html`), "utf8");
  if (record.source_id !== source.source_id || record.canonical_url !== source.canonical_url) throw new Error(`${source.source_id}: fetch record does not match the manifest`);
  if (record.fetcher_version !== FETCHER_VERSION) throw new Error(`${source.source_id}: fetcher version mismatch`);
  if (`sha256:${sha256Hex(html)}` !== record.raw_sha256) throw new Error(`${source.source_id}: raw HTML hash does not match the fetch record`);
  const envelope = validateFetchEnvelope(source, record.envelope);
  if (!envelope.valid) throw new Error(`${source.source_id}: ${envelope.issues.map((issue) => issue.code).join(", ")}`);

  const page = normalizeHtml(html, source.title);
  const documentHash = createDocumentHash(page.markdown);
  const front = {
    source_id: source.source_id,
    publisher: source.publisher,
    title: source.title,
    canonical_url: source.canonical_url,
    question_classes: source.question_classes.join(","),
    retrieved_at: record.retrieved_at,
    content_current_as_of: page.content_current_as_of ?? "unknown",
    raw_hash: record.raw_sha256,
    parser: `${NORMALIZER.name}@${NORMALIZER.version}`,
    fetcher: FETCHER_VERSION,
    document_hash: documentHash,
  };
  const snapshot = `---\n${Object.entries(front).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n${page.markdown}\n`;
  writeFileSync(join(PATHS.snapshots, `${source.source_id}.md`), snapshot);

  const chunks = chunkDocument({
    source_id: source.source_id,
    document_id: createDocumentId(source.source_id, page.markdown),
    document_hash: documentHash,
    publisher: source.publisher,
    title: source.title,
    canonical_url: source.canonical_url,
    retrieved_at: record.retrieved_at,
    question_classes: source.question_classes,
    normalized_text: page.markdown,
  });
  const headings = page.markdown.split("\n").filter((line) => /^#{1,4} /.test(line));
  review.push(
    `## ${source.title} (${source.question_classes.join(", ")})`,
    "",
    `- URL: ${source.canonical_url}`,
    `- Retrieved: ${record.retrieved_at} · FDA "content current as of": ${page.content_current_as_of ?? "not shown"}`,
    `- Raw HTML: ${record.envelope.content_length} bytes, \`${record.raw_sha256}\`, redirects: ${record.envelope.redirect_chain.length}`,
    `- Copyright/reuse notice candidates: ${record.notice_candidates?.length ? record.notice_candidates.join(" · ") : "none found"}`,
    `- Normalized: ${page.markdown.length} characters, ${page.block_count} blocks, \`${documentHash}\``,
    `- Unknown HTML entities: ${page.unknown_entities.length ? page.unknown_entities.join(", ") : "none"}`,
    `- Chunks: ${chunks.length} (${chunks.map((chunk) => chunk.token_estimate).join(", ")} est. tokens)`,
    "- Headings:",
    ...headings.map((heading) => `  - ${heading.replace(/^#+ /, "")}`),
    "",
  );
  console.log(`${source.source_id}: ${page.markdown.length} chars, ${chunks.length} chunks, ${documentHash}`);
}

writeFileSync(join(PATHS.snapshots, "REVIEW.md"), `${review.join("\n")}\n`);
