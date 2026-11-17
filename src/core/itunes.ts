// iTunes Search lookup (no key, CORS-enabled): Apple Music track id + cover art for the playing song.
// Shared by sharper cover art and the AMLL word-synced lyrics source (keyed by Apple Music id).
import type { NowPlaying } from "./playback/clock";
import { createKv } from "./storage/kv";
import { buildQueries, scoreCandidate } from "./lyrics/query";
import { normalize } from "./lyrics/query";

export interface ItunesMatch {
  trackId: number;
  artworkUrl: string | null;
}

interface ItunesResult {
  trackId: number;
  trackName: string;
  artistName: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
}

const cache = createKv<{ at: number; match: ItunesMatch | null }>("itunes-cache.json");
const TTL_MISS = 7 * 24 * 3600_000;

const key = (np: Pick<NowPlaying, "title" | "artist">) => `${normalize(np.artist)}|${normalize(np.title)}`;

/** Store fronts to try: the US catalog first, then the one matching the lyrics' script. */
function countries(text: string): string[] {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return ["US", "JP"];
  if (/\p{Script=Hangul}/u.test(text)) return ["US", "KR"];
  if (/\p{Script=Han}/u.test(text)) return ["US", "TW", "CN"];
  return ["US"];
}

/** Best iTunes match for the song, or null. Network errors return null without caching. */
export async function itunesMatch(np: Pick<NowPlaying, "title" | "artist" | "album" | "durationMs">): Promise<ItunesMatch | null> {
  const k = key(np);
  const hit = await cache.get(k);
  if (hit && (hit.match || Date.now() - hit.at < TTL_MISS)) return hit.match;
  const q = buildQueries(np.title, np.artist, np.album)[0];
  if (!q) return null;
  let match: ItunesMatch | null = null;
  try {
    for (const country of countries(`${np.title} ${np.artist}`)) {
      const term = encodeURIComponent(`${q.artist} ${q.track}`.trim());
      const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=10&country=${country}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { results: ItunesResult[] };
      let best: { r: ItunesResult; s: number } | null = null;
      for (const r of data.results ?? []) {
        const s = scoreCandidate(
          { trackName: r.trackName, artistName: r.artistName, duration: (r.trackTimeMillis ?? 0) / 1000, instrumental: false, syncedLyrics: null, plainLyrics: "x" },
          q,
          r.trackTimeMillis ? np.durationMs : 0,
        );
        if (s > 0.7 && (!best || s > best.s)) best = { r, s };
      }
      if (best) {
        match = { trackId: best.r.trackId, artworkUrl: best.r.artworkUrl100?.replace(/\/\d+x\d+bb\./, "/600x600bb.") ?? null };
        break;
      }
    }
  } catch {
    return null; // offline: try again next time
  }
  await cache.set(k, { at: Date.now(), match });
  return match;
}
