// Lyrics service: per-song pin → cache → LRCLIB get/search → best match → parsed Lyrics.
import { useEffect, useRef, useState } from "react";
import { isTauri, platform } from "../platform";
import type { NowPlaying } from "../playback/clock";
import { createKv } from "../storage/kv";
import { lrclib } from "./lrclib";
import type { LrclibRecord, Lyrics } from "./model";
import { parseLrc, recordToLyrics, wordCoverage } from "./parse";
import { amllToLyrics, findAmll, type AmllRecord } from "./amll";
import { getSettings } from "../settings/store";
import { buildQueries, MIN_SCORE, normalize, scoreCandidate, type Query } from "./query";
import { maybeAdLength } from "../playback/ads";
import { spotifyLookup } from "../spotify";
import { learnedFor, recordCorrection, useLearnedOffset } from "../timing/learnStore";

/** Song identity for offsets; with the player kind, corrections also teach the per-app default (Upgrade 10). */
type OffsetNp = Pick<NowPlaying, "title" | "artist"> & { sourceKind?: NowPlaying["sourceKind"] };

interface CacheEntry {
  at: number;
  record: LrclibRecord | null; // null = not found (negative cache)
  /** AMLL word-synced lyrics; undefined = not checked yet, null = not in the database */
  amll?: AmllRecord | null;
}
export interface SongPrefs {
  pinId?: number;
  offsetMs?: number;
  /** lyrics synced by the user in the sync editor (LRC / enhanced LRC); used before anything else */
  localLrc?: string;
  /** auto-sync (Step 15): where each line was heard, for these exact lyrics */
  aiSync?: import("../ai/autosync").SavedSync;
  /** AI lyrics (Step 16) for a song no database has */
  aiLyrics?: import("../ai/aiLyrics").SavedAiLyrics;
  /** don't write AI lyrics for this song (hover toolbar) */
  aiLyricsOff?: boolean;
}

const NEGATIVE_TTL = 24 * 3600_000;
const RETRY_MS = 30_000;
const CACHE_MAX = 400;
const cache = createKv<CacheEntry>("lyrics-cache.json");
export const songs = createKv<SongPrefs>("songs.json");

/** Stable per-song key from raw metadata (used for cache, pins and offsets). */
export const songKey = (np: Pick<NowPlaying, "title" | "artist">) => `${normalize(np.artist)}|${normalize(np.title)}`;

/** Keep only what we need (lyricsfile only when it adds word timing). */
const slim = (r: LrclibRecord): LrclibRecord => ({
  id: r.id,
  trackName: r.trackName,
  artistName: r.artistName,
  albumName: r.albumName,
  duration: r.duration,
  instrumental: r.instrumental,
  hasWordSync: r.hasWordSync,
  plainLyrics: r.syncedLyrics ? null : r.plainLyrics,
  syncedLyrics: r.syncedLyrics,
  lyricsfile: r.hasWordSync ? r.lyricsfile : null,
});

async function prune() {
  const all = await cache.entries();
  if (all.length <= CACHE_MAX) return;
  all.sort((a, b) => a[1].at - b[1].at);
  for (const [k] of all.slice(0, all.length - CACHE_MAX)) await cache.delete(k);
}

/** Search LRCLIB for the best record for this track. */
export async function findRecord(np: Pick<NowPlaying, "title" | "artist" | "album" | "durationMs">): Promise<LrclibRecord | null> {
  const queries = buildQueries(np.title, np.artist, np.album);
  if (!queries.length) return null;
  const dur = np.durationMs > 0 ? np.durationMs : 0;
  const best: { r: LrclibRecord | null; s: number } = { r: null, s: MIN_SCORE };
  const consider = (r: LrclibRecord, q: Query) => {
    const s = scoreCandidate(r, q, dur);
    if (s >= best.s) Object.assign(best, { r, s });
  };

  // 1) Exact lookups (cheap, precise) for the first variants.
  for (const q of queries.slice(0, 3)) {
    if (!q.artist) continue;
    const r = await lrclib.get(q, dur || undefined);
    if (r) consider(r, q);
    if (best.s >= 0.9) return best.r;
  }
  // 2) Field search, then free-text search.
  const q0 = queries[0];
  for (const r of await lrclib.search({ track_name: q0.track, artist_name: q0.artist || undefined })) consider(r, q0);
  if (best.s < 0.85) {
    for (const q of queries.slice(0, 2)) {
      for (const r of await lrclib.search({ q: `${q.artist} ${q.track}`.trim() })) consider(r, q);
    }
  }
  return best.r;
}

