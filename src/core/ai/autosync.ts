// Step 15 — auto-sync: line the lyrics up with the singing. Pure logic (tested); the engine feeds it
// alignments from the MMS aligner (Rust `ai_align`) and the renderer uses the retimed timeline.
//
//   lyrics ──romanize──▶ sync lines (a–z words) ──plan──▶ window of captured audio ──ai_align──▶ word times
//   word times ──accept──▶ line fixes ──▶ anchors (expected start → sung start) ──▶ time map (tempo + offset)
//   timeline: aligned lines take their sung times; the rest (incl. upcoming lines) follow the time map.
import anyAscii from "any-ascii";
import type { Lyrics } from "../lyrics/model";
import type { RomanLine } from "../romanize";
import { romanTimeline } from "../romanize/timeline";
import { findInterludes, type Timeline, type TimedLine, type TimedWord } from "../timing/timeline";
import { tokenize, totalWeight } from "../timing/tokens";

/** Word → the aligner's alphabet (a–z and '); "" when nothing is left (numbers, symbols). */
export const alignWord = (w: string) =>
  anyAscii(w)
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z']/g, "")
    .replace(/^'+|'+$/g, "");

export interface SyncLine {
  /** index into lyrics.lines / timeline.lines */
  idx: number;
  /** expected times from the lyrics (ms) */
  start: number;
  end: number;
  /** romanized words in singing order ("" = skipped) */
  words: string[];
}

/** Main (non-background) lines with their words romanized like the "romanized" display mode. */
export function syncLines(lyrics: Lyrics, roman: (RomanLine | null)[] | null): SyncLine[] {
  const tl = romanTimeline(lyrics, roman, "roman-main", "estimated");
  const out: SyncLine[] = [];
  tl.lines.forEach((l, idx) => {
    if (l.bg) return;
    const words = l.words.map((w) => alignWord(w.text));
    if (words.some(Boolean)) out.push({ idx, start: l.start, end: l.end, words });
  });
  return out;
}

export interface WordTime {
  start: number;
  end: number;
  score: number;
}

export interface LineFix {
  /** sung start / end of the line (ms, song time) */
  start: number;
  end: number;
  /** per sync word [start, end], null = not found / skipped */
  words: ([number, number] | null)[];
  /** mean letter log-probability (≈0 = sure) */
  score: number;
}

