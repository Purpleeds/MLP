import { describe, expect, it } from "vitest";
import type { Lyrics } from "../lyrics/model";
import { syncLines, type LineFix } from "./autosync";
import { errorRate, perturb, timingErrors } from "./evaluate";

const ref: Lyrics = {
  kind: "word",
  source: "amll",
  id: 1,
  trackName: "t",
  artistName: "a",
  durationMs: 60_000,
  lines: [
    { start: 1000, end: 3000, text: "hold me close", words: [{ text: "hold ", start: 1000, end: 1400 }, { text: "me ", start: 1400, end: 1800 }, { text: "close", start: 1800, end: 3000 }] },
    { start: 4000, end: 6000, text: "never let go", words: [{ text: "never ", start: 4000, end: 4500 }, { text: "let ", start: 4500, end: 5000 }, { text: "go", start: 5000, end: 6000 }] },
  ],
};

describe("evaluation", () => {
  it("counts word / character errors", () => {
    expect(errorRate("Hold me close, never let go", "hold me close never let it go")).toMatchObject({ errors: 1, n: 6, unit: "word" });
    expect(errorRate("夜空に光る", "夜空に光").unit).toBe("char");
    expect(errorRate("夜空に光る", "夜空に光").errors).toBe(1);
  });
  it("measures timing against word-synced reference lyrics", () => {
    const lines = syncLines(ref, null);
    const fixes: Record<number, LineFix> = {
      0: { start: 1050, end: 2900, words: [[1050, 1300], [1380, 1700], [1900, 2900]], score: -0.1 },
      1: { start: 4300, end: 5900, words: [[4300, 4400], [4500, 4900], [5000, 5900]], score: -0.2 },
    };
    const e = timingErrors(ref, lines, fixes);
    expect(e.words.n).toBe(6);
    expect(e.words.median).toBe(50);
    expect(e.lines.p90).toBe(300);
    expect(e.aligned).toBe(2);
  });
  it("makes a drifting line-synced copy", () => {
    const p = perturb(ref, 1.03, 1500);
    expect(p.kind).toBe("line");
    expect(p.lines[1].start).toBe(Math.round((4000 - 1500) / 1.03));
    expect(p.lines[0].words).toBeNull();
  });
});
