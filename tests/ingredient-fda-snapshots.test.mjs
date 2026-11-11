import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { createDocumentHash, createDocumentId, validateSourceManifest } from "../lib/ingredient-corpus.ts";
import { chunkDocument } from "../lib/ingredient-chunking.ts";
import { normalizeHtml, parseHtml, decodeEntities } from "../lib/ingredient-normalize.ts";
import { parseCorpusMarkdown } from "../scripts/rag/shared.ts";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("rag/sources/manifest.v1.json", root), "utf8"));
const snapshotDir = new URL("rag/sources/snapshots/", root);
const snapshots = readdirSync(snapshotDir).filter((name) => name.endsWith(".md") && name !== "REVIEW.md").map((name) => {
  const { meta, body } = parseCorpusMarkdown(readFileSync(new URL(name, snapshotDir), "utf8"));
  return { name, meta, body };
});
const draft = JSON.parse(readFileSync(new URL("rag/sources/claim-units.v1.json", root), "utf8"));

test("snapshots: one per FDA source, metadata matches the manifest, document hash binds the text", () => {
  assert.equal(validateSourceManifest(manifest).valid, true);
  const fda = manifest.sources.filter((s) => s.publisher === "FDA").map((s) => s.source_id).sort();
  assert.deepEqual(snapshots.map((s) => s.meta.source_id).sort(), fda);
  for (const { name, meta, body } of snapshots) {
    const source = manifest.sources.find((s) => s.source_id === meta.source_id);
    assert.equal(name, `${source.source_id}.md`);
    assert.equal(meta.canonical_url, source.canonical_url);
    assert.equal(meta.title, source.title);
    assert.equal(meta.publisher, "FDA");
    assert.equal(meta.question_classes, source.question_classes.join(","));
    assert.equal(meta.parser, "readability-normalizer@1.0.0");
    assert.equal(meta.document_hash, createDocumentHash(body.replace(/\n$/, "")), name);
    assert.match(meta.retrieved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(/<\/?[a-z][^>]*>/i.test(body), false, `${name}: no HTML left`);
    assert.equal(/Content current as of/i.test(body), false, `${name}: page trailer removed`);
  }
  for (const s of manifest.sources) {
    if (s.publisher === "FDA") assert.equal(s.retrieval_policy, "include");
    else assert.deepEqual([s.retrieval_policy, s.corpus_review.decision, s.snapshot_storage_review.decision], ["exclude", "pending", "pending"], "AAD stays out without written permission");
  }
});

test("claims: approved by a named reviewer, each verbatim in a chunk of the cited section", () => {
  assert.deepEqual(draft.review, { decision: "approved", reviewed_by: "yanyan-milktea", reviewed_at: "2026-11-11", review_version: "claim-review-v1" });
  assert.equal(draft.claim_units.length, 19);
  const chunks = snapshots.flatMap(({ meta, body }) => chunkDocument({
    source_id: meta.source_id, document_id: createDocumentId(meta.source_id, body.replace(/\n$/, "")), document_hash: meta.document_hash,
    publisher: meta.publisher, title: meta.title, canonical_url: meta.canonical_url, retrieved_at: meta.retrieved_at,
    question_classes: meta.question_classes.split(","), normalized_text: body.replace(/\n$/, ""),
  }));
  const classes = new Map(manifest.sources.map((s) => [s.source_id, s.question_classes]));
  for (const unit of draft.claim_units) {
    assert.ok(["Q1", "Q2", "Q4"].includes(unit.question_class), "FDA-backed classes only");
    for (const ref of unit.support) {
      assert.ok(classes.get(ref.doc)?.includes(unit.question_class), `${ref.doc} is a ${unit.question_class} source`);
      const hit = chunks.filter((c) => c.source_id === ref.doc && c.section_path.at(-1) === ref.section && c.text.includes(unit.canonical_claim_text));
      assert.ok(hit.length > 0, `not verbatim in ${ref.doc} § ${ref.section}: ${unit.canonical_claim_text.slice(0, 70)}`);
    }
    for (const term of [...unit.required_terms, ...unit.negation_terms]) assert.ok(unit.canonical_claim_text.includes(term), `"${term}" in claim`);
  }
  const intents = new Set(draft.claim_units.flatMap((u) => u.supported_intent_ids));
  for (const intent of ["q1_aha_definition", "q1_sun_sensitivity_relationship", "q1_sun_protection_caution", "q2_bha_definition", "q2_fda_cosmetic_scope", "q2_reviewed_safety_context", "q4_premarket_approval_rule", "q4_color_additive_exception", "q4_fda_role"]) assert.ok(intents.has(intent), intent);
});

test("normalizer: main only, nav/scripts/hidden dropped, run-together attributes, implied end tags, entities", () => {
  const html = `<html><head><title>X | FDA</title><script>var a="<main>";</script></head><body>
    <nav id="section-nav"class="side"><ul><li>Menu item</li></ul></nav>
    <main><h1>Example</h1><p>First <a href="#">linked</a> words &amp; more&nbsp;text.<p>Second para
    <ul><li>One<li>Two <span class="visually-hidden">hidden</span></ul>
    <table><tr><td>A<td>B</tr></table><p hidden>secret</p><form><input></form>
    <h2>Content current as of:</h2><p>05/19/2022</p><h2>Regulated Product(s)</h2><ul><li>Cosmetics</li></ul></main>
    <footer>Footer</footer></body></html>`;
  const out = normalizeHtml(html, "Example");
  assert.equal(out.markdown, "# Example\n\nFirst linked words & more text.\n\nSecond para\n\n- One\n\n- Two\n\nA | B");
  assert.equal(out.content_current_as_of, "2022-05-19");
  assert.throws(() => normalizeHtml("<html><body><p>no main</p></body></html>", "X"), /MAIN_NOT_FOUND/);
  const unknown = new Set();
  assert.equal(decodeEntities("&alpha;-hydroxy &#x3B2; &#946; &bogus;", unknown), "α-hydroxy β β &bogus;");
  assert.deepEqual([...unknown], ["&bogus;"]);
  assert.equal(normalizeHtml("<main><ol><li>a</li><li>b</li></ol></main>", "T").markdown, "# T\n\n1. a\n\n2. b");
  assert.ok(parseHtml("<p>x</p>").children.length > 0);
});
