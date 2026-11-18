// Step 16 — AI lyrics engine (main window): while a song that no database has plays, transcribe what
// has been captured in ~28 s chunks (Whisper via Rust `ai_transcribe`), filter hallucinations, build
// timed lines and keep them per song (songs.json `aiLyrics`). Auto-sync (Step 15) then adds word timing.
// Every play is a new pass: passes are merged (passes.ts), settled stretches are skipped, and lines
// fixed by hand always win.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isTauri, platform } from "../platform";
import { getSettings, updateSettings } from "../settings/store";
import { trackKey, type NowPlaying } from "../playback/clock";
import type { LyricLine, Lyrics } from "../lyrics/model";
import { songKey, songs } from "../lyrics/service";
import { removeTiming, type SongId } from "./timingFiles";
import { detectedLanguage, filterSegments, missingWhisper, nextChunk, segmentsFrom, segmentsToLines, settle, sizeText, type AssetInfo, type WhisperJson } from "./transcribe";
import { addHandFixes, canSkip, handFixes, lockedShare, MAX_PASSES, mergePasses, settled, type AiLine, type AiPass, type HandFix } from "./passes";
import { tunedModelFor } from "./training";

/** Version 1 (one transcript per song, before plays were merged). */
interface SavedAiLyricsV1 {
  v: 1;
  lines: LyricLine[];
  doneTo: number;
  lang: string | null;
  complete: boolean;
  model: string;
}

export interface SavedAiLyrics {
  v: 2;
  /** one per play, oldest first (at most MAX_PASSES) */
  passes: AiPass[];
  hand: HandFix[];
  /** the merged lines (what's shown) */
  lines: AiLine[];
  lang: string | null;
  /** nothing more to learn: no more passes */
  settled: boolean;
  model: string;
}

/** Saved AI lyrics of any version → version 2 (an old transcript becomes the first pass). */
export function upgradeSaved(x: SavedAiLyrics | SavedAiLyricsV1 | undefined, model: string): SavedAiLyrics {
  if (x?.v === 2) return x;
  if (x?.v === 1) {
    const pass: AiPass = { at: 0, model: x.model, spans: [[0, x.doneTo]], cands: x.lines.map((l) => ({ start: l.start, end: l.end, text: l.text, conf: 0.5 })), doneTo: x.doneTo, complete: x.complete };
    return { v: 2, passes: [pass], hand: [], lines: mergePasses([pass]), lang: x.lang, settled: false, model: x.model };
  }
  return { v: 2, passes: [], hand: [], lines: [], lang: null, settled: false, model };
}

const newPass = (model: string): AiPass => ({ at: Date.now(), model, spans: [], cands: [], doneTo: 0, complete: false });

