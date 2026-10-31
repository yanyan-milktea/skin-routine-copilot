// Usage: node scripts/rag/verify-index.ts [synthetic|production]
// Recomputes every hash, count, dimension, norm, binding and budget. Exits non-zero on any failure.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { INDEX_BUDGETS, IndexVerificationError, verifyIndex } from "../../lib/ingredient-index.ts";
import { PATHS, readIndexFiles } from "./shared.ts";

const kind = process.argv[2] ?? "synthetic";
const dir = kind === "production" ? PATHS.productionIndex : PATHS.evalIndex;
if (!existsSync(join(dir, "manifest.json"))) {
  console.error(kind === "production" ? "No production index exists yet (no build-eligible sources)." : "Synthetic index missing. Run: node scripts/rag/build-index.ts synthetic");
  process.exit(kind === "production" ? 2 : 1);
}
try {
  const files = readIndexFiles(dir);
  const index = verifyIndex(files, { corpusKind: kind === "production" ? "production" : "synthetic_only" });
  const raw = Buffer.concat([Buffer.from(files.manifest), Buffer.from(files.chunks), Buffer.from(files.vectors), Buffer.from(files.claimUnits)]);
  const compressed = gzipSync(raw, { level: 9 }).byteLength;
  if (compressed > INDEX_BUDGETS.max_compressed_bytes) throw new IndexVerificationError("INDEX_BUDGET_COMPRESSED_BYTES_EXCEEDED");
  console.log(`${index.manifest.index_version}: OK — ${index.manifest.chunk_count} chunks, ${index.manifest.claim_unit_count} claim units, ${raw.byteLength} bytes raw, ${compressed} bytes gzip.`);
} catch (error) {
  console.error(error instanceof IndexVerificationError ? error.message : `INDEX_VERIFY_FAILED: ${(error as Error).message}`);
  process.exit(1);
}
