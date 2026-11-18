// Step 16 — AI lyrics engine (main window): while a song that no database has plays, transcribe what
// has been captured in ~28 s chunks (Whisper via Rust `ai_transcribe`), filter hallucinations, build
// timed lines and keep them per song (songs.json `aiLyrics`). Auto-sync (Step 15) then adds word timing.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isTauri, platform } from "../platform";
import { getSettings, updateSettings } from "../settings/store";
import { trackKey, type NowPlaying } from "../playback/clock";
import type { LyricLine, Lyrics } from "../lyrics/model";
import { songKey, songs } from "../lyrics/service";
import { removeTiming, type SongId } from "./timingFiles";
import { detectedLanguage, filterSegments, missingWhisper, nextChunk, segmentsFrom, segmentsToLines, settle, sizeText, type AssetInfo, type WhisperJson } from "./transcribe";

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
  /** what's missing before MLP can write lyrics: listening is off, or Whisper isn't downloaded yet */
  need?: "listen" | "download";
  /** with need "download": what to download and how big it is */
  download?: { ids: string[]; mb: number; busy: boolean };
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

/** Last look at which Whisper files are missing (asking runs nvidia-smi, so not every tick). */
let assets: { key: string; at: number; missing: AssetInfo[] } | null = null;
let setupBusy = false;

/** Whisper files the settings need that aren't downloaded yet ([] = ready; also [] when we can't tell). */
async function missingNow(runtime: string, model: string): Promise<AssetInfo[]> {
  const key = `${runtime}/${model}`;
  // Complete stays complete; missing is looked at again every 5 s (Settings may be downloading).
  if (assets?.key === key && (!assets.missing.length || Date.now() - assets.at < 5_000)) return assets.missing;
  const st = await platform.invoke<{ gpu: string | null; assets: AssetInfo[] }>("ai_status").catch(() => undefined);
  assets = { key, at: Date.now(), missing: st ? missingWhisper(st.assets, st.gpu, runtime, model) : [] };
  return assets.missing;
}

const downloadInfo = (missing: AssetInfo[]) =>
  missing.length ? { ids: missing.map((a) => a.id), mb: missing.reduce((n, a) => n + a.sizeMb, 0), busy: missing.some((a) => a.downloading) } : undefined;

/**
 * Lyric view button: turn on listening and download whatever Whisper still needs, so AI lyrics can
 * start. Progress shows in the status; the engine picks up on its next tick.
 */
export async function setUpAiLyrics(): Promise<void> {
  if (setupBusy) return;
  if (!getSettings().ai.listen) await updateSettings("ai.listen", true);
  const s = getSettings();
  const st = await platform.invoke<{ gpu: string | null; assets: AssetInfo[] }>("ai_status").catch(() => undefined);
  const missing = st ? missingWhisper(st.assets, st.gpu, s.ai.whisperRuntime, s.ai.whisperModel) : [];
  if (!missing.length) {
    setStatus({ phase: "listening", need: undefined, download: undefined, detail: "Listening…" });
    return;
  }
  setupBusy = true;
  const waiting = new Map<string, { ok: () => void; fail: (e: string) => void }>();
  const off = await platform.on<{ id: string; received: number; total: number; done: boolean; error: string | null }>("ai-download", (p) => {
    const a = missing.find((m) => m.id === p.id);
    if (!a) return;
    if (p.done) waiting.get(p.id)?.ok();
    else if (p.error) waiting.get(p.id)?.fail(p.error);
    else if (p.total) setStatus({ phase: "off", need: "download", detail: `Downloading ${a.name}… ${Math.round((p.received / p.total) * 100)} %` });
  });
  try {
    for (const a of missing) {
      setStatus({ phase: "off", need: "download", detail: `Downloading ${a.name}…` });
      const finished = new Promise<void>((ok, fail) => waiting.set(a.id, { ok, fail }));
      finished.catch(() => undefined); // only awaited when Settings already started it
      // Already downloading (started in Settings): wait for that download to finish.
      await platform.invoke("ai_download", { id: a.id }).catch((e) => {
        if (String(e).includes("already downloading")) return finished;
        throw e;
      });
    }
    assets = null;
    setStatus({ phase: "listening", need: undefined, download: undefined, detail: "Listening…" });
  } catch (e) {
    assets = null;
    setStatus({ phase: "error", need: "download", detail: `Download failed: ${e}` });
  } finally {
    setupBusy = false;
    off();
  }
}

async function tick() {
  if (busy || !ctx || !data) return;
  const s = getSettings();
  if (!s.ai.lyrics) return setStatus({ phase: "off", need: undefined, detail: "AI lyrics are off." });
  if (data.complete) return setStatus({ phase: "done", need: undefined, download: undefined, detail: "Finished this song." });
  if (setupBusy || (status.phase === "error" && status.need)) return; // a failed download stays on screen until "Try again"
  const missing = await missingNow(s.ai.whisperRuntime, s.ai.whisperModel);
  if (!ctx || !data) return;
  if (!s.ai.listen) return setStatus({ phase: "off", need: "listen", download: downloadInfo(missing), detail: "Turn on “Listen to the player” to write lyrics with AI." });
  if (missing.length) {
    const dl = downloadInfo(missing)!;
    const detail = dl.busy ? "Downloading Whisper…" : `Whisper isn't downloaded yet (${sizeText(dl.mb)}, once).`;
    return setStatus({ phase: "off", need: "download", download: dl, detail });
  }
  if (status.need) setStatus({ need: undefined, download: undefined });
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
  const listen = getSettings().ai.listen;
  setStatus({
    phase: listen ? "listening" : "off",
    need: listen ? undefined : "listen",
    download: undefined,
    detail: listen ? "Listening…" : "Turn on “Listen to the player” to write lyrics with AI.",
    lines: data.lines.length,
    lang: data.lang,
  });
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
  setStatus({ phase: "off", detail: "", lines: 0, need: undefined, download: undefined });
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
