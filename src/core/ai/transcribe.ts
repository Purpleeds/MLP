// Step 16 — AI lyrics: Whisper's output for captured song audio → filtered, timed lyric lines.
// Pure logic (tested); `aiLyrics.ts` runs it while a song without lyrics plays.
import type { LyricLine } from "../lyrics/model";

export interface WWord {
  text: string;
  start: number;
  end: number;
  p: number;
}
export interface Seg {
  /** song time (ms) */
  start: number;
  end: number;
  text: string;
  words: WWord[];
  avgLogprob: number;
  noSpeech: number;
}

export interface WhisperJson {
  segments?: {
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
    no_speech_prob?: number;
    words?: { word: string; start: number; end: number; probability?: number }[];
  }[];
  language_probabilities?: Record<string, number>;
}

/** Whisper verbose JSON (seconds, relative to the chunk) → segments in song time (ms). */
export function segmentsFrom(json: WhisperJson, offsetMs: number): Seg[] {
  return (json.segments ?? []).map((s) => ({
    start: Math.round(offsetMs + s.start * 1000),
    end: Math.round(offsetMs + s.end * 1000),
    text: s.text.trim(),
    words: (s.words ?? [])
      .filter((w) => w.word.trim() && !/^\[_?\w+_?\]$/.test(w.word.trim()))
      .map((w) => ({ text: w.word, start: Math.round(offsetMs + w.start * 1000), end: Math.round(offsetMs + w.end * 1000), p: w.probability ?? 1 })),
    avgLogprob: s.avg_logprob ?? 0,
    noSpeech: s.no_speech_prob ?? 0,
  }));
}

/** Most likely language of the chunk and how sure Whisper is. */
export function detectedLanguage(json: WhisperJson): { code: string; p: number } | null {
  const probs = Object.entries(json.language_probabilities ?? {});
  if (!probs.length) return null;
  const [code, p] = probs.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { code, p };
}

/** Typical Whisper hallucinations on music / silence (subtitle credits, outros, sound tags). */
const JUNK = new RegExp(
  [
    "thanks? (you )?for watching",
    "please subscribe",
    "like and subscribe",
    "subtitles? (by|made by|created by)",
    "transcri(bed|ption) by",
    "amara\\.org",
    "www\\.|https?://|\\.com\\b",
    "ご視聴ありがとうございました",
    "チャンネル登録",
    "字幕",
    "请不吝点赞",
    "订阅",
    "시청해 ?주셔서",
    "구독",
    "продолжение следует",
    "untertitel",
    "sous-titres",
  ].join("|"),
  "iu",
);
/** Only sound tags or symbols: ♪, (music), [Music], *applause*, 【音楽】, （拍手）, … */
const ONLY_TAGS = /^[\s♪♫🎵🎶*#~.,!?\-–—]*([([*【（［〔][^)\]*】）］〕]*[)\]*】）］〕][\s♪♫🎵🎶.,!?]*)*$/u;

const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");

/** Many repeats of the same few words ("la la la la la…" loops) → probably a decoding loop. */
export function isLoop(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 8) return new Set(words).size / words.length < 0.3;
  // No spaces (CJK): the same short piece repeated over and over.
  const t = letters(text);
  if (t.length >= 16) {
    for (let n = 1; n <= 4; n++) {
      const piece = t.slice(0, n);
      if (piece.repeat(Math.ceil(t.length / n)).slice(0, t.length) === t) return true;
    }
  }
  return false;
}

export function keepSegment(s: Seg): boolean {
  const len = letters(s.text).length;
  const dur = s.end - s.start;
  if (!len || ONLY_TAGS.test(s.text) || JUNK.test(s.text)) return false;
  if (s.noSpeech > 0.6 && s.avgLogprob < -0.8) return false; // "no speech" and unsure
  if (s.avgLogprob < -1.3) return false;
  if (dur < 250 || (len / Math.max(0.25, dur / 1000) > 30 && len > 6)) return false; // impossibly fast
  return !isLoop(s.text);
}

/** Drop hallucinations; also a 3rd+ identical segment in a row (repeat loops, not real choruses). */
export function filterSegments(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    if (!keepSegment(s)) continue;
    const n = out.length;
    const same = (x?: Seg) => x && letters(x.text).toLowerCase() === letters(s.text).toLowerCase();
    if (same(out[n - 1]) && same(out[n - 2])) continue;
    out.push({ ...s, text: s.text.replace(/\s*♪+\s*/gu, " ").trim() });
  }
  return out;
}