/** Thresholds (tuned on TTS lines in speech and in a synthetic band; Step 18 tunes on songs). */
// Calibrated on real songs (2026-11-17, 晴天 / Super Shy): correctly placed lines score about −2.25
// (p10 −2.9), wrong ones about −3.0, so scores only pre-filter; agreement with the time map does the
// rest (two agreeing anchors before the map moves anything, outliers dropped by `dropOutliers`).
export const ACCEPT = { minFound: 0.6, minMedian: -2.9, minMean: -3.2 };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Turn one aligned line into a fix, or null when the match isn't trustworthy. */
export function toFix(line: SyncLine, res: (WordTime | null)[]): LineFix | null {
  const real = line.words.map((w, k) => (w ? (res[k] ?? null) : null));
  const found = real.filter((w): w is WordTime => !!w);
  const need = line.words.filter(Boolean).length;
  if (!found.length || found.length < Math.ceil(need * ACCEPT.minFound)) return null;
  const scores = found.map((w) => w.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (median(scores) < ACCEPT.minMedian || mean < ACCEPT.minMean) return null;
  const start = found[0].start;
  const end = found[found.length - 1].end;
  const expected = Math.max(400, line.end - line.start);
  if (end - start > expected * 4 + 1000) return null; // smeared over unrelated audio
  return { start: Math.round(start), end: Math.round(end), words: real.map((w) => (w ? [Math.round(w.start), Math.round(w.end)] : null)), score: +mean.toFixed(2) };
}

// ---------- time map: expected (lyrics) time → sung time ----------
export interface Anchor {
  exp: number;
  act: number;
}
export interface TimeMap {
  /** tempo scale (1 = same speed) */
  a: number;
  /** offset (ms) */
  b: number;
  anchors: Anchor[];
  /** anchors that agree with the fit (fewer than 2 = the map moves nothing) */
  inliers?: number;
}

export const IDENTITY: TimeMap = { a: 1, b: 0, anchors: [], inliers: 0 };

/**
 * Robust fit (RANSAC over anchor pairs ≥ 8 s apart): the tempo/offset line that most anchors agree
 * with (±250 ms), later anchors weighing a little more, refined by least squares on its inliers.
 * One wrong match (a repeated chorus line) or a section cut out of the recording can't bend it.
 */
export function fitMap(anchors: Anchor[]): TimeMap {
  if (!anchors.length) return IDENTITY;
  const p = [...anchors].sort((x, y) => x.exp - y.exp);
  const n = p.length;
  const weight = (i: number) => 1 + (0.5 * i) / n;
  const inliers = (a: number, b: number) => p.map((q, i) => (Math.abs(q.act - (a * q.exp + b)) <= 250 ? i : -1)).filter((i) => i >= 0);
  // Offset-only model from each anchor, plus tempo models from pairs.
  let best = { a: 1, b: median(p.map((q) => q.act - q.exp)), score: -1, idx: [] as number[] };
  const consider = (a: number, b: number) => {
    if (a < 0.8 || a > 1.25) return;
    const idx = inliers(a, b);
    // More (and later) inliers win; among equals, the smaller mean error (≤ 0.25, less than one inlier).
    const err = idx.reduce((s, i) => s + Math.abs(p[i].act - (a * p[i].exp + b)), 0) / Math.max(1, idx.length);
    const score = idx.reduce((s, i) => s + weight(i), 0) - err / 1000;
    if (score > best.score) best = { a, b, score, idx };
  };
  for (const q of p) consider(1, q.act - q.exp);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const dx = p[j].exp - p[i].exp;
      if (dx < 8_000) continue;
      const a = (p[j].act - p[i].act) / dx;
      consider(a, p[i].act - a * p[i].exp);
    }
  // Refine on the inliers. One line alone never moves the whole song: a single wrong match would
  // shift every other line with it.
  const pts = best.idx.map((i) => p[i]);
  if (pts.length < 2) return { a: 1, b: 0, anchors: p, inliers: pts.length };
  const mx = pts.reduce((s, q) => s + q.exp, 0) / pts.length;
  const my = pts.reduce((s, q) => s + q.act, 0) / pts.length;
  const span = pts[pts.length - 1].exp - pts[0].exp;
  let a = best.a;
  if (span >= 8_000 && pts.length >= 3 && best.a !== 1) {
    const cov = pts.reduce((s, q) => s + (q.exp - mx) * (q.act - my), 0);
    const v = pts.reduce((s, q) => s + (q.exp - mx) ** 2, 0);
    a = Math.min(1.25, Math.max(0.8, cov / v));
  }
  return { a, b: my - a * mx, anchors: p, inliers: pts.length };
}

/** Expected → sung time: the linear fit plus the local error of the nearest anchors (a cut or added section shifts what follows). */
export function mapTime(m: TimeMap, t: number): number {
  const base = m.a * t + m.b;
  if (m.anchors.length < 2 || (m.inliers ?? 2) < 2) return base;
  const near = m.anchors
    .filter((p) => Math.abs(p.exp - t) <= 45_000)
    .sort((x, y) => Math.abs(x.exp - t) - Math.abs(y.exp - t))
    .slice(0, 3);
  if (!near.length) return base;
  const r = median(near.map((p) => p.act - (m.a * p.exp + m.b)));
  return base + (Math.abs(r) > 120 ? r : 0);
}

export const anchorsOf = (lines: SyncLine[], fixes: Record<number, LineFix>): Anchor[] =>
  lines.filter((l) => fixes[l.idx]).map((l) => ({ exp: l.start, act: fixes[l.idx].start }));

