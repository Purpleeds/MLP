// Translation line: translations shipped in the lyrics file (TTML) first, then MyMemory (free, small
// daily limit) or DeepL (user's API key). Online results are saved per song as text files
// (see translationFiles.ts); answers are checked before they're shown or saved.
import type { Lyrics } from "./lyrics/model";
import type { Settings } from "./settings/schema";
import { songLanguage } from "./romanize";

export type TranslateOptions = Settings["translation"];

const MYMEMORY = "https://api.mymemory.translated.net/get";
const MYMEMORY_CHUNK = 450; // service limit is ~500 bytes per request
const RETRY_CONCURRENCY = 5;
const RETRY_GAP_MS = 150;
const DEEPL_CHUNK = 50; // DeepL accepts at most 50 texts per request

const WORDS: Record<string, string[]> = {
  en: ["the", "you", "and", "i", "to", "me", "my", "in", "it", "is", "of", "your", "we", "be", "on", "that", "for", "love", "all", "know", "can't", "don't", "i'm", "what", "with"],
  es: ["el", "la", "que", "de", "y", "en", "mi", "tu", "yo", "te", "me", "no", "es", "por", "con", "una", "los", "las", "pero", "amor", "como", "más", "quiero", "corazón"],
  fr: ["le", "la", "les", "et", "je", "tu", "de", "des", "un", "une", "est", "pas", "que", "qui", "mon", "moi", "toi", "dans", "pour", "avec", "c'est", "j'ai", "nous", "vous"],
  de: ["der", "die", "das", "und", "ich", "du", "nicht", "ist", "ein", "eine", "mit", "mich", "dich", "mir", "dir", "wir", "auf", "für", "es", "zu", "sie", "noch", "auch", "liebe"],
  pt: ["o", "a", "que", "de", "e", "eu", "você", "não", "um", "uma", "meu", "minha", "com", "para", "se", "mais", "do", "da", "em", "coração", "amor", "nós", "vou", "tudo"],
  it: ["il", "la", "che", "di", "e", "io", "tu", "non", "un", "una", "mi", "ti", "per", "con", "sono", "è", "ma", "come", "amore", "cuore", "del", "della", "questo", "più"],
};
const WORD_SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v)]));

