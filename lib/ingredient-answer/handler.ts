import { randomUUID } from "node:crypto";
import type { QueryEmbedder, RetrievalResult } from "../ingredient-retrieval.ts";
import { createRetriever } from "../ingredient-retrieval.ts";
import type { DenyList, RetrievalConfig } from "../ingredient-retrieval.ts";
import type { LoadedIndex } from "../ingredient-index.ts";
import type { CompiledAliases } from "../ingredient-tokenizer.ts";
import { HttpError, TIMEOUTS_MS, anonymousIdentifier, assertJsonPost, assertOrigin, readJsonBody, withTimeout } from "./abuse.ts";
import type { RateLimiter, Semaphore } from "./abuse.ts";
import { CARE_TEMPLATES, LIMITATION_TEMPLATES, modelOutputJsonSchema, validateAnswerRequest, validateModelOutput, validatePublicAnswer } from "./contract.ts";
import type { AnswerStatus, CareCode, LimitationCode, PublicAnswer, PublicCitation, PublicClaim } from "./contract.ts";
import { PROMPT_VERSION, buildPrompt } from "./generate.ts";
import type { SelectionGenerator } from "./generate.ts";
import { excerptCitations, groundSelections, promptClaimUnits } from "./ground.ts";
import { careCodeForQuestion, limitationForClassification } from "./safety.ts";

// Framework-agnostic `(Request) => Response` for POST /api/ingredient-answer.
// The local Next route and the future Vercel adapter wrap the same function.

export const PRODUCTION_PUBLISHERS = Object.freeze(["FDA", "American Academy of Dermatology"]);

export type AnswerEvent = {
  trace_id: string;
  http_status: number;
  error_code: string | null;
  status: AnswerStatus | null;
  provenance: "gemini" | "deterministic_fallback" | null;
  versions: Record<string, string | null>;
  classification: { status: string; question_class: string | null; intent_ids: string[]; reason_code: string | null } | null;
  retrieval: { status: string; mode: string; evidence_chunk_ids: string[]; discovery_chunk_ids: string[]; available_claim_unit_ids: string[] } | null;
  prompt_claim_unit_ids: string[];
  selected_claim_unit_ids: string[];
  accepted_claim_unit_ids: string[];
  rejected: { claim_unit_id: string; rule: string }[];
  citation_rejections: string[];
  model_output_issue: string | null;
  care_code: CareCode | null;
  limitation_codes: LimitationCode[];
  provider_result: string;
  fallback_reason: string | null;
  durations_ms: { retrieval: number; generation: number; total: number };
};

export type AnswerHandlerOptions = {
  index: LoadedIndex;
  config: RetrievalConfig;
  aliases: CompiledAliases;
  embedder: QueryEmbedder;
  denyList?: DenyList | null;
  generator: SelectionGenerator | null;
  allowedOrigins: ReadonlySet<string>;
  rateLimiter: RateLimiter;
  rateLimitSecret: string;
  semaphore: Semaphore;
  /** Trusted client IP from the platform, or null (one global bucket). Never an attacker-chosen header. */
  clientIp: (request: Request) => string | null;
  clock?: () => number;
  traceId?: () => string;
  /** Override the Section 10.2 timeouts (tests only shorten them). */
  timeoutsMs?: Partial<typeof TIMEOUTS_MS>;
  /** Receives one privacy-safe structured event per request (no question, prompt, answer text, or IP). */
  onEvent?: (event: AnswerEvent) => void;
};

function withEmbeddingTimeout(embedder: QueryEmbedder, ms: number): QueryEmbedder {
  return {
    model: embedder.model,
    dimensions: embedder.dimensions,
    embed: (texts, task) => withTimeout(ms, "EMBEDDING_TIMEOUT", () => embedder.embed(texts, task)),
  };
}