export type LyricsState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "found"; key: string; lyrics: Lyrics; offsetMs: number }
  | { status: "notfound"; key: string }
  | { status: "error"; key: string; error: string };

/** Lyrics the user synced themselves (sync editor). */
export function localLyrics(lrc: string, np: Pick<NowPlaying, "title" | "artist" | "durationMs">): Lyrics {
  const lines = parseLrc(lrc, np.durationMs).map((l) => ({ ...l, exactEnds: !!l.words }));
  return { kind: wordCoverage(lines) >= 0.5 ? "word" : "line", lines, source: "local", id: 0, trackName: np.title, artistName: np.artist, durationMs: np.durationMs };
}

export async function loadLyrics(np: NowPlaying, force = false, lookup?: Partial<NowPlaying>): Promise<Lyrics | null> {
  const key = songKey(np);
  // Exact metadata (e.g. Spotify Web API) is used for searching; keys stay on the player's metadata.
  if (lookup) np = { ...np, ...lookup };
  // During a web-player ad the song's title comes with the ad's duration: look up without it.
  if (getSettings().sources?.skipAds !== false && maybeAdLength(np)) np = { ...np, durationMs: 0 };
  const prefs = await songs.get(key);
  if (prefs?.localLrc?.trim()) return localLyrics(prefs.localLrc, np);
  if (prefs?.pinId) {
    const pinned = await cache.get(`id:${prefs.pinId}`);
    const rec = pinned?.record ?? (await lrclib.getById(prefs.pinId));
    if (rec) {
      if (!pinned) await cache.set(`id:${prefs.pinId}`, { at: Date.now(), record: slim(rec) });
      return recordToLyrics(rec);
    }
  }
  const hit = force ? undefined : await cache.get(key);
  const fresh = hit && (hit.record || hit.amll || Date.now() - hit.at < NEGATIVE_TTL);
  const entry: CacheEntry = fresh ? { ...hit } : { at: Date.now(), record: await findRecord(np).then((r) => (r ? slim(r) : null)) };
  const fromLrclib = entry.record ? recordToLyrics(entry.record) : null;

  // No real word timing from LRCLIB? Try the community word-synced database.
  if (getSettings().provider?.amll !== false && (!fromLrclib || fromLrclib.kind !== "word")) {
    if (entry.amll === undefined) {
      try {
        entry.amll = await findAmll(np);
      } catch {
        // network / server problem: leave undefined so it's retried next time
      }
    }
    if (entry.amll) {
      try {
        const am = amllToLyrics(entry.amll, np);
        if (am.lines.length) {
          if (!fresh || hit?.amll === undefined) await cache.set(key, entry);
          return am;
        }
      } catch {
        entry.amll = null; // unreadable file: don't try it again
      }
    }
  }
  if (!fresh || hit?.amll !== entry.amll) {
    await cache.set(key, entry);
    void prune();
  }
  return fromLrclib;
}

/** Save (or clear) lyrics the user synced themselves; the lyrics window picks them up immediately. */
export async function setLocalLyrics(np: Pick<NowPlaying, "title" | "artist">, lrc: string | undefined) {
  const key = songKey(np);
  await songs.set(key, { ...(await songs.get(key)), localLrc: lrc });
  await changed(key);
}

/** Forget all cached lyrics (pins and offsets are kept). */
export const clearLyricsCache = () => cache.clear();

/** Candidates for the manual search dialog (Step 10). */
export const searchCandidates = (q: string) => lrclib.search({ q });

// ---------- per-song preferences (pin + offset), synced across windows ----------
const prefListeners = new Set<(key: string) => void>();
let prefBridge = false;
function onSongPrefs(cb: (key: string) => void) {
  if (!prefBridge) {
    prefBridge = true;
    void platform.on<string>("song-prefs-changed", (k) => prefListeners.forEach((l) => l(k)));
  }
  prefListeners.add(cb);
  return () => void prefListeners.delete(cb);
}
async function changed(key: string) {
  if (isTauri()) await platform.emit("song-prefs-changed", key); // reaches every window, incl. this one
  else prefListeners.forEach((l) => l(key));
}

export async function pinLyrics(np: Pick<NowPlaying, "title" | "artist">, id: number | undefined) {
  const key = songKey(np);
  await songs.set(key, { ...(await songs.get(key)), pinId: id });
  await changed(key);
}

