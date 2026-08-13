export const DEFAULT_AI_API_BASE_URL = "https://skin-routine-ai-api.vercel.app";

export function resolveAiApiBaseUrl(configured: string | undefined): string {
  const normalized = configured?.trim().replace(/\/+$/, "") ?? "";
  return normalized || DEFAULT_AI_API_BASE_URL;
}
