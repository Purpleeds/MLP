// LRCLIB HTTP client: identified, sequential, polite (gap between requests, 429 backoff, timeout, retries).
import type { LrclibRecord } from "./model";
import type { Query } from "./query";
import { getSettings } from "../settings/store";
import { CLIENT_ID } from "../version";

export const LRCLIB_BASE = "https://lrclib.net/api";
const GAP_MS = 300;
const TIMEOUT_MS = 8000;
const RETRIES = 2;

let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(public status: number) {
    super(`LRCLIB HTTP ${status}`);
  }
}

async function request<T>(path: string, params: Record<string, string | number | undefined>): Promise<T | null> {
  const base = (getSettings().provider?.baseUrl || LRCLIB_BASE).replace(/\/+$/, "");
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

  const run = async (): Promise<T | null> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, { headers: { "Lrclib-Client": CLIENT_ID }, signal: ctrl.signal });
        if (res.status === 404) return null;
        if (res.status === 429 && attempt < RETRIES) {
          const ra = Number(res.headers.get("Retry-After")) || 2;
          await sleep(ra * 1000 + Math.random() * 500);
          continue;
        }
        if (!res.ok) throw new HttpError(res.status);
        return (await res.json()) as T;
      } catch (e) {
        const retryable = !(e instanceof HttpError) || e.status >= 500;
        if (!retryable || attempt >= RETRIES) throw e;
        await sleep(600 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
  };
  // Serialize all requests through one chain.
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

export const lrclib = {
  get: (q: Query, durationMs?: number) =>
    request<LrclibRecord>("/get", {
      track_name: q.track,
      artist_name: q.artist,
      album_name: q.album,
      duration: durationMs ? Math.round(durationMs / 1000) : undefined,
    }),
  getById: (id: number) => request<LrclibRecord>(`/get/${id}`, {}),
  search: (params: { q?: string; track_name?: string; artist_name?: string }) =>
    request<LrclibRecord[]>("/search", params).then((r) => r ?? []),
};
