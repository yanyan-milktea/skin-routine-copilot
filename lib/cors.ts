export const PRODUCTION_SITE_ORIGIN = "https://skin-routine-copilot.gogogoyan.chatgpt.site";

function corsHeaders(request: Request, includePreflight = false): Headers {
  const headers = new Headers({ Vary: "Origin" });
  if (request.headers.get("origin") !== PRODUCTION_SITE_ORIGIN) return headers;

  headers.set("Access-Control-Allow-Origin", PRODUCTION_SITE_ORIGIN);
  if (includePreflight) {
    headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

export function corsPreflightResponse(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, true) });
}

export function jsonWithCors(request: Request, value: unknown, init: ResponseInit = {}): Response {
  const headers = corsHeaders(request);
  if (init.headers) {
    for (const [name, headerValue] of new Headers(init.headers)) headers.set(name, headerValue);
  }
  return Response.json(value, { ...init, headers });
}
