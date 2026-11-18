// Saved translations: one readable text file per song in "<app data>\saved translation\".
// A file is used only when its language, provider and lyrics hash match; lines whose text is unchanged
// are reused when the lyrics change (AI lyrics growing, corrected lines), only new lines are sent.
import type { Lyrics } from "./lyrics/model";
import { isTauri, platform } from "./platform";
import { createKv } from "./storage/kv";
import {
  fileTranslations, problemText, TranslateError, translateTexts, wantedLines,
  type LineResults, type TranslateDeps, type TranslateOptions, type TranslateProblem,
} from "./translate";

// ---------- file names ----------
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Windows-safe file name: "<title> - <artist>.txt" (just "<title>.txt" without an artist). */
export function translationFileName(title: string, artist?: string): string {
  const clean = (s: string) =>
    s.replace(/[<>:"/\\|?*]/g, "_").replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
  let base = clean(title) || "Untitled";
  const a = clean(artist ?? "");
  if (a) base += ` - ${a}`;
  base = [...base].slice(0, 120).join("").replace(/[. ]+$/, "");
  if (!base) base = "Untitled";
  if (RESERVED.test(base.split(".")[0])) base = `_${base}`;
  return `${base}.txt`;
}

// ---------- content ----------
/** FNV-1a over the line texts: tells whether the saved file belongs to these exact lyrics. */
export function lyricsHash(texts: string[]): string {
  let h = 0x811c9dc5;
  for (const ch of texts.join("\n")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface SavedTranslation {
  song: string;
  artist: string;
  target: string;
  provider: string;
  hash: string;
  complete: boolean;
  /** original text + result (string = translation, null = nothing to show, undefined = not done yet) */
  lines: { text: string; tr: string | null | undefined }[];
}

const ONE_LINE = (s: string) => s.replace(/\r?\n/g, " ");

/** Notepad-friendly format: header, blank line, then per lyric line: original / "→ translation" / blank. */
export function formatTranslation(f: SavedTranslation): string {
  const head = [
    "MLP saved translation",
    `Song: ${ONE_LINE(f.song)}`,
    `Artist: ${ONE_LINE(f.artist)}`,
    `Language: ${f.target}`,
    `Provider: ${f.provider}`,
    `Lyrics hash: ${f.hash}`,
    `Complete: ${f.complete ? "yes" : "no"}`,
    "",
    "# Each lyric line, then its translation after →. A lone → means none needed; … means not translated yet.",
    "",
  ];
  const body = f.lines.flatMap((l) => [ONE_LINE(l.text), l.tr === undefined ? "…" : l.tr === null ? "→" : `→ ${ONE_LINE(l.tr)}`, ""]);
  return [...head, ...body].join("\r\n");
}

export function parseTranslation(text: string): SavedTranslation | null {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/);
  if (rows[0] !== "MLP saved translation") return null;
  const field = (name: string) => rows.find((r) => r.startsWith(`${name}: `))?.slice(name.length + 2) ?? "";
  const start = rows.findIndex((r) => r.startsWith("# "));
  if (start < 0) return null;
  const lines: SavedTranslation["lines"] = [];
  for (let i = start + 2; i + 1 < rows.length; i += 3) {
    const t = rows[i + 1];
    if (t !== "…" && !t.startsWith("→")) return null; // hand-edited beyond recognition
    lines.push({ text: rows[i], tr: t === "…" ? undefined : t.slice(1).trim() || null });
  }
  return { song: field("Song"), artist: field("Artist"), target: field("Language"), provider: field("Provider"), hash: field("Lyrics hash"), complete: field("Complete") === "yes", lines };
}

// ---------- storage ----------
export interface TranslationFiles {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  clear(): Promise<number>;
}

const MOCK_PREFIX = "mlp.saved-translation.";
/** Rust commands in the app (`tr_*`), localStorage in mock mode. */
export const appFiles: TranslationFiles = isTauri()
  ? {
      read: async (name) => (await platform.invoke<string | null>("tr_read", { name })) ?? null,
      write: async (name, text) => void (await platform.invoke("tr_write", { name, text })),
      remove: async (name) => void (await platform.invoke("tr_delete", { name })),
      clear: async () => (await platform.invoke<number>("tr_clear")) ?? 0,
    }
  : {
      read: async (name) => {
        try {
          return localStorage.getItem(MOCK_PREFIX + name);
        } catch {
          return null;
        }
      },
      write: async (name, text) => {
        try {
          localStorage.setItem(MOCK_PREFIX + name, text);
        } catch {
          /* unavailable */
        }
      },
      remove: async (name) => {
        try {
          localStorage.removeItem(MOCK_PREFIX + name);
        } catch {
          /* unavailable */
        }
      },
      clear: async () => {
        let n = 0;
        try {
          for (const k of Object.keys(localStorage)) if (k.startsWith(MOCK_PREFIX)) (localStorage.removeItem(k), n++);
        } catch {
          /* unavailable */
        }
        return n;
      },
    };

// ---------- status (last problem), shared with the settings window ----------
export interface TranslationStatus {
  problem?: TranslateProblem;
  message: string;
  at: number;
  song?: string;
}
const statusKv = createKv<TranslationStatus>("translation-status.json");
export const getTranslationStatus = () => statusKv.get("last");
async function setStatus(st: TranslationStatus) {
  await statusKv.set("last", st);
  await platform.emit("translation-status", st);
}

// ---------- main entry ----------
export interface SongMeta {
  title: string;
  artist?: string;
}

export interface TranslationResult {
  lines: (string | null)[];
  problem?: TranslateProblem;
}

/** Translation per lyric line (null where none): TTML translations, else saved file, else online + save. */
export async function getTranslations(
  lyrics: Lyrics,
  song: SongMeta,
  o: TranslateOptions,
  deps: TranslateDeps & { files?: TranslationFiles; onProblem?: (p: TranslateProblem) => void },
): Promise<TranslationResult> {
  const shipped = fileTranslations(lyrics, o);
  if (shipped) return { lines: shipped };

  const files = deps.files ?? appFiles;
  const texts = lyrics.lines.map((l) => l.text);
  const hash = lyricsHash(texts);
  const name = translationFileName(song.title || lyrics.trackName, song.artist); // same name resetTranslation() builds
  const saved = parseTranslation((await files.read(name).catch(() => null)) ?? "");
  const usable = saved && saved.target === o.target && saved.provider === o.provider ? saved : null;
  if (usable?.complete && usable.hash === hash && usable.lines.length === texts.length) return { lines: usable.lines.map((l) => l.tr ?? null) };

  // Reuse whatever the old file already knows (by line text); send only the rest.
  const known = new Map<string, string | null>();
  for (const l of usable?.lines ?? []) if (l.tr !== undefined) known.set(l.text, l.tr);
  const want = new Set(wantedLines(lyrics));
  const ask = [...new Set(texts.filter((t, i) => want.has(i) && !known.has(t)))]; // choruses repeat: once
  let res: { lines: LineResults; problem?: TranslateProblem } = { lines: [] };
  try {
    res = await translateTexts(ask, o, deps);
  } catch (e) {
    const p = e instanceof TranslateError ? e.problem : "service";
    await report(p, song, deps.onProblem);
    if (p === "key") throw e;
    res = { lines: ask.map(() => undefined), problem: p };
  }
  ask.forEach((t, k) => res.lines[k] !== undefined && known.set(t, res.lines[k]!));
  const lines = texts.map((t, i) => (want.has(i) ? known.get(t) : null));
  const complete = lines.every((l) => l !== undefined);
  if (res.problem) await report(res.problem, song, deps.onProblem);
  else if (complete && ask.length) {
    quotaNoticed = false;
    await setStatus({ message: "", at: Date.now(), song: song.title }).catch(() => undefined);
  }

  // Save what we have (nothing if nothing was translated); incomplete files are finished next time.
  const anyDone = lines.some((l, i) => want.has(i) && l !== undefined);
  if (anyDone && (ask.length || !usable || usable.hash !== hash)) {
    const f: SavedTranslation = {
      song: song.title || lyrics.trackName, artist: song.artist ?? "", target: o.target, provider: o.provider, hash, complete,
      lines: texts.map((text, i) => ({ text, tr: lines[i] })),
    };
    await files.write(name, formatTranslation(f)).catch((e) => platform.log(`translation save: ${e}`));
  }
  return { lines: lines.map((l) => l ?? null), problem: res.problem };
}

const problemListeners = new Set<(p: TranslateProblem) => void>();
let quotaNoticed = false;
/** Main window: hear about the daily limit once (until a translation works again) for a toast. */
export function onQuotaReached(cb: () => void) {
  const l = (p: TranslateProblem) => p === "quota" && cb();
  problemListeners.add(l);
  return () => void problemListeners.delete(l);
}

async function report(p: TranslateProblem, song: SongMeta, cb?: (p: TranslateProblem) => void) {
  cb?.(p);
  if (p !== "quota" || !quotaNoticed) problemListeners.forEach((l) => l(p));
  if (p === "quota") quotaNoticed = true;
  await setStatus({ problem: p, message: problemText(p), at: Date.now(), song: song.title }).catch(() => undefined);
}

// ---------- resets ----------
/** Delete this song's saved translation; the lyrics window translates it again. */
export async function resetTranslation(song: SongMeta, files: TranslationFiles = appFiles) {
  await files.remove(translationFileName(song.title, song.artist));
  await platform.emit("translations-reset");
}

/** Delete every saved translation. Returns how many files were removed. */
export async function resetAllTranslations(files: TranslationFiles = appFiles) {
  const n = await files.clear();
  await platform.emit("translations-reset");
  return n;
}
