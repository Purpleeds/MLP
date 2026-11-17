// Romanization of lyrics: Japanese → romaji (Lindera readings from Rust), Chinese → pinyin,
// Korean → Revised Romanization, other non-Latin scripts → any-ascii. Per-word output keeps
// exact word timings usable for the karaoke fill.
import { pinyin } from "pinyin-pro";
import * as wanakana from "wanakana";
import anyAscii from "any-ascii";
import { getJyutpingList } from "to-jyutping";
import { koRoman } from "./korean";
import { isTauri, platform } from "../platform";
import type { Lyrics } from "../lyrics/model";
import type { Settings } from "../settings/schema";

export type RomanOptions = Settings["romanization"];
export type SongLang = "ja" | "zh" | "ko" | null;

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const HANGUL = /\p{Script=Hangul}/u;
// Letters that aren't Latin/Common (Cyrillic, Greek, Thai, Arabic, Devanagari, …).
const OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s]/u;

/** Dominant CJK language of a song (kana anywhere ⇒ Japanese, since kanji lines in J-songs have no kana). */
export function songLanguage(texts: string[]): SongLang {
  const all = texts.join("\n");
  if (KANA.test(all)) return "ja";
  const hangul = (all.match(/\p{Script=Hangul}/gu) ?? []).length;
  const han = (all.match(/\p{Script=Han}/gu) ?? []).length;
  if (hangul && hangul >= han) return "ko";
  if (han) return "zh";
  if (hangul) return "ko";
  return null;
}

export type LineScript = "ja" | "zh" | "ko" | "th" | "abjad" | "other" | "latin";

const ABJAD = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;
// Arabic harakat / Hebrew niqqud: written vowels.
const VOWEL_MARKS = /[ً-ְْٰ-ׇֻ]/gu;

export function lineScript(text: string, song: SongLang): LineScript {
  if (KANA.test(text)) return "ja";
  if (HANGUL.test(text)) return "ko";
  if (HAN.test(text)) return song === "ja" ? "ja" : "zh";
  if (/\p{Script=Thai}/u.test(text)) return "th";
  if (ABJAD.test(text)) return "abjad";
  if (OTHER_SCRIPT.test(text)) return "other";
  return "latin";
}

/** Arabic / Hebrew lines usually leave short vowels out; only lines that write them romanize readably. */
export function hasVowelMarks(text: string): boolean {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters > 0 && (text.match(VOWEL_MARKS) ?? []).length >= letters * 0.3;
}

/** any-ascii for Arabic / Hebrew, with long vowels tidied (habiybiy → habibi, ruwhiy → ruhi). */
export const abjadLine = (text: string) =>
  anyAscii(text)
    .replace(/iy(?![aeiou])/g, "i")
    .replace(/uw(?![aeiou])/g, "u");

// ---------- Japanese ----------
export interface JaWord {
  display: string;
  yomi: string; // katakana reading
  pos: string;
  pos1: string;
}

const PARTICLE_READ: Record<string, string> = { は: "wa", へ: "e", を: "o" };

function macron(s: string) {
  return s.replace(/ou/g, "ō").replace(/uu/g, "ū").replace(/aa/g, "ā").replace(/ee/g, "ē").replace(/oo/g, "ō");
}

/** Romaji for one analyzer token, and whether it attaches to the previous token without a space. */
export function jaToken(w: JaWord, long: RomanOptions["romajiLong"]): { text: string; attach: boolean } {
  const isParticle = w.pos === "助詞";
  let text: string;
  if (isParticle && PARTICLE_READ[w.display]) text = PARTICLE_READ[w.display];
  else if (w.yomi) text = wanakana.toRomaji(w.yomi);
  else text = KANA.test(w.display) ? wanakana.toRomaji(w.display) : w.display;
  text = text.replace(/[々〻〃]/g, ""); // iteration marks never belong in romaji
  if (long === "macron") text = macron(text);
  // Verb endings attach (iki|masu → ikimasu); copulas stay separate (tenki desu).
  const copula = /^(です|でした|でしょう|だ|だった|だろう)$/.test(w.display);
  const attach =
    (w.pos === "助動詞" && !copula) || w.pos1 === "接尾" || w.pos === "記号" || (isParticle && (w.pos1 === "接続助詞" || w.display === "っ")) || /^\s*$/.test(w.display);
  return { text, attach };
}