export async function setSongOffset(np: OffsetNp, offsetMs: number) {
  const key = songKey(np);
  await songs.set(key, { ...(await songs.get(key)), offsetMs: Math.round(offsetMs) });
  if (np.sourceKind) void recordCorrection(np.sourceKind, key, Math.round(offsetMs));
  await changed(key);
}

let offsetChain: Promise<unknown> = Promise.resolve();
/** Serialized read-modify-write so rapid hotkey presses (key repeat) never lose a step. */
export function adjustSongOffset(np: OffsetNp, deltaMs: number): Promise<number> {
  const run = async () => {
    // Start from what's shown: the song's own offset, else the learned default for its app.
    const cur = (await songs.get(songKey(np)))?.offsetMs ?? (np.sourceKind ? await learnedFor(np.sourceKind) : 0);
    await setSongOffset(np, cur + deltaMs);
    return cur + deltaMs;
  };
  const p = offsetChain.then(run, run);
  offsetChain = p.catch(() => undefined);
  return p;
}

/** Live per-song offset (ms) for the current song: its own, else the learned default for its app. */
export function useSongOffset(np: OffsetNp | null): number {
  const key = np ? songKey(np) : "";
  const source = np?.sourceKind;
  const [v, setV] = useState<{ key: string; ms: number | null }>({ key: "", ms: null });
  const learned = useLearnedOffset(source);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = () => void songs.get(key).then((p) => alive && setV({ key, ms: p?.offsetMs ?? null }));
    load();
    const off = onSongPrefs((k) => k === key && load());
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return v.key === key && v.ms !== null ? v.ms : learned;
}

/** Turn AI lyrics writing off (or back on) for one song; its AI lyrics are kept, just not shown. */
export async function setAiLyricsOff(np: Pick<NowPlaying, "title" | "artist">, off: boolean) {
  const key = songKey(np);
  await songs.set(key, { ...(await songs.get(key)), aiLyricsOff: off || undefined });
  await changed(key);
}

/** Live: are AI lyrics turned off for this song? (null while loading) */
export function useAiLyricsOff(np: Pick<NowPlaying, "title" | "artist"> | null): boolean | null {
  const key = np ? songKey(np) : "";
  const [v, setV] = useState<{ key: string; off: boolean } | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = () => void songs.get(key).then((p) => alive && setV({ key, off: !!p?.aiLyricsOff }));
    load();
    const off = onSongPrefs((k) => k === key && load());
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return v?.key === key ? v.off : null;
}

/** React hook: lyrics for the current track (refetches on track change). */
export function useLyrics(np: NowPlaying | null): LyricsState {
  const key = np ? songKey(np) : "";
  const [state, setState] = useState<LyricsState>({ status: "idle" });
  const [version, setVersion] = useState(0);
  const latest = useRef(np);
  latest.current = np;
  useEffect(() => onSongPrefs((k) => k === key && setVersion((v) => v + 1)), [key]);
  // Offline / LRCLIB down or rate-limiting: try again when the connection returns, and every 30 s.
  const failed = state.status === "error";
  useEffect(() => {
    if (!failed) return;
    const retry = () => setVersion((v) => v + 1);
    window.addEventListener("online", retry);
    const t = setTimeout(retry, RETRY_MS);
    return () => {
      window.removeEventListener("online", retry);
      clearTimeout(t);
    };
  }, [failed, version]);
  useEffect(() => {
    if (!np || !key) {
      setState({ status: "idle" });
      return;
    }
    let alive = true;
    // A retry after an error keeps the message up until it works (no shimmer flashing every 30 s).
    setState((s) => (s.status === "error" && s.key === key ? s : { status: "loading", key }));
    (async () => {
      try {
        // Sources often publish the title before duration/album: wait briefly, then use the latest metadata.
        await new Promise((r) => setTimeout(r, 400));
        for (let i = 0; i < 6 && alive && !(latest.current?.durationMs ?? 0); i++) await new Promise((r) => setTimeout(r, 250));
        if (!alive) return;
        const cur = latest.current && songKey(latest.current) === key ? latest.current : np;
        const lyrics = await loadLyrics(cur, false, await spotifyLookup(cur));
        const offsetMs = (await songs.get(key))?.offsetMs ?? 0;
        if (!alive) return;
        setState(lyrics ? { status: "found", key, lyrics, offsetMs } : { status: "notfound", key });
      } catch (e) {
        if (alive) setState({ status: "error", key, error: String(e) });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the song (or its pin) changes
  }, [key, version]);
  return state;
}