function corsHeaders(origin: string | null, preflight = false): Headers {
  const headers = new Headers({ Vary: "Origin", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    if (preflight) {
      headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type");
      headers.set("Access-Control-Max-Age", "600");
    }
  }
  return headers;
}

export function createAnswerHandler(options: AnswerHandlerOptions): (request: Request) => Promise<Response> {
  const clock = options.clock ?? (() => Date.now());
  const timeouts = { ...TIMEOUTS_MS, ...options.timeoutsMs };
  const nextTraceId = options.traceId ?? (() => randomUUID());
  const allowedPublishers = new Set(options.index.manifest.corpus_kind === "production" ? PRODUCTION_PUBLISHERS : options.index.manifest.sources.map((source) => source.publisher));
  if (options.index.manifest.corpus_kind === "production" && options.index.manifest.sources.some((source) => !allowedPublishers.has(source.publisher))) {
    throw new Error("ANSWER_HANDLER_PUBLISHER_NOT_ALLOWED");
  }
  if (!options.rateLimitSecret || options.rateLimitSecret.length < 32) throw new Error("ANSWER_HANDLER_RATE_LIMIT_SECRET_MISSING");
  const retriever = createRetriever({
    index: options.index,
    config: options.config,
    aliases: options.aliases,
    embedder: withEmbeddingTimeout(options.embedder, timeouts.embedding),
    denyList: options.denyList ?? null,
    traceId: nextTraceId,
  });
  const versions = {
    corpus_version: options.index.manifest.corpus_version,
    index_version: options.index.manifest.index_version,
    claim_units_version: options.index.manifest.claim_units_sha256,
    prompt_version: PROMPT_VERSION,
    generation_model: options.generator ? `${options.generator.provider}:${options.generator.model}` : null,
  };

  return async function handle(request: Request): Promise<Response> {
    const started = clock();
    const event: AnswerEvent = {
      trace_id: nextTraceId(), http_status: 0, error_code: null, status: null, provenance: null, versions, classification: null, retrieval: null,
      prompt_claim_unit_ids: [], selected_claim_unit_ids: [], accepted_claim_unit_ids: [], rejected: [], citation_rejections: [], model_output_issue: null,
      care_code: null, limitation_codes: [], provider_result: "not_called", fallback_reason: null, durations_ms: { retrieval: 0, generation: 0, total: 0 },
    };
    const emit = (response: Response) => {
      event.http_status = response.status;
      event.durations_ms.total = Math.max(0, clock() - started);
      try { options.onEvent?.(event); } catch { /* observability must not break the response */ }
      return response;
    };

    let origin: string | null = null;
    try {
      origin = assertOrigin(request, options.allowedOrigins);
      if (request.method === "OPTIONS") return emit(new Response(null, { status: 204, headers: corsHeaders(origin, true) }));
      assertJsonPost(request);
      const parsed = validateAnswerRequest(await readJsonBody(request));
      if (!parsed.ok) throw new HttpError(400, parsed.code);
      await options.rateLimiter.check(anonymousIdentifier(options.rateLimitSecret, options.clientIp(request), clock()), clock());

      const answer = await withTimeout(timeouts.total, "HANDLER_TIMEOUT", (signal) => answerQuestion(parsed.value.question, signal));
      const issues = validatePublicAnswer(answer, allowedPublishers);
      if (issues.length) throw new HttpError(500, `PUBLIC_SCHEMA_${issues[0]}`);
      event.status = answer.status;
      event.provenance = answer.provenance.source;
      return emit(Response.json(answer, { status: 200, headers: corsHeaders(origin) }));
    } catch (error) {
      const http = error instanceof HttpError ? error : new HttpError(500, error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "INTERNAL_ERROR");
      event.error_code = http.code;
      const headers = corsHeaders(http.status === 403 ? null : origin);
      if (http.retryAfterSeconds) headers.set("Retry-After", String(http.retryAfterSeconds));
      return emit(Response.json({ error: http.code }, { status: http.status, headers }));
    }

    async function answerQuestion(question: string, signal: AbortSignal): Promise<PublicAnswer> {
      const careCode = careCodeForQuestion(question);
      const retrievalStarted = clock();
      const retrieval: RetrievalResult = await retriever.retrieve(question);
      event.durations_ms.retrieval = Math.max(0, clock() - retrievalStarted);
      event.classification = {
        status: retrieval.trace.classification.status,
        question_class: retrieval.question_class,
        intent_ids: retrieval.intent_ids,
        reason_code: retrieval.trace.classification.reason_code,
      };
      event.retrieval = {
        status: retrieval.status,
        mode: retrieval.trace.mode,
        evidence_chunk_ids: retrieval.evidence.map((chunk) => chunk.chunk_id),
        discovery_chunk_ids: retrieval.discovery.map((chunk) => chunk.chunk_id),
        available_claim_unit_ids: retrieval.available_claim_unit_ids,
      };
      const blockedCare: CareCode | null = careCode ?? (retrieval.trace.classification.blocked_families.includes("personal_medical") ? "CONSULT_DERMATOLOGIST" : null);
      const build = (status: AnswerStatus, source: PublicAnswer["provenance"]["source"], claims: PublicClaim[], citations: PublicCitation[], answer: string, limitationCodes: LimitationCode[]): PublicAnswer => {
        event.care_code = blockedCare;
        event.limitation_codes = limitationCodes;
        return {
          schema_version: 1,
          status,
          answer,
          claims,
          citations,
          limitations: limitationCodes.map((code) => LIMITATION_TEMPLATES[code]),
          care_guidance: blockedCare ? CARE_TEMPLATES[blockedCare] : null,
          provenance: { source, trace_id: event.trace_id, corpus_version: versions.corpus_version, index_version: versions.index_version, claim_units_version: versions.claim_units_version, schema_version: 1 },
        };
      };
      const excerpts = (chunks: RetrievalResult["evidence"]) => {
        const built = excerptCitations(chunks, { index: options.index, allowedPublishers });
        event.citation_rejections.push(...built.rejections);
        return built.citations;
      };
      const fallback = (reason: string, chunks: RetrievalResult["evidence"]) => {
        event.fallback_reason = reason;
        return build("fallback", "deterministic_fallback", [], excerpts(chunks), "", ["PROVIDER_UNAVAILABLE"]);
      };

      if (retrieval.status === "lexical_only_discovery") return fallback(retrieval.trace.fallback_reason ?? "EMBEDDING_FAILED", retrieval.discovery);
      if (retrieval.status === "discovery") return build("insufficient", "deterministic_fallback", [], excerpts(retrieval.discovery), "", ["NO_ELIGIBLE_EVIDENCE"]);
      if (retrieval.status === "insufficient") {
        if (retrieval.trace.fallback_reason) return fallback(retrieval.trace.fallback_reason, []);
        const limitation = limitationForClassification(retrieval.trace.classification) ?? "NO_ELIGIBLE_EVIDENCE";
        return build("insufficient", "deterministic_fallback", [], [], "", [limitation]);
      }

      // Eligible evidence with at least one available claim unit.
      const evidenceIds = new Set(retrieval.evidence.map((chunk) => chunk.chunk_id));
      const units = promptClaimUnits(options.index, retrieval.available_claim_unit_ids, evidenceIds);
      event.prompt_claim_unit_ids = units.map((unit) => unit.claim_unit_id);
      if (units.length === 0) return build("insufficient", "deterministic_fallback", [], excerpts(retrieval.evidence), "", ["NO_ELIGIBLE_EVIDENCE"]);
      if (!options.generator) return fallback("GENERATION_NOT_CONFIGURED", retrieval.evidence);

      let release: (() => void) | null = null;
      try {
        release = await options.semaphore.acquire();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(429, "CONCURRENCY_LIMIT", 1);
      }
      let raw: unknown;
      const generationStarted = clock();
      try {
        const prompt = buildPrompt({ question, evidence: retrieval.evidence, claimUnits: units });
        raw = await withTimeout(timeouts.generation, "GENERATION_TIMEOUT", (generationSignal) => options.generator!.select({ ...prompt, schema: modelOutputJsonSchema(units.map((unit) => unit.claim_unit_id)), signal: generationSignal }), signal);
        event.provider_result = "ok";
      } catch (error) {
        const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "GENERATION_FAILED";
        event.provider_result = code;
        return fallback(code, retrieval.evidence);
      } finally {
        event.durations_ms.generation = Math.max(0, clock() - generationStarted);
        release();
      }

      const output = validateModelOutput(raw);
      if (!output.ok) {
        event.model_output_issue = output.code;
        return fallback("MODEL_OUTPUT_INVALID", retrieval.evidence);
      }
      event.selected_claim_unit_ids = output.value.selected_claim_unit_ids;
      const grounded = groundSelections(output.value.selected_claim_unit_ids, {
        index: options.index,
        questionClass: retrieval.question_class!,
        intentIds: retrieval.intent_ids,
        availableIds: new Set(units.map((unit) => unit.claim_unit_id)),
        evidenceIds,
        allowedPublishers,
      });
      event.accepted_claim_unit_ids = grounded.accepted.map((unit) => unit.claim_unit_id);
      event.rejected = grounded.rejected;
      event.citation_rejections.push(...grounded.citationRejections);
      if (grounded.claims.length === 0) return build("insufficient", "gemini", [], [], "", ["NO_ELIGIBLE_EVIDENCE"]);
      if (grounded.uncoveredIntentIds.length) return build("partial", "gemini", grounded.claims, grounded.citations, grounded.answer, ["PARTIAL_EVIDENCE"]);
      return build("supported", "gemini", grounded.claims, grounded.citations, grounded.answer, []);
    }
  };
}
