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
  // Verb endings attach (iki|masu → ikimasu); copulas stay separate (tenki desu, kirei na, mon nan desho).
  const copula = /^(です|でした|でしょう|でしょ|だ|だった|だろう|な)$/.test(w.display);
  // The contracted nominalizer ん belongs to the word before it (nan desho, not na n desho).
  const nominalN = /^[んン]$/.test(w.display) && w.pos === "名詞";
  const attach =
    (w.pos === "助動詞" && !copula) ||
    w.pos1 === "接尾" ||
    w.pos === "記号" ||
    nominalN ||
    (isParticle && (w.pos1 === "接続助詞" || w.display === "っ")) ||
    /^\s*$/.test(w.display);
  return { text, attach };
}

/**
 * A small っ/ッ at the end of a word (or split off on its own) doubles the next word's first consonant:
 * 命|っ|つっ|たって → inochi ttsuttatte. Romanized alone it would just disappear.
 */
function carrySmallTsu(words: JaWord[]): JaWord[] {
  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i < out.length - 1; i++) {
    const y = out[i].yomi || (KANA.test(out[i].display) ? wanakana.toKatakana(out[i].display) : "");
    if (!/ッ$/.test(y)) continue;
    const next = out[i + 1];
    const ny = next.yomi || (KANA.test(next.display) ? wanakana.toKatakana(next.display) : "");
    if (!ny || !/^[\p{Script=Katakana}]/u.test(ny)) continue;
    out[i].yomi = y.slice(0, -1) || " "; // " " = nothing left to say (the token stays for timing)
    next.yomi = "ッ" + ny;
  }
  return out;
}

/** Romaji for a line plus per-character-range mapping (start offset → romaji). */
export function jaLine(words: JaWord[], long: RomanOptions["romajiLong"]): { text: string; pieces: { start: number; end: number; text: string; attach: boolean }[] } {
  const pieces: { start: number; end: number; text: string; attach: boolean }[] = [];
  let pos = 0;
  for (const w of carrySmallTsu(words)) {
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
/** Waits before trying again after the dictionary couldn't be set up (the last one repeats). */
export const DICT_RETRY_MS = [15_000, 60_000, 300_000];
let dictState: "idle" | "working" | "waiting" | "ready" = "idle";
let dictFails = 0;
let dictListening = false;
/** A Japanese line with kanji went without readings since the dictionary was last set up. */
let jaMissing = false;
let dictVersion = 0;
const dictListeners = new Set<() => void>();

function dictArrived() {
  jaMissing = false;
  cache.clear();
  dictVersion++;
  dictListeners.forEach((l) => l());
}

/**
 * Kanji need the Japanese dictionary (~11 MB, fetched when the first Japanese song plays); until it works,
 * lines with kanji stay as written. Rust uses the copy on disk, replaces one that doesn't load, or downloads
 * it. A failure is retried after 15 s, 1 min, then every 5 min, so one network hiccup or a half-unpacked
 * copy can't leave romaji off for good (it used to wait for the next song, and a broken copy counted as
 * installed forever).
 */
function ensureJpDict() {
  if (dictState !== "idle") return;
  dictState = "working";
  if (!dictListening) {
    dictListening = true;
    // Also fires when the dictionary is downloaded from Settings → AI models.
    void platform.on("jp-dict-ready", () => {
      dictState = "ready";
      dictArrived();
    });
  }
  void platform.invoke("jp_dict_ensure").then(
    () => {
      dictFails = 0;
      dictState = "ready";
      if (jaMissing) dictArrived();
    },
    (e) => {
      platform.log(`japanese dictionary: ${e}`);
      dictState = "waiting";
      setTimeout(() => {
        dictState = "idle";
        ensureJpDict();
      }, DICT_RETRY_MS[Math.min(dictFails++, DICT_RETRY_MS.length - 1)]);
    },
  );
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
  if (jaIdx.length) {
    jaWords = (isTauri() ? await platform.invoke<JaWord[][]>("jp_readings", { lines: jaIdx.map((i) => texts[i]) }).catch(() => undefined) : undefined) ?? [];
  }
  if (isTauri() && jaIdx.some((i, k) => !jaWords[k]?.length && HAN.test(texts[i]))) {
    jaMissing = true;
    ensureJpDict();
  }
  // No analysis (dictionary still downloading, or mock mode): kana-only lines can still be romanized;
  // lines with kanji stay as written until the dictionary arrives (a half-converted mix of romaji and
  // kanji reads worse than either), then everything is romanized again.
  const jaFor = new Map(jaIdx.map((i, k) => [i, jaWords[k]?.length ? jaWords[k] : HAN.test(texts[i]) ? null : jaFallback(texts[i])]));

  const out = lyrics.lines.map((line, i): RomanLine | null => {
    const sc = scripts[i];
    if (!enabled(sc, line.text)) return null;
    const text = line.text;
    let roman = "";
    let words: string[] | undefined;
    let ruby: RubyPiece[] | undefined;
    if (sc === "ja") {
      const analyzed = jaFor.get(i);
      if (!analyzed) return null;
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
