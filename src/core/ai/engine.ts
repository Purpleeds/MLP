// Step 15 — the auto-sync engine (main window). While a synced song plays it watches how much of the
// song has been captured (or vocal-isolated), asks the aligner for the next lines, keeps the fixes
// per song (songs.json `aiSync`) and tells the lyric view, the debug overlay and Settings how it goes.
import { useEffect, useSyncExternalStore } from "react";
import { isTauri, platform } from "../platform";
import { getSettings } from "../settings/store";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { trackKey, type NowPlaying } from "../playback/clock";
import type { Lyrics } from "../lyrics/model";
import { songKey, songs } from "../lyrics/service";
import { romanizeLyrics, type RomanOptions } from "../romanize";
import { anchorsOf, dropOutliers, fitMap, IDENTITY, lyricsSig, nextSequential, nextWindow, syncLines, toFix, type LineFix, type SavedSync, type SyncLine, type TimeMap, type WordTime } from "./autosync";

export interface SyncView {
  /** the lyrics object these fixes belong to */
  for: Lyrics;
  lines: SyncLine[];
  fixes: Record<number, LineFix>;
  map: TimeMap;
}

export interface SyncStatus {
  phase: "off" | "idle" | "listening" | "aligning" | "paused" | "done" | "error";
  detail: string;
  aligned: number;
  total: number;
  /** what the aligner listened to last */
  source?: "vocals" | "mix";
  /** ms the last alignment took */
  tookMs?: number;
  /** tempo / offset of the time map */
  tempo?: number;
  offsetMs?: number;
}

/** Romanization used for alignment: always on, plain letters (independent of the display settings). */
export const ALIGN_ROMAN: RomanOptions = {
  ...DEFAULT_SETTINGS.romanization,
  mode: "roman-main",
  ja: true,
  zh: true,
  ko: true,
  th: true,
  other: true,
  abjad: "on", // consonants alone still align
  pinyinTones: "none",
  romajiLong: "plain",
  capitalize: false,
};
const TICK_MS = 1_500;
const MAX_ATTEMPTS = 2;

interface Ctx {
  np: NowPlaying;
  lyrics: Lyrics;
  song: string; // songs.json key
  cap: string; // capture key
  sig: string;
}

let ctx: Ctx | null = null;
let view: SyncView | null = null;
let status: SyncStatus = { phase: "off", detail: "", aligned: 0, total: 0 };
const attempts = new Map<number, number>();
const listeners = new Set<() => void>();
let timer = 0;
let busy = false;
let backoffUntil = 0;
let saveTimer = 0;
let gen = 0;
let lastFixes: { sig: string; fixes: Record<number, LineFix> } | null = null;

const notify = () => listeners.forEach((l) => l());
function setStatus(p: Partial<SyncStatus>) {
  const next = { ...status, ...p };
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next;
  notify();
  if (isTauri()) void platform.emit("ai-sync-status", status);
}

const countFixes = () => (view ? view.lines.filter((l) => view!.fixes[l.idx]).length : 0);
function publishView(v: SyncView) {
  view = v;
  setStatus({ aligned: countFixes(), total: v.lines.length, tempo: +v.map.a.toFixed(3), offsetMs: Math.round(v.map.b) });
  notify();
}

/** The view belongs to the current song's lyrics (not left over from the previous song while a new one starts). */
const own = (): boolean => !!ctx && !!view && view.for === ctx.lyrics;

function scheduleSave() {
  if (!own() || !getSettings().ai.autoSync) return;
  if (!ctx || !view) return;
  const { song, sig } = ctx;
  const fixes = view.fixes;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    saveTimer = 0;
    const saved: SavedSync = { v: 1, sig, fixes };
    await songs.set(song, { ...(await songs.get(song)), aiSync: saved });
  }, 2_000);
}

/** After a few lines: the lyrics already match the singing (no offset, no tempo difference, no big misses). */
function inTime(v: SyncView): boolean {
  const a = v.map.anchors;
  if (a.length < 4) return false;
  return Math.abs(v.map.a - 1) < 0.01 && a.every((p) => Math.abs(p.act - p.exp) < 250);
}

interface AlignResult {
  lines: (WordTime | null)[][];
  source: "vocals" | "mix";
  tookMs: number;
}
interface Coverage {
  song: string | null;
  covered?: [number, number][];
  isolated?: [number, number][];
}

