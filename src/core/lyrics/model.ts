// Normalized lyrics model shared by parsers, timing engine and renderer. Times in ms.

export interface LyricWord {
  /** includes trailing whitespace when the source has it */
  text: string;
  start: number;
  end: number;
}

export interface LyricLine {
  start: number;
  end: number;
  text: string;
  /** real word timings from the source, or null when only the line is timed (Step 5 synthesizes) */
  words: LyricWord[] | null;
  /** background / secondary vocal line */
  bg?: boolean;
  /** sung by a second singer (duet) */
  duet?: boolean;
  /** singer number when the lyrics name singers: 1, 2, 3… in order of appearance, 0 = sung together */
  voice?: number;
  /** word end times are real (TTML / tapped), so held notes must not be trimmed */
  exactEnds?: boolean;
  /** translation shipped with the lyrics (TTML x-translation) and its language */
  translation?: string;
  translationLang?: string;
}

export type LyricsKind = "word" | "line" | "plain" | "instrumental";

export interface Lyrics {
  kind: LyricsKind;
  lines: LyricLine[];
  /** unsynced text for kind "plain" */
  plain?: string;
  /** ai = written by Whisper from the captured audio (Step 16) */
  source: "lrclib" | "amll" | "local" | "ai";
  id: number;
  trackName: string;
  artistName: string;
  durationMs: number;
  /** line times are placeholders (plain lyrics waiting for auto-sync) */
  estimated?: boolean;
}

/** Raw LRCLIB record (subset we use / cache). */
export interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number; // seconds
  instrumental: boolean;
  hasWordSync?: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  lyricsfile?: string | null;
}
