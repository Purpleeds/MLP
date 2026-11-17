// Combine lyrics + romanization (+ translations) into the timeline shown by the renderer.
import type { Lyrics } from "../lyrics/model";
import { buildTimeline, type Timeline, type TimedLine, type TimedWord, type WordMode } from "../timing/timeline";
import type { RomanLine, RomanOptions, RubyPiece } from "./index";

const isKana = (c: string) => /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(c);
const toHira = (c: string) => c.replace(/[ァ-ヶ]/g, (k) => String.fromCharCode(k.charCodeAt(0) - 0x60));

/** Split a word + reading into ruby segments, keeping okurigana outside the ruby (裁か/さばか → 裁[さば]か). */
export function rubySegments(display: string, reading: string): { base: string; rt: string }[] {
  const d = [...display];
  const r = [...reading];
  let pre = 0;
  while (pre < d.length - 1 && pre < r.length - 1 && isKana(d[pre]) && toHira(d[pre]) === toHira(r[pre])) pre++;
  let suf = 0;
  while (suf < d.length - pre - 1 && suf < r.length - pre - 1 && isKana(d[d.length - 1 - suf]) && toHira(d[d.length - 1 - suf]) === toHira(r[r.length - 1 - suf])) suf++;
  const segs: { base: string; rt: string }[] = [];
  if (pre) segs.push({ base: d.slice(0, pre).join(""), rt: "" });
  segs.push({ base: d.slice(pre, d.length - suf).join(""), rt: r.slice(pre, r.length - suf).join("") });
  if (suf) segs.push({ base: d.slice(d.length - suf).join(""), rt: "" });
  return segs;
}

/** Put furigana onto a timed line: words covering one analyzer word are merged into one span. */
export function applyFurigana(line: TimedLine, pieces: RubyPiece[], originalText: string): void {
  if (!pieces.length || line.fill === "none") return;
  const base = Math.max(0, [...originalText].join("").indexOf(line.text)); // bg lines lose their outer "("
  const shift = base ? [...originalText.slice(0, base)].length : 0;
  const shifted = pieces.map((p) => ({ ...p, start: p.start - shift, end: p.end - shift }));
  const rangesOf = (ws: TimedWord[]) => {
    let off = 0;
    return ws.map((w) => {
      const r = { s: off, e: off + [...w.text].length };
      off = r.e;
      return r;
    });
  };
  // 1) Merge timed words so every analyzer word with kanji sits inside a single span.
  let words = line.words;
  for (const p of shifted) {
    const ranges = rangesOf(words);
    const a = ranges.findIndex((r) => p.start >= r.s && p.start < r.e);
    const b = ranges.findIndex((r) => p.end > r.s && p.end <= r.e);
    if (a < 0 || b <= a) continue;
    const merged: TimedWord = { text: words.slice(a, b + 1).map((w) => w.text).join(""), start: words[a].start, end: words[b].end, bg: words[a].bg };
    words = [...words.slice(0, a), merged, ...words.slice(b + 1)];
  }
  // 2) Build ruby segments for each word from the pieces inside it.
  const ranges = rangesOf(words);
  line.words = words.map((w, i) => {
    const inside = shifted.filter((p) => p.start >= ranges[i].s && p.end <= ranges[i].e).sort((x, y) => x.start - y.start);
    if (!inside.length) return w;
    const chars = [...w.text];
    const segs: { base: string; rt: string }[] = [];
    let at = 0;
    for (const p of inside) {
      const s = p.start - ranges[i].s;
      const e = p.end - ranges[i].s;
      if (s > at) segs.push({ base: chars.slice(at, s).join(""), rt: "" });
      segs.push(...rubySegments(chars.slice(s, e).join(""), p.reading));
      at = e;
    }
    if (at < chars.length) segs.push({ base: chars.slice(at).join(""), rt: "" });
    return { ...w, ruby: segs };
  });
}

export function romanTimeline(
  lyrics: Lyrics,
  roman: (RomanLine | null)[] | null,
  mode: RomanOptions["mode"],
  wordMode: WordMode,
  trans?: (string | null)[] | null,
): Timeline {
  const tl = baseTimeline(lyrics, roman, mode, wordMode);
  if (trans) tl.lines.forEach((l, i) => trans[i] && (l.trans = trans[i]!));
  return tl;
}

function baseTimeline(lyrics: Lyrics, roman: (RomanLine | null)[] | null, mode: RomanOptions["mode"], wordMode: WordMode): Timeline {
  if (!roman || mode === "off" || roman.every((r) => !r)) return buildTimeline(lyrics, wordMode);

  if (mode === "original-main" || mode === "furigana") {
    const tl = buildTimeline(lyrics, wordMode);
    tl.lines.forEach((l, i) => {
      const r = roman[i];
      if (!r) return;
      if (mode === "furigana" && r.ruby) applyFurigana(l, r.ruby, lyrics.lines[i].text);
      else if (mode === "original-main" || !r.ruby) l.sub = r.text;
    });
    return tl;
  }

  // Romanized text becomes the sung line; exact word timings carry over word by word.
  const swapped: Lyrics = {
    ...lyrics,
    lines: lyrics.lines.map((line, i) => {
      const r = roman[i];
      if (!r) return line;
      if (line.words && r.words && r.words.length === line.words.length) {
        const n = line.words.length;
        const words = line.words.map((w, k) => ({ ...w, text: r.words![k] + (r.words![k] && k < n - 1 ? " " : "") }));
        return { ...line, text: words.map((w) => w.text).join("").trim(), words };
      }
      return { ...line, text: r.text, words: null };
    }),
  };
  const tl = buildTimeline(swapped, wordMode);
  if (mode === "roman-main") tl.lines.forEach((l, i) => roman[i] && (l.sub = lyrics.lines[i].text));
  return tl;
}
