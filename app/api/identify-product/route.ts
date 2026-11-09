// Local mirror of vercel-api/api/identify-product.ts for development.
import { corsPreflightResponse, jsonWithCors } from "../../../lib/cors";
import { identifyProduct } from "../../../lib/product-identify.ts";

export const runtime = "nodejs";

export function OPTIONS(request: Request): Response {
  return corsPreflightResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => key !== "name")) {
    return jsonWithCors(request, { error: "Send only a product name." }, { status: 400 });
  }
  const outcome = await identifyProduct((body as { name?: unknown }).name, (input, init) => fetch(input, init));
  if (!outcome.ok) return jsonWithCors(request, { error: outcome.error }, { status: 400 });
  return jsonWithCors(request, { result: outcome.result, lookup_error: outcome.lookup_error });
}