/** Romaji for a line plus per-character-range mapping (start offset → romaji). */
export function jaLine(words: JaWord[], long: RomanOptions["romajiLong"]): { text: string; pieces: { start: number; end: number; text: string; attach: boolean }[] } {
  const pieces: { start: number; end: number; text: string; attach: boolean }[] = [];
  let pos = 0;
  for (const w of words) {
    const t = jaToken(w, long);
    pieces.push({ start: pos, end: pos + [...w.display].length, ...t });
    pos += [...w.display].length;
  }
  return { text: joinPieces(pieces), pieces };
}

function joinPieces(pieces: { text: string; attach: boolean }[]): string {
  let out = "";
  for (const p of pieces) {
    const t = p.text.trim();
    if (!t) continue;
    out += out && !p.attach && !/^[,.!?、。！？」』)]/.test(t) ? " " + t : t;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Kana-only fallback (mock mode / analyzer unavailable): kanji are left as written. */
const jaFallback = (text: string): JaWord[] => [{ display: text, yomi: "", pos: "", pos1: "" }];

// ---------- Chinese / Korean / other ----------
export function zhChars(text: string, tones: RomanOptions["pinyinTones"]): string[] {
  const toneType = tones === "symbol" ? "symbol" : tones === "num" ? "num" : "none";
  return pinyin(text, { type: "all", toneType }).map((x) => (x.isZh ? x.pinyin : x.origin));
}

const joinZh = (chars: string[], src: string[]) => {
  let out = "";
  chars.forEach((c, i) => {
    const zh = HAN.test(src[i] ?? "");
    const prevZh = i > 0 && HAN.test(src[i - 1] ?? "");
    out += (zh || prevZh) && out && !out.endsWith(" ") && c !== " " ? " " + c : c;
  });
  return out.replace(/\s+/g, " ").trim();
};

export const zhLine = (text: string, tones: RomanOptions["pinyinTones"]) => joinZh(zhChars(text, tones), [...text]);
export const koLine = (text: string, rules = true) => koRoman(text, rules);

/** Characters only written in Cantonese → the lyrics are Cantonese. */
const CANTONESE_ONLY = /[嘅咗冇唔佢哋啲嚟喺乜嘢咁噉睇嗰嘥嬲攰咪囉喎噃嘞]/u;
export const isCantonese = (text: string) => CANTONESE_ONLY.test(text);

/** Jyutping per character (non-Han characters kept as they are). */
export function jyutChars(text: string): string[] {
  return getJyutpingList(text).map(([ch, jp]) => jp ?? ch);
}
export const otherLine = (text: string) => anyAscii(text);

// ---------- whole song ----------
export interface RubyPiece {
  /** character offsets in the original line */
  start: number;
  end: number;
  display: string;
  /** hiragana reading */
  reading: string;
}

export interface RomanLine {
  text: string;
  /** Japanese: readings for kanji words (furigana mode) */
  ruby?: RubyPiece[];
  /** romanization per source word (only for lines with exact word timing) */
  words?: string[];
}

const capitalize = (s: string) => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());

// ---------- Japanese dictionary on demand (Upgrade 17) ----------
let dictAsked = false;
let dictVersion = 0;
const dictListeners = new Set<() => void>();
/** First Japanese song: download the dictionary (~11 MB) in the background; kana-only romaji until then. */
function ensureJpDict() {
  if (dictAsked) return;
  dictAsked = true;
  void platform.on("jp-dict-ready", () => {
    cache.clear();
    dictVersion++;
    dictListeners.forEach((l) => l());
  });
  void platform.invoke<{ installed: boolean; downloading: boolean }>("jp_dict_status").then((st) => {
    if (st && !st.installed && !st.downloading) void platform.invoke("ai_download", { id: "ipadic" }).catch(() => (dictAsked = false));
  });
}
/** Changes when the Japanese dictionary arrives (re-romanize). */
export const jpDictVersion = () => dictVersion;
export function onJpDict(cb: () => void) {
  dictListeners.add(cb);
  return () => void dictListeners.delete(cb);
}

const cache = new Map<string, (RomanLine | null)[]>();

