// Usage:
//   node scripts/rag/build-index.ts synthetic          rebuild the synthetic eval index
//   node scripts/rag/build-index.ts synthetic --check  fail if a fresh build differs from the checked-in artifacts
//   node scripts/rag/build-index.ts production         build the production index (requires eligible sources + key)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSourceAvailability, validateSourceManifest } from "../../lib/ingredient-corpus.ts";
import type { SourceManifest } from "../../lib/ingredient-corpus.ts";
import { verifyIndex } from "../../lib/ingredient-index.ts";
import { PATHS, buildSyntheticIndex, readIndexFiles, readJson, sameFiles, writeIndexFiles } from "./shared.ts";

const [mode, flag] = process.argv.slice(2);

if (mode === "synthetic") {
  const files = await buildSyntheticIndex();
  verifyIndex(files, { corpusKind: "synthetic_only" });
  if (flag === "--check") {
    if (!existsSync(join(PATHS.evalIndex, "manifest.json")) || !sameFiles(files, readIndexFiles(PATHS.evalIndex))) {
      console.error("Synthetic index is stale or not reproducible. Run: node scripts/rag/build-index.ts synthetic");
      process.exit(1);
    }
    console.log("Synthetic index matches a fresh deterministic build.");
  } else {
    writeIndexFiles(PATHS.evalIndex, files);
    const manifest = JSON.parse(files.manifest);
    console.log(`Wrote ${manifest.index_version}: ${manifest.chunk_count} chunks, ${manifest.claim_unit_count} claim units.`);
  }
} else if (mode === "production") {
  const manifest = readJson(PATHS.sourceManifest) as SourceManifest;
  const validation = validateSourceManifest(manifest);
  if (!validation.valid) {
    console.error(`Source manifest invalid: ${validation.issues.map((issue) => issue.code).join(", ")}`);
    process.exit(1);
  }
  const now = new Date();
  const eligible = manifest.sources.filter((source) =>
    source.retrieval_policy === "include" &&
    source.corpus_review.decision === "approved" &&
    source.snapshot_storage_review.decision === "approved" &&
    !source.emergency_disabled &&
    getSourceAvailability(source, now) === "available" &&
    existsSync(join(PATHS.snapshots, `${source.source_id}.md`)));
  if (eligible.length === 0) {
    console.error(
      "No build-eligible sources: every manifest entry is excluded pending exact-page review (FDA Q1/Q2/Q4) " +
      "or written permission (AAD Q3/Q5). The production index was not built.",
    );
    process.exit(2);
  }
  // Reaching here requires a reviewed snapshot set and an authorized embedding run; both are out of scope for Milestone 1.
  console.error("Production builds require an authorized embedding run (GEMINI_API_KEY, server-side only) and are not enabled in Milestone 1.");
  process.exit(2);
} else {
  console.error("Usage: node scripts/rag/build-index.ts <synthetic [--check] | production>");
  process.exit(1);
}
