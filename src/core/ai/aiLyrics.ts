// Step 16 — AI lyrics engine (main window): while a song that no database has plays, transcribe what
// has been captured in ~28 s chunks (Whisper via Rust `ai_transcribe`), filter hallucinations, build
// timed lines and keep them per song (songs.json `aiLyrics`). Auto-sync (Step 15) then adds word timing.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isTauri, platform } from "../platform";
import { getSettings } from "../settings/store";
import { trackKey, type NowPlaying } from "../playback/clock";
import type { LyricLine, Lyrics } from "../lyrics/model";
import { songKey, songs } from "../lyrics/service";
import { removeTiming, type SongId } from "./timingFiles";
import { detectedLanguage, filterSegments, nextChunk, segmentsFrom, segmentsToLines, settle, type WhisperJson } from "./transcribe";

export interface SavedAiLyrics {
  v: 1;
  lines: LyricLine[];
  /** everything before this (ms) has been transcribed */
  doneTo: number;
  lang: string | null;
  complete: boolean;
  model: string;
}

export interface AiLyricsStatus {
  phase: "off" | "listening" | "transcribing" | "paused" | "done" | "error";
  detail: string;
  lines: number;
  runtime?: string;
  source?: "vocals" | "mix";
  tookMs?: number;
  lang?: string | null;
}

interface Ctx {
  np: NowPlaying;
  song: string;
  cap: string;
}

const TICK_MS = 2_000;
const LOCK_P = 0.7;

let ctx: Ctx | null = null;
let data: SavedAiLyrics | null = null;
let status: AiLyricsStatus = { phase: "off", detail: "", lines: 0 };
const listeners = new Set<() => void>();
let timer = 0;
let busy = false;
let gen = 0;
let backoffUntil = 0;
let lastEnd = 0;
let lastGrowth = 0;
let flushedAt = -1;
let saveTimer = 0;
let firstGpu = true;

const notify = () => listeners.forEach((l) => l());
function setStatus(p: Partial<AiLyricsStatus>) {
  const next = { ...status, ...p };
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next;
  notify();
  if (isTauri()) void platform.emit("ai-lyrics-status", status);
}

function save() {
  if (!ctx || !data) return;
  const { song } = ctx;
  const d = data;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    saveTimer = 0;
    await songs.set(song, { ...(await songs.get(song)), aiLyrics: d });
  }, 1_500);
}

interface Coverage {
  song: string | null;
  covered?: [number, number][];
  isolated?: [number, number][];
}

async function tick() {
  if (busy || !ctx || !data) return;
  const s = getSettings();
  if (!s.ai.lyrics) return setStatus({ phase: "off", detail: "AI lyrics are off." });
  if (!s.ai.listen) return setStatus({ phase: "off", detail: "Turn on “Listen to the player” to write lyrics with AI." });
  if (data.complete) return setStatus({ phase: "done", detail: "Finished this song." });
  if (Date.now() < backoffUntil) return;
  if (s.ai.pauseFullscreen && (await platform.invoke<boolean>("ai_busy").catch(() => false))) return setStatus({ phase: "paused", detail: "Paused while a full-screen app runs." });

  const my = gen;
  const c = ctx;
  const vocals = s.ai.isolateVocals;
  const cov = await platform.invoke<Coverage>(vocals ? "vocals_status" : "capture_status").catch(() => undefined);
  if (my !== gen || !data) return;
  const ranges = cov?.song === c.cap ? ((vocals ? cov.isolated : cov.covered) ?? []) : [];
  const end = Math.max(0, ...ranges.map(([, b]) => b));
  if (end !== lastEnd) {
    lastEnd = end;
    lastGrowth = Date.now();
  }
  // Paused / stopped growing: flush what's there once, then wait for new audio.
  const stalled = Date.now() - lastGrowth > 6_000 && end !== flushedAt;
  const chunk = nextChunk(data.doneTo, ranges, stalled, c.np.durationMs);
  if (!chunk) return setStatus({ phase: "listening", detail: vocals ? "Waiting for isolated vocals…" : "Listening…", lines: data.lines.length });

  busy = true;
  const gpuNote = firstGpu && s.ai.whisperRuntime !== "cpu" ? " (the first run on the GPU takes about a minute)" : "";
  setStatus({ phase: "transcribing", detail: `Writing lyrics for ${Math.round(chunk.from / 1000)}–${Math.round(chunk.to / 1000)} s…${gpuNote}` });
  try {
    const last = data.lines[data.lines.length - 1];
    const json = await platform.invoke<WhisperJson & { runtime?: string; source?: "vocals" | "mix"; tookMs?: number }>("ai_transcribe", {
      req: {
        key: c.cap,
        fromMs: chunk.from,
        toMs: chunk.to,
        vocals,
        language: data.lang,
        prompt: data.lang && last ? last.text.slice(-120) : null,
        model: s.ai.whisperModel,
        runtime: s.ai.whisperRuntime,
      },
    });
    if (my !== gen || !json || !data) return;
    firstGpu = false;
    const segs = filterSegments(segmentsFrom(json, chunk.from));
    const { kept, doneTo } = settle(segs, chunk);
    if (chunk.to >= end - 50) flushedAt = end;
    const lang = data.lang ?? (() => {
      const d = detectedLanguage(json);
      return d && d.p >= LOCK_P && kept.length ? d.code : null;
    })();
    const lines = [...data.lines, ...segmentsToLines(kept)].sort((a, b) => a.start - b.start);
    data = { ...data, lines, doneTo, lang, complete: chunk.final, model: s.ai.whisperModel };
    notify();
    save();
    platform.log(`[ai-lyrics] ${(chunk.from / 1000).toFixed(0)}–${(chunk.to / 1000).toFixed(0)} s: ${kept.length}/${segs.length} segments kept, ${lines.length} lines · ${json.runtime} ${json.source} ${json.tookMs} ms · lang ${lang ?? "?"}`);
    setStatus({ phase: chunk.final ? "done" : "listening", detail: chunk.final ? "Finished this song." : "Listening…", lines: lines.length, runtime: json.runtime, source: json.source, tookMs: json.tookMs, lang });
  } catch (e) {
    backoffUntil = Date.now() + 15_000;
    platform.log(`[ai-lyrics] error: ${e}`);
    setStatus({ phase: "error", detail: String(e) });
  } finally {
    busy = false;
  }
}

