/** Decode JWT payload segment (no signature verify) — debugging only. */

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4;
    const b64 =
      pad === 0 ? padded : padded + "=".repeat(4 - pad);
    const json = atob(b64);
    const obj = JSON.parse(json) as unknown;
    return typeof obj === "object" && obj !== null && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function extractClIdFromJwtPayload(
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;
  const am = payload.app_metadata;
  if (typeof am === "object" && am !== null && !Array.isArray(am)) {
    const cl = (am as Record<string, unknown>).cl_id;
    if (typeof cl === "string" && cl.trim()) return cl.trim();
  }
  return null;
}
