// Human translations from VocaDB (vocadb.net, community database of Vocaloid / UTAU / synth songs).
// VocaDB has no timing: its original lyrics are lined up with the synced lyrics we show, and the
// translation lines that pair with them are put under the matching lines. Lookups are cached
// (vocadb-cache.json) and spaced out; only the song title goes out (like the LRCLIB lookup).
import { createKv } from "../storage/kv";
import { cleanArtist, normalize, similarity } from "./query";

const API = "https://vocadb.net/api";
const GAP_MS = 1100; // VocaDB publishes no limit: one request at a time, about a second apart
const FOUND_TTL = 14 * 864e5; // re-check now and then: new translations get added
const MISS_TTL = 7 * 864e5;
const MAX_ENTRIES = 400;
/** share of the shown lines that must line up with VocaDB's lyrics before its translation is used */
export const MIN_COVERAGE = 0.6;

export interface VdbLyric {
  type: "Original" | "Romanized" | "Translation";
  langs: string[];
  source: string;
  url: string;
  text: string;
}
export interface VdbSong {
  id: number;
  name: string;
  artist: string;
  lyrics: VdbLyric[];
}
interface CacheEntry {
  at: number;
  song: VdbSong | null;
}

// ---------- requests (sequential, spaced, backing off on 429 / 503) ----------
export type FetchJson = (url: string) => Promise<{ ok: boolean; status: number; json: unknown; retryAfter?: number }>;

export class VdbBusy extends Error {}

let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;
let blockedUntil = 0;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function request<T>(url: string, fetchJson: FetchJson, gapMs = GAP_MS): Promise<T> {
  const run = async () => {
    if (Date.now() < blockedUntil) throw new VdbBusy("VocaDB asked to slow down");
    const gap = lastAt + gapMs - Date.now();
    if (gap > 0) await wait(gap);
    lastAt = Date.now();
    const res = await fetchJson(url);
    if (res.status === 429 || res.status === 503) {
      blockedUntil = Date.now() + Math.max(30, res.retryAfter ?? 60) * 1000;
      throw new VdbBusy(`VocaDB ${res.status}`);
    }
    if (!res.ok) throw new Error(`VocaDB ${res.status}`);
    return res.json as T;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

export const vdbFetch: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok, status: res.status, json, retryAfter: Number(res.headers.get("retry-after")) || undefined };
};

// ---------- finding the song ----------
interface ApiLyric {
  cultureCodes?: string[];
  cultureCode?: string;
  translationType?: string;
  source?: string;
  url?: string;
  value?: string;
}
interface ApiSong {
  id: number;
  name: string;
  defaultName?: string;
  artistString?: string;
  lengthSeconds?: number;
  songType?: string;
  originalVersionId?: number;
  names?: { value: string }[];
  lyrics?: ApiLyric[];
}

const toLyric = (l: ApiLyric): VdbLyric | null => {
  const type = l.translationType as VdbLyric["type"];
  if (!l.value?.trim() || !["Original", "Romanized", "Translation"].includes(type)) return null;
  const langs = (l.cultureCodes ?? (l.cultureCode ? [l.cultureCode] : [])).map((c) => c.toLowerCase()).filter(Boolean);
  return { type, langs, source: l.source ?? "", url: l.url ?? "", text: l.value };
};

/** Artist names in "黒うさP feat. 初音ミク" / "A, B feat. various". */
const artistNames = (s: string) => s.split(/\s+feat\.?\s+|\s*,\s*|\s*、\s*|\s+&\s+/i).map((x) => x.trim()).filter((x) => x && !/^(various|unknown)$/i.test(x));

/** How well a VocaDB song fits the playing one (0…1), title first. */
export function scoreSong(s: ApiSong, title: string, artist: string, durationMs: number): number {
  const names = [s.name, s.defaultName, ...(s.names ?? []).map((n) => n.value)].filter(Boolean) as string[];
  const t = Math.max(0, ...names.map((n) => similarity(n, title)));
  const a = artist ? Math.max(0, ...artistNames(s.artistString ?? "").map((n) => similarity(n, cleanArtist(artist)))) : 0;
  const d = s.lengthSeconds && durationMs > 0 ? Math.max(0, 1 - Math.abs(s.lengthSeconds * 1000 - durationMs) / 8000) : 0.5;
  const original = s.songType === "Original" ? 0.05 : 0;
  return t * 0.6 + a * 0.25 + d * 0.15 + original;
}

const songUrl = (q: Record<string, string>) => `${API}/songs?${new URLSearchParams(q)}`;

