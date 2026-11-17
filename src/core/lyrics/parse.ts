// Parsers: LRC (incl. enhanced/A2 word stamps), LRCLIB lyricsfile YAML, and record → Lyrics selection.
import { parse as parseYaml } from "yaml";
import type { LrclibRecord, LyricLine, Lyrics, LyricWord } from "./model";

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
const WORD_STAMP = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const META = /^\[([a-z#]+):(.*)\]\s*$/i;
const DEFAULT_LAST_LINE_MS = 5000;

export function toMs(m: string, s: string, frac?: string): number {
  let f = 0;
  if (frac) f = frac.length === 1 ? +frac * 100 : frac.length === 2 ? +frac * 10 : +frac;
  return (+m * 60 + +s) * 1000 + f;
}

/** Split text containing `<mm:ss.xx>` stamps into timed words (end filled later). */
function parseWords(text: string, offset: number): { plain: string; words: LyricWord[] | null } {
  WORD_STAMP.lastIndex = 0;
  const stamps: { at: number; idx: number; len: number }[] = [];
  for (let m; (m = WORD_STAMP.exec(text)); ) {
    stamps.push({ at: toMs(m[1], m[2], m[3]) - offset, idx: m.index, len: m[0].length });
  }
  if (!stamps.length) return { plain: text.trim(), words: null };
  const lead = text.slice(0, stamps[0].idx);
  const words: LyricWord[] = [];
  stamps.forEach((st, i) => {
    const next = stamps[i + 1];
    const seg = text.slice(st.idx + st.len, next ? next.idx : undefined);
    if (seg.trim() === "") {
      // A2 end stamp: closes the previous word.
      if (words.length) words[words.length - 1].end = st.at;
      return;
    }
    words.push({ text: (i === 0 ? lead.trimStart() : "") + seg, start: st.at, end: NaN });
  });
  if (words.length) words[words.length - 1].text = words[words.length - 1].text.trimEnd();
  const plain = words.map((w) => w.text).join("").trim();
  return { plain, words: words.length ? words : null };
}

/** Fill missing line/word ends from following starts. */
function finalize(lines: LyricLine[], breaks: number[], durationMs: number): LyricLine[] {
  lines.sort((a, b) => a.start - b.start);
  const stops = [...lines.map((l) => l.start), ...breaks].sort((a, b) => a - b);
  for (const l of lines) {
    if (!Number.isFinite(l.end) || l.end <= l.start) {
      const next = stops.find((t) => t > l.start);
      l.end = next ?? (durationMs > l.start ? Math.min(durationMs, l.start + DEFAULT_LAST_LINE_MS * 2) : l.start + DEFAULT_LAST_LINE_MS);
    }
    if (l.words) {
      l.words.forEach((w, i) => {
        if (!Number.isFinite(w.end) || w.end <= w.start) w.end = l.words![i + 1]?.start ?? l.end;
      });
      // Word stamps may run past the line stamp (or vice versa): widen the line to fit.
      l.start = Math.min(l.start, l.words[0].start);
      l.end = Math.max(l.end, l.words[l.words.length - 1].end);
    }
  }
  return lines;
}

/** Parse (enhanced) LRC text. */
export function parseLrc(src: string, durationMs = 0): LyricLine[] {
  let offset = 0;
  const lines: LyricLine[] = [];
  const breaks: number[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const meta = META.exec(raw.trim());
    if (meta && !/^\d/.test(meta[1])) {
      if (meta[1].toLowerCase() === "offset") offset = parseInt(meta[2], 10) || 0;
      continue;
    }
    const times: number[] = [];
    STAMP.lastIndex = 0;
    let pos = 0;
    for (let m; (m = STAMP.exec(raw)); pos = STAMP.lastIndex) times.push(toMs(m[1], m[2], m[3]) - offset);
    if (!times.length) continue;
    const { plain, words } = parseWords(raw.slice(pos), offset);
    for (const t of times) {
      if (!plain) breaks.push(t);
      else
        lines.push({
          start: t,
          end: NaN,
          text: plain,
          // Repeated stamps share one text; word stamps only apply to the first occurrence.
          words: words && t === times[0] ? words.map((w) => ({ ...w })) : null,
        });
    }
  }
  return finalize(lines, breaks, durationMs);
}

interface LfWord { text?: string; start_ms?: number; end_ms?: number }
interface LfLine { text?: string; start_ms?: number; end_ms?: number; words?: LfWord[]; background?: boolean }

/** Parse LRCLIB `lyricsfile` YAML. */
export function parseLyricsfile(src: string, durationMs = 0): LyricLine[] {
  const doc = parseYaml(src) as { lines?: LfLine[] } | null;
  const lines: LyricLine[] = [];
  for (const l of doc?.lines ?? []) {
    if (typeof l?.start_ms !== "number" || !l.text?.trim()) continue;
    let words: LyricWord[] | null = null;
    let text = l.text;
    if (Array.isArray(l.words) && l.words.length) {
      words = l.words
        .filter((w) => typeof w.start_ms === "number" && w.text)
        .map((w) => ({ text: w.text!, start: w.start_ms!, end: w.end_ms ?? NaN }));
    } else {
      const p = parseWords(l.text, 0);
      text = p.plain;
      words = p.words;
    }
    lines.push({
      start: l.start_ms,
      end: l.end_ms ?? NaN,
      text: words ? words.map((w) => w.text).join("").trim() || text.trim() : text.trim(),
      words: words?.length ? words : null,
      ...(l.background ? { bg: true } : {}),
    });
  }
  return finalize(lines, [], durationMs);
}

/** A line counts as word-timed only if its timing is finer than the whole line. */
export function isWordTimed(l: LyricLine): boolean {
  return !!l.words && (l.words.length > 1 || [...l.text].length <= 3);
}

/** Fraction of lines with real word timing. */
export const wordCoverage = (lines: LyricLine[]) =>
  lines.length ? lines.filter(isWordTimed).length / lines.length : 0;

/** Build the best Lyrics from a record: richest of lyricsfile / syncedLyrics, else plain. */
export function recordToLyrics(r: LrclibRecord): Lyrics {
  const durationMs = Math.round(r.duration * 1000);
  const base = { source: "lrclib" as const, id: r.id, trackName: r.trackName, artistName: r.artistName, durationMs };
  if (r.instrumental) return { ...base, kind: "instrumental", lines: [] };

  const options: LyricLine[][] = [];
  if (r.lyricsfile) {
    try {
      options.push(parseLyricsfile(r.lyricsfile, durationMs));
    } catch {
      /* malformed YAML: fall back to LRC */
    }
  }
  if (r.syncedLyrics) options.push(parseLrc(r.syncedLyrics, durationMs));
  const usable = options.filter((o) => o.length > 0);
  if (usable.length) {
    const best = usable.reduce((a, b) => (wordCoverage(b) > wordCoverage(a) + 0.05 ? b : a));
    for (const l of best) if (!isWordTimed(l)) l.words = null;
    return { ...base, kind: wordCoverage(best) >= 0.5 ? "word" : "line", lines: best };
  }
  if (r.plainLyrics?.trim()) return { ...base, kind: "plain", lines: [], plain: r.plainLyrics.trim() };
  return { ...base, kind: "instrumental", lines: [] };
}
