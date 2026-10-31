// Node-only helpers shared by the RAG build/verify scripts and tests.
// Pure retrieval logic lives in lib/; this file only touches the filesystem.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../lib/ingredient-corpus.ts";
import { createSyntheticEmbedder } from "../../lib/ingredient-embedding.ts";
import { buildIndex, verifyIndex } from "../../lib/ingredient-index.ts";
import type { BuildDocumentInput, ClaimUnitSource, IndexFiles, LoadedIndex } from "../../lib/ingredient-index.ts";
import { createRetriever, validateDenyList, validateRetrievalConfig } from "../../lib/ingredient-retrieval.ts";
import type { DenyList, RetrievalConfig, Retriever } from "../../lib/ingredient-retrieval.ts";
import { compileAliases } from "../../lib/ingredient-tokenizer.ts";
import type { CompiledAliases } from "../../lib/ingredient-tokenizer.ts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const PATHS = Object.freeze({
  config: join(ROOT, "rag/retrieval/config.v1.json"),
  aliases: join(ROOT, "rag/retrieval/aliases.v1.json"),
  productionDenyList: join(ROOT, "rag/retrieval/deny-list.v1.json"),
  sourceManifest: join(ROOT, "rag/sources/manifest.v1.json"),
  snapshots: join(ROOT, "rag/sources/snapshots"),
  productionIndex: join(ROOT, "rag/index/v1"),
  evalRoot: join(ROOT, "evals/ingredient-rag/v1"),
  evalCorpus: join(ROOT, "evals/ingredient-rag/v1/corpus"),
  evalClaimUnits: join(ROOT, "evals/ingredient-rag/v1/claim-units.source.json"),
  evalIndex: join(ROOT, "evals/ingredient-rag/v1/index"),
  evalDenyList: join(ROOT, "evals/ingredient-rag/v1/deny-list.json"),
  evalCases: join(ROOT, "evals/ingredient-rag/v1/cases.jsonl"),
  evalManifest: join(ROOT, "evals/ingredient-rag/v1/manifest.json"),
});

export const SYNTHETIC_PUBLISHER = "Synthetic Test Publisher";
export const SYNTHETIC_CORPUS_VERSION = "synthetic-retrieval-v1";
export const SYNTHETIC_INDEX_VERSION = "ingredient-rag-index-synthetic-retrieval-v1";
export const SYNTHETIC_BUILT_AT = "2026-10-31T00:00:00Z";

export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function loadAliases(): CompiledAliases {
  return compileAliases(readJson(PATHS.aliases));
}

export function loadConfig(): RetrievalConfig {
  return validateRetrievalConfig(readJson(PATHS.config));
}

export function loadDenyList(path: string): DenyList {
  return validateDenyList(readJson(path));
}

export type CorpusDocument = { key: string; markdown: string; input: BuildDocumentInput };

export function syntheticSourceId(key: string, canonicalUrl: string): string {
  return `syn_${key.replace(/[^a-z0-9]+/g, "_")}_${sha256Hex(canonicalUrl).slice(0, 8)}`;
}

/** Parse a corpus Markdown file with a minimal `key: value` front matter block. */
export function parseCorpusMarkdown(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n?/g, "\n"));
  if (!match) throw new Error("CORPUS_FRONT_MATTER_MISSING");
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`CORPUS_FRONT_MATTER_INVALID: ${line}`);
    meta[pair[1]] = pair[2].trim();
  }
  return { meta, body: match[2] };
}