async function tick() {
  if (busy || !ctx || !view || !own()) return;
  const s = getSettings();
  if (!s.ai.autoSync) return setStatus({ phase: "off", detail: "Auto-sync is off." });
  if (!isTauri()) return setStatus({ phase: "off", detail: "Available in the app." });
  if (!s.ai.listen) return setStatus({ phase: "off", detail: "Turn on “Listen to the player” to line lyrics up." });
  if (s.ai.autoSyncWhen === "line" && ctx.lyrics.kind === "word") return setStatus({ phase: "done", detail: "Word-synced lyrics aren't checked (setting)." });
  if (s.ai.autoSyncWhen === "off" && inTime(view)) return setStatus({ phase: "done", detail: "These lyrics are in time — stopped checking." });
  if (view.lines.length && countFixes() === view.lines.length) return setStatus({ phase: "done", detail: "Every line is lined up." });
  if (Date.now() < backoffUntil) return;
  if (s.ai.pauseFullscreen && (await platform.invoke<boolean>("ai_busy").catch(() => false))) return setStatus({ phase: "paused", detail: "Paused while a full-screen app runs." });

  const my = gen;
  const c = ctx;
  // Always the full mix: on real songs isolated vocals lined up worse (晴天 53 vs 56 of 62 lines, Super
  // Shy 23 vs 32 of 42); vocal isolation is kept for AI-written lyrics, where it helps.
  const vocals = false;
  const cov = await platform.invoke<Coverage>("capture_status").catch(() => undefined);
  if (my !== gen) return;
  const ranges = cov?.song === c.cap ? (cov.covered ?? []) : [];
  const v = view;
  const done = (i: number) => !!v.fixes[i] || (attempts.get(i) ?? 0) >= MAX_ATTEMPTS;
  // Nothing found yet after a try: the lyrics may be far off → look further around them.
  const margin = v.map.anchors.length >= 2 ? 2_500 : attempts.size ? 12_000 : 6_000;
  const sequential = !!c.lyrics.estimated;
  const w = sequential
    ? nextSequential(v.lines, v.fixes, (i) => attempts.get(i) ?? 0, ranges, c.np.durationMs)
    : nextWindow(v.lines, done, ranges, v.map, c.np.durationMs, margin);
  if (!w) {
    const left = v.lines.some((l) => !done(l.idx));
    return setStatus(left ? { phase: "listening", detail: "Listening…" } : { phase: "done", detail: "Finished this song." });
  }

  busy = true;
  setStatus({ phase: "aligning", detail: `Lining up ${w.lines.length} line${w.lines.length > 1 ? "s" : ""}…` });
  try {
    const res = await platform.invoke<AlignResult>("ai_align", {
      req: { key: c.cap, fromMs: w.from, toMs: w.to, lines: w.lines.map((l) => l.words), vocals },
    });
    if (my !== gen || !res || !view || view !== v) return;
    let fixes = { ...view.fixes };
    const before = view.map.anchors.length;
    w.lines.forEach((l, k) => {
      const f = toFix(l, res.lines[k] ?? []);
      if (f) fixes[l.idx] = f;
      // Plain lyrics: only the first line of the window counts a miss (it moves the search on).
      else if (!sequential || k === 0) attempts.set(l.idx, (attempts.get(l.idx) ?? 0) + 1);
    });
    let map = fitMap(anchorsOf(view.lines, fixes));
    // Lines matched to the wrong place (they disagree with all the others) are dropped for good.
    const out = dropOutliers(view.lines, fixes, map);
    if (out.dropped.length) {
      fixes = out.fixes;
      for (const i of out.dropped) attempts.set(i, MAX_ATTEMPTS);
      map = fitMap(anchorsOf(view.lines, fixes));
    }
    publishView({ ...view, fixes, map });
    // Once the offset is known, lines that failed with a poor guess get another chance.
    if (!sequential && before < 2 && view.map.anchors.length >= 2) attempts.clear();
    platform.log(
      `[sync] ${(w.from / 1000).toFixed(1)}–${(w.to / 1000).toFixed(1)} s: ` +
        w.lines.map((l) => (fixes[l.idx] ? `#${l.idx} ${fixes[l.idx].start} (${fixes[l.idx].score})` : `#${l.idx} ✗`)).join(", ") +
        ` · ${res.source} ${res.tookMs} ms · map ×${view.map.a.toFixed(3)} ${Math.round(view.map.b)} ms`,
    );
    setStatus({ phase: "listening", detail: "Listening…", source: res.source, tookMs: res.tookMs });
    scheduleSave();
  } catch (e) {
    backoffUntil = Date.now() + 10_000;
    platform.log(`[sync] error: ${e}`);
    setStatus({ phase: "error", detail: String(e) });
  } finally {
    busy = false;
  }
}