/** Rough language guess good enough to skip translating a song into its own language. */
export function guessLanguage(texts: string[]): string | null {
  const cjk = songLanguage(texts);
  if (cjk) return cjk;
  const all = texts.join(" ");
  if (/\p{Script=Thai}/u.test(all)) return "th";
  if (/\p{Script=Cyrillic}/u.test(all)) return /[іїєґІЇЄҐ]/u.test(all) ? "uk" : "ru";
  if (/\p{Script=Arabic}/u.test(all)) return "ar";
  const tokens = all.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (!tokens.length) return null;
  let best: string | null = null;
  let bestShare = 0.12;
  for (const [lang, set] of Object.entries(WORD_SETS)) {
    const share = tokens.filter((t) => set.has(t)).length / tokens.length;
    if (share > bestShare) [best, bestShare] = [lang, share];
  }
  return best;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const langMatches = (lang: string | undefined, target: string) => !!lang && lang.toLowerCase().split("-")[0] === target.toLowerCase();

export interface TranslateDeps {
  fetchJson: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: unknown }>;
  /** pause between per-line retries (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
}

/** Why translation stopped, in a form the UI can word. */
export type TranslateProblem = "quota" | "offline" | "unsupported" | "key" | "service";

export class TranslateError extends Error {
  constructor(public problem: TranslateProblem, message: string) {
    super(message);
  }
}

/** Plain-words message for a problem (shown in Settings → Translation). */
export const problemText = (p: TranslateProblem): string =>
  ({
    quota: "Free daily limit reached, try again tomorrow",
    offline: "Offline — translations will load when you're back online",
    unsupported: "Language not supported by the translation service",
    key: "DeepL rejected the API key",
    service: "The translation service didn't answer properly",
  })[p];

const QUOTA_TEXT = /ALL AVAILABLE FREE TRANSLATIONS|NEXT AVAILABLE IN|QUOTA/i;
const WARNING_TEXT = /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE|SELECT TWO DISTINCT LANGUAGES|INVALID SOURCE LANGUAGE|INVALID TARGET LANGUAGE|NO QUERY SPECIFIED|INVALID EMAIL|AUTODETECT/i;

/** An answer that looks like a service message rather than a translation (shouty all-caps). */
function looksLikeError(text: string, source: string): boolean {
  if (WARNING_TEXT.test(text) || QUOTA_TEXT.test(text)) return true;
  const letters = text.replace(/[^\p{L}]/gu, "");
  const upper = letters.replace(/[^\p{Lu}]/gu, "");
  const srcLetters = source.replace(/[^\p{L}]/gu, "");
  const srcUpper = srcLetters.replace(/[^\p{Lu}]/gu, "");
  return letters.length >= 12 && upper.length === letters.length && text.trim().split(/\s+/).length >= 3 && srcUpper.length < srcLetters.length;
}

/** Translation for a line, null = nothing to show (bad answer or same as the original). */
export function cleanAnswer(text: string | undefined | null, source: string): string | null {
  const t = (text ?? "").trim();
  if (!t || looksLikeError(t, source) || same(t, source)) return null;
  return t;
}

interface MmBody {
  responseData?: { translatedText?: string; detectedLanguage?: string };
  quotaFinished?: boolean | null;
  responseStatus?: number | string;
  responseDetails?: string;
}

/** One MyMemory request. Returns the raw translated text ("" when the text is already in the target language). */
async function mmGet(q: string, target: string, deps: TranslateDeps): Promise<string> {
  const url = `${MYMEMORY}?q=${encodeURIComponent(q)}&langpair=Autodetect|${encodeURIComponent(target)}`;
  let res: Awaited<ReturnType<TranslateDeps["fetchJson"]>>;
  try {
    res = await deps.fetchJson(url);
  } catch {
    throw new TranslateError("offline", "offline");
  }
  const body = (res.json ?? {}) as MmBody;
  const status = Number(body.responseStatus ?? res.status);
  const text = body.responseData?.translatedText ?? "";
  const details = `${body.responseDetails ?? ""} ${text}`;
  if (body.quotaFinished || status === 429 || res.status === 429 || QUOTA_TEXT.test(details)) throw new TranslateError("quota", "quota");
  if (/SELECT TWO DISTINCT LANGUAGES/i.test(details)) return ""; // already in the target language
  if (/INVALID (SOURCE |TARGET )?LANGUAGE/i.test(details)) throw new TranslateError("unsupported", details.trim());
  if (!res.ok || status !== 200) throw new TranslateError("service", `MyMemory ${status}`);
  if (langMatches(body.responseData?.detectedLanguage, target)) return "";
  return text;
}

const MARK = /^\s*[[(]?(\d{1,3})[\].):]\s*(.*)$/;

/** Split a numbered answer ("1. …\n2. …") back into lines; null where a line can't be trusted. */
export function splitNumbered(answer: string, count: number): (string | null)[] {
  const got = new Map<number, string[]>();
  const seen = new Map<number, number>();
  let cur = -1;
  for (const raw of answer.split(/\r?\n/)) {
    const m = MARK.exec(raw);
    const n = m ? Number(m[1]) : NaN;
    if (m && n >= 1 && n <= count) {
      cur = n;
      seen.set(n, (seen.get(n) ?? 0) + 1);
      got.set(n, [...(got.get(n) ?? []), m[2]]);
    } else if (cur > 0 && raw.trim()) got.get(cur)!.push(raw.trim()); // a line split in two: keep it with its number
  }
  const out: (string | null)[] = [];
  for (let n = 1; n <= count; n++) {
    // A missing next number means it was probably merged into this one.
    const ok = seen.get(n) === 1 && (n === count || seen.get(n + 1) === 1);
    out.push(ok ? got.get(n)!.join(" ").trim() : null);
  }
  return out;
}

/** Results per line: string = translation, null = nothing to show (done), undefined = not translated. */
export type LineResults = (string | null | undefined)[];

export interface ProviderResult {
  lines: LineResults;
  problem?: TranslateProblem;
}

async function viaMyMemory(lines: string[], target: string, deps: TranslateDeps): Promise<ProviderResult> {
  const out: LineResults = lines.map(() => undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retry: number[] = [];
  let batch: number[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const b = batch;
    batch = [];
    size = 0;
    if (b.length === 1) {
      out[b[0]] = cleanAnswer(await mmGet(lines[b[0]], target, deps), lines[b[0]]);
      return;
    }
    const answer = await mmGet(b.map((i, k) => `${k + 1}. ${lines[i]}`).join("\n"), target, deps);
    if (!answer) return b.forEach((i) => (out[i] = null)); // already in the target language
    splitNumbered(answer, b.length).forEach((t, k) => (t === null ? retry.push(b[k]) : (out[b[k]] = cleanAnswer(t, lines[b[k]]))));
  };
  try {
    for (let i = 0; i < lines.length; i++) {
      const len = new TextEncoder().encode(`${batch.length + 1}. ${lines[i]}`).length + 1;
      if (size + len > MYMEMORY_CHUNK) await flush();
      batch.push(i);
      size += len;
    }
    await flush();
    // Lines that came back merged or split: one by one, a few at a time.
    for (let k = 0; k < retry.length; k += RETRY_CONCURRENCY) {
      if (k) await sleep(RETRY_GAP_MS);
      await Promise.all(retry.slice(k, k + RETRY_CONCURRENCY).map(async (i) => (out[i] = cleanAnswer(await mmGet(lines[i], target, deps), lines[i]))));
    }
  } catch (e) {
    if (e instanceof TranslateError) return { lines: out, problem: e.problem };
    throw e;
  }
  return { lines: out };
}

async function viaDeepL(lines: string[], target: string, key: string, deps: TranslateDeps): Promise<ProviderResult> {
  const host = key.trim().endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const out: LineResults = lines.map(() => undefined);
  for (let k = 0; k < lines.length; k += DEEPL_CHUNK) {
    const part = lines.slice(k, k + DEEPL_CHUNK);
    let res: Awaited<ReturnType<TranslateDeps["fetchJson"]>>;
    try {
      res = await deps.fetchJson(`${host}/v2/translate`, {
        method: "POST",
        headers: { Authorization: `DeepL-Auth-Key ${key.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: part, target_lang: target.toUpperCase() === "PT" ? "PT-PT" : target.toUpperCase() }),
      });
    } catch {
      return { lines: out, problem: "offline" };
    }
    if (res.status === 403) throw new TranslateError("key", "DeepL rejected the API key");
    if (res.status === 456 || res.status === 429) return { lines: out, problem: "quota" };
    if (res.status === 400) return { lines: out, problem: "unsupported" };
    if (!res.ok) throw new TranslateError("service", `DeepL HTTP ${res.status}`);
    const t = (res.json as { translations?: { text: string }[] }).translations ?? [];
    part.forEach((src, i) => (out[k + i] = cleanAnswer(t[i]?.text, src)));
  }
  return { lines: out };
}

/** Lines worth sending: has letters, not a background vocal. */
export const wantedLines = (lyrics: Lyrics) => lyrics.lines.map((l, i) => (/\p{L}/u.test(l.text) && !l.bg ? i : -1)).filter((i) => i >= 0);

/** Translations shipped with the lyrics, or null when the online services should be asked. */
export function fileTranslations(lyrics: Lyrics, o: TranslateOptions): (string | null)[] | null {
  const fromFile = lyrics.lines.map((l) => (l.translation && langMatches(l.translationLang, o.target) ? l.translation : null));
  if (fromFile.some(Boolean)) return fromFile;
  const lang = guessLanguage(lyrics.lines.map((l) => l.text));
  if (lang && lang === o.target.toLowerCase()) return lyrics.lines.map(() => null);
  return null;
}

/** Translate the given unique texts with the chosen online provider. */
export function translateTexts(texts: string[], o: TranslateOptions, deps: TranslateDeps): Promise<ProviderResult> {
  if (!texts.length) return Promise.resolve({ lines: [] });
  return o.provider === "deepl" ? viaDeepL(texts, o.target, o.deeplKey, deps) : viaMyMemory(texts, o.target, deps);
}
