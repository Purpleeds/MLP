import { describe, expect, it } from "vitest";
import { parseLrc, parseLyricsfile, recordToLyrics, toMs } from "./parse";
import type { LrclibRecord } from "./model";

describe("toMs", () => {
  it("handles 1/2/3-digit fractions", () => {
    expect(toMs("01", "02", "5")).toBe(62_500);
    expect(toMs("01", "02", "50")).toBe(62_500);
    expect(toMs("01", "02", "500")).toBe(62_500);
    expect(toMs("1", "2")).toBe(62_000);
  });
});

describe("parseLrc", () => {
  it("parses lines, breaks, repeated stamps, offset and metadata", () => {
    const lines = parseLrc(
      ["[ar:Someone]", "[offset:+500]", "[00:10.00]Hello", "[00:12.00]", "[00:15.00][00:30.00]Chorus", "[00:20.00]World"].join("\n"),
      40_000,
    );
    expect(lines.map((l) => [l.start, l.end, l.text])).toEqual([
      [9_500, 11_500, "Hello"],
      [14_500, 19_500, "Chorus"],
      [19_500, 29_500, "World"],
      [29_500, 39_500, "Chorus"],
    ]);
    expect(lines.every((l) => l.words === null)).toBe(true);
  });

  it("parses enhanced word stamps incl. A2 end stamps", () => {
    const [l] = parseLrc("[00:18.89] <00:18.89>We're <00:19.25>no <00:19.53>strangers<00:20.50>\n[00:22.00]Next");
    expect(l.text).toBe("We're no strangers");
    expect(l.words!.map((w) => [w.text, w.start, w.end])).toEqual([
      ["We're ", 18_890, 19_250],
      ["no ", 19_250, 19_530],
      ["strangers", 19_530, 20_500],
    ]);
  });
});

describe("parseLyricsfile", () => {
  const yaml = `version: '1.0'
lines:
- text: 「さよなら」だけだった
  start_ms: 30170
  end_ms: 32620
  words:
  - text: 「さよなら」
    start_ms: 30200
  - text: だけだった
    start_ms: 32296
- text: <00:40.00>Inline <00:40.50>stamps
  start_ms: 40000
  end_ms: 42000
`;
  it("reads explicit words and inline stamps", () => {
    const [a, b] = parseLyricsfile(yaml);
    expect(a.words!.map((w) => [w.text, w.start, w.end])).toEqual([
      ["「さよなら」", 30_200, 32_296],
      ["だけだった", 32_296, 32_620],
    ]);
    expect(b.text).toBe("Inline stamps");
    expect(b.words![1]).toMatchObject({ text: "stamps", start: 40_500, end: 42_000 });
  });
});

describe("recordToLyrics", () => {
  const rec = (o: Partial<LrclibRecord>): LrclibRecord => ({
    id: 1, trackName: "T", artistName: "A", albumName: null, duration: 100, instrumental: false,
    plainLyrics: null, syncedLyrics: null, lyricsfile: null, ...o,
  });
  it("classifies kinds", () => {
    expect(recordToLyrics(rec({ instrumental: true })).kind).toBe("instrumental");
    expect(recordToLyrics(rec({ plainLyrics: "a\nb" })).kind).toBe("plain");
    expect(recordToLyrics(rec({ syncedLyrics: "[00:01.00]a\n[00:02.00]b" })).kind).toBe("line");
    expect(recordToLyrics(rec({ syncedLyrics: "[00:01.00]<00:01.00>a <00:01.50>b\n[00:02.00]<00:02.00>c <00:02.40>d" })).kind).toBe("word");
  });
  it("treats single whole-line 'words' as line-timed", () => {
    const lf = "lines:\n- text: 沈むように溶けてゆくように\n  start_ms: 160\n  end_ms: 4069\n  words:\n  - text: 沈むように溶けてゆくように\n    start_ms: 160\n";
    const l = recordToLyrics(rec({ lyricsfile: lf, hasWordSync: true }));
    expect(l.kind).toBe("line");
    expect(l.lines[0].words).toBeNull();
  });
});
