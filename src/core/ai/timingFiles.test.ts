import { describe, expect, it } from "vitest";
import type { Lyrics } from "../lyrics/model";
import { songKey } from "../lyrics/service";
import type { LineFix, SavedSync, SyncLine } from "./autosync";
import { fitMap, anchorsOf } from "./autosync";
import {
  formatTiming, loadTiming, parseTiming, removeTiming, saveTiming, timingFileName,
  type LegacyStore, type SongId, type TimingStore,
} from "./timingFiles";

const memFiles = () => {
  const m = new Map<string, string>();
  const store: TimingStore = {
    read: async (n) => m.get(n) ?? null,
    write: async (n, t) => void m.set(n, t),
    remove: async (n) => void m.delete(n),
    count: async () => m.size,
    clear: async () => {
      const n = m.size;
      m.clear();
      return n;
    },
  };
  return { m, store };
};
const memLegacy = (init: Record<string, SavedSync> = {}) => {
  const m = new Map(Object.entries(init));
  const legacy: LegacyStore = { get: async (k) => m.get(k), drop: async (k) => void m.delete(k) };
  return { m, legacy };
};

const song: SongId = { title: "Paper Satellites", artist: "The Placeholder Band", album: "", sourceKind: "spotify" };
const lyrics: Lyrics = {
  kind: "line", source: "lrclib", id: 1, trackName: song.title, artistName: song.artist, durationMs: 60_000,
  lines: [{ start: 1000, text: "first line here" }, { start: 4000, text: "second line" }, { start: 8000, text: "third" }],
} as Lyrics;
const lines: SyncLine[] = [
  { idx: 0, start: 1000, end: 3500, words: ["first", "line", "here"] },
  { idx: 1, start: 4000, end: 7500, words: ["second", "line"] },
  { idx: 2, start: 8000, end: 9000, words: ["third"] },
];
const fixes: Record<number, LineFix> = {
  0: { start: 1500, end: 3900, words: [[1500, 2000], null, [3000, 3900]], score: -2.1 },
  1: { start: 4480, end: 7600, words: [[4480, 5000], [5100, 7600]], score: -2.4 },
};
const map = fitMap(anchorsOf(lines, fixes));
const SIG = "lrclib:1:3:abc";

describe("timing file names", () => {
  it("builds '[song] - [artist].json', Windows-safe, numbered on collisions", () => {
    expect(timingFileName("晴天", "周杰倫")).toBe("晴天 - 周杰倫.json");
    expect(timingFileName('AC/DC: "Back"?', "a|b")).toBe('AC_DC_ _Back__ - a_b.json');
    expect(timingFileName("Song", "", 2)).toBe("Song (2).json");
    expect(timingFileName("x".repeat(300), "y").length).toBeLessThanOrEqual(125);
  });
});

describe("timing file content", () => {
  it("round-trips the fixes and is readable", () => {
    const text = formatTiming({ song: song.title, artist: song.artist, songKey: songKey(song), sig: SIG, lyrics, lines, fixes, map });
    const d = JSON.parse(text);
    expect(d).toMatchObject({ format: "MLP AI timing", version: 1, song: song.title, lyricsSig: SIG, linesAligned: 2, linesTotal: 3 });
    expect(d.lines[0]).toMatchObject({ line: 1, text: "first line here", sungMs: [1500, 3900] });
    expect(d.lines[2].sungMs).toBeNull();
    expect(d.anchors[0]).toEqual({ line: 1, lyricsMs: 1000, sungMs: 1500 });
    expect(text).toContain('{ "word": "first", "sungMs": [1500, 2000] }'); // one word per line
    expect(parseTiming(text)).toEqual({ songKey: songKey(song), sig: SIG, fixes });
  });
  it("rejects other files", () => {
    expect(parseTiming("not json")).toBeNull();
    expect(parseTiming('{"format":"something else"}')).toBeNull();
  });
});

describe("load / save / migration", () => {
  it("prefers the file; other lyrics → nothing", async () => {
    const { store } = memFiles();
    const { legacy } = memLegacy();
    await saveTiming({ id: song, sig: SIG, lyrics, lines, fixes, map }, { files: store, legacy });
    expect(await loadTiming(song, SIG, { files: store, legacy })).toEqual({ fixes, legacy: false });
    expect(await loadTiming(song, "lrclib:2:3:def", { files: store, legacy })).toBeNull();
  });

  it("reads old songs.json timing, and drops it only once a file is written", async () => {
    const { m, store } = memFiles();
    const { m: old, legacy } = memLegacy({ [songKey(song)]: { v: 1, sig: SIG, fixes } });
    const got = await loadTiming(song, SIG, { files: store, legacy });
    expect(got).toEqual({ fixes, legacy: true });
    expect(old.size).toBe(1);
    const name = await saveTiming({ id: song, sig: SIG, lyrics, lines, fixes: got!.fixes, map }, { files: store, legacy });
    expect(name).toBe("Paper Satellites - The Placeholder Band.json");
    expect(m.has(name!)).toBe(true);
    expect(old.size).toBe(0);
  });

  it("keeps a different song with the same file name apart", async () => {
    const { m, store } = memFiles();
    const { legacy } = memLegacy();
    const other: SongId = { ...song, title: "Other", artist: "X" };
    // a file for someone else's song already sits on the plain name
    await saveTiming({ id: song, sig: SIG, lyrics, lines, fixes, map }, { files: store, legacy });
    m.set("Other - X.json", m.get("Paper Satellites - The Placeholder Band.json")!);
    m.set("Other - X (3).json", "hand-edited, not JSON"); // unreadable files are never overwritten
    const n = await saveTiming({ id: other, sig: SIG, lyrics, lines, fixes: { 1: fixes[1] }, map }, { files: store, legacy });
    expect(n).toBe("Other - X (2).json");
    expect(await loadTiming(other, SIG, { files: store, legacy })).toEqual({ fixes: { 1: fixes[1] }, legacy: false });
    expect(await saveTiming({ id: other, sig: SIG, lyrics, lines, fixes, map }, { files: store, legacy })).toBe("Other - X (2).json");
    expect(m.get("Other - X (3).json")).toBe("hand-edited, not JSON");
  });

  it("forget removes the file and any songs.json copy; `only` limits it", async () => {
    const { m, store } = memFiles();
    const { m: old, legacy } = memLegacy();
    await saveTiming({ id: song, sig: SIG, lyrics, lines, fixes, map }, { files: store, legacy });
    await removeTiming(song, (s) => s.startsWith("ai:"), { files: store, legacy });
    expect(m.size).toBe(1);
    old.set(songKey(song), { v: 1, sig: SIG, fixes });
    await removeTiming(song, undefined, { files: store, legacy });
    expect(m.size).toBe(0);
    expect(old.size).toBe(0);
  });

  it("saving no fixes deletes the file", async () => {
    const { m, store } = memFiles();
    const { legacy } = memLegacy();
    await saveTiming({ id: song, sig: SIG, lyrics, lines, fixes, map }, { files: store, legacy });
    await saveTiming({ id: song, sig: SIG, lyrics, lines, fixes: {}, map }, { files: store, legacy });
    expect(m.size).toBe(0);
  });
});