/**
 * Once the map rests on ≥ 4 anchors, a fix more than `tolMs` away from where the map puts its line
 * matched the wrong place (a repeated chorus line, an ad-lib): drop it. Returns the kept fixes and the
 * dropped line indexes; the caller refits the map.
 */
export function dropOutliers(lines: SyncLine[], fixes: Record<number, LineFix>, map: TimeMap, tolMs = 700): { fixes: Record<number, LineFix>; dropped: number[] } {
  if (map.anchors.length < 4) return { fixes, dropped: [] };
  const kept: Record<number, LineFix> = {};
  const dropped: number[] = [];
  for (const l of lines) {
    const f = fixes[l.idx];
    if (!f) continue;
    if (Math.abs(f.start - mapTime(map, l.start)) > tolMs) dropped.push(l.idx);
    else kept[l.idx] = f;
  }
  return dropped.length ? { fixes: kept, dropped } : { fixes, dropped };
}

// ---------- planning: which lines to align next ----------
export interface Window {
  from: number;
  to: number;
  lines: SyncLine[];
}

const covers = (ranges: [number, number][], a: number, b: number) => ranges.some(([x, y]) => x <= a + 40 && y + 40 >= b);

/**
 * Next group of not-yet-aligned lines whose predicted window (± margin) has been captured.
 * Margin is wide until the offset is known; groups of ≤ 4 lines / ≤ 16 s keep windows short
 * and make repeated lines (choruses) less ambiguous.
 */
export function nextWindow(
  lines: SyncLine[],
  done: (idx: number) => boolean,
  coverage: [number, number][],
  map: TimeMap,
  songMs: number,
  /** ms of audio around the predicted lines (default: 6 s until two anchors exist, then 2.5 s) */
  margin = map.anchors.length >= 2 ? 2_500 : 6_000,
): Window | null {
  for (let i = 0; i < lines.length; i++) {
    if (done(lines[i].idx)) continue;
    const group = [lines[i]];
    for (let j = i + 1; j < lines.length && group.length < 4; j++) {
      if (done(lines[j].idx)) break;
      if (mapTime(map, lines[j].end) - mapTime(map, lines[i].start) > 16_000) break;
      group.push(lines[j]);
    }
    // Shrink the group until its window is captured (the last lines may not be sung yet).
    while (group.length) {
      const from = Math.max(0, Math.round(mapTime(map, group[0].start) - margin));
      let to = Math.round(mapTime(map, group[group.length - 1].end) + margin);
      if (songMs > 0) to = Math.min(to, songMs);
      if (to - from <= 40_000 && to > from + 500 && covers(coverage, from, to)) return { from, to, lines: group };
      group.pop();
    }
  }
  return null;
}

// ---------- plain (unsynced) lyrics ----------
/** Section labels like "[Chorus]" or "(x2)" aren't sung. */
const LABEL = /^\s*[[(（【].*[\])）】]\s*$/u;

/**
 * Plain lyrics as line-synced lyrics with placeholder times (spaced by how long each line takes to
 * sing), so auto-sync can align them one after another and the time map can predict what's next.
 */
export function plainToLines(l: Lyrics): Lyrics {
  const texts = (l.plain ?? "").split(/\r?\n/).map((t) => t.trim()).filter((t) => t && !LABEL.test(t));
  let t = 0;
  const lines = texts.map((text) => {
    const dur = Math.min(8_000, Math.max(1_500, (totalWeight(tokenize(text)) / 3.2) * 1000));
    const line = { start: t, end: t + dur, text, words: null };
    t += dur + 600;
    return line;
  });
  return { ...l, kind: "line", lines, estimated: true };
}

/** Plain lyrics give up on a line after this many windows (it may not be sung at all). */
export const SEQ_TRIES = 6;

/**
 * Plain lyrics: align in singing order — the next lines are searched in the ~24 s of audio after the
 * last line found; every miss looks 10 s further on.
 */
