// Sharper cover art: when the player's thumbnail is small (or a 16:9 video frame), use the 600×600
// artwork from the iTunes match (shared lookup in core/itunes.ts).
import { useEffect, useState } from "react";
import type { NowPlaying } from "../playback/clock";
import { songKey } from "../lyrics/service";
import { itunesMatch } from "../itunes";

const MIN_GOOD_PX = 300;

/** Natural size of an image URL. */
function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = src;
  });
}

export async function lookupArt(np: Pick<NowPlaying, "title" | "artist" | "album" | "durationMs">): Promise<string | null> {
  return (await itunesMatch(np))?.artworkUrl ?? null;
}

/** Artwork to display: the player's thumbnail, upgraded when it is small or not square. */
export function useArtwork(np: NowPlaying | null, enabled: boolean): string | null {
  const [hires, setHires] = useState<{ key: string; url: string | null } | null>(null);
  const key = np ? songKey(np) : "";
  useEffect(() => {
    if (!np || !enabled) return;
    let alive = true;
    (async () => {
      if (np.artwork) {
        const { w, h } = await imageSize(np.artwork);
        if (Math.min(w, h) >= MIN_GOOD_PX && Math.abs(w - h) <= 4) return;
      }
      const url = await lookupArt(np);
      if (alive) setHires({ key, url });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per song / thumbnail
  }, [key, np?.artwork, enabled]);
  if (!np) return null;
  return (enabled && hires?.key === key && hires.url) || np.artwork;
}
