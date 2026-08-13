import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_AI_API_BASE_URL, resolveAiApiBaseUrl } from "../lib/api-base.ts";

const artifactRoot = path.resolve("dist/client");

async function clientArtifactText() {
  const files = await readdir(artifactRoot, { recursive: true });
  const scripts = files.filter((file) => file.endsWith(".js"));
  return (await Promise.all(scripts.map((file) => readFile(path.join(artifactRoot, file), "utf8")))).join("\n");
}

test("undefined, empty, and whitespace-only API config use the production alias", () => {
  for (const configured of [undefined, "", "   \n\t  "]) {
    assert.equal(resolveAiApiBaseUrl(configured), DEFAULT_AI_API_BASE_URL);
  }
});

test("configured API URLs are honored, trimmed, and normalized", () => {
  assert.equal(resolveAiApiBaseUrl("https://api.example.test"), "https://api.example.test");
  assert.equal(resolveAiApiBaseUrl("  https://api.example.test///  "), "https://api.example.test");
});

test("production request URLs remain absolute when configuration is empty", () => {
  const base = resolveAiApiBaseUrl("");
  assert.equal(`${base}/api/generate-routine`, `${DEFAULT_AI_API_BASE_URL}/api/generate-routine`);
  assert.equal(`${base}/api/summarize-history`, `${DEFAULT_AI_API_BASE_URL}/api/summarize-history`);
  assert.match(base, /^https:\/\//);
});

test("production client artifact embeds the standard Vercel API hostname", async () => {
  const artifact = await clientArtifactText();
  assert.match(artifact, /skin-routine-ai-api\.vercel\.app/);
  assert.match(artifact, /\/api\/generate-routine/);
  assert.match(artifact, /\/api\/summarize-history/);
});
