// Upgrade 7: optional Spotify login. When Spotify is the player and the account is connected,
// the Web API gives the exact track (title, artists, album, duration, ISRC) and 640 px cover art.
import { useEffect, useState } from "react";
import { isTauri, platform } from "./platform";
import { getSettings } from "./settings/store";
import type { NowPlaying } from "./playback/clock";
import { normalize } from "./lyrics/query";

export interface SpotifyTrack {
  id: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  isrc: string | null;
  art: string | null;
}

type Np = Pick<NowPlaying, "title" | "artist" | "sourceKind">;

/** The Web API's track is the one the player shows (titles can differ in "- Remastered" etc.). */
export function sameTrack(np: Pick<NowPlaying, "title" | "artist">, t: Pick<SpotifyTrack, "title" | "artists">): boolean {
  const a = normalize(np.title);
  const b = normalize(t.title);
  if (!a || !b) return false;
  const titleOk = a === b || a.startsWith(b) || b.startsWith(a);
  const artist = normalize(np.artist);
  const artistOk = !artist || t.artists.some((x) => artist.includes(normalize(x)) || normalize(x).includes(artist));
  return titleOk && artistOk;
}

const cache = new Map<string, Promise<SpotifyTrack | null>>();
const keyOf = (np: Np) => `${np.artist}|${np.title}`;

/** Spotify's view of this track (null when not connected / not Spotify / no match). */
export function spotifyTrackFor(np: Np): Promise<SpotifyTrack | null> {
  if (!isTauri() || np.sourceKind !== "spotify" || !getSettings().spotify.enabled) return Promise.resolve(null);
  const key = keyOf(np);
  let p = cache.get(key);
  if (!p) {
    p = platform
      .invoke<SpotifyTrack | null>("spotify_now")
      .then((t) => (t && sameTrack(np, t) ? t : null))
      .catch((e) => {
        platform.log(`spotify: ${e}`);
        return null;
      });
    // A miss (track changed in between, network) is retried on the next lookup.
    void p.then((t) => !t && setTimeout(() => cache.get(key) === p && cache.delete(key), 15_000));
    cache.set(key, p);
    if (cache.size > 30) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Lookup fields for the lyrics search (exact title / first artist / album / duration). */
export async function spotifyLookup(np: Np): Promise<Partial<NowPlaying> | undefined> {
  const t = await Promise.race([spotifyTrackFor(np), new Promise<null>((r) => setTimeout(() => r(null), 2_500))]);
  return t ? { title: t.title, artist: t.artists[0] ?? np.artist, album: t.album, durationMs: t.durationMs } : undefined;
}

/** React: the Spotify track for the current song (for HD cover art). */
export function useSpotifyTrack(np: NowPlaying | null): SpotifyTrack | null {
  const [t, setT] = useState<{ key: string; track: SpotifyTrack | null } | null>(null);
  const key = np ? keyOf(np) : "";
  const enabled = getSettings().spotify.enabled;
  useEffect(() => {
    if (!np || !enabled) return;
    let alive = true;
    void spotifyTrackFor(np).then((track) => alive && setT({ key, track }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per song
  }, [key, enabled]);
  return t?.key === key ? t.track : null;
}
