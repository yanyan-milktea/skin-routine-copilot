# Ingredient Intelligence corpus governance (Milestone 0)

This directory contains only the offline governance foundation for Ingredient
Intelligence. Milestone 0 does not fetch websites, create embeddings, perform
retrieval, call an AI provider, expose an API, or change the frontend.

## Versions

- Source manifest schema: `source-manifest.v1.schema.json`
- Synthetic corpus schema: `synthetic-corpus.v1.schema.json`
- Canonical claim-unit schema: `claim-units.v1.schema.json`
- Question-boundary schema: `ingredient-question.v1.schema.json`
- Initial source manifest: corpus version `2026-08-14.1`
- Locked synthetic corpus: `synthetic-v1`
- Reviewed synthetic claim fixtures: `synthetic-claims-v1`
- Parser configuration: `readability-normalizer@1.0.0`, scripts and remote
  resources disabled

Every object schema uses `additionalProperties: false`. Runtime validation in
`lib/ingredient-corpus.ts` additionally enforces cross-record relationships,
deterministic identifiers, hash bindings, review state, and exact URL policy.

## Real-source policy and closeout decision

`sources/manifest.v1.json` contains only the exact FDA and American Academy of
Dermatology URLs approved by the design for Q1–Q5. It stores titles and governance
metadata, not downloaded page bodies.

This governance record is an engineering control, not legal advice. It does not
represent written permission from either publisher.

The four FDA entries record a policy-level snapshot/redistribution decision
against the [FDA Website Policies](https://www.fda.gov/about-fda/about-website/website-policies).
That policy says FDA website text and graphics are generally public domain
unless otherwise noted. The decision is deliberately narrower than source
approval: before a real snapshot or excerpt can be generated, a reviewer must
still inspect the exact page for a contrary copyright notice. Any stored FDA
material must retain publisher attribution, canonical URL, retrieval/copy date,
and document hash; freshness monitoring remains mandatory. FDA names and logos
must not be copied or used in a way that implies endorsement. Consequently, all
four FDA entries still have `corpus_review: pending` and
`retrieval_policy: exclude`; they are not currently build eligible.

The two AAD entries remain `snapshot_storage_review: pending` and
`retrieval_policy: exclude`, so their derived `build_eligible` state is `false`.
The governing reference is the [AAD Terms of Use](https://www.aad.org/terms-use),
and the permission contact is `permissions@aad.org`. No AAD text, snapshot,
excerpt, chunk, claim unit, or embedding may enter a distributable artifact
without written permission. No such permission is recorded.

### Phase 1 source availability

| Question class | Publisher | Closeout state | Production meaning |
| --- | --- | --- | --- |
| Q1 | FDA | `future_eligible_after_exact_page_review` | Eligible for a future reviewed FDA corpus only after exact-page review, snapshot generation, hash binding, and corpus approval |
| Q2 | FDA | `future_eligible_after_exact_page_review` | Same gate as Q1 |
| Q3 | AAD | `blocked_pending_permission` | Cannot enter a distributable production corpus without written AAD permission |
| Q4 | FDA | `future_eligible_after_exact_page_review` | Same gate as Q1 |
| Q5 | AAD | `blocked_pending_permission` | Cannot enter a distributable production corpus without written AAD permission |

Synthetic fixtures continue to exercise all Q1–Q5 contracts, but synthetic
evidence cannot satisfy a production release gate for Q3 or Q5.

Before any real snapshot is added, a later authorized review must record:

1. an identified corpus reviewer and approval date;
2. a separate snapshot/redistribution reviewer and approval date;
3. the applicable publisher-policy reference and review basis, plus written
   permission where publisher terms require it;
4. the exact parser name/version and canonical redirect chain;
5. a source diff bound to the new document hash;
6. successful offline validation and safety review.

No source becomes `include` merely because it is public or belongs to an
allow-listed publisher.

## Synthetic fixture boundary

The locked corpus under `fixtures/` is entirely synthetic. It uses the fictional
publisher `Synthetic Test Publisher` and HTTPS URLs under `.fixture.invalid`.
Every document, chunk, and claim has `build_eligible: false`.

Synthetic claims are marked `approved_for_synthetic_tests`; this is a test-fixture
review decision, not legal, medical, publisher, or redistribution approval. The
sentences are short fictional examples and do not reproduce FDA/AAD webpages.

## Deterministic identity and normalization

Text normalization is NFC Unicode normalization, CRLF-to-LF conversion,
horizontal whitespace collapse, per-line trim, blank-line collapse, and final
trim. Hashes use UTF-8 SHA-256.

- Source ID: publisher key plus first eight hex characters of the canonical URL
  hash.
- Document ID: source ID plus first eight characters of the normalized document
  hash.
- Chunk ID: source ID, normalized section slug, zero-padded ordinal, and first
  eight characters of the normalized chunk hash.
- Claim-unit ID: question class, normalized canonical-claim slug, and first
  eight characters of the stable hash of canonical text plus supporting chunks.
- Claim review binding: SHA-256 of stable, key-sorted claim semantics, required
  terms, support IDs, and source/document hashes.

A changed canonical claim, supporting chunk, qualifier, negation, exception,
population, number, intent, or source hash invalidates the review binding and
requires a new review and claim-unit ID where applicable.

## Review and freshness behavior

- A changed document requires corpus and snapshot reviewers to approve the same
  new document hash. One approval is insufficient.
- Soft expiry begins after `review_due_at`. A previously approved source may
  remain available for at most 30 days while review is pending.
- After the 30-day grace period the source is hard expired and excluded.
- Emergency disable has no grace period and overrides all approvals.
- The initial manifest remains pending/excluded, so its sources are unavailable
  regardless of date.

## Offline validation

Run the isolated Milestone 0 suite with:

```bash
npm run test:milestone0
```

The test suite reads only checked-in JSON and synthetic strings. It does not
make network requests, call Gemini, access API keys, or contact FDA/AAD.

## Source-change review procedure

1. Produce a normalized candidate snapshot outside the committed corpus.
2. Record old/new document hashes, parser version, redirects, and changed
   headings/paragraphs, including changed numbers, qualifiers, and negation.
3. Obtain independent corpus and snapshot/redistribution decisions bound to the
   new hash.
4. Keep the source excluded when either decision is pending or rejected.
5. If both are approved and permission is documented, add only the reviewed
   material in a separate authorized milestone.
6. Revalidate all affected chunks and claim-unit bindings.

Downloaded webpages, raw HTML, and unreviewed excerpts must never be committed.
