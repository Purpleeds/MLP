// Split lyric text into fill tokens and estimate how long each takes to sing (relative weight).

export interface Token {
  /** display text incl. trailing whitespace/punctuation */
  text: string;
  /** relative singing length (≈ syllables / morae, plus holds) */
  weight: number;
  /** pause weight after this token (commas etc.) */
  pause: number;
  /** inside parentheses → background vocal */
  bg: boolean;
}

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const THAI = /\p{Script=Thai}/u;
// Small kana / prolonged sound mark attach to the previous mora.
const ATTACH_KANA = /[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿー゛゜]/u;
const PUNCT = /[\p{P}\p{S}]/u;
const PAUSE_PUNCT = /[,;:、，；：…。.!?！？]$/u;
const VOWELS = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ]+/giu;

const isCjkChar = (c: string) => HAN.test(c) || KANA.test(c) || HANGUL.test(c) || THAI.test(c);

const CYRILLIC = /\p{Script=Cyrillic}/u;
const CYR_VOWELS = /[аеёиоуыэюяіїєў]/giu;
const GREEK = /\p{Script=Greek}/u;
const GREEK_VOWELS = /[αεηιουωάέήίόύώϊϋΐΰ]+/giu;
// Abjads write few vowels: about one syllable per two letters.
const ABJAD = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}]/u;
// Indic scripts: every consonant carries a vowel unless a virama kills it.
const INDIC = /[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]/u;
const VIRAMA = /[्্੍્୍்్್്්]/gu;

/** Syllables of one word in a non-CJK script (Latin by vowel groups, others per script). */
function syllables(raw: string, w: string): number {
  if (CYRILLIC.test(w)) return (w.match(CYR_VOWELS) ?? []).length;
  if (GREEK.test(w)) return (w.match(GREEK_VOWELS) ?? []).length;
  const letters = [...w].filter((c) => /\p{L}/u.test(c)).length;
  if (ABJAD.test(w)) return Math.round(letters / 2);
  if (INDIC.test(w)) return letters - (raw.match(VIRAMA) ?? []).length;
  let syl = (w.match(VOWELS) ?? []).length;
  if (syl > 1 && /[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) syl -= 1; // silent e
  return syl;
}

/** Syllable estimate for one Latin-ish (or Cyrillic / Greek / Arabic / Hebrew / Indic) word, plus elongation bonus ("noooo", "yeahhh", "~"). */
export function latinWeight(word: string): number {
  const w = word.toLowerCase().replace(/[^\p{L}\p{N}~]/gu, "");
  if (!w) return 0;
  if (/^\d+$/.test(w)) return w.length;
  const syl = Math.max(1, syllables(word, w));
  let bonus = 0;
  for (const run of w.match(/(\p{L})\1{2,}/gu) ?? []) bonus += (run.length - 2) * 0.6;
  bonus += (w.match(/~/g) ?? []).length;
  return syl + Math.min(bonus, 6);
}

/** Weight of a CJK/kana token (morae; ー and っ add length). */
function cjkWeight(tok: string): number {
  let w = 0;
  for (const c of tok) {
    if (c === "ー" || c === "〜" || c === "~") w += 1;
    else if (c === "っ" || c === "ッ") w += 0.3;
    else if (ATTACH_KANA.test(c)) w += 0;
    else if (isCjkChar(c)) w += 1;
  }
  return Math.max(w, 0.5);
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const chars = [...text];
  let bgDepth = 0;
  let prefix = ""; // opening brackets / leading punctuation waiting for the next token
  let i = 0;
  const push = (t: string, weight: number) => {
    out.push({ text: prefix + t, weight, pause: 0, bg: bgDepth > 0 });
    prefix = "";
  };
  const glue = (s: string) => {
    if (out.length && !prefix) out[out.length - 1].text += s;
    else prefix += s;
  };

  while (i < chars.length) {
    const c = chars[i];
    if (c === "(" || c === "（") {
      bgDepth++;
      prefix += c;
      i++;
    } else if (c === ")" || c === "）") {
      glue(c);
      bgDepth = Math.max(0, bgDepth - 1);
      i++;
    } else if (PUNCT.test(c) && (i === 0 || /\s/u.test(chars[i - 1])) && /[\p{L}\p{N}]/u.test(chars[i + 1] ?? "")) {
      prefix += c; // leading quote/punctuation belongs to the next word ('Cause, "Hey)
      i++;
    } else if (/\s/u.test(c) || PUNCT.test(c)) {
      glue(c);
      i++;
    } else if (isCjkChar(c)) {
      let tok = c;
      i++;
      while (i < chars.length && ATTACH_KANA.test(chars[i])) tok += chars[i++];
      push(tok, cjkWeight(tok));
    } else {
      // Latin/other word: until whitespace, CJK, bracket, or a hyphen between syllable groups ("oh-oh-oh").
      let tok = c;
      i++;
      while (i < chars.length && !/\s/u.test(chars[i]) && !isCjkChar(chars[i]) && !/[()（）]/u.test(chars[i])) {
        if (chars[i] === "-" && i + 1 < chars.length && /\p{L}/u.test(chars[i + 1])) {
          tok += chars[i++];
          break;
        }
        tok += chars[i++];
      }
      push(tok, latinWeight(tok));
    }
  }
  if (prefix) {
    if (out.length) out[out.length - 1].text += prefix;
    else out.push({ text: prefix, weight: 0, pause: 0, bg: false });
  }

  for (const t of out) if (PAUSE_PUNCT.test(t.text.trimEnd())) t.pause = 0.3;
  // Drop pure-punctuation tokens of zero weight by gluing them to the previous token.
  const merged: Token[] = [];
  for (const t of out) {
    if (t.weight === 0 && merged.length) merged[merged.length - 1].text += t.text;
    else merged.push(t);
  }
  return merged;
}

export const totalWeight = (toks: Token[]) => toks.reduce((s, t) => s + t.weight, 0);