async function start(np: NowPlaying, lyrics: Lyrics) {
  const my = ++gen;
  const song = songKey(np);
  const sig = lyricsSig(lyrics);
  ctx = { np, lyrics, song, cap: trackKey(np), sig };
  view = null; // the previous song's view must not be used (or saved) under this song
  notify();
  attempts.clear();
  backoffUntil = 0;
  const [roman, prefs] = await Promise.all([romanizeLyrics(lyrics, ALIGN_ROMAN).catch(() => null), songs.get(song)]);
  if (my !== gen) return;
  const lines = syncLines(lyrics, roman);
  const saved = { ...(prefs?.aiSync?.v === 1 && prefs.aiSync.sig === sig ? prefs.aiSync.fixes : {}), ...(lastFixes?.sig === sig ? lastFixes.fixes : {}) };
  publishView({ for: lyrics, lines, fixes: saved, map: fitMap(anchorsOf(lines, saved)) });
  setStatus({ phase: "idle", detail: "" });
  clearInterval(timer);
  timer = window.setInterval(() => void tick(), TICK_MS);
}

function flushSave() {
  if (!saveTimer || !ctx || !view) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!own()) return;
  const { song, sig } = ctx;
  const saved: SavedSync = { v: 1, sig, fixes: view.fixes };
  void songs.get(song).then((p) => songs.set(song, { ...p, aiSync: saved }));
}

function stop() {
  // AI lyrics grow (new lyrics object, same song): carry the fixes over without waiting for the save.
  // Only when the view is this song's: a song change interrupted before its view was ready would
  // otherwise file the previous song's line times under the new song's lyrics.
  lastFixes = own() ? { sig: ctx!.sig, fixes: view!.fixes } : null;
  flushSave();
  gen++;
  ctx = null;
  clearInterval(timer);
  timer = 0;
  setStatus({ phase: "off", detail: "", aligned: 0, total: 0 });
}

let bridged = false;
function bridge() {
  if (bridged || !isTauri()) return;
  bridged = true;
  // Settings asks for the current status / tells us a song's AI timing was forgotten.
  void platform.on("ai-sync-status-request", () => void platform.emit("ai-sync-status", status));
  void platform.on<string>("ai-sync-forget", (key) => {
    if (ctx && view && ctx.song === key) {
      attempts.clear();
      publishView({ ...view, fixes: {}, map: IDENTITY });
    }
  });
}

/** Lyric view: run auto-sync for this song + lyrics while mounted. */
export function useAutoSync(np: NowPlaying | null, lyrics: Lyrics | null, enabled: boolean) {
  const key = np ? trackKey(np) : "";
  useEffect(() => {
    if (!np || !lyrics || !enabled) return;
    bridge();
    void start(np, lyrics);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only for a new song / lyrics
  }, [key, lyrics, enabled]);
  // Keep the latest metadata (duration arrives late on some players).
  useEffect(() => {
    if (ctx && np && trackKey(np) === ctx.cap) ctx.np = np;
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** The fixes for the current lyrics (null when there are none or they're for other lyrics). */
export function useSyncView(lyrics: Lyrics | null): SyncView | null {
  const v = useSyncExternalStore(subscribe, () => view);
  return v && lyrics && v.for === lyrics && Object.keys(v.fixes).length ? v : null;
}
export const useSyncStatus = () => useSyncExternalStore(subscribe, () => status);

/** Settings: forget the AI timing saved for a song (the main window drops it too). */
export async function forgetAutoSync(np: Pick<NowPlaying, "title" | "artist">) {
  const key = songKey(np);
  const prefs = await songs.get(key);
  if (prefs?.aiSync) await songs.set(key, { ...prefs, aiSync: undefined });
  if (isTauri()) await platform.emit("ai-sync-forget", key);
}
