import { AG_PREFIX, getAgnenticBaseUrl } from "./config";

export type AgFetchInit = Omit<RequestInit, "headers"> & {
  bearer?: string | null;
  headers?: HeadersInit;
};

export async function agnenticFetch(
  path: string,
  init: AgFetchInit = {},
): Promise<{ ok: boolean; status: number; text: string; json: unknown | null }> {
  const base = getAgnenticBaseUrl().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${p}`;
  const { bearer, headers: hdrs, ...rest } = init;
  const headers = new Headers(hdrs ?? {});
  if (bearer?.trim()) headers.set("Authorization", `Bearer ${bearer.trim()}`);
  if (!headers.has("Content-Type") && rest.body != null && typeof rest.body === "string")
    headers.set("Content-Type", "application/json");
  const resp = await fetch(url, { ...rest, headers });
  const text = await resp.text();
  let json: unknown | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: resp.ok, status: resp.status, text, json };
}

export function agPath(suffix: string): string {
  const s = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${AG_PREFIX}${s}`;
}
