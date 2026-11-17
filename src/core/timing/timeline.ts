// Timing engine: every line gets word timings (real when the source has them, estimated otherwise),
// realistic line ends, interludes and background-vocal flags. Times in ms (song time, before offsets).
import type { Lyrics } from "../lyrics/model";
import { tokenize, totalWeight, type Token } from "./tokens";

export type WordMode = "estimated" | "linear" | "line";

export interface TimedWord {
  text: string;
  start: number;
  end: number;
  bg: boolean;
  /** furigana: text split into segments, kanji segments carry their reading */
  ruby?: { base: string; rt: string }[];
}

export interface TimedLine {
  start: number;
  /** when singing of this line ends (≤ next line start) */
  end: number;
  text: string;
  words: TimedWord[];
  /** word timings come from the source (exact) rather than estimation */
  exact: boolean;
  /** "none" → highlight the line only (line mode) */
  fill: "words" | "none";
  /** whole line is a background vocal */
  bg: boolean;
  /** secondary text under the line (romanization or the original) */
  sub?: string;
  /** second singer: drawn on the other side */
  duet?: boolean;
  /** singer number (1, 2, 3…; 0 = together) for per-singer colours */
  voice?: number;
  /** translation line */
  trans?: string;
}

export interface Interlude {
  start: number;
  end: number;
}

export interface Timeline {
  lines: TimedLine[];
  interludes: Interlude[];
  /** estimated singing pace (weight units per second) */
  pace: number;
}

const INTERLUDE_MIN_MS = 4000;
const MIN_LINE_MS = 500;
const LINE_GAP_MS = 50;
const FINAL_HOLD = 0.6; // extra weight for the last word of a line (singers sustain line ends)
const PACE_MIN = 2;
const PACE_MAX = 8;

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Singing pace of the song: median weight/second over lines that look densely sung. */
export function estimatePace(lines: { start: number; end: number; tokens: Token[] }[]): number {
  const rates = lines
    .map((l) => ({ w: totalWeight(l.tokens), d: (l.end - l.start) / 1000 }))
    .filter((x) => x.w >= 3 && x.d > 0.3)
    .map((x) => x.w / x.d);
  const m = median(rates);
  // Gaps include pauses, so the raw median underestimates pace a little.
  return Number.isFinite(m) ? Math.min(PACE_MAX, Math.max(PACE_MIN, m * 1.15)) : 4;
}

/** Spread tokens over [start, end] proportionally to their weights (+ pauses after punctuation). */
export function distribute(tokens: Token[], start: number, end: number, finalHold = FINAL_HOLD): TimedWord[] {
  const n = tokens.length;
  if (!n) return [];
  const w = tokens.map((t, i) => t.weight + (i === n - 1 ? finalHold : 0));
  const pauses = tokens.map((t, i) => (i < n - 1 ? t.pause : 0));
  const total = w.reduce((a, b) => a + b, 0) + pauses.reduce((a, b) => a + b, 0) || 1;
  const unit = (end - start) / total;
  const out: TimedWord[] = [];
  let t = start;
  tokens.forEach((tok, i) => {
    const s = t;
    t += w[i] * unit;
    out.push({ text: tok.text, start: Math.round(s), end: Math.round(t), bg: tok.bg });
    t += pauses[i] * unit;
  });
  out[n - 1].end = end;
  return out;
}

const stripOuterParens = (s: string) => {
  const m = /^\s*[(（](.*)[)）]\s*$/u.exec(s);
  return m && !/[()（）]/u.test(m[1]) ? m[1].trim() : null;
};

export function buildTimeline(lyrics: Lyrics, mode: WordMode = "estimated"): Timeline {
  const src = lyrics.lines;
  const prepared = src.map((l, i) => {
    const inner = stripOuterParens(l.text);
    const text = inner ?? l.text;
    // Hard limit: a line ends no later than the next main line starts (background lines overlap).
    const next = src.slice(i + 1).find((x) => !x.bg)?.start ?? Infinity;
    const hardEnd = Math.min(l.end, next > l.start ? next : l.end);
    return { src: l, text, bg: inner !== null || !!l.bg, start: l.start, end: hardEnd, tokens: tokenize(text) };
  });
  const pace = estimatePace(prepared);

  const lines: TimedLine[] = prepared.map((p) => {
    const room = Math.max(MIN_LINE_MS, p.end - p.start);
    const weight = totalWeight(p.tokens) + FINAL_HOLD;

    if (p.src.words?.length) {
      // Exact word timings: keep them, only tame an over-long final word (no end stamp → ran to next line).
      const words = p.src.words.map((w) => ({ text: w.text, start: w.start, end: w.end, bg: p.bg }));
      const last = words[words.length - 1];
      const lastTok = tokenize(last.text);
      const natural = ((totalWeight(lastTok) + FINAL_HOLD) / pace) * 1000 * 2.5;
      const cap = Math.max(1500, natural);
      if (!p.src.exactEnds && last.end - last.start > cap) last.end = last.start + cap;
      return { start: p.start, end: Math.max(last.end, words[0].start + 1), text: p.text, words, exact: true, fill: "words", bg: p.bg };
    }

    if (mode === "line") {
      return {
        start: p.start, end: p.start + room, text: p.text, exact: false, fill: "none", bg: p.bg,
        words: [{ text: p.text, start: p.start, end: p.start + room, bg: p.bg }],
      };
    }

    if (mode === "linear") {
      // Even sweep by characters across the whole slot.
      const toks = p.tokens.map((t) => ({ ...t, weight: [...t.text.trim()].length || 0.5, pause: 0 }));
      const end = p.start + room - LINE_GAP_MS;
      return { start: p.start, end, text: p.text, exact: false, fill: "words", bg: p.bg, words: distribute(toks, p.start, end, 0) };
    }

    // Estimated: natural singing length from the song's pace, never past the next line.
    const natural = (weight / pace) * 1000 * 1.25 + 200;
    const end = p.start + Math.max(Math.min(room - LINE_GAP_MS, natural), Math.min(room, MIN_LINE_MS));
    return { start: p.start, end, text: p.text, exact: false, fill: "words", bg: p.bg, words: distribute(p.tokens, p.start, end) };
  });

  lines.forEach((l, i) => {
    const src = prepared[i].src;
    if (src.duet) l.duet = true;
    if (src.voice !== undefined) l.voice = src.voice;
  });

  return { lines, interludes: findInterludes(lines), pace };
}

/** Instrumental breaks (≥ 4 s without main or background singing), incl. a long intro. */
export function findInterludes(lines: TimedLine[]): Interlude[] {
  const interludes: Interlude[] = [];
  const main = lines.filter((l) => !l.bg);
  if (main.length && main[0].start >= INTERLUDE_MIN_MS) interludes.push({ start: 0, end: main[0].start });
  for (let i = 0; i < main.length - 1; i++) {
    const gapStart = Math.max(main[i].end, ...lines.filter((l) => l.bg && l.start >= main[i].start && l.start < main[i + 1].start).map((l) => l.end));
    const gapEnd = main[i + 1].start;
    if (gapEnd - gapStart >= INTERLUDE_MIN_MS) interludes.push({ start: gapStart, end: gapEnd });
  }
  return interludes;
}

/** Index of the line being sung at `t` (last line that started), or -1 before the first line. */
export function lineAt(lines: TimedLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Fill progress 0..1 of a word at time t. */
export const wordProgress = (w: TimedWord, t: number) =>
  t <= w.start ? 0 : t >= w.end ? 1 : (t - w.start) / Math.max(1, w.end - w.start);
