// "Train on my songs": while a song with synced lyrics plays, the captured audio and its lyrics (with the
// best timing MLP knows: auto-sync's sung times, else its time map, else the lyrics' own times) are
// kept as a training clip (Rust `training_*`, files in the training folder). A LoRA fine-tune of
// Whisper (training/mlp_train.py) learns from them; its model is used only when it beat the original
// on songs it never trained on.
import { useEffect, useRef } from "react";
import { isTauri, platform } from "../platform";
import { getSettings } from "../settings/store";
import type { Settings } from "../settings/schema";
import { trackKey, type NowPlaying } from "../playback/clock";
import type { Lyrics } from "../lyrics/model";
import { songKey } from "../lyrics/service";
import { songLanguage } from "../romanize";
import { APP_VERSION } from "../version";
import { mapTime, type LineFix, type SyncLine, type TimeMap } from "./autosync";
import type { AiLine } from "./passes";

export const CLIP_FORMAT = "MLP training clip";

export interface ClipLine {
  start: number;
  end: number;
  text: string;
  /** the words are right (lyrics database / hand-checked), so it can teach the model */
  trusted: boolean;
  /** sung = lined up with the singing; mapped = auto-sync's time map; lyrics = the lyrics' own times */
  timing: "sung" | "mapped" | "lyrics";
}

export interface ClipMeta {
  format: typeof CLIP_FORMAT;
  version: 1;
  songKey: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  source: Lyrics["source"];
  /** Whisper language code when the script tells (ja / zh / ko), else null (the trainer detects it) */
  lang: string | null;
  lines: ClipLine[];
  app: string;
}

export interface SyncInfo {
  lines: SyncLine[];
  fixes: Record<number, LineFix>;
  map: TimeMap;
}

/** Lyrics usable as labels: synced (not placeholders) and either from a database / the user, or hand-checked AI lines. */
export function clipLines(lyrics: Lyrics, sync: SyncInfo | null, offsetMs: number): ClipLine[] {
  if (lyrics.kind !== "line" && lyrics.kind !== "word") return [];
  // Plain lyrics with placeholder times: only the lines auto-sync found in the singing have real times.
  const mapped = !lyrics.estimated && !!sync && (sync.map.inliers ?? 0) >= 2;
  const out: ClipLine[] = [];
  lyrics.lines.forEach((l, i) => {
    if (!l.text.trim()) return;
    const fix = sync?.fixes[i];
    const trusted = !l.bg && (lyrics.source !== "ai" || !!(l as Partial<AiLine>).hand);
    if (fix) out.push({ start: fix.start, end: fix.end, text: l.text, trusted, timing: "sung" });
    else if (lyrics.estimated) return;
    else if (mapped) out.push({ start: Math.round(mapTime(sync!.map, l.start)), end: Math.round(mapTime(sync!.map, l.end)), text: l.text, trusted, timing: "mapped" });
    else out.push({ start: Math.round(l.start - offsetMs), end: Math.round(l.end - offsetMs), text: l.text, trusted, timing: "lyrics" });
  });
  return out.sort((a, b) => a.start - b.start);
}

export function clipMeta(np: NowPlaying, lyrics: Lyrics, lines: ClipLine[]): ClipMeta {
  return {
    format: CLIP_FORMAT,
    version: 1,
    songKey: songKey(np),
    title: np.title,
    artist: np.artist,
    album: np.album,
    durationMs: np.durationMs,
    source: lyrics.source,
    lang: songLanguage(lines.map((l) => l.text)),
    lines,
    app: APP_VERSION,
  };
}

/** Worth keeping: enough trusted lines to learn from. */
export const usefulClip = (lines: ClipLine[]) => lines.filter((l) => l.trusted).length >= 4;

const REARM_MS = 20_000;

/**
 * Lyric view (synced lyrics): keep this song's audio + lyrics as a training clip when "Train on my
 * songs" saves audio. The latest labels are handed to Rust every 20 s (auto-sync keeps improving
 * them); Rust writes the clip when the song changes or the view goes away.
 */
export function useTrainingClip(np: NowPlaying | null, lyrics: Lyrics | null, sync: SyncInfo | null, offsetMs: number, enabled: boolean) {
  const latest = useRef({ np, lyrics, sync, offsetMs });
  latest.current = { np, lyrics, sync, offsetMs };
  const key = np ? trackKey(np) : "";
  useEffect(() => {
    if (!isTauri() || !enabled || !np || !lyrics) return;
    let sent = "";
    const arm = () => {
      const s = getSettings();
      const cur = latest.current;
      if (!s.ai.saveTraining || !s.ai.listen || !cur.np || !cur.lyrics) return;
      const lines = clipLines(cur.lyrics, cur.sync, cur.offsetMs);
      if (!usefulClip(lines)) return;
      const meta = clipMeta(cur.np, cur.lyrics, lines);
      const text = JSON.stringify(meta);
      if (text === sent) return;
      sent = text;
      void platform.invoke("training_arm", { dir: s.ai.trainingDir, key, meta }).catch((e) => platform.log(`[training] arm: ${e}`));
    };
    arm();
    const t = window.setInterval(arm, REARM_MS);
    return () => {
      clearInterval(t);
      arm();
      if (sent) void platform.invoke("training_flush", { key }).catch((e) => platform.log(`[training] save: ${e}`));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per song / lyrics
  }, [key, lyrics, enabled]);
}

// ---------- the tuned model ----------
export interface TunedModel {
  path: string;
  baseError: number;
  tunedError: number;
  metric: string;
  trainedAt: string;
  songs: number;
}

let tunedCache: { dir: string; at: number; model: TunedModel | null } | null = null;

/** The adopted tuned model's file, if training produced one that beat the original (cached 30 s). */
export async function tunedModelFor(s: Settings): Promise<string | null> {
  if (!isTauri()) return null;
  const dir = s.ai.trainingDir;
  if (!tunedCache || tunedCache.dir !== dir || Date.now() - tunedCache.at > 30_000) {
    const model = await platform.invoke<TunedModel | null>("training_model", { dir }).catch(() => null);
    tunedCache = { dir, at: Date.now(), model: model ?? null };
  }
  return tunedCache.model?.path ?? null;
}
export const forgetTunedCache = () => void (tunedCache = null);