/** Search VocaDB; derivatives (covers, remixes) lead to the original, which holds the lyrics. */
async function search(title: string, artist: string, durationMs: number, fetchJson: FetchJson, gapMs?: number): Promise<VdbSong | null> {
  const body = await request<{ items?: ApiSong[] }>(
    songUrl({ query: title, maxResults: "10", sort: "RatingScore", preferAccurateMatches: "true", nameMatchMode: "Auto", fields: "Names,Lyrics", lang: "Default" }),
    fetchJson,
    gapMs,
  );
  const ranked = (body?.items ?? [])
    .map((s) => ({ s, score: scoreSong(s, title, artist, durationMs) }))
    .filter((x) => similarity(x.s.name, title) >= 0.8 || (x.s.names ?? []).some((n) => similarity(n.value, title) >= 0.8) || similarity(x.s.defaultName ?? "", title) >= 0.8)
    .sort((a, b) => b.score - a.score);
  // Covers, remixes and fan translations point at the original, which holds the real lyrics.
  const roots = [...new Set(ranked.map(({ s }) => (s.songType !== "Original" && s.originalVersionId ? s.originalVersionId : s.id)))];
  for (const id of roots.slice(0, 2)) {
    const listed = body?.items?.find((s) => s.id === id && s.lyrics?.length);
    const src =
      listed ??
      (await request<ApiSong>(`${API}/songs/${id}?fields=Lyrics&lang=Default`, fetchJson, gapMs).catch((e) => {
        if (e instanceof VdbBusy) throw e;
        return null;
      }));
    const lyrics = (src?.lyrics ?? []).map(toLyric).filter((l): l is VdbLyric => !!l);
    if (src && lyrics.some((l) => l.type === "Original")) return { id: src.id, name: src.name, artist: src.artistString ?? "", lyrics };
  }
  return null;
}

// ---------- cache ----------
const cache = createKv<CacheEntry>("vocadb-cache.json");
export const vdbKey = (title: string, artist: string) => `${normalize(artist)}|${normalize(title)}`;

async function prune() {
  const all = await cache.entries();
  if (all.length <= MAX_ENTRIES) return;
  all.sort((a, b) => a[1].at - b[1].at);
  for (const [k] of all.slice(0, all.length - MAX_ENTRIES)) await cache.delete(k);
}

export interface LookupDeps {
  fetchJson?: FetchJson;
  /** tests: no spacing between requests */
  gapMs?: number;
  store?: Pick<typeof cache, "get" | "set" | "delete">;
}

/** VocaDB entry for a song (cached). null = not on VocaDB; throws when VocaDB can't be asked right now. */
export async function findVocaDbSong(title: string, artist: string, durationMs: number, deps: LookupDeps = {}): Promise<VdbSong | null> {
  const store = deps.store ?? cache;
  const key = vdbKey(title, artist);
  const hit = await store.get(key).catch(() => undefined);
  if (hit && Date.now() - hit.at < (hit.song ? FOUND_TTL : MISS_TTL)) return hit.song;
  try {
    const song = await search(title, artist, durationMs, deps.fetchJson ?? vdbFetch, deps.gapMs);
    await store.set(key, { at: Date.now(), song }).catch(() => undefined);
    if (!deps.store) void prune().catch(() => undefined);
    return song;
  } catch (e) {
    if (hit) return hit.song; // stale but better than nothing
    throw e;
  }
}

/** Forget a song's cached VocaDB entry (Reset translation): the next lookup asks again. */
export const forgetVocaDbSong = (title: string, artist: string) => cache.delete(vdbKey(title, artist));

// ---------- lining up ----------
/** VocaDB text → lines (blank lines kept as stanza breaks, ""). */
export function vdbLines(text: string): string[] {
  return text.replace(/\r/g, "").split("\n").map((l) => l.trim());
}

/** Inline furigana "磊々落々（らいらいらくらく）" and spacing don't count when comparing lines. */
const bare = (s: string) => s.replace(/[（(][\p{Script=Hiragana}\p{Script=Katakana}ー・\s]+[）)]/gu, "");

const lineSim = (a: string, b: string) => similarity(bare(a), bare(b));

const GOOD = 0.55;
const gain = (sim: number) => (sim >= GOOD ? sim - 0.3 : -Infinity);

/**
 * Line up shown lyric lines with VocaDB lines (sequence alignment, both in order). A shown line may
 * match one VocaDB line, two VocaDB lines joined, or two shown lines may share one VocaDB line.
 * Returns the VocaDB indices per shown line ([] = no match); for a shared line only the first gets
 * them and the second is marked in `rest`.
 */
