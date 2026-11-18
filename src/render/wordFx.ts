// Word effects: which sung words get an effect, and which one, matched to the song.
// Pure (no DOM) so it can be unit-tested; LyricRenderer draws the effects.
//
// Who qualifies:
//   • held words (≥ 1 s with real word timing, or visibly stretched "noooo") — as before;
//   • the song's title words and a small set of vivid keywords ("love", "insanity", "fire", …) when
//     they are sung long enough to see an effect (at most one such word per line).
// Which effect (style "auto"):
//   • a keyword picks its own family (love → glow, insanity → glitch, shine → shimmer, ocean → wave,
//     thunder → shake, fire → bloom); the title word blooms;
//   • other held words take the song's style: the family most of its keywords belong to, otherwise one
//     from how fast it is sung (fast → shimmer, mid → glow, slow → wave).
// Strength grows with the song's pace, in choruses (lines sung more than once) and on the title.
import type { Timeline, TimedLine, TimedWord } from "../core/timing/timeline";

export const FX_STYLES = ["glow", "bloom", "shimmer", "wave", "shake", "glitch"] as const;
export type FxStyle = (typeof FX_STYLES)[number];
export type FxChoice = "auto" | FxStyle;

export interface WordFx {
  style: FxStyle;
  /** 0.6 … 1.3: scales glow radius and motion */
  strength: number;
}

export interface SongFx {
  /** per line, per word; null = no effect */
  words: (WordFx | null)[][];
  /** style for held words without a keyword of their own */
  base: FxStyle;
  /** 0 … 1 from the singing pace */
  energy: number;
}

const HELD_MS = 1000;
const KEYWORD_MS_EXACT = 500;
const KEYWORD_MS_EST = 700;
export const FX_LETTERS_MAX = 12;

// Stems (lower case, matched at the start of the word, ignoring trailing "s", "'s" etc. via prefix).
const LEXICON: Record<FxStyle, string[]> = {
  glow: ["love", "lover", "heart", "baby", "kiss", "darling", "forever", "together", "soul", "warm", "honey", "amor", "corazon", "corazón"],
  bloom: ["fire", "burn", "flame", "alive", "free", "freedom", "rise", "blossom", "bloom", "glory", "golden", "euphori", "ignite"],
  shimmer: ["shine", "shining", "star", "gold", "diamond", "light", "bright", "spark", "glitter", "magic", "heaven", "angel", "crystal", "clear", "clarity", "remedy", "sunshine", "neon", "glow"],
  wave: ["ocean", "sea", "wave", "water", "rain", "fly", "flying", "float", "sky", "wind", "river", "drift", "falling", "tears", "cry", "dream", "tragedy", "alone", "lonely", "slow", "breathe"],
  shake: ["shake", "fight", "war", "scream", "rage", "thunder", "boom", "bang", "explode", "earthquake", "fury", "storm", "run", "hurricane", "riot"],
  glitch: ["insan", "crazy", "madness", "chaos", "broken", "glitch", "static", "electric", "psycho", "toxic", "danger",  "wild", "error", "system", "digital", "paranoi"],
};

/** Short stems that must match the whole word (+ "s" / "y"): "star" ≠ "start", "war" ≠ "warm". */
const EXACT = new Set(["star", "war", "run", "sea", "sky", "fly", "free", "rise", "wild", "gold", "light", "clear", "cry", "slow", "glow", "wave", "boom", "bang", "kiss", "soul", "warm", "baby", "neon", "spark", "rain", "wind", "storm", "fire", "burn"]);
const STOP = new Set([
  "the", "and", "for", "you", "your", "with", "that", "this", "from", "feat", "remix", "version", "edit", "live", "mix", "radio", "official", "video", "audio", "lyrics", "what", "when", "where", "into", "just", "like",
]);

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** Keyword family of one word, or null. */
export function keywordStyle(word: string): FxStyle | null {
  const w = norm(word).replace(/'s$|'$/, "");
  if (w.length < 3) return null;
  for (const style of FX_STYLES) {
    for (const k of LEXICON[style]) {
      if (EXACT.has(k) ? w === k || w === `${k}s` || w === `${k}y` : w.startsWith(k)) return style;
    }
  }
  return null;
}

