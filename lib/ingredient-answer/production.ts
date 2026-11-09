import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createGeminiEmbedder } from "../ingredient-embedding.ts";
import { verifyIndex } from "../ingredient-index.ts";
import { validateDenyList, validateRetrievalConfig } from "../ingredient-retrieval.ts";
import { compileAliases } from "../ingredient-tokenizer.ts";
import { MemoryRateLimitStore, createRateLimiter, createSemaphore, parseAllowedOrigins } from "./abuse.ts";
import { createGeminiSelectionGenerator } from "./generate.ts";
import { createAnswerHandler } from "./handler.ts";

// Production wiring for the ingredient answer endpoint. It fails closed: any
// missing artifact, secret, or durable rate-limit store means "unavailable".

export const SITES_ORIGIN = "https://skin-routine-copilot.gogogoyan.chatgpt.site";

export class AnswerUnavailableError extends Error {}

/**
 * Builds the handler from `rag/index/v1` and server-only environment. Milestone 2a
 * has no build-eligible corpus and no distributed rate-limit store, so in practice
 * this throws AnswerUnavailableError and the route returns 503.
 */
export async function loadProductionAnswerHandler(root: string, env: Record<string, string | undefined>) {
  const read = (path: string) => readFile(join(root, path));
  let files;
  try {
    files = {
      manifest: (await read("rag/index/v1/manifest.json")).toString("utf8"),
      chunks: (await read("rag/index/v1/chunks.json")).toString("utf8"),
      vectors: new Uint8Array(await read("rag/index/v1/vectors.f32")),
      claimUnits: (await read("rag/index/v1/claim-units.json")).toString("utf8"),
    };
  } catch {
    throw new AnswerUnavailableError("PRODUCTION_INDEX_MISSING");
  }
  const index = verifyIndex(files, { corpusKind: "production", queryEmbeddingModel: "gemini-embedding-2" });
  if (!env.GEMINI_API_KEY) throw new AnswerUnavailableError("PROVIDER_CREDENTIAL_MISSING");
  if (!env.INGREDIENT_RATE_LIMIT_SECRET || env.INGREDIENT_RATE_LIMIT_SECRET.length < 32) throw new AnswerUnavailableError("RATE_LIMIT_SECRET_MISSING");
  // An in-memory store is per-instance and does not satisfy the distributed limit in Section 10.2.
  if (env.INGREDIENT_RATE_LIMIT_STORE !== "memory-dev-only") throw new AnswerUnavailableError("RATE_LIMIT_STORE_NOT_CONFIGURED");
  return createAnswerHandler({
    index,
    config: validateRetrievalConfig(JSON.parse((await read("rag/retrieval/config.v1.json")).toString("utf8"))),
    aliases: compileAliases(JSON.parse((await read("rag/retrieval/aliases.v1.json")).toString("utf8"))),
    denyList: validateDenyList(JSON.parse((await read("rag/retrieval/deny-list.v1.json")).toString("utf8"))),
    embedder: createGeminiEmbedder({ apiKey: env.GEMINI_API_KEY, timeoutMs: 2000 }),
    generator: createGeminiSelectionGenerator({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }),
    allowedOrigins: parseAllowedOrigins([SITES_ORIGIN, env.ALLOWED_ORIGINS]),
    rateLimiter: createRateLimiter(new MemoryRateLimitStore()),
    rateLimitSecret: env.INGREDIENT_RATE_LIMIT_SECRET,
    semaphore: createSemaphore(),
    clientIp: (request) => (env.VERCEL ? request.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim() || null : null),
  });
}
