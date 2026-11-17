// What each display mode shows, and cleaned-up metadata for display.
import type { NowPlaying } from "./playback/clock";
import type { DisplayMode, Elements, Settings } from "./settings/schema";
import { buildQueries } from "./lyrics/query";

const E = (on: (keyof Elements)[]): Elements => ({
  art: false, title: false, artist: false, album: false, progress: false, times: false, controls: false, lyrics: false,
  ...Object.fromEntries(on.map((k) => [k, true])),
});

export const MODE_ELEMENTS: Record<Exclude<DisplayMode, "custom">, Elements> = {
  full: E(["art", "title", "artist", "album", "progress", "times", "controls", "lyrics"]),
  "lyrics-title": E(["art", "title", "artist", "lyrics"]),
  lyrics: E(["lyrics"]),
  card: E(["art", "title", "artist", "album", "progress", "times", "controls"]),
  title: E(["art", "title", "artist"]),
  mini: E(["lyrics"]),
  overlay: E(["lyrics"]),
  bar: E(["lyrics"]),
};

export const elementsFor = (s: Settings): Elements =>
  s.layout.mode === "custom" ? s.layout.elements : MODE_ELEMENTS[s.layout.mode];

/** Title/artist for display: YouTube-style "Artist - Song (Official Video)" cleaned up. */
export function displayMeta(np: Pick<NowPlaying, "title" | "artist" | "album" | "sourceKind">) {
  if (np.sourceKind === "spotify" || np.sourceKind === "mock") return { title: np.title, artist: np.artist, album: np.album };
  const q = buildQueries(np.title, np.artist, np.album)[0];
  return q ? { title: q.track, artist: q.artist || np.artist, album: np.album } : { title: np.title, artist: np.artist, album: np.album };
}

export const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