const MAX_WORDS = 12;
const MAX_CJK = 20;
const BIG_GAP_MS = 1_500;
const cjk = (s: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
const joinWords = (ws: WWord[]) => ws.map((w) => w.text).join("").replace(/\s+/g, " ").trim();
/** Line size in words (Latin) or characters (CJK, no spaces). */
const size = (ws: WWord[]) => (cjk(joinWords(ws)) ? letters(joinWords(ws)).length / 2 : ws.length);
const MIN_SIDE = 3;

/** Split one segment's words into lines: keep it whole when it's short and has no long pause; else cut at the best place. */
function splitWords(ws: WWord[]): WWord[][] {
  const n = ws.length;
  const tooLong = cjk(joinWords(ws)) ? letters(joinWords(ws)).length > MAX_CJK : n > MAX_WORDS;
  const gaps = ws.map((w, k) => (k ? w.start - ws[k - 1].end : 0));
  const bigGap = gaps.some((g, k) => g >= BIG_GAP_MS && size(ws.slice(0, k)) >= MIN_SIDE && size(ws.slice(k)) >= MIN_SIDE);
  if (!tooLong && !bigGap) return [ws];
  let best = -1;
  let bestScore = -Infinity;
  for (let k = 1; k < n; k++) {
    if (size(ws.slice(0, k)) < MIN_SIDE || size(ws.slice(k)) < MIN_SIDE) continue;
    const comma = /[,，、。.!?！？;:]$/.test(ws[k - 1].text.trim()) ? 1.5 : 0;
    const score = gaps[k] / 500 + comma - Math.abs(k - n / 2) / n;
    if (score > bestScore) [best, bestScore] = [k, score];
  }
  if (best < 0) return [ws];
  return [...splitWords(ws.slice(0, best)), ...splitWords(ws.slice(best))];
}

/** Segments → lyric lines (a segment is usually a sung line; long ones are cut at a pause or comma). */
export function segmentsToLines(segs: Seg[]): (LyricLine & { conf: number })[] {
  const lines: (LyricLine & { conf: number })[] = [];
  for (const s of segs) {
    const segConf = Math.exp(Math.min(0, s.avgLogprob));
    const words = s.words.length ? s.words : [{ text: s.text, start: s.start, end: s.end, p: segConf }];
    for (const part of splitWords(words)) {
      const text = joinWords(part);
      // How sure Whisper was: mean word probability, weighted by word length.
      const w = part.map((x) => Math.max(1, letters(x.text).length));
      const conf = part.reduce((n, x, i) => n + x.p * w[i], 0) / w.reduce((a, b) => a + b, 0);
      if (letters(text)) lines.push({ start: part[0].start, end: Math.max(part[part.length - 1].end, part[0].start + 300), text, words: null, conf: +conf.toFixed(3) });
    }
  }
  return lines;
}

// ---------- chunk planning ----------
export const CHUNK_MS = 28_000;
const MIN_FLUSH_MS = 6_000;

/**
 * Next stretch to transcribe from `doneTo`: a full chunk once it's captured, or what's there when
 * capturing stalled (paused / song ended). Starts at the first captured audio after `doneTo`.
 */
export function nextChunk(doneTo: number, coverage: [number, number][], stalled: boolean, songMs: number): { from: number; to: number; final: boolean } | null {
  const range = coverage.find(([, b]) => b > doneTo + 1_000);
  if (!range) return null;
  const from = Math.max(doneTo, range[0]);
  const end = range[1];
  const atSongEnd = songMs > 0 && end >= songMs - 1_500;
  if (end - from >= CHUNK_MS) return { from, to: from + CHUNK_MS, final: false };
  if ((stalled || atSongEnd) && end - from >= (atSongEnd ? 1_500 : MIN_FLUSH_MS)) return { from, to: end, final: atSongEnd };
  return null;
}

/**
 * After a chunk: keep segments that ended well before the chunk's end (the last one may be cut off
 * and is redone with the next chunk). Returns the kept segments and where the next chunk starts.
 */
export function settle(segs: Seg[], chunk: { from: number; to: number; final: boolean }): { kept: Seg[]; doneTo: number } {
  if (chunk.final) return { kept: segs, doneTo: chunk.to };
  const kept = segs.filter((s) => s.end <= chunk.to - 2_000);
  const last = kept[kept.length - 1];
  // Always move on by at least 5 s (an instrumental stretch has no segments at all).
  const doneTo = Math.max(chunk.from + 5_000, last ? last.end : chunk.to - 3_000);
  return { kept, doneTo: Math.min(doneTo, chunk.to) };
}

// ---------- setup ----------
export interface AssetInfo {
  id: string;
  name: string;
  installed: boolean;
  downloading: boolean;
  sizeMb: number;
}

/** Whisper engine + model the settings ask for that aren't on this PC yet (any installed engine will do). */
export function missingWhisper(assets: AssetInfo[], gpu: string | null, runtime: string, model: string): AssetInfo[] {
  const find = (id: string) => assets.find((a) => a.id === id);
  const engines = [find("whisper-cuda"), find("whisper-cpu")];
  const wantGpu = runtime === "gpu" || (runtime === "auto" && !!gpu);
  const engine = engines.some((a) => a?.installed) ? undefined : find(wantGpu ? "whisper-cuda" : "whisper-cpu");
  return [engine, find(model)].filter((a): a is AssetInfo => !!a && !a.installed);
}

/** Auto-sync's aligner model when it isn't on this PC yet ([] = ready). */
export const ALIGNER_ID = "mms-aligner";
export function missingAligner(assets: AssetInfo[]): AssetInfo[] {
  return assets.filter((a) => a.id === ALIGNER_ID && !a.installed);
}

/** How much a set of missing files is to download (undefined = nothing missing). */
export const downloadInfo = (missing: AssetInfo[]) =>
  missing.length ? { ids: missing.map((a) => a.id), mb: missing.reduce((n, a) => n + a.sizeMb, 0), busy: missing.some((a) => a.downloading) } : undefined;

/** Download size for people: "148 MB", "1.3 GB". */
export const sizeText = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`);
