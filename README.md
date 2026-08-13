# Skin Routine Copilot

An applied-AI skincare routine planner. It turns a short daily check-in into a
structured morning/evening routine using only products already on the user's
shelf.

Live app: https://skin-routine-copilot.gogogoyan.chatgpt.site

## What this project demonstrates

- Gemini structured output with a strict JSON schema
- Product allow-listing and deterministic post-generation guardrails
- Prompt-injection resistance for free-text notes
- Automatic local fallback when the model or network fails
- A separate production AI proxy so API keys never reach the browser
- Responsive React UI with a visible AI/fallback provenance badge

## Open in Codex

1. Download and unzip the project.
2. Open the project folder in the ChatGPT desktop app under **Codex**.
3. In the integrated terminal, run `git init` and then `npm install`.
4. Copy `.env.example` to `.env.local` and add your own Gemini key.
5. Run `npm run dev:codex`.

The checked-in code never contains a Gemini API key. The live production key
remains in Vercel.

## Useful commands

```bash
npm run dev:codex
npm run check:codex
npm run lint
npm test
```

Start with [CODEX_START_HERE.md](./CODEX_START_HERE.md).

## Architecture

```text
app/page.tsx
    │ POST /api/generate-routine
    ▼
app/api/generate-routine/route.ts
    ├── Gemini or OpenAI structured output
    ├── deterministic guardrails
    └── local fallback on provider failure
             │
             ▼
        lib/routine.ts
```

In production, the browser calls a Vercel AI proxy configured by
`NEXT_PUBLIC_AI_API_URL`. Locally, leave that variable empty to use this repo's
own API route.

## Safety boundary

This is a conservative planning demo, not a diagnostic or medical tool. Notes
are treated as untrusted data. Generated products are restricted to the local
shelf list, sunscreen is enforced as the last morning step, and sensitivity
signals remove azelaic acid from the routine.