/** Content words of the title worth highlighting ("Clarity (feat. Foxes)" → ["clarity"]). */
export function titleWords(title: string | undefined): Set<string> {
  if (!title) return new Set();
  const core = title.replace(/[([{].*?[)\]}]/g, " ").replace(/\s[-–—]\s.*$/, " ").replace(/\bfeat\..*$/i, " ");
  const all = core.split(/\s+/).map(norm).filter(Boolean);
  // Long titles ("Never Gonna Give You Up") would light half the chorus: only short titles count.
  if (all.length > 3) return new Set();
  return new Set(all.filter((w) => w.length >= 4 && !STOP.has(w)));
}

const isHeld = (line: TimedLine, w: TimedWord, core: string) =>
  w.end - w.start >= HELD_MS && (line.exact || /(\p{L})\1{2,}/u.test(core));

const lineKey = (l: TimedLine) => norm(l.text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Song pace (weight units / s, 2 … 8) → 0 … 1. */
export const energyOf = (pace: number) => Math.min(1, Math.max(0, (pace - 2.6) / 3.2));

export function planWordFx(tl: Timeline, opts: { choice: FxChoice; title?: string }): SongFx {
  const energy = energyOf(tl.pace || 4);
  const title = titleWords(opts.title);

  // Chorus = lines sung more than once.
  const counts = new Map<string, number>();
  for (const l of tl.lines) if (!l.bg) counts.set(lineKey(l), (counts.get(lineKey(l)) ?? 0) + 1);

  // Song style: the keyword family the lyrics lean on, else one from the pace.
  const hits = new Map<FxStyle, number>();
  let total = 0;
  for (const l of tl.lines)
    for (const w of l.words) {
      const k = keywordStyle(w.text);
      if (k) {
        hits.set(k, (hits.get(k) ?? 0) + 1);
        total++;
      }
    }
  let base: FxStyle = energy >= 0.62 ? "shimmer" : energy <= 0.25 ? "wave" : "glow";
  const top = [...hits].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 3 && top[1] >= total * 0.4) base = top[0];
  if (opts.choice !== "auto") base = opts.choice;

  const words = tl.lines.map((line) => {
    const out: (WordFx | null)[] = line.words.map(() => null);
    if (line.fill !== "words") return out;
    const chorus = (counts.get(lineKey(line)) ?? 0) >= 2;
    let spot: { i: number; fx: WordFx; dur: number } | null = null;
    line.words.forEach((w, i) => {
      const core = w.text.trim();
      const n = [...core].length;
      if (!n || n > FX_LETTERS_MAX) return;
      const dur = w.end - w.start;
      const isTitle = title.has(norm(core).replace(/'s$/, ""));
      const kw = keywordStyle(core);
      const held = isHeld(line, w, core);
      let strength = 0.75 + 0.3 * energy + (chorus ? 0.1 : 0) + (isTitle ? 0.15 : 0);
      strength = Math.min(1.3, strength);
      const pick = (s: FxStyle): FxStyle => (opts.choice === "auto" ? s : opts.choice);
      if (held) {
        out[i] = { style: pick(isTitle ? "bloom" : (kw ?? base)), strength };
        return;
      }
      // Title words and keywords sung long enough to notice; one per line (the longest).
      if (!isTitle && !kw) return;
      if (dur < (line.exact ? KEYWORD_MS_EXACT : KEYWORD_MS_EST)) return;
      if (!spot || dur > spot.dur) spot = { i, dur, fx: { style: pick(isTitle ? "bloom" : kw!), strength: strength * 0.85 } };
    });
    const s = spot as { i: number; fx: WordFx } | null;
    if (s && !out.some(Boolean)) out[s.i] = s.fx;
    return out;
  });
  return { words, base, energy };
}
