// AMLL TTML DB: community-made, word-synced lyrics (CC0) keyed by Apple Music track id.
// https://github.com/amll-dev/amll-ttml-db — files served by raw.githubusercontent.com (CORS *).
import type { NowPlaying } from "../playback/clock";
import { itunesMatch } from "../itunes";
import type { Lyrics } from "./model";
import { parseTtml } from "./ttml";
import { wordCoverage } from "./parse";

export const AMLL_BASE = "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/am-lyrics";

export interface AmllRecord {
  id: number; // Apple Music track id
  xml: string;
}

/** Look the song up on iTunes, then fetch its TTML. null = not in the database (or no iTunes match). */
export async function findAmll(np: Pick<NowPlaying, "title" | "artist" | "album" | "durationMs">): Promise<AmllRecord | null> {
  const m = await itunesMatch(np);
  if (!m) return null;
  const res = await fetch(`${AMLL_BASE}/${m.trackId}.ttml`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`AMLL HTTP ${res.status}`);
  return { id: m.trackId, xml: await res.text() };
}

export function amllToLyrics(r: AmllRecord, np: Pick<NowPlaying, "title" | "artist" | "durationMs">): Lyrics {
  const lines = parseTtml(r.xml);
  return {
    kind: wordCoverage(lines) >= 0.5 ? "word" : "line",
    lines,
    source: "amll",
    id: r.id,
    trackName: np.title,
    artistName: np.artist,
    durationMs: np.durationMs,
  };
}
