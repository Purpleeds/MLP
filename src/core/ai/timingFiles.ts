// Saved AI timing (auto-sync): one readable JSON file per song in "<app data>\ai\timing\".
// The files are the source of truth. Older versions kept the timing in songs.json (`aiSync`): that is
// still read as a fallback and moved into a file the first time the song plays (the songs.json copy
// is dropped only after the file was written).
import type { NowPlaying } from "../playback/clock";
import type { Lyrics } from "../lyrics/model";
import { songKey, songs } from "../lyrics/service";
import { displayMeta } from "../display";
import { isTauri, platform } from "../platform";
import { translationFileName } from "../translationFiles";
import type { LineFix, SavedSync, SyncLine, TimeMap } from "./autosync";

export const TIMING_FORMAT = "MLP AI timing";

export type SongId = Pick<NowPlaying, "title" | "artist" | "album" | "sourceKind">;

/** Title / artist as shown (YouTube "Artist - Song (Official Video)" cleaned up) — same as saved translations. */
export const songMeta = (np: SongId) => displayMeta(np);

// ---------- file names ----------
/** "<title> - <artist>.json"; `n` ≥ 2 → "<title> - <artist> (n).json" for a different song with the same name. */
export function timingFileName(title: string, artist?: string, n = 1): string {
  const base = translationFileName(title, artist).replace(/\.txt$/, "");
  return n > 1 ? `${base} (${n}).json` : `${base}.json`;
}
/** Names tried for one song: the plain one, then numbered ones for name collisions. */
export const MAX_NAMES = 5;
export const timingFileNames = (title: string, artist?: string) =>
  Array.from({ length: MAX_NAMES }, (_, i) => timingFileName(title, artist, i + 1));

// ---------- content ----------
export interface TimingFileData {
  format: typeof TIMING_FORMAT;
  version: 1;
  song: string;
  artist: string;
  /** songs.json key (normalized "artist|title"): tells two songs with the same file name apart */
  songKey: string;
  /** fingerprint of the lyrics this timing belongs to (other lyrics → the file is not used) */
  lyricsSig: string;
  savedAt: string;
  linesAligned: number;
  linesTotal: number;
  timeMap: { tempo: number; offsetMs: number; about: string };
  anchors: { line: number; lyricsMs: number; sungMs: number }[];
  lines: {
    line: number;
    text: string;
    lyricsMs: [number, number];
    /** null = not lined up (yet) */
    sungMs: [number, number] | null;
    score?: number;
    words?: { word: string; sungMs: [number, number] | null }[];
  }[];
}

export interface TimingInput {
  song: string;
  artist: string;
  songKey: string;
  sig: string;
  lyrics: Lyrics;
  lines: SyncLine[];
  fixes: Record<number, LineFix>;
  map: TimeMap;
  savedAt?: Date;
}

export function timingData(t: TimingInput): TimingFileData {
  const fixed = t.lines.filter((l) => t.fixes[l.idx]);
  return {
    format: TIMING_FORMAT,
    version: 1,
    song: t.song,
    artist: t.artist,
    songKey: t.songKey,
    lyricsSig: t.sig,
    savedAt: (t.savedAt ?? new Date()).toISOString(),
    linesAligned: fixed.length,
    linesTotal: t.lines.length,
    timeMap: {
      tempo: +t.map.a.toFixed(4),
      offsetMs: Math.round(t.map.b),
      about: "sung time ≈ lyrics time × tempo + offset; line numbers count from 1",
    },
    anchors: t.map.anchors.map((a) => ({
      line: (t.lines.find((l) => l.start === a.exp && t.fixes[l.idx]?.start === a.act)?.idx ?? -1) + 1,
      lyricsMs: Math.round(a.exp),
      sungMs: Math.round(a.act),
    })),
    lines: t.lines.map((l) => {
      const f = t.fixes[l.idx];
      const base = { line: l.idx + 1, text: t.lyrics.lines[l.idx]?.text ?? "", lyricsMs: [Math.round(l.start), Math.round(l.end)] as [number, number] };
      if (!f) return { ...base, sungMs: null };
      return {
        ...base,
        sungMs: [f.start, f.end],
        score: f.score,
        words: l.words.map((word, k) => ({ word, sungMs: f.words[k] ?? null })),
      };
    }),
  };
}