export function alignToVdb(shown: string[], vdb: string[]): { idx: number[][]; rest: boolean[] } {
  const n = shown.length;
  const m = vdb.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const from: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 skip shown, 2 skip vdb, 3 1:1, 4 1:2, 5 2:1
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= m; j++) {
      if (!i && !j) continue;
      let best = -Infinity;
      let how = 0;
      const tryMove = (v: number, h: number) => v > best && ((best = v), (how = h));
      if (i) tryMove(dp[i - 1][j], 1);
      if (j) tryMove(dp[i][j - 1], 2);
      if (i && j && shown[i - 1] && vdb[j - 1]) tryMove(dp[i - 1][j - 1] + gain(lineSim(shown[i - 1], vdb[j - 1])), 3);
      if (i && j > 1 && shown[i - 1] && vdb[j - 1] && vdb[j - 2]) tryMove(dp[i - 1][j - 2] + gain(lineSim(shown[i - 1], vdb[j - 2] + vdb[j - 1])) + 0.05, 4);
      if (i > 1 && j && shown[i - 1] && shown[i - 2] && vdb[j - 1]) tryMove(dp[i - 2][j - 1] + gain(lineSim(shown[i - 2] + shown[i - 1], vdb[j - 1])) + 0.05, 5);
      dp[i][j] = best;
      from[i][j] = how;
    }
  const out: number[][] = shown.map(() => []);
  const rest = shown.map(() => false);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const h = from[i][j];
    if (h === 1) i--;
    else if (h === 2) j--;
    else if (h === 3) (out[i - 1] = [j - 1], i--, j--);
    else if (h === 4) (out[i - 1] = [j - 2, j - 1], i--, (j -= 2));
    else if (h === 5) (out[i - 2] = [j - 1], (rest[i - 1] = true), (i -= 2), j--);
    else break;
  }
  return { idx: out, rest };
}

const stanzas = (lines: string[]) => {
  const out: string[][] = [[]];
  for (const l of lines) l ? out[out.length - 1].push(l) : out[out.length - 1].length && out.push([]);
  return out.filter((s) => s.length);
};

/** Marks a lyrics line whose translation sits on the line before (two short lines, one translated line). */
export const CONTINUED = "";

/**
 * Pair the lines of VocaDB's lyrics with a translation's lines (index = non-blank lyrics line): line for
 * line when both have the same number of lines, else stanza by stanza where the counts match, or where
 * one side has exactly twice the lines of the other (stanzas of 2+ lines) (two short lines translated as one, or the reverse).
 * Anything less certain gets null: a wrong pairing would show the wrong meaning.
 */
export function pairTranslation(lyrics: string[], translation: string[]): (string | null)[] {
  const a = lyrics.filter(Boolean);
  const b = translation.filter(Boolean);
  if (a.length === b.length) return b;
  const sa = stanzas(lyrics);
  const sb = stanzas(translation);
  const out: (string | null)[] = [];
  sa.forEach((st, k) => {
    const tr = sa.length === sb.length ? sb[k] : sb.length === 1 && sa.length === 1 ? sb[0] : undefined;
    st.forEach((_, i) => {
      if (!tr) return out.push(null);
      if (tr.length === st.length) return out.push(tr[i]);
      if (tr.length >= 2 && st.length === 2 * tr.length) return out.push(i % 2 ? CONTINUED : tr[i / 2]);
      if (st.length >= 2 && tr.length === 2 * st.length) return out.push(`${tr[2 * i]} ${tr[2 * i + 1]}`);
      out.push(null);
    });
  });
  return out;
}

export interface HumanTranslation {
  lines: (string | null)[];
  source: string;
  url: string;
  songId: number;
  coverage: number;
}

const langIs = (langs: string[], target: string) => langs.some((c) => c.split("-")[0] === target.toLowerCase().split("-")[0]);

/**
 * Human translation for the shown lines, or null when VocaDB has none in `target` or its lyrics don't
 * line up well enough with the shown ones (then the machine translation is used).
 */
export function humanTranslation(song: VdbSong, shown: string[], target: string, wanted: (i: number) => boolean = () => true): HumanTranslation | null {
  const translations = song.lyrics.filter((l) => l.type === "Translation" && langIs(l.langs, target));
  if (!translations.length) return null;
  // The shown lyrics may be in the original script or romanized: try both of VocaDB's versions.
  const bases = song.lyrics.filter((l) => l.type === "Original" || l.type === "Romanized");
  const want = shown.map((t, i) => wanted(i) && /\p{L}/u.test(t));
  const wantCount = want.filter(Boolean).length;
  if (!wantCount) return null;
  let best: HumanTranslation | null = null;
  for (const base of bases) {
    const baseLines = vdbLines(base.text);
    const nonBlank = baseLines.filter(Boolean);
    const { idx: align, rest } = alignToVdb(shown, nonBlank);
    for (const tr of translations) {
      const paired = pairTranslation(baseLines, vdbLines(tr.text));
      const lines = shown.map((_, i) => {
        if (!want[i] || !align[i].length) return null;
        const parts = align[i].map((j) => paired[j]);
        if (parts.some((x) => x === null || x === undefined)) return null;
        return parts.filter(Boolean).join(" ") || CONTINUED;
      });
      // Covered: has a translation, or shares the one shown on the line before.
      const got = lines.filter((l, i) => l || (l === CONTINUED && i > 0) || (rest[i] && lines[i - 1] !== null)).length;
      lines.forEach((l, i) => l === CONTINUED && (lines[i] = null));
      const coverage = got / wantCount;
      if (coverage >= MIN_COVERAGE && got >= Math.min(3, wantCount) && (!best || coverage > best.coverage))
        best = { lines, source: tr.source, url: tr.url, songId: song.id, coverage };
    }
  }
  return best;
}
