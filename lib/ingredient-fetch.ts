// Offline source fetching for corpus review (design §4.4, steps 1–4).
// Runs only from a manual review workflow; never on a user request.
import { APPROVED_SOURCE_URLS, MAX_SOURCE_RESPONSE_BYTES, sha256Hex, validateFetchEnvelope, validateSourceManifest } from "./ingredient-corpus.ts";
import type { FetchEnvelope, SourceManifest, SourceManifestEntry } from "./ingredient-corpus.ts";

export const FETCHER_VERSION = "ingredient-fetcher-v1" as const;
export const FETCH_USER_AGENT = "SkinRoutineCopilot-CorpusReview/1.0 (+https://github.com/yanyan-milktea/skin-routine-copilot)";
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 3;

export type FetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}>;

export type FetchedSource = {
  fetcher_version: typeof FETCHER_VERSION;
  source_id: string;
  publisher: SourceManifestEntry["publisher"];
  canonical_url: string;
  retrieved_at: string;
  http_status: number;
  envelope: FetchEnvelope;
  raw_sha256: string;
};

export class SourceFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Sources that may be fetched for review: snapshot storage approved, not
 * emergency-disabled, exact URL on the allow-list. Corpus approval comes after
 * review, so it is not required here. AAD sources stay out (no permission).
 */
export function sourcesToFetch(manifest: SourceManifest): SourceManifestEntry[] {
  const validation = validateSourceManifest(manifest);
  if (!validation.valid) throw new SourceFetchError("INVALID_MANIFEST", validation.issues.map((issue) => issue.code).join(", "));
  return manifest.sources.filter((source) =>
    source.snapshot_storage_review.decision === "approved" &&
    !source.emergency_disabled &&
    APPROVED_SOURCE_URLS[source.canonical_url]?.publisher === source.publisher);
}

async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new SourceFetchError("SOURCE_TOO_LARGE", `Response exceeds ${limit} bytes.`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function checkHop(source: SourceManifestEntry, url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new SourceFetchError("UNSAFE_REDIRECT", "Redirect target is not a URL."); }
  if (parsed.protocol !== "https:") throw new SourceFetchError("UNSAFE_REDIRECT", "Every hop must use HTTPS.");
  if (!source.allowed_hosts.includes(parsed.hostname)) throw new SourceFetchError("CROSS_HOST_REDIRECT", `Host ${parsed.hostname} is not allowed for this source.`);
  if (parsed.username || parsed.password || parsed.port) throw new SourceFetchError("UNSAFE_REDIRECT", "Credentials or ports are not allowed.");
}

/** Fetches exactly one approved source with manual, same-host, HTTPS-only redirects and a byte cap. */
export async function fetchSource(source: SourceManifestEntry, fetchImpl: FetchLike, now: () => Date = () => new Date(), timeoutMs = FETCH_TIMEOUT_MS): Promise<{ record: FetchedSource; body: Uint8Array }> {
  if (!APPROVED_SOURCE_URLS[source.canonical_url]) throw new SourceFetchError("UNAPPROVED_URL", "Source URL is not on the approved list.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const redirectChain: string[] = [];
  let url = source.canonical_url;
  try {
    for (let hop = 0; ; hop += 1) {
      checkHop(source, url);
      let response;
      try {
        response = await fetchImpl(url, { redirect: "manual", signal: controller.signal, headers: { "User-Agent": FETCH_USER_AGENT, Accept: "text/html" } });
      } catch (error) {
        if (controller.signal.aborted) throw new SourceFetchError("FETCH_TIMEOUT", `No response within ${timeoutMs} ms.`);
        throw new SourceFetchError("FETCH_FAILED", error instanceof Error ? error.message : "Network error.");
      }
      if (response.status >= 300 && response.status < 400) {
        if (hop >= MAX_REDIRECTS) throw new SourceFetchError("TOO_MANY_REDIRECTS", "Redirect limit reached.");
        const location = response.headers.get("location");
        if (!location) throw new SourceFetchError("UNSAFE_REDIRECT", "Redirect without a location.");
        url = new URL(location, url).toString();
        redirectChain.push(url);
        continue;
      }
      if (response.status !== 200) throw new SourceFetchError(`HTTP_${response.status}`, `Unexpected status ${response.status}.`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_SOURCE_RESPONSE_BYTES) throw new SourceFetchError("SOURCE_TOO_LARGE", "Declared length exceeds the byte limit.");
      const body = await readCapped(response.body, MAX_SOURCE_RESPONSE_BYTES);
      const envelope: FetchEnvelope = { content_type: response.headers.get("content-type") ?? "", content_length: body.byteLength, redirect_chain: redirectChain, final_url: url };
      const validation = validateFetchEnvelope(source, envelope);
      if (!validation.valid) throw new SourceFetchError(validation.issues[0].code, validation.issues.map((issue) => issue.message).join(" "));
      return {
        body,
        record: {
          fetcher_version: FETCHER_VERSION,
          source_id: source.source_id,
          publisher: source.publisher,
          canonical_url: source.canonical_url,
          retrieved_at: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
          http_status: response.status,
          envelope,
          raw_sha256: `sha256:${sha256Hex(new TextDecoder().decode(body))}`,
        },
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

const NOTICE_PATTERNS = [/copyright/i, /©/, /all rights reserved/i, /may not be (?:reproduced|copied|republished)/i, /used with permission/i, /reprinted with permission/i];

/**
 * Lines of visible text that look like a copyright or reuse notice, for the
 * exact-page contrary-notice review. A human decides; this only surfaces them.
 */
export function findNoticeCandidates(html: string): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&copy;|&#169;/gi, "©")
    .replace(/&nbsp;/gi, " ");
  const lines = text.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  return [...new Set(lines.filter((line) => NOTICE_PATTERNS.some((pattern) => pattern.test(line))).map((line) => line.slice(0, 300)))];
}
