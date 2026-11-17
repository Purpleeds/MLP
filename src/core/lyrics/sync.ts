// "Sync it yourself": tapped timings → LRC / enhanced LRC, and publishing to LRCLIB.
import { tokenize } from "../timing/tokens";

export type SyncMode = "lines" | "words";

export interface SyncUnit {
  /** index of the lyric line this unit belongs to */
  line: number;
  /** text incl. trailing space (words mode) or the whole line */
  text: string;
}

export interface Stamp {
  start: number;
  /** words mode: when the key was released (held notes) */
  end?: number;
}

/** Split lyric text into tap units: one per line, or one per word / CJK character. */
export function syncUnits(text: string, mode: SyncMode): { lines: string[]; units: SyncUnit[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[[a-z]+:.*\]$/i.test(l)); // drop LRC metadata tags if pasted
  const units: SyncUnit[] = [];
  lines.forEach((l, i) => {
    if (mode === "lines") units.push({ line: i, text: l });
    else for (const t of tokenize(l)) units.push({ line: i, text: t.text });
  });
  return { lines, units };
}

export const lrcTime = (ms: number) => {
  const cs = Math.max(0, Math.round(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** Build LRC (lines) or enhanced LRC (words, with an end stamp after each line's last word). */
export function toLrc(lines: string[], units: SyncUnit[], stamps: Stamp[], mode: SyncMode, offsetMs = 0): string {
  const out: string[] = [];
  lines.forEach((text, li) => {
    const idx = units.map((u, i) => (u.line === li ? i : -1)).filter((i) => i >= 0 && stamps[i]);
    if (!idx.length) return;
    const t = (ms: number) => lrcTime(ms + offsetMs);
    if (mode === "lines") {
      out.push(`[${t(stamps[idx[0]].start)}]${text}`);
      return;
    }
    let row = `[${t(stamps[idx[0]].start)}]`;
    idx.forEach((i) => (row += ` <${t(stamps[i].start)}>${units[i].text.trim()}`));
    const last = stamps[idx[idx.length - 1]];
    if (last.end && last.end > last.start) row += ` <${t(last.end)}>`;
    out.push(row);
  });
  return out.join("\n");
}

// ---------- LRCLIB publish ----------
export interface PublishInput {
  trackName: string;
  artistName: string;
  albumName: string;
  durationSec: number;
  plainLyrics: string;
  syncedLyrics: string;
}

export interface PublishDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  solve: (prefix: string, target: string) => Promise<string>;
  base: string;
  client: string;
}

export function validatePublish(p: PublishInput): string | null {
  if (!p.trackName.trim()) return "Add the song title.";
  if (!p.artistName.trim()) return "Add the artist.";
  if (!p.albumName.trim()) return "Add the album (LRCLIB requires it).";
  if (!(p.durationSec >= 1 && p.durationSec <= 3600)) return "Song length must be between 1 second and 1 hour.";
  if (!p.syncedLyrics.trim()) return "Sync the lyrics first.";
  return null;
}

/** Request a challenge, solve the proof-of-work, publish. Throws a readable Error on failure. */
export async function publishToLrclib(p: PublishInput, deps: PublishDeps, onStep?: (s: string) => void): Promise<void> {
  const invalid = validatePublish(p);
  if (invalid) throw new Error(invalid);
  const headers = { "Content-Type": "application/json", "Lrclib-Client": deps.client };
  onStep?.("Getting a publish challenge…");
  const ch = await deps.fetch(`${deps.base}/request-challenge`, { method: "POST", headers });
  if (!ch.ok) throw new Error(`LRCLIB refused the challenge request (HTTP ${ch.status}). Try again later.`);
  const { prefix, target } = (await ch.json()) as { prefix: string; target: string };
  onStep?.("Solving the challenge (proves you're not a spam bot)…");
  const nonce = await deps.solve(prefix, target);
  onStep?.("Publishing…");
  const res = await deps.fetch(`${deps.base}/publish`, {
    method: "POST",
    headers: { ...headers, "X-Publish-Token": `${prefix}:${nonce}` },
    body: JSON.stringify({
      trackName: p.trackName.trim(),
      artistName: p.artistName.trim(),
      albumName: p.albumName.trim(),
      duration: Math.round(p.durationSec),
      plainLyrics: p.plainLyrics.trim(),
      syncedLyrics: p.syncedLyrics.trim(),
    }),
  });
  if (res.status === 201) return;
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string; name?: string };
    detail = body.message || body.name || "";
  } catch {
    /* no JSON body */
  }
  if (res.status === 429) throw new Error("LRCLIB is rate-limiting right now. Wait a minute and try again.");
  throw new Error(`LRCLIB didn't accept it (HTTP ${res.status})${detail ? `: ${detail}` : ""}.`);
}
