// POST /api/ingredient-answer — disabled by default (design Milestone 2).
// Returns 404 unless INGREDIENT_ANSWER_ENABLED=1, and 503 until a reviewed
// production index, provider key, rate-limit secret, and durable rate-limit
// store all exist. No frontend code calls this route yet.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Handler = (request: Request) => Promise<Response>;
let handlerPromise: Promise<Handler> | null = null;

const json = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store", Vary: "Origin" } });

async function dispatch(request: Request): Promise<Response> {
  if (process.env.INGREDIENT_ANSWER_ENABLED !== "1") return json(404, "NOT_FOUND");
  try {
    if (!handlerPromise) {
      handlerPromise = import("../../../lib/ingredient-answer/production.ts").then((module) => module.loadProductionAnswerHandler(process.cwd(), process.env));
      handlerPromise.catch(() => { handlerPromise = null; });
    }
    return (await handlerPromise)(request);
  } catch {
    return json(503, "INGREDIENT_ANSWER_UNAVAILABLE");
  }
}

export const POST = dispatch;
export const OPTIONS = dispatch;
