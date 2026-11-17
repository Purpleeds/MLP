import { describe, expect, it } from "vitest";
import { latinWeight, tokenize } from "./tokens";
import { buildTimeline, distribute, lineAt, wordProgress } from "./timeline";
import type { Lyrics, LyricLine } from "../lyrics/model";

const lyrics = (lines: Partial<LyricLine>[]): Lyrics => ({
  kind: "line", source: "lrclib", id: 1, trackName: "T", artistName: "A", durationMs: 200_000,
  lines: lines.map((l) => ({ start: 0, end: 0, text: "", words: null, ...l })),
});

describe("tokenize / weights", () => {
  it("estimates syllables and elongation", () => {
    expect(latinWeight("love")).toBe(1);
    expect(latinWeight("commitment's")).toBe(3);
    expect(latinWeight("no")).toBe(1);
    expect(latinWeight("noooooo")).toBeGreaterThan(3);
    expect(latinWeight("yeahhhh")).toBeGreaterThan(latinWeight("yeah"));
  });
  it("counts syllables in other scripts", () => {
    expect(latinWeight("любовь")).toBe(2); // lyu-bov'
    expect(latinWeight("здравствуйте")).toBe(3);
    expect(latinWeight("αγάπη")).toBe(3); // a-ga-pi
    expect(latinWeight("καιρός")).toBe(2); // kai-ros (diphthong)
    expect(latinWeight("حبيبي")).toBe(3); // ha-bi-bi (5 letters)
    expect(latinWeight("אהבה")).toBe(2);
    expect(latinWeight("मोहब्बत")).toBe(4); // mo-hab-ba-t (virama counted out)
  });
  it("keeps spacing/punctuation on tokens and splits vocal hyphens", () => {
    expect(tokenize("Oh-oh-oh, I won't").map((t) => t.text)).toEqual(["Oh-", "oh-", "oh, ", "I ", "won't"]);
    expect(tokenize("'Cause I'm (Shining)").map((t) => [t.text, t.bg])).toEqual([
      ["'Cause ", false], ["I'm ", false], ["(Shining)", true],
    ]);
  });
  it("splits CJK per character with attached small kana and long marks", () => {
    expect(tokenize("きょうはー").map((t) => t.text)).toEqual(["きょ", "う", "はー"]);
    expect(tokenize("「さよなら」").map((t) => t.text)).toEqual(["「さ", "よ", "な", "ら」"]);
    expect(tokenize("晴天").length).toBe(2);
    expect(tokenize("밤양갱").length).toBe(3);
  });
});

describe("distribute", () => {
  it("covers the span exactly, is monotonic, and gives held words more time", () => {
    const words = distribute(tokenize("Noooooo I won't let go"), 1000, 5000);
    expect(words[0].start).toBe(1000);
    expect(words.at(-1)!.end).toBe(5000);
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].end);
    const dur = words.map((w) => w.end - w.start);
    expect(dur[0]).toBeGreaterThan(dur[1] * 2); // "Noooooo" ≫ "I"
  });
});

describe("buildTimeline", () => {
  const dense = Array.from({ length: 8 }, (_, i) => ({ start: i * 3000, end: (i + 1) * 3000, text: "one two three four five six seven" }));

  it("estimates line ends before long gaps and creates interludes", () => {
    const tl = buildTimeline(lyrics([...dense, { start: 24_000, end: 40_000, text: "short line" }, { start: 40_000, end: 43_000, text: "after the break" }]));
    const short = tl.lines[8];
    expect(short.end).toBeLessThan(28_000); // sung quickly, not stretched over 16 s
    expect(tl.interludes).toContainEqual({ start: short.end, end: 40_000 });
    expect(tl.pace).toBeGreaterThan(2);
  });

  it("never runs past the next line and keeps words inside the line", () => {
    const tl = buildTimeline(lyrics(dense));
    for (let i = 0; i < tl.lines.length - 1; i++) expect(tl.lines[i].end).toBeLessThanOrEqual(tl.lines[i + 1].start);
    for (const l of tl.lines) {
      expect(l.words[0].start).toBe(l.start);
      expect(l.words.at(-1)!.end).toBe(l.end);
    }
  });

  it("keeps exact word timings but caps a runaway final word", () => {
    const tl = buildTimeline(lyrics([
      { start: 0, end: 20_000, text: "hi there", words: [{ text: "hi ", start: 0, end: 400 }, { text: "there", start: 400, end: 20_000 }] },
    ]));
    expect(tl.lines[0].exact).toBe(true);
    expect(tl.lines[0].words[0]).toMatchObject({ start: 0, end: 400 });
    expect(tl.lines[0].words[1].end).toBeLessThan(5000);
  });

  it("marks fully parenthesized lines as background vocals", () => {
    const tl = buildTimeline(lyrics([{ start: 0, end: 2000, text: "(Hold on)" }]));
    expect(tl.lines[0]).toMatchObject({ bg: true, text: "Hold on" });
  });

  it("supports line and linear modes", () => {
    expect(buildTimeline(lyrics(dense), "line").lines[0].fill).toBe("none");
    const lin = buildTimeline(lyrics(dense), "linear").lines[0];
    expect(lin.end).toBe(2950);
  });

  it("finds the active line", () => {
    const tl = buildTimeline(lyrics(dense));
    expect(lineAt(tl.lines, -1)).toBe(-1);
    expect(lineAt(tl.lines, 4500)).toBe(1);
    expect(wordProgress(tl.lines[0].words[0], tl.lines[0].words[0].end)).toBe(1);
  });
});