export function nextSequential(lines: SyncLine[], fixes: Record<number, LineFix>, tries: (idx: number) => number, coverage: [number, number][], songMs: number): Window | null {
  let last = -1;
  lines.forEach((l, k) => fixes[l.idx] && (last = k));
  let i = last + 1;
  while (i < lines.length && (fixes[lines[i].idx] || tries(lines[i].idx) >= SEQ_TRIES)) i++;
  if (i >= lines.length) return null;
  const cursor = last >= 0 ? fixes[lines[last].idx].end : 0;
  const from = Math.max(0, cursor - 1_000 + tries(lines[i].idx) * 10_000);
  const range = coverage.find(([a, b]) => b > from + 1_000 && a <= from + 40) ?? coverage.find(([a]) => a > from);
  if (!range) return null;
  const start = Math.max(from, range[0]);
  const atEnd = songMs > 0 && range[1] >= songMs - 1_500;
  const to = Math.min(start + 24_000, range[1]);
  if (to - start < 12_000 && !(atEnd && to - start >= 3_000)) return null;
  return { from: start, to, lines: lines.slice(i, i + 3) };
}

// ---------- retiming the displayed timeline ----------
const LINE_GAP = 50;
const HOLD_MS = 400; // singers hold the last syllable past its letters

/** Letters a display word stands for (romanized letters; kana ≈ 2, kanji ≈ 3, hangul ≈ 3 per char). */
function weight(text: string): number {
  const latin = alignWord(text).length;
  if (latin) return latin;
  let w = 0;
  for (const ch of text.trim()) {
    if (/\p{Script=Han}|\p{Script=Hangul}/u.test(ch)) w += 3;
    else if (/\p{L}|\p{N}/u.test(ch)) w += 2;
  }
  return Math.max(1, w);
}

