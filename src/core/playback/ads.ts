// Upgrade 8: don't show (or look up) lyrics during ads and for long non-music videos.
// Browsers report an ad under the song's own title, but with the ad's short duration; some players
// publish a plain "Advertisement" title instead.
import type { NowPlaying } from "./clock";

type Meta = Pick<NowPlaying, "title" | "artist" | "sourceKind" | "durationMs">;

const AD_WORD = /^(advertisement|advert|ad|ads|sponsored|anzeige|werbung|publicité|publicidad|pubblicità|reclame|propaganda|реклама|広告|광고|广告|廣告)$/iu;

/** Browser-style players that play ads in the same media session as the song. */
const webPlayer = (np: Pick<NowPlaying, "sourceKind">) => np.sourceKind === "browser" || np.sourceKind === "ytmusic-app";

/** Ads last up to about a minute (YouTube: 6 s bumpers, 15–30 s and up to 60 s skippables). */
export const AD_MAX_MS = 65_000;
/** Longer browser videos are mixes, podcasts, streams… — no song lyrics to find. */
export const LONG_VIDEO_MS = 15 * 60_000;

/** The metadata itself says it's an ad (title "Advertisement", "Ad · 0:15", "広告", …). */
export function adMarker(np: Pick<Meta, "title" | "artist" | "sourceKind">): boolean {
  const head = np.title.trim().split(/\s*[·•|:–—-]\s*/u)[0] ?? "";
  if (!AD_WORD.test(head)) return false;
  // A real song can be called "Advertisement": then the artist is a real name and the player isn't a browser.
  return webPlayer(np) || !np.artist.trim() || AD_WORD.test(np.artist.trim());
}

/** Short enough to be an ad when a web player reports it (duration is then not trusted for lookups). */
export const maybeAdLength = (np: Pick<Meta, "sourceKind" | "durationMs">) => webPlayer(np) && np.durationMs > 0 && np.durationMs <= AD_MAX_MS;

/** An ad is playing: marked as one, or a web player reports a short clip while the song's lyrics run much longer. */
export function isAd(np: Meta, lyricsLengthMs = 0): boolean {
  if (adMarker(np)) return true;
  return maybeAdLength(np) && lyricsLengthMs - np.durationMs >= 30_000;
}

/** A long browser video: skip the lyrics lookup. */
export const isLongVideo = (np: Pick<Meta, "sourceKind" | "durationMs">) => np.sourceKind === "browser" && np.durationMs > LONG_VIDEO_MS;