async function start(np: NowPlaying) {
  const my = ++gen;
  const song = songKey(np);
  ctx = { np, song, cap: trackKey(np) };
  backoffUntil = 0;
  lastEnd = 0;
  flushedAt = -1;
  lastGrowth = Date.now();
  const saved = (await songs.get(song))?.aiLyrics;
  if (my !== gen) return;
  data = saved?.v === 1 ? saved : { v: 1, lines: [], doneTo: 0, lang: null, complete: false, model: getSettings().ai.whisperModel };
  setStatus({ phase: "listening", detail: "Listening…", lines: data.lines.length, lang: data.lang });
  notify();
  clearInterval(timer);
  timer = window.setInterval(() => void tick(), TICK_MS);
}

function stop() {
  if (saveTimer && ctx && data) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const { song } = ctx;
    const d = data;
    void songs.get(song).then((p) => songs.set(song, { ...p, aiLyrics: d }));
  }
  gen++;
  ctx = null;
  data = null;
  clearInterval(timer);
  timer = 0;
  setStatus({ phase: "off", detail: "", lines: 0 });
}

let bridged = false;
function bridge() {
  if (bridged || !isTauri()) return;
  bridged = true;
  void platform.on("ai-lyrics-status-request", () => void platform.emit("ai-lyrics-status", status));
  void platform.on<string>("ai-lyrics-forget", (key) => {
    if (ctx && ctx.song === key) void start(ctx.np);
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Lyric view: while `wanted` (no lyrics anywhere), write lyrics with AI; returns them as they grow. */
export function useAiLyrics(np: NowPlaying | null, wanted: boolean): Lyrics | null {
  const key = np ? trackKey(np) : "";
  useEffect(() => {
    if (!np || !wanted) return;
    bridge();
    void start(np);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per song
  }, [key, wanted]);
  useEffect(() => {
    if (ctx && np && trackKey(np) === ctx.cap) ctx.np = np;
  });
  const d = useSyncExternalStore(subscribe, () => data);
  return useMemo(
    () =>
      wanted && np && d && d.lines.length
        ? { kind: "line", lines: d.lines, source: "ai", id: 0, trackName: np.title, artistName: np.artist, durationMs: np.durationMs }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new object only when the lines change
    [d?.lines, wanted, key],
  );
}
export const useAiLyricsStatus = () => useSyncExternalStore(subscribe, () => status);

/** Settings: throw away a song's AI lyrics (and their auto-sync); the main window starts over. */
export async function forgetAiLyrics(np: SongId) {
  const key = songKey(np);
  await removeTiming(np, (sig) => sig.startsWith("ai:")); // timing of the AI lyrics only
  const prefs = await songs.get(key);
  if (prefs) await songs.set(key, { ...prefs, aiLyrics: undefined });
  if (isTauri()) await platform.emit("ai-lyrics-forget", key);
}
