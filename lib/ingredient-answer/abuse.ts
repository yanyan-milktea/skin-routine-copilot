import { createHmac } from "node:crypto";

// Abuse controls (design Section 10.2). CORS is not an abuse control: Origin is
// enforced server-side before any body read, retrieval, or provider call.

export const MAX_BODY_BYTES = 8 * 1024;
export const RATE_LIMIT = Object.freeze({ perMinute: 10, perDay: 60 });
export const CONCURRENCY = Object.freeze({ maxActive: 4, acquireTimeoutMs: 250 });
export const TIMEOUTS_MS = Object.freeze({ embedding: 2000, generation: 8000, total: 10000 });

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;
  constructor(status: number, code: string, retryAfterSeconds?: number) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Exact https origins (no wildcard, no reflection). Malformed entries are dropped. */
export function parseAllowedOrigins(values: readonly (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    for (const entry of (value ?? "").split(",")) {
      const candidate = entry.trim().replace(/\/+$/, "");
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
        if ((url.protocol === "https:" || local) && url.origin === candidate) out.add(candidate);
      } catch { /* ignore */ }
    }
  }
  return out;
}

/** Missing, `null`, malformed, or unlisted Origin is rejected with 403. */
export function assertOrigin(request: Request, allowed: ReadonlySet<string>): string {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || !allowed.has(origin)) throw new HttpError(403, "ORIGIN_NOT_ALLOWED");
  return origin;
}

export function assertJsonPost(request: Request): void {
  if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
  const type = (request.headers.get("content-type") ?? "").toLowerCase().replace(/\s+/g, "");
  if (type !== "application/json" && type !== "application/json;charset=utf-8") throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  const encoding = (request.headers.get("content-encoding") ?? "identity").toLowerCase().trim();
  if (encoding !== "identity") throw new HttpError(415, "COMPRESSED_BODY_REJECTED");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new HttpError(413, "BODY_TOO_LARGE");
}

/** Streams the body with a hard 8 KiB ceiling regardless of Content-Length, then parses JSON. */
export async function readJsonBody(request: Request, limit = MAX_BODY_BYTES): Promise<unknown> {
  if (!request.body) throw new HttpError(400, "BODY_MISSING");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "BODY_TOO_LARGE");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new HttpError(400, "BODY_NOT_UTF8"); }
  try { return JSON.parse(text); } catch { throw new HttpError(400, "BODY_NOT_JSON"); }
}

// --- Rate limiting -------------------------------------------------------------

/** Storage behind the limiter. Production needs a distributed implementation (Milestone 2b). */
export interface RateLimitStore {
  /** Atomically increments `key` and returns the new count; the counter expires after `ttlSeconds`. */
  increment(key: string, ttlSeconds: number, nowMs: number): Promise<number>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();
  async increment(key: string, ttlSeconds: number, nowMs: number): Promise<number> {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= nowMs) {
      this.entries.set(key, { count: 1, expiresAt: nowMs + ttlSeconds * 1000 });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }
}

/**
 * Privacy-preserving identifier: first 128 bits of HMAC-SHA256(secret, utcDate || ip).
 * A missing trusted IP uses one global conservative bucket; the raw IP is never stored.
 */
export function anonymousIdentifier(secret: string, clientIp: string | null, nowMs: number): string {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  if (!clientIp) return `global:${date}`;
  return createHmac("sha256", secret).update(`${date}|${clientIp}`).digest("hex").slice(0, 32);
}

export type RateLimiter = { check(identifier: string, nowMs: number): Promise<void> };

/** Fixed-window counters: 10 per minute and 60 per UTC day per identifier. Throws 429 with Retry-After. */
export function createRateLimiter(store: RateLimitStore, limits: { perMinute: number; perDay: number } = RATE_LIMIT): RateLimiter {
  return {
    async check(identifier, nowMs) {
      const minute = Math.floor(nowMs / 60000);
      const day = new Date(nowMs).toISOString().slice(0, 10);
      const perMinute = await store.increment(`m:${identifier}:${minute}`, 120, nowMs);
      if (perMinute > limits.perMinute) throw new HttpError(429, "RATE_LIMIT_MINUTE", Math.max(1, 60 - Math.floor((nowMs % 60000) / 1000)));
      const perDay = await store.increment(`d:${identifier}:${day}`, 48 * 3600, nowMs);
      if (perDay > limits.perDay) throw new HttpError(429, "RATE_LIMIT_DAY", 3600);
    },
  };
}

// --- Concurrency -------------------------------------------------------------

export type Semaphore = { acquire(timeoutMs?: number): Promise<() => void>; readonly active: number };

/** At most `max` active generations; a waiter that cannot get a slot within the timeout gets 429 (no unbounded queue). */
export function createSemaphore(max = CONCURRENCY.maxActive): Semaphore {
  let active = 0;
  const waiters: (() => void)[] = [];
  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };
  return {
    get active() { return active; },
    acquire(timeoutMs = CONCURRENCY.acquireTimeoutMs) {
      if (active < max) { active += 1; return Promise.resolve(release); }
      return new Promise((resolve, reject) => {
        const grant = () => { clearTimeout(timer); active += 1; resolve(release); };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(grant);
          if (index >= 0) waiters.splice(index, 1);
          reject(new HttpError(429, "CONCURRENCY_LIMIT", 1));
        }, timeoutMs);
        waiters.push(grant);
      });
    },
  };
}

/** Runs `work` with an abort signal that fires after `ms` or when `parent` aborts. Rejects with `code` on timeout. */
export async function withTimeout<T>(ms: number, code: string, work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const onParent = () => controller.abort();
  parent?.addEventListener("abort", onParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(code)); }, ms); }),
      ...(parent ? [new Promise<never>((_, reject) => { if (parent.aborted) reject(new Error(code)); parent.addEventListener("abort", () => reject(new Error(code)), { once: true }); })] : []),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  }
}