export interface AiLyricsStatus {
  /** the engine is running for the current song (it has no lyrics anywhere) */
  active?: boolean;
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
  /** which play of this song (1 = first) and how many lines are locked in */
  pass?: number;
  locked?: number;
  /** written with the model trained on this PC's songs */
  tuned?: boolean;
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

const doneText = (d: SavedAiLyrics) => {
  const n = d.passes.length;
  const share = Math.round(lockedShare(d.lines) * 100);
  if (d.settled) return n > 1 ? `Finished: ${n} plays, ${share} % of lines agree.` : "Finished this song.";
  return n > 1 ? `Play ${n} done (${share} % of lines agree). The next play checks the rest.` : "Done for this play. The next play checks the lines again.";
};

/** Put a chunk's result (or a skip) into the current pass and merge everything again. */
function finishChunk(pass: AiPass, lang: string | null) {
  if (!data) return;
  const passes = [...data.passes.slice(0, -1), pass];
  const lines = mergePasses(passes, data.hand);
  data = { ...data, passes, lines, lang, settled: pass.complete && settled(passes, lines), model: pass.model };
  notify();
  save();
  setStatus({
    phase: pass.complete ? "done" : "listening",
    detail: pass.complete ? doneText(data) : "Listening…",
    lines: lines.length,
    locked: lines.filter((l) => l.locked).length,
    pass: passes.length,
  });
}

async function tick() {
  if (busy || !ctx || !data) return;
  const s = getSettings();
  if (!s.ai.lyrics) return setStatus({ phase: "off", need: undefined, detail: "AI lyrics are off." });
  if (data.settled) return setStatus({ phase: "done", need: undefined, download: undefined, detail: doneText(data) });
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
  const pass = data.passes[data.passes.length - 1];
  if (pass.complete) return setStatus({ phase: "done", detail: doneText(data) });
  const chunk = nextChunk(pass.doneTo, ranges, stalled, c.np.durationMs);
  if (!chunk) return setStatus({ phase: "listening", detail: vocals ? "Waiting for isolated vocals…" : "Listening…", lines: data.lines.length });
  // A later play: stretches every earlier play agrees on are skipped.
  if (canSkip(data.lines, data.passes, chunk.from, chunk.to)) {
    finishChunk({ ...pass, doneTo: chunk.to, complete: chunk.final }, data.lang);
    if (chunk.to >= end - 50) flushedAt = end;
    return;
  }

  busy = true;
  const gpuNote = firstGpu && s.ai.whisperRuntime !== "cpu" ? " (the first run on the GPU takes about a minute)" : "";
  setStatus({ phase: "transcribing", detail: `Writing lyrics for ${Math.round(chunk.from / 1000)}–${Math.round(chunk.to / 1000)} s…${gpuNote}` });
  try {
    // Context: the line just before this chunk (from any play), once the language is known.
    const last = [...data.lines].reverse().find((l) => l.start < chunk.from);
    const tuned = s.ai.useTuned ? await tunedModelFor(s) : null;
    const json = await platform.invoke<WhisperJson & { runtime?: string; source?: "vocals" | "mix"; tookMs?: number; tuned?: boolean }>("ai_transcribe", {
      req: {
        key: c.cap,
        fromMs: chunk.from,
        toMs: chunk.to,
        vocals,
        language: data.lang,
        prompt: data.lang && last ? last.text.slice(-120) : null,
        model: s.ai.whisperModel,
        runtime: s.ai.whisperRuntime,
        tunedModel: tuned,
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
    const cur = data.passes[data.passes.length - 1];
    const cands = segmentsToLines(kept).map((l) => ({ start: l.start, end: l.end, text: l.text, conf: l.conf }));
    const model = json.tuned ? "tuned" : s.ai.whisperModel;
    finishChunk({ ...cur, model, cands: [...cur.cands, ...cands], spans: [...cur.spans, [chunk.from, doneTo]], doneTo, complete: chunk.final }, lang);
    const d = data!;
    platform.log(`[ai-lyrics] pass ${d.passes.length} ${(chunk.from / 1000).toFixed(0)}–${(chunk.to / 1000).toFixed(0)} s: ${kept.length}/${segs.length} segments kept, ${d.lines.length} lines (${d.lines.filter((l) => l.locked).length} locked) · ${json.runtime} ${json.source} ${json.tookMs} ms${json.tuned ? " tuned" : ""} · lang ${lang ?? "?"}`);
    setStatus({ runtime: json.runtime, source: json.source, tookMs: json.tookMs, lang, tuned: !!json.tuned });
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
  const model = getSettings().ai.whisperModel;
  data = upgradeSaved(saved, model);
  // A new play of a song that isn't settled: start another pass (one play = one pass).
  const last = data.passes[data.passes.length - 1];
  const again = !last || (last.complete && getSettings().ai.improveEachPlay);
  if (!data.settled && again) {
    data = { ...data, passes: [...data.passes, newPass(model)].slice(-MAX_PASSES) };
    if (last) platform.log(`[ai-lyrics] play ${data.passes.length} of this song: checking the lines again`);
  }
  const listen = getSettings().ai.listen;
  setStatus({
    active: true,
    phase: listen ? "listening" : "off",
    need: listen ? undefined : "listen",
    download: undefined,
    detail: listen ? "Listening…" : "Turn on “Listen to the player” to write lyrics with AI.",
    lines: data.lines.length,
    lang: data.lang,
    pass: data.passes.length,
    locked: data.lines.filter((l) => l.locked).length,
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
  setStatus({ active: false, phase: "off", detail: "", lines: 0, need: undefined, download: undefined });
}

let bridged = false;
function bridge() {
  if (bridged || !isTauri()) return;
  bridged = true;
  void platform.on("ai-lyrics-status-request", () => void platform.emit("ai-lyrics-status", status));
  void platform.on<string>("ai-lyrics-forget", (key) => {
    if (ctx && ctx.song === key) void start(ctx.np);
  });
  // Settings saved hand corrections for the playing song: merge them in (and save) right away.
  void platform.on<{ key: string; hand: HandFix[] }>("ai-lyrics-hand", ({ key, hand }) => {
    if (!ctx || ctx.song !== key || !data) return;
    data = { ...data, hand, lines: mergePasses(data.passes, hand) };
    notify();
    save();
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

/**
 * Settings: hand corrections of a song's AI lyrics (one edited line per line; "" removes it).
 * `allCorrect` marks every line as checked, not only the changed ones. Hand-fixed lines are final
 * and count as ground truth for training.
 */
export async function correctAiLyrics(np: SongId, edited: string[], allCorrect: boolean): Promise<number> {
  const key = songKey(np);
  const prefs = await songs.get(key);
  const saved = prefs?.aiLyrics ? upgradeSaved(prefs.aiLyrics, prefs.aiLyrics.model) : null;
  if (!saved?.lines.length) throw new Error("This song has no AI lyrics yet.");
  const fresh = handFixes(saved.lines, edited, allCorrect);
  const hand = addHandFixes(saved.hand, fresh);
  await songs.set(key, { ...prefs, aiLyrics: { ...saved, hand, lines: mergePasses(saved.passes, hand) } });
  if (isTauri()) await platform.emit("ai-lyrics-hand", { key, hand });
  return fresh.length;
}

/** Settings: throw away a song's AI lyrics (and their auto-sync); the main window starts over. */
export async function forgetAiLyrics(np: SongId) {
  const key = songKey(np);
  await removeTiming(np, (sig) => sig.startsWith("ai:")); // timing of the AI lyrics only
  const prefs = await songs.get(key);
  if (prefs) await songs.set(key, { ...prefs, aiLyrics: undefined });
  if (isTauri()) await platform.emit("ai-lyrics-forget", key);
}