/** Romanize every line; null for lines that are already Latin or whose language is switched off. */
export async function romanizeLyrics(lyrics: Lyrics, o: RomanOptions): Promise<(RomanLine | null)[]> {
  const key = `${lyrics.source}:${lyrics.id}:${lyrics.trackName}:${lyrics.lines.length}:${lyrics.lines[lyrics.lines.length - 1]?.text ?? ""}:${JSON.stringify(o)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const texts = lyrics.lines.map((l) => l.text);
  const song = songLanguage(texts);
  const scripts = texts.map((t) => lineScript(t, song));
  const abjad = o.abjad ?? "auto";
  const enabled = (s: LineScript, text = "") =>
    s === "ja"
      ? o.ja
      : s === "zh"
        ? o.zh
        : s === "ko"
          ? o.ko
          : s === "th"
            ? o.th !== false
            : s === "abjad"
              ? abjad === "on" || (abjad === "auto" && hasVowelMarks(text))
              : s === "other"
                ? o.other
                : false;
  const useJyutping = o.chinese === "jyutping" || (o.chinese === "auto" && texts.some(isCantonese));

  // Thai in one batch through Rust (dictionary-based RTGS); any-ascii as the fallback.
  const thIdx = scripts.map((s, i) => (s === "th" && enabled("th") ? i : -1)).filter((i) => i >= 0);
  const thFor = new Map<number, string>();
  if (thIdx.length && isTauri()) {
    const res = (await platform.invoke<string[]>("th_romanize", { lines: thIdx.map((i) => texts[i]) }).catch(() => undefined)) ?? [];
    thIdx.forEach((i, k) => res[k] && thFor.set(i, res[k]));
  }

  // Japanese analysis in one batch through Rust.
  const jaIdx = scripts.map((s, i) => (s === "ja" && o.ja ? i : -1)).filter((i) => i >= 0);
  let jaWords: JaWord[][] = [];
  if (jaIdx.length && isTauri()) ensureJpDict();
  if (jaIdx.length) {
    jaWords = (isTauri() ? await platform.invoke<JaWord[][]>("jp_readings", { lines: jaIdx.map((i) => texts[i]) }).catch(() => undefined) : undefined) ?? [];
  }
  const jaFor = new Map(jaIdx.map((i, k) => [i, jaWords[k]?.length ? jaWords[k] : jaFallback(texts[i])]));

  const out = lyrics.lines.map((line, i): RomanLine | null => {
    const sc = scripts[i];
    if (!enabled(sc, line.text)) return null;
    const text = line.text;
    let roman = "";
    let words: string[] | undefined;
    let ruby: RubyPiece[] | undefined;
    if (sc === "ja") {
      const analyzed = jaFor.get(i)!;
      const { text: r, pieces } = jaLine(analyzed, o.romajiLong);
      roman = r;
      let off = 0;
      ruby = [];
      for (const w of analyzed) {
        const len = [...w.display].length;
        if (/\p{Script=Han}/u.test(w.display) && w.yomi) ruby.push({ start: off, end: off + len, display: w.display, reading: wanakana.toHiragana(w.yomi) });
        off += len;
      }
      if (line.words) {
        // Assign analyzer pieces to the timed words they start in.
        let off = 0;
        words = line.words.map((w) => {
          const len = [...w.text].length;
          const own = pieces.filter((p) => p.start >= off && p.start < off + len);
          off += len;
          return joinPieces(own);
        });
      }
    } else if (sc === "zh") {
      const chars = useJyutping ? jyutChars(text) : zhChars(text, o.pinyinTones);
      roman = joinZh(chars, [...text]);
      if (line.words) {
        let off = 0;
        words = line.words.map((w) => {
          const len = [...w.text].length;
          const seg = joinZh(chars.slice(off, off + len), [...text].slice(off, off + len));
          off += len;
          return seg;
        });
      }
    } else if (sc === "ko") {
      roman = koLine(text, o.koreanPronunciation !== false);
      words = line.words?.map((w) => koLine(w.text, false).trim());
    } else if (sc === "th") {
      roman = thFor.get(i) ?? otherLine(text);
      words = line.words?.map((w) => otherLine(w.text).trim());
    } else if (sc === "abjad") {
      roman = abjadLine(text);
      words = line.words?.map((w) => abjadLine(w.text).trim());
    } else {
      roman = otherLine(text);
      words = line.words?.map((w) => otherLine(w.text).trim());
    }
    if (o.capitalize) roman = capitalize(roman);
    if (!roman || roman === text) return null;
    return { text: roman, ...(words ? { words } : {}), ...(ruby?.length ? { ruby } : {}) };
  });
  cache.set(key, out);
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return out;
}