export function loadSyntheticCorpus(): { documents: CorpusDocument[]; claimUnits: ClaimUnitSource[]; sourceIdByKey: Map<string, string> } {
  const documents: CorpusDocument[] = [];
  const sourceIdByKey = new Map<string, string>();
  for (const file of readdirSync(PATHS.evalCorpus).filter((name) => name.endsWith(".md")).sort()) {
    const { meta, body } = parseCorpusMarkdown(readFileSync(join(PATHS.evalCorpus, file), "utf8"));
    const required = ["key", "title", "canonical_url", "question_classes", "retrieved_at"];
    if (Object.keys(meta).sort().join(",") !== [...required].sort().join(",")) throw new Error(`CORPUS_FRONT_MATTER_KEYS: ${file}`);
    if (`${meta.key}.md` !== file) throw new Error(`CORPUS_KEY_FILENAME_MISMATCH: ${file}`);
    if (!/^https:\/\/[a-z0-9-]+\.fixture\.invalid\//.test(meta.canonical_url)) throw new Error(`CORPUS_URL_NOT_SYNTHETIC: ${file}`);
    const classes = meta.question_classes ? meta.question_classes.split(",").map((item) => item.trim()) : [];
    for (const item of classes) if (!/^Q[1-5]$/.test(item)) throw new Error(`CORPUS_CLASS_INVALID: ${file}`);
    const sourceId = syntheticSourceId(meta.key, meta.canonical_url);
    sourceIdByKey.set(meta.key, sourceId);
    documents.push({
      key: meta.key,
      markdown: body,
      input: {
        source_id: sourceId,
        publisher: SYNTHETIC_PUBLISHER,
        title: meta.title,
        canonical_url: meta.canonical_url,
        retrieved_at: meta.retrieved_at,
        question_classes: classes,
        normalized_text: body,
      },
    });
  }
  const raw = readJson(PATHS.evalClaimUnits) as { review: ClaimUnitSource["review"]; claim_units: (Omit<ClaimUnitSource, "support" | "review"> & { support: { doc: string; section: string }[] })[] };
  const claimUnits: ClaimUnitSource[] = raw.claim_units.map((unit) => ({
    question_class: unit.question_class,
    supported_intent_ids: unit.supported_intent_ids,
    canonical_claim_text: unit.canonical_claim_text,
    enabled: unit.enabled,
    review: raw.review,
    support: unit.support.map((reference) => {
      const sourceId = sourceIdByKey.get(reference.doc);
      if (!sourceId) throw new Error(`CLAIM_UNIT_UNKNOWN_DOC: ${reference.doc}`);
      return { source_id: sourceId, section: reference.section };
    }),
  }));
  return { documents, claimUnits, sourceIdByKey };
}

export async function buildSyntheticIndex(): Promise<IndexFiles> {
  const aliases = loadAliases();
  const { documents, claimUnits } = loadSyntheticCorpus();
  return buildIndex({
    corpusVersion: SYNTHETIC_CORPUS_VERSION,
    corpusKind: "synthetic_only",
    indexVersion: SYNTHETIC_INDEX_VERSION,
    builtAt: SYNTHETIC_BUILT_AT,
    documents: documents.map((document) => document.input),
    claimUnits,
    embedder: createSyntheticEmbedder(aliases),
  });
}

const FILE_NAMES = Object.freeze({ manifest: "manifest.json", chunks: "chunks.json", vectors: "vectors.f32", claimUnits: "claim-units.json" });

export function readIndexFiles(dir: string): IndexFiles {
  return {
    manifest: readFileSync(join(dir, FILE_NAMES.manifest), "utf8"),
    chunks: readFileSync(join(dir, FILE_NAMES.chunks), "utf8"),
    vectors: new Uint8Array(readFileSync(join(dir, FILE_NAMES.vectors))),
    claimUnits: readFileSync(join(dir, FILE_NAMES.claimUnits), "utf8"),
  };
}

export function writeIndexFiles(dir: string, files: IndexFiles): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE_NAMES.manifest), files.manifest);
  writeFileSync(join(dir, FILE_NAMES.chunks), files.chunks);
  writeFileSync(join(dir, FILE_NAMES.vectors), files.vectors);
  writeFileSync(join(dir, FILE_NAMES.claimUnits), files.claimUnits);
}

export function sameFiles(a: IndexFiles, b: IndexFiles): boolean {
  return a.manifest === b.manifest && a.chunks === b.chunks && a.claimUnits === b.claimUnits && Buffer.compare(Buffer.from(a.vectors), Buffer.from(b.vectors)) === 0;
}

export type SyntheticStack = { index: LoadedIndex; aliases: CompiledAliases; config: RetrievalConfig; denyList: DenyList; retriever: Retriever };

/** Load and verify the checked-in synthetic index, then build a retriever with the fixture embedder. */
export function loadSyntheticStack(options: { config?: RetrievalConfig; failEmbedding?: boolean; denyList?: DenyList } = {}): SyntheticStack {
  const aliases = loadAliases();
  const config = options.config ?? loadConfig();
  const index = verifyIndex(readIndexFiles(PATHS.evalIndex), { corpusKind: "synthetic_only" });
  const denyList = options.denyList ?? loadDenyList(PATHS.evalDenyList);
  const synthetic = createSyntheticEmbedder(aliases);
  const embedder = options.failEmbedding
    ? { model: synthetic.model, dimensions: synthetic.dimensions, async embed(): Promise<Float32Array[]> { throw new Error("EMBEDDING_PROVIDER_ERROR"); } }
    : synthetic;
  const retriever = createRetriever({ index, config, aliases, embedder, denyList, traceId: () => "trace-fixed" });
  return { index, aliases, config, denyList, retriever };
}
