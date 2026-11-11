import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fetchSource, findNoticeCandidates, sourcesToFetch, SourceFetchError } from "../lib/ingredient-fetch.ts";

const manifest = JSON.parse(readFileSync(new URL("../rag/sources/manifest.v1.json", import.meta.url), "utf8"));
const aha = manifest.sources.find((s) => s.canonical_url.endsWith("/alpha-hydroxy-acids"));
const NOW = () => new Date("2026-11-11T21:00:00.123Z");
const stream = (text, chunks = 1) => {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / chunks);
  return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size)); c.close(); } });
};
const headers = (h) => ({ get: (name) => h[name.toLowerCase()] ?? null });
const ok = (html = "<html><body><h1>Alpha Hydroxy Acids</h1></body></html>", h = {}) => ({ status: 200, headers: headers({ "content-type": "text/html; charset=utf-8", ...h }), body: stream(html, 3) });
const scripted = (...responses) => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url, init }); const next = responses[calls.length - 1]; if (next instanceof Error) throw next; return typeof next === "function" ? next(init) : next; } }; };
const code = async (promise) => { try { await promise; return "OK"; } catch (error) { assert.ok(error instanceof SourceFetchError, String(error)); return error.code; } };

test("only sources approved for snapshot storage are fetched: the four FDA pages, never AAD", () => {
  const picked = sourcesToFetch(manifest);
  assert.equal(picked.length, 4);
  assert.ok(picked.every((s) => s.publisher === "FDA"));
  const disabled = structuredClone(manifest);
  disabled.sources.find((s) => s.source_id === aha.source_id).emergency_disabled = true;
  disabled.sources.find((s) => s.source_id === aha.source_id).emergency_disable_reason = "test";
  assert.equal(sourcesToFetch(disabled).length, 3, "an emergency-disabled source is skipped");
});

test("a normal fetch records the envelope, timestamp, hash, and identifying headers", async () => {
  const { calls, fetchImpl } = scripted(ok());
  const { record, body } = await fetchSource(aha, fetchImpl, NOW);
  assert.equal(record.retrieved_at, "2026-11-11T21:00:00Z");
  assert.equal(record.envelope.final_url, aha.canonical_url);
  assert.deepEqual(record.envelope.redirect_chain, []);
  assert.equal(record.envelope.content_length, body.byteLength);
  assert.match(record.raw_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(calls[0].init.redirect, "manual");
  assert.match(calls[0].init.headers["User-Agent"], /SkinRoutineCopilot-CorpusReview/);
});

test("redirects: cross-host, plain HTTP, a different path, and loops are all rejected", async () => {
  const redirect = (location) => ({ status: 301, headers: headers({ location }), body: null });
  assert.equal(await code(fetchSource(aha, scripted(redirect("https://evil.example/aha")).fetchImpl, NOW)), "CROSS_HOST_REDIRECT");
  assert.equal(await code(fetchSource(aha, scripted(redirect("http://www.fda.gov/cosmetics/cosmetic-ingredients/alpha-hydroxy-acids")).fetchImpl, NOW)), "UNSAFE_REDIRECT");
  assert.equal(await code(fetchSource(aha, scripted(redirect("/some/other/page"), ok()).fetchImpl, NOW)), "FINAL_URL_MISMATCH");
  const loop = scripted(...Array.from({ length: 5 }, () => redirect(aha.canonical_url)));
  assert.equal(await code(fetchSource(aha, loop.fetchImpl, NOW)), "TOO_MANY_REDIRECTS");
  assert.equal(await code(fetchSource(aha, scripted(redirect("https://user:pw@www.fda.gov/x")).fetchImpl, NOW)), "UNSAFE_REDIRECT");
});

test("size, type, status, network failure, and timeout are enforced", async () => {
  const big = "x".repeat(1_000_001);
  assert.equal(await code(fetchSource(aha, scripted(ok(big)).fetchImpl, NOW)), "SOURCE_TOO_LARGE", "streamed bytes are capped even without a length header");
  assert.equal(await code(fetchSource(aha, scripted(ok("<p>x</p>", { "content-length": "5000000" })).fetchImpl, NOW)), "SOURCE_TOO_LARGE");
  assert.equal(await code(fetchSource(aha, scripted(ok("%PDF", { "content-type": "application/pdf" })).fetchImpl, NOW)), "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(await code(fetchSource(aha, scripted({ status: 404, headers: headers({}), body: null }).fetchImpl, NOW)), "HTTP_404");
  assert.equal(await code(fetchSource(aha, scripted(new TypeError("network")).fetchImpl, NOW)), "FETCH_FAILED");
  const hang = scripted((init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  assert.equal(await code(fetchSource(aha, hang.fetchImpl, NOW, 20)), "FETCH_TIMEOUT");
  assert.equal(await code(fetchSource({ ...aha, canonical_url: "https://www.fda.gov/not-approved" }, scripted(ok()).fetchImpl, NOW)), "UNAPPROVED_URL");
});

test("contrary-notice review surfaces copyright and reuse lines from visible text only", () => {
  const html = `<html><head><script>var c = "copyright in a script";</script><style>.copyright{}</style></head>
    <body><p>AHAs are acids.</p><p>Photo &copy; Example Stock, used with permission.</p><footer>Content current as of 2024</footer></body></html>`;
  assert.deepEqual(findNoticeCandidates(html), ["Photo © Example Stock, used with permission."]);
  assert.deepEqual(findNoticeCandidates("<p>Public domain text.</p>"), []);
});
