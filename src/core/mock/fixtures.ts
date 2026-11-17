// Mock-mode data so the UI can be developed in a plain browser (no Tauri, no music playing).
// Lyrics are original placeholder text, not from any real song.

export interface MockTrack {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  /** [startMs, text] line-synced sample lyrics */
  lines: [number, string][];
}

export const MOCK_TRACK: MockTrack = {
  title: "Paper Satellites",
  artist: "The Placeholder Band",
  album: "Mock Sessions",
  durationMs: 64_000,
  lines: [
    [0, ""],
    [4_000, "Folded up the evening into paper satellites"],
    [9_000, "Threw them past the streetlights just to watch them fly"],
    [14_500, "Every little signal says you're somewhere close"],
    [19_500, "Noooo, I won't let the static win"],
    [25_000, "(Hold on)"],
    [27_000, "We're louder than the radio"],
    [32_000, "夜空に光る紙の星"],
    [37_000, "纸做的卫星飞向远方"],
    [42_000, "우리의 노래는 끝나지 않아"],
    [47_000, "Folded up the evening, let it go"],
    [53_000, ""],
    [58_000, "Paper satellites"],
  ],
};

/** A simple looping clock for mock playback. */
export function mockPositionMs(startedAt: number, now = performance.now()): number {
  return (now - startedAt) % MOCK_TRACK.durationMs;
}

/** Generated placeholder cover art (data URL) so backgrounds can be previewed in mock mode. */
export function mockArtwork(): string | null {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 128, 128);
    grad.addColorStop(0, "#c2183b");
    grad.addColorStop(1, "#5b0f2a");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#1d4fa8";
    g.fillRect(0, 84, 128, 44);
    g.fillStyle = "#f2e6d9";
    g.beginPath();
    g.arc(64, 70, 18, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}
