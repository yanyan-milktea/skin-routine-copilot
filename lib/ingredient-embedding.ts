import type { CompiledAliases } from "./ingredient-tokenizer.ts";
import { tokenize } from "./ingredient-tokenizer.ts";

export const PRODUCTION_EMBEDDING_MODEL = "gemini-embedding-2" as const;
export const SYNTHETIC_EMBEDDING_MODEL = "synthetic-concept-embedding-v1" as const;
export const EMBEDDING_DIMENSIONS = 768 as const;

export type EmbeddingTask = "retrieval_document" | "retrieval_query";

export type Embedder = {
  readonly model: string;
  readonly dimensions: number;
  readonly fixtureOnly: boolean;
  embed(texts: readonly string[], task: EmbeddingTask): Promise<Float32Array[]>;
};

export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) sum += vector[index] * vector[index];
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("EMBEDDING_ZERO_OR_NONFINITE");
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index] / norm;
  return out;
}

/** Validate a provider batch: exact count, dimension and finiteness, then L2-normalize every vector. */
export function validateEmbeddingBatch(vectors: readonly ArrayLike<number>[], expectedCount: number, dimensions: number): Float32Array[] {
  if (vectors.length !== expectedCount) throw new Error("EMBEDDING_COUNT_MISMATCH");
  return vectors.map((vector) => {
    if (vector.length !== dimensions) throw new Error("EMBEDDING_DIMENSION_MISMATCH");
    const copy = new Float32Array(dimensions);
    for (let index = 0; index < dimensions; index += 1) {
      const value = Number(vector[index]);
      if (!Number.isFinite(value)) throw new Error("EMBEDDING_NONFINITE");
      copy[index] = value;
    }
    return l2Normalize(copy);
  });
}

// ---------------------------------------------------------------------------
// Synthetic concept embedder (fixture only)
//
// A deterministic stand-in for a real embedding model so keyless CI can
// exercise vector search, the cosine answer gate, vector-only eligibility and
// RRF fusion. It maps reviewed synthetic concept groups to fixed dimensions and
// hashes every other token into the remaining dimensions. It is NOT a semantic
// model, and its cosine values say nothing about how gemini-embedding-2 will
// behave. The index verifier refuses this model for any non-synthetic corpus.
// ---------------------------------------------------------------------------

const CONCEPT_GROUPS: readonly (readonly string[])[] = [
  ["aha", "glycolic_acid", "lactic_acid"],
  ["bha", "salicylic_acid"],
  ["retinoid", "retinol"],
  ["pregnancy", "breastfeeding", "baby"],
  ["sun", "sunlight", "uv", "sunburn", "sun_sensitivity", "sunscreen", "sun_protection"],
  ["sun_sensitivity", "sensitivity", "sensitive", "photosensitivity"],
  ["sunscreen", "sun_protection", "protect", "protection", "protective", "clothing", "hat", "shade"],
  ["premarket_approval", "cosmetic_regulation", "approve", "approved", "approval", "law", "rule", "enforce", "enforcement", "permission"],
  ["color_additive", "dye", "pigment", "color"],
  ["clinician", "consult", "ask", "talk", "discuss"],
  ["irritation", "dryness", "dry", "uncomfortable", "tolerate", "tolerance"],
  ["gradual", "start", "starting", "begin", "beginning", "introduce", "introducing", "new", "first", "week"],
  ["difference", "differ", "different", "stronger", "strength", "versus", "vs", "compare", "prescription", "distinction"],
  ["what", "define", "definition", "mean", "family", "group", "type", "kind", "example"],
  ["drug", "acne", "treat", "treatment", "medicine", "intended"],
  ["cosmetic", "product", "ingredient", "formula"],
  ["avoid", "skip", "stop", "caution", "warning"],
  ["niacinamide", "vitamin", "b3"],
  ["hair", "scalp", "shampoo"],
  ["food", "diet", "eat", "eating", "drink"],
  ["routine", "change", "regimen"],
];
const CONCEPT_DIMENSIONS = 64;
const HASH_WEIGHT = 0.3;

const CONCEPT_INDEX: ReadonlyMap<string, readonly number[]> = (() => {
  const map = new Map<string, number[]>();
  CONCEPT_GROUPS.forEach((group, index) => {
    for (const token of group) map.set(token, [...(map.get(token) ?? []), index]);
  });
  return map;
})();

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function syntheticConceptVector(text: string, aliases: Pick<CompiledAliases, "phrases">): Float32Array {
  const counts = new Map<string, number>();
  for (const token of tokenize(text, aliases)) counts.set(token, (counts.get(token) ?? 0) + 1);
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  for (const [token, count] of counts) {
    const weight = 1 + Math.log(count);
    for (const concept of CONCEPT_INDEX.get(token) ?? []) vector[concept] += weight;
    const hash = fnv1a(token);
    const slot = CONCEPT_DIMENSIONS + (hash % (EMBEDDING_DIMENSIONS - CONCEPT_DIMENSIONS));
    vector[slot] += (hash & 0x80000000 ? -1 : 1) * HASH_WEIGHT * weight;
  }
  // An input with no tokens gets a fixed tiny vector so normalization stays finite.
  if (counts.size === 0) vector[EMBEDDING_DIMENSIONS - 1] = 1;
  return l2Normalize(vector);
}

export function createSyntheticEmbedder(aliases: Pick<CompiledAliases, "phrases">): Embedder {
  return Object.freeze({
    model: SYNTHETIC_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    fixtureOnly: true,
    async embed(texts: readonly string[]) {
      return texts.map((text) => syntheticConceptVector(text, aliases));
    },
  });
}

// ---------------------------------------------------------------------------
// Gemini adapter (server/offline only)
//
// Not exercised by CI and never run in Milestone 1: no source is build eligible
// and no credential is available. Request shape must be re-verified against the
// current Gemini embeddings documentation in an authorized run before the first
// real index build. The key is read by the caller from server-side env only.
// ---------------------------------------------------------------------------

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createGeminiEmbedder(options: { apiKey: string; fetch?: FetchLike; timeoutMs?: number; batchSize?: number }): Embedder {
  if (!options.apiKey) throw new Error("EMBEDDING_CREDENTIAL_MISSING");
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 8000;
  const batchSize = Math.min(Math.max(options.batchSize ?? 50, 1), 100);
  const model = PRODUCTION_EMBEDDING_MODEL;
  return Object.freeze({
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    fixtureOnly: false,
    async embed(texts: readonly string[], task: EmbeddingTask) {
      const out: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
            body: JSON.stringify({
              requests: batch.map((text) => ({
                model: `models/${model}`,
                content: { parts: [{ text }] },
                taskType: task === "retrieval_query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
                outputDimensionality: EMBEDDING_DIMENSIONS,
              })),
            }),
            signal: controller.signal,
          });
          // Redact provider details to a status class; never surface bodies or keys.
          if (!response.ok) throw new Error(`EMBEDDING_PROVIDER_HTTP_${Math.floor(response.status / 100)}XX`);
          const body = (await response.json()) as { embeddings?: { values?: unknown }[] };
          const values = Array.isArray(body?.embeddings) ? body.embeddings.map((item) => (Array.isArray(item?.values) ? (item.values as number[]) : [])) : [];
          out.push(...validateEmbeddingBatch(values, batch.length, EMBEDDING_DIMENSIONS));
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw new Error("EMBEDDING_TIMEOUT");
          if (error instanceof Error && error.message.startsWith("EMBEDDING_")) throw error;
          throw new Error("EMBEDDING_PROVIDER_ERROR");
        } finally {
          clearTimeout(timer);
        }
      }
      return out;
    },
  });
}
