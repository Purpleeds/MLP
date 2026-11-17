// Step 15: auto-sync timing → LRC (enhanced when word times are known), for "Use on this song" and
// "Publish to LRCLIB" in the sync editor — the user reviews it first.
import type { NowPlaying } from "../playback/clock";
import type { Lyrics } from "../lyrics/model";
import { loadLyrics, songKey, songs } from "../lyrics/service";
import { lrcTime } from "../lyrics/sync";
import { romanizeLyrics } from "../romanize";
import { buildTimeline, type Timeline } from "../timing/timeline";
import { anchorsOf, applySync, fitMap, lyricsSig, plainToLines, syncLines } from "./autosync";
import { ALIGN_ROMAN } from "./engine";

/** Main lines as LRC; lines with exact word times get enhanced <mm:ss.xx> word stamps. */
export function timelineToLrc(tl: Timeline): string {
  return tl.lines
    .filter((l) => !l.bg && l.text.trim())
    .map((l) => {
      if (!l.exact || l.words.length < 2) return `[${lrcTime(l.start)}]${l.text.trim()}`;
      const words = l.words.map((w) => `<${lrcTime(w.start)}>${w.text}`).join("");
      return `[${lrcTime(l.start)}]${words.trimEnd()} <${lrcTime(l.words[l.words.length - 1].end)}>`;
    })
    .join("\n");
}

/** LRC → plain lyrics text (time and word stamps removed), for LRCLIB's plainLyrics field. */
export const lrcToPlain = (lrc: string) =>
  lrc
    .split("\n")
    .map((l) => l.replace(/^\[[^\]]*\]/, "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim())
    .join("\n");

/** The song's lyrics as auto-sync saw them (plain lyrics → placeholder lines, AI lyrics from songs.json). */
async function syncedLyrics(np: NowPlaying): Promise<Lyrics | null> {
  const l = await loadLyrics(np);
  if (l && l.kind === "plain") return plainToLines(l);
  if (l && (l.kind === "line" || l.kind === "word")) return l;
  const ai = (await songs.get(songKey(np)))?.aiLyrics;
  return ai?.lines.length ? { kind: "line", lines: ai.lines, source: "ai", id: 0, trackName: np.title, artistName: np.artist, durationMs: np.durationMs } : null;
}

/** LRC from the AI timing saved for this song, or null when auto-sync hasn't lined anything up yet. */
export async function aiTimingLrc(np: NowPlaying): Promise<{ lrc: string; lines: number; aligned: number } | null> {
  const lyrics = await syncedLyrics(np);
  const saved = (await songs.get(songKey(np)))?.aiSync;
  if (!lyrics || !saved || saved.sig !== lyricsSig(lyrics) || !Object.keys(saved.fixes).length) return null;
  const lines = syncLines(lyrics, await romanizeLyrics(lyrics, ALIGN_ROMAN).catch(() => null));
  const tl = applySync(buildTimeline(lyrics, "estimated"), lyrics, lines, saved.fixes, fitMap(anchorsOf(lines, saved.fixes)));
  return { lrc: timelineToLrc(tl), lines: lines.length, aligned: lines.filter((l) => saved.fixes[l.idx]).length };
}