/** Piecewise-linear interpolation over sorted (x, y) points. */
function interp(pts: [number, number][], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

/** Word timings for a displayed line from an aligned line. */
function wordsFromFix(words: TimedWord[], sync: SyncLine, fix: LineFix, start: number, end: number): { words: TimedWord[]; exact: boolean } {
  const known = sync.words.map((w, k) => (w && fix.words[k] ? fix.words[k]! : null));
  // Same words as aligned (Latin lines, romanized display): take the times word for word.
  const same = words.length === sync.words.length && words.every((w, k) => alignWord(w.text) === sync.words[k]);
  if (same && known.filter(Boolean).length >= 2) {
    const starts = known.map((k) => (k ? k[0] : NaN));
    // Fill missing words between found neighbours.
    for (let k = 0; k < starts.length; k++) {
      if (!Number.isNaN(starts[k])) continue;
      const prev = starts.slice(0, k).reverse().find((x) => !Number.isNaN(x)) ?? start;
      const next = starts.slice(k + 1).find((x) => !Number.isNaN(x)) ?? end;
      starts[k] = (prev + next) / 2;
    }
    return {
      exact: true,
      words: words.map((w, k) => {
        const s = Math.max(start, starts[k]);
        const next = k + 1 < words.length ? starts[k + 1] : end;
        const own = known[k] ? known[k]![1] + HOLD_MS : next;
        return { ...w, start: s, end: Math.max(s + 60, next - s > 1_200 ? Math.min(own, next) : next) };
      }),
    };
  }
  // Different display (kanji, hangul…): map by position within the line.
  const total = sync.words.reduce((a, w) => a + w.length, 0) || 1;
  const pts: [number, number][] = [[0, start]];
  let acc = 0;
  sync.words.forEach((w, k) => {
    if (known[k]) pts.push([acc / total, known[k]![0]]);
    acc += w.length;
  });
  pts.push([1, end]);
  for (let i = 1; i < pts.length; i++) pts[i][1] = Math.max(pts[i][1], pts[i - 1][1]);
  const weights = words.map((w) => weight(w.text));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let c = 0;
  return {
    exact: false,
    words: words.map((w, k) => {
      const s = interp(pts, c / sum);
      c += weights[k];
      const e = k + 1 < words.length ? interp(pts, c / sum) : end;
      return { ...w, start: s, end: Math.max(s + 60, e) };
    }),
  };
}

const shiftLine = (l: TimedLine, f: (t: number) => number): TimedLine => ({
  ...l,
  start: f(l.start),
  end: f(l.end),
  words: l.words.map((w) => ({ ...w, start: f(w.start), end: f(w.end) })),
});

/**
 * Retime a displayed timeline: aligned lines get their sung times (source word timings are kept
 * and shifted as a whole), every other line follows the time map.
 */
export function applySync(tl: Timeline, lyrics: Lyrics, lines: SyncLine[], fixes: Record<number, LineFix>, map: TimeMap): Timeline {
  const byIdx = new Map(lines.map((l) => [l.idx, l]));
  const out: TimedLine[] = [];
  let lastShift: ((t: number) => number) | null = null;
  tl.lines.forEach((line, i) => {
    const fix = fixes[i];
    const sync = byIdx.get(i);
    const linear = (base: number) => {
      const d = mapTime(map, base) - base;
      return (t: number) => base + d + (t - base) * map.a;
    };
    if (line.bg) {
      // Background vocals move with the line they belong to.
      out.push(shiftLine(line, lastShift ?? linear(line.start)));
      return;
    }
    if (fix && sync) {
      if (lyrics.lines[i]?.words) {
        // Word timings from the source: keep them, move the line to where it's sung.
        const d = fix.start - line.start;
        lastShift = (t) => t + d;
        out.push({ ...shiftLine(line, lastShift), _fixed: true } as TimedLine);
      } else {
        const end = fix.end + HOLD_MS;
        const { words, exact } = wordsFromFix(line.words, sync, fix, fix.start, end);
        const d = fix.start - line.start;
        lastShift = (t) => t + d;
        out.push({ ...line, start: fix.start, end, words, exact, _fixed: true } as TimedLine);
      }
      return;
    }
    lastShift = linear(line.start);
    out.push(shiftLine(line, lastShift));
  });

  // Keep main lines in order and stop non-exact lines before the next main line starts.
  const main = out.map((l, i) => ({ l, i })).filter((x) => !x.l.bg);
  for (let k = 1; k < main.length; k++) {
    const prev = main[k - 1].l;
    const cur = main[k].l;
    if (cur.start < prev.start + 100 && !(cur as { _fixed?: boolean })._fixed) {
      const d = prev.start + 100 - cur.start;
      out[main[k].i] = main[k].l = shiftLine(cur, (t) => t + d);
    }
  }
  for (let k = 0; k < main.length - 1; k++) {
    const cur = main[k].l;
    const nextStart = main[k + 1].l.start;
    if (cur.end > nextStart - LINE_GAP && !lyrics.lines[main[k].i]?.exactEnds) {
      const end = Math.max(cur.start + 200, nextStart - LINE_GAP);
      cur.end = end;
      const last = cur.words[cur.words.length - 1];
      if (last) last.end = Math.min(last.end, end);
      cur.words.forEach((w) => (w.end = Math.min(w.end, end)));
    }
  }
  for (const l of out) delete (l as { _fixed?: boolean })._fixed;
  return { ...tl, lines: out, interludes: findInterludes(out) };
}

// ---------- persistence ----------
/** Saved per song (songs.json `aiSync`), valid only for the same lyrics text. */
export interface SavedSync {
  v: 1;
  sig: string;
  fixes: Record<number, LineFix>;
}

/** Fingerprint of the lyrics a saved sync belongs to (FNV-1a of the line texts). */
export function lyricsSig(l: Lyrics): string {
  if (l.source === "ai") return `ai:${l.artistName}|${l.trackName}`; // grows by appending lines
  let h = 0x811c9dc5;
  for (const ch of l.lines.map((x) => x.text).join("\n")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${l.source}:${l.id}:${l.lines.length}:${h.toString(16)}`;
}