/** Pretty JSON that keeps small objects / arrays on one line (one word per line, not four). */
export function prettyJson(v: unknown, indent = "", width = 110): string {
  const flat = inline(v);
  if (flat.length + indent.length <= width || v === null || typeof v !== "object") return flat;
  const next = indent + "  ";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[\n${v.map((x) => next + prettyJson(x, next, width)).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  return `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${prettyJson(x, next, width)}`).join(",\n")}\n${indent}}`;
}
function inline(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")} }` : "{}";
}

export const formatTiming = (t: TimingInput) => prettyJson(timingData(t)) + "\n";

const isPair = (x: unknown): x is [number, number] =>
  Array.isArray(x) && x.length === 2 && x.every((n) => typeof n === "number" && Number.isFinite(n));

/** File text → who it belongs to + the line fixes (hand edits that break a line skip that line). */
export function parseTiming(text: string): { songKey: string; sig: string; fixes: Record<number, LineFix> } | null {
  let d: Partial<TimingFileData>;
  try {
    d = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (!d || d.format !== TIMING_FORMAT || d.version !== 1 || typeof d.songKey !== "string" || typeof d.lyricsSig !== "string") return null;
  const fixes: Record<number, LineFix> = {};
  for (const l of Array.isArray(d.lines) ? d.lines : []) {
    if (!l || !Number.isInteger(l.line) || l.line < 1 || !isPair(l.sungMs)) continue;
    fixes[l.line - 1] = {
      start: l.sungMs[0],
      end: l.sungMs[1],
      words: Array.isArray(l.words) ? l.words.map((w) => (w && isPair(w.sungMs) ? w.sungMs : null)) : [],
      score: typeof l.score === "number" ? l.score : 0,
    };
  }
  return { songKey: d.songKey, sig: d.lyricsSig, fixes };
}

// ---------- storage ----------
export interface TimingStore {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  count(): Promise<number>;
  clear(): Promise<number>;
}

const MOCK_PREFIX = "mlp.ai-timing.";
const mockKeys = () => {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith(MOCK_PREFIX));
  } catch {
    return [];
  }
};
/** Rust commands in the app (`timing_*`), localStorage in mock mode. */
export const timingStore: TimingStore = isTauri()
  ? {
      read: async (name) => (await platform.invoke<string | null>("timing_read", { name })) ?? null,
      write: async (name, text) => void (await platform.invoke("timing_write", { name, text })),
      remove: async (name) => void (await platform.invoke("timing_delete", { name })),
      count: async () => (await platform.invoke<number>("timing_count")) ?? 0,
      clear: async () => (await platform.invoke<number>("timing_clear")) ?? 0,
    }
  : {
      read: async (name) => {
        try {
          return localStorage.getItem(MOCK_PREFIX + name);
        } catch {
          return null;
        }
      },
      write: async (name, text) => {
        try {
          localStorage.setItem(MOCK_PREFIX + name, text);
        } catch {
          /* unavailable */
        }
      },
      remove: async (name) => {
        try {
          localStorage.removeItem(MOCK_PREFIX + name);
        } catch {
          /* unavailable */
        }
      },
      count: async () => mockKeys().length,
      clear: async () => {
        const keys = mockKeys();
        try {
          keys.forEach((k) => localStorage.removeItem(k));
        } catch {
          /* unavailable */
        }
        return keys.length;
      },
    };

