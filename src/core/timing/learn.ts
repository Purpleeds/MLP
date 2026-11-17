// Upgrade 10: learn a timing offset per app from the user's per-song corrections. When several songs
// from the same player needed about the same nudge, new songs from that player start with it.
import type { NowPlaying } from "../playback/clock";

export type SourceKind = NowPlaying["sourceKind"];

export interface OffsetSample {
  song: string;
  offset: number;
  at: number;
}

export const LEARN = { minSongs: 3, minAbsMs: 100, agree: 0.7, keep: 12 };

/** Remember the latest correction for a song (one sample per song, newest last, capped). */
export function addSample(list: OffsetSample[], song: string, offset: number, at = Date.now()): OffsetSample[] {
  const rest = list.filter((x) => x.song !== song);
  return [...rest, { song, offset, at }].slice(-LEARN.keep);
}

/**
 * The offset most songs from this app needed: median of the corrections, when at least 3 songs were
 * corrected, most of them in the same direction, and the median is big enough to matter. Rounded to 50 ms.
 */
export function learnedOffset(list: OffsetSample[]): number | null {
  const xs = list.map((x) => x.offset).filter((x) => x !== 0);
  if (xs.length < LEARN.minSongs) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  if (Math.abs(m) < LEARN.minAbsMs) return null;
  const same = xs.filter((x) => Math.sign(x) === Math.sign(m)).length / xs.length;
  if (same < LEARN.agree) return null;
  return Math.round(m / 50) * 50;
}
