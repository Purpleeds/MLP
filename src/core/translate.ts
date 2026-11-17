// Translation line: translations shipped in the lyrics file (TTML) first, then MyMemory (free, small
// daily limit) or DeepL (user's API key). Results cached per song + target language.
import type { Lyrics } from "./lyrics/model";
import type { Settings } from "./settings/schema";
import { createKv } from "./storage/kv";
import { songLanguage } from "./romanize";

export type TranslateOptions = Settings["translation"];

const cache = createKv<(string | null)[]>("translations.json");
const MYMEMORY_CHUNK = 450; // service limit is ~500 bytes per request

const ENGLISH_WORDS = new Set(["the", "you", "and", "i", "to", "me", "my", "a", "in", "it", "is", "of", "your", "we", "be", "on", "that", "for", "love", "all", "know", "can't", "don't", "i'm"]);

/** Rough language guess good enough to skip translating a song into its own language. */
export function guessLanguage(texts: string[]): string | null {
  const cjk = songLanguage(texts);
  if (cjk) return cjk;
  const all = texts.join(" ");
  if (/\p{Script=Thai}/u.test(all)) return "th";
  if (/\p{Script=Cyrillic}/u.test(all)) return "ru";
  if (/\p{Script=Arabic}/u.test(all)) return "ar";
  const tokens = all.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (tokens.length && tokens.filter((t) => ENGLISH_WORDS.has(t)).length / tokens.length > 0.12) return "en";
  return null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const langMatches = (lang: string | undefined, target: string) => !!lang && lang.toLowerCase().split("-")[0] === target.toLowerCase();

export interface TranslateDeps {
  fetchJson: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: unknown }>;
}

async function viaMyMemory(lines: string[], target: string, deps: TranslateDeps): Promise<(string | null)[]> {
  const out: (string | null)[] = lines.map(() => null);
  // Batch lines (joined with newlines) to stay under the request limit and the daily quota.
  let batch: number[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const q = batch.map((i) => lines[i]).join("\n");
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=Autodetect|${encodeURIComponent(target)}`;
    const res = await deps.fetchJson(url);
    const body = res.json as { responseData?: { translatedText?: string }; quotaFinished?: boolean; responseStatus?: number | string };
    if (!res.ok || body.quotaFinished || Number(body.responseStatus) === 429) throw new Error("quota");
    const parts = (body.responseData?.translatedText ?? "").split(/\n/);
    if (parts.length === batch.length) batch.forEach((i, k) => (out[i] = parts[k]));
    else if (batch.length === 1) out[batch[0]] = parts.join(" ");
    else {
      // Line breaks got lost: retry these lines one by one.
      for (const i of batch) {
        const r = await deps.fetchJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(lines[i])}&langpair=Autodetect|${encodeURIComponent(target)}`);
        out[i] = (r.json as { responseData?: { translatedText?: string } }).responseData?.translatedText ?? null;
      }
    }
    batch = [];
    size = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const len = new TextEncoder().encode(lines[i]).length + 1;
    if (size + len > MYMEMORY_CHUNK) await flush();
    batch.push(i);
    size += len;
  }
  await flush();
  return out;
}

async function viaDeepL(lines: string[], target: string, key: string, deps: TranslateDeps): Promise<(string | null)[]> {
  const host = key.trim().endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const res = await deps.fetchJson(`${host}/v2/translate`, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${key.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: lines, target_lang: target.toUpperCase() === "PT" ? "PT-PT" : target.toUpperCase() }),
  });
  if (!res.ok) throw new Error(res.status === 403 ? "DeepL rejected the API key" : `DeepL HTTP ${res.status}`);
  const t = (res.json as { translations?: { text: string }[] }).translations ?? [];
  return lines.map((_, i) => t[i]?.text ?? null);
}

/** Translation per lyric line (null where none). Throws only for configuration problems (bad key). */
export async function translateLyrics(lyrics: Lyrics, o: TranslateOptions, deps: TranslateDeps): Promise<(string | null)[]> {
  const texts = lyrics.lines.map((l) => l.text);
  const fromFile = lyrics.lines.map((l) => (l.translation && langMatches(l.translationLang, o.target) ? l.translation : null));
  if (fromFile.some(Boolean) || o.provider === "file") return fromFile;
  const lang = guessLanguage(texts);
  if (lang && lang === o.target.toLowerCase()) return texts.map(() => null);

  const key = `${lyrics.source}:${lyrics.id}:${lyrics.trackName}:${lyrics.source === "ai" ? `${lyrics.lines.length}:` : ""}${o.target}:${o.provider}`;
  const hit = await cache.get(key);
  if (hit) return hit;

  const want = texts.map((t, i) => (/\p{L}/u.test(t) && !lyrics.lines[i].bg ? i : -1)).filter((i) => i >= 0);
  const uniq = [...new Set(want.map((i) => texts[i]))]; // choruses repeat: translate once
  let res: (string | null)[];
  try {
    res = o.provider === "deepl" ? await viaDeepL(uniq, o.target, o.deeplKey, deps) : await viaMyMemory(uniq, o.target, deps);
  } catch (e) {
    if (String(e).includes("quota")) return texts.map(() => null); // daily limit reached: try again tomorrow
    throw e;
  }
  const byText = new Map(uniq.map((t, k) => [t, res[k]]));
  const out = texts.map((t, i) => {
    const tr = want.includes(i) ? byText.get(t) : null;
    return tr && !same(tr, t) ? tr : null;
  });
  await cache.set(key, out);
  return out;
}