/** The legacy songs.json copy (only read; dropped once a file holds the timing). */
export interface LegacyStore {
  get(key: string): Promise<SavedSync | undefined>;
  drop(key: string): Promise<void>;
}
const legacySongs: LegacyStore = {
  get: async (key) => (await songs.get(key))?.aiSync,
  drop: async (key) => {
    const p = await songs.get(key);
    if (p?.aiSync) await songs.set(key, { ...p, aiSync: undefined });
  },
};

export interface TimingDeps {
  files?: TimingStore;
  legacy?: LegacyStore;
}

interface Found {
  name: string;
  sig: string;
  fixes: Record<number, LineFix>;
}

/** This song's file (matched by songKey among the numbered names), or the first free name for it. */
async function locate(id: SongId, files: TimingStore): Promise<{ found: Found | null; free: string | null }> {
  const m = songMeta(id);
  const key = songKey(id);
  let free: string | null = null;
  for (const name of timingFileNames(m.title, m.artist)) {
    const text = await files.read(name).catch(() => null);
    if (text == null) {
      free ??= name;
      continue;
    }
    const p = parseTiming(text);
    if (p?.songKey === key) return { found: { name, sig: p.sig, fixes: p.fixes }, free };
    // Someone else's file, or one we can't read (hand-edited): never overwrite it.
  }
  return { found: null, free };
}

export interface LoadedTiming {
  fixes: Record<number, LineFix>;
  /** came from songs.json (no file yet): the caller saves it as a file */
  legacy: boolean;
}

/** Saved timing for this song and these lyrics: the file first, then the old songs.json copy. */
export async function loadTiming(id: SongId, sig: string, deps: TimingDeps = {}): Promise<LoadedTiming | null> {
  const files = deps.files ?? timingStore;
  const { found } = await locate(id, files);
  if (found) return found.sig === sig ? { fixes: found.fixes, legacy: false } : null;
  const old = await (deps.legacy ?? legacySongs).get(songKey(id)).catch(() => undefined);
  return old?.v === 1 && old.sig === sig && Object.keys(old.fixes).length ? { fixes: old.fixes, legacy: true } : null;
}

export interface SaveTiming {
  id: SongId;
  sig: string;
  lyrics: Lyrics;
  lines: SyncLine[];
  fixes: Record<number, LineFix>;
  map: TimeMap;
}

/** Write (or with no fixes: delete) this song's timing file; then drop the old songs.json copy. */
export async function saveTiming(s: SaveTiming, deps: TimingDeps = {}): Promise<string | null> {
  const files = deps.files ?? timingStore;
  const key = songKey(s.id);
  const { found, free } = await locate(s.id, files);
  if (!Object.keys(s.fixes).length) {
    if (found) await files.remove(found.name);
    return null;
  }
  const name = found?.name ?? free;
  if (!name) {
    platform.log(`[sync] no free timing file name for ${key}`);
    return null;
  }
  const m = songMeta(s.id);
  await files.write(name, formatTiming({ song: m.title, artist: m.artist, songKey: key, ...s }));
  await (deps.legacy ?? legacySongs).drop(key).catch(() => undefined);
  return name;
}

/** Forget this song's AI timing: its file and any songs.json copy. `only` limits it to some lyrics. */
export async function removeTiming(id: SongId, only: (sig: string) => boolean = () => true, deps: TimingDeps = {}) {
  const files = deps.files ?? timingStore;
  const legacy = deps.legacy ?? legacySongs;
  const key = songKey(id);
  const { found } = await locate(id, files);
  if (found && only(found.sig)) await files.remove(found.name);
  const old = await legacy.get(key).catch(() => undefined);
  if (old && only(old.sig)) await legacy.drop(key);
}

/** Every saved AI timing file. Returns how many were removed. */
export const clearAllTiming = (files: TimingStore = timingStore) => files.clear();
export const countTiming = (files: TimingStore = timingStore) => files.count().catch(() => 0);
export const openTimingFolder = () => platform.invoke<string>("timing_open_folder");
