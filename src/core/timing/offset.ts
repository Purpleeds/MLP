// Total lyric offset: global + per-source latency + per-song. Positive = lyrics earlier.
import type { Settings } from "../settings/schema";
import type { NowPlaying } from "../playback/clock";

export function totalOffsetMs(s: Settings, np: Pick<NowPlaying, "sourceKind"> | null, songOffsetMs = 0): number {
  const kind = np?.sourceKind;
  const src = kind && kind !== "mock" ? s.timing.sourceOffsetMs[kind] ?? 0 : 0;
  return s.timing.globalOffsetMs + src + songOffsetMs;
}

/** Song time to compare against lyric timestamps. */
export const lyricTime = (positionMs: number, offsetMs: number) => positionMs + offsetMs;
