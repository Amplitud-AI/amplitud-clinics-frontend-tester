import { getWhatsAppServiceUrl } from "./config";

export function waApiBase(): string {
  return getWhatsAppServiceUrl().replace(/\/$/, "");
}

type WaJson<T = unknown> = {
  success?: boolean;
  error?: string;
  data?: T;
  message?: string;
  timestamp?: string;
};

export async function waFetchJson<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<WaJson<T>> {
  const url = `${waApiBase()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as WaJson<T>;
  return body;
}
