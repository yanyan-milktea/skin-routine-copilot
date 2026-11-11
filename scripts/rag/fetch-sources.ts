// Usage: node scripts/rag/fetch-sources.ts <output-dir>
// Fetches every source approved for snapshot storage and writes, per source,
// the raw HTML, a fetch record, and contrary-notice candidates, plus a summary.
// Manual review step only: nothing here changes the manifest or the index.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchSource, findNoticeCandidates, sourcesToFetch, SourceFetchError } from "../../lib/ingredient-fetch.ts";
import type { FetchLike } from "../../lib/ingredient-fetch.ts";
import type { SourceManifest } from "../../lib/ingredient-corpus.ts";
import { PATHS, readJson } from "./shared.ts";

const outDir = process.argv[2];
if (!outDir) {
  console.error("Usage: node scripts/rag/fetch-sources.ts <output-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const manifest = readJson(PATHS.sourceManifest) as SourceManifest;
const sources = sourcesToFetch(manifest);
const summary: string[] = ["# Source fetch for corpus review", "", `Fetched at: ${new Date().toISOString()}`, `Manifest corpus version: ${manifest.corpus_version}`, ""];
let failures = 0;

for (const source of sources) {
  summary.push(`## ${source.title}`, "", `- Source: \`${source.source_id}\` (${source.publisher})`, `- URL: ${source.canonical_url}`);
  try {
    const { record, body } = await fetchSource(source, fetch as unknown as FetchLike);
    const html = new TextDecoder().decode(body);
    const notices = findNoticeCandidates(html);
    writeFileSync(join(outDir, `${source.source_id}.html`), body);
    writeFileSync(join(outDir, `${source.source_id}.fetch.json`), `${JSON.stringify({ ...record, notice_candidates: notices }, null, 2)}\n`);
    summary.push(`- Result: fetched, ${record.envelope.content_length} bytes, redirects: ${record.envelope.redirect_chain.length ? record.envelope.redirect_chain.join(" → ") : "none"}`, `- Raw hash: \`${record.raw_sha256}\``, `- Copyright/reuse notice candidates (${notices.length}):`);
    for (const notice of notices) summary.push(`  - ${notice}`);
  } catch (error) {
    failures += 1;
    const code = error instanceof SourceFetchError ? error.code : "UNEXPECTED";
    summary.push(`- Result: **failed** \`${code}\`: ${error instanceof Error ? error.message : String(error)}`);
  }
  summary.push("");
}

summary.push(`Sources excluded (no snapshot-storage approval): ${manifest.sources.filter((s) => !sources.includes(s)).map((s) => s.title).join("; ") || "none"}`);
writeFileSync(join(outDir, "SUMMARY.md"), `${summary.join("\n")}\n`);
console.log(summary.join("\n"));
process.exit(failures ? 1 : 0);
