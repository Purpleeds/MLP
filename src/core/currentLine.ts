// What the lyrics view is showing right now (share card, stream overlay): registered by the synced view.
export interface ShownLine {
  text: string;
  sub?: string;
  /** line + word timings in lyric time, and the lyric time now (ms) */
  start: number;
  end: number;
  words: { s: number; e: number }[];
  next?: string;
  t: number;
}
let provider: (() => ShownLine | null) | null = null;
export const setLineProvider = (p: (() => ShownLine | null) | null) => void (provider = p);
export const currentLine = (): ShownLine | null => provider?.() ?? null;
