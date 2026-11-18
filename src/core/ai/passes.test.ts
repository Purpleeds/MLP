import { describe, expect, it } from "vitest";
import { addHandFixes, canSkip, handFixes, mergePasses, settled, similarity, type AiPass, type Cand } from "./passes";
import { upgradeSaved } from "./aiLyrics";

const pass = (cands: Cand[], spans: [number, number][] = [[0, 60_000]], complete = true): AiPass => ({ at: 0, model: "m", spans, cands, doneTo: spans[spans.length - 1][1], complete });
const c = (start: number, end: number, text: string, conf = 0.8): Cand => ({ start, end, text, conf });

describe("similarity", () => {
  it("ignores case and punctuation", () => {
    expect(similarity("Hello, World!", "hello world")).toBe(1);
    expect(similarity("abcd", "abxd")).toBeCloseTo(0.75);
    expect(similarity("", "x")).toBe(0);
  });
});

describe("mergePasses", () => {
  it("locks lines two plays agree on and takes the median timing", () => {
    const a = pass([c(1000, 3000, "I walk alone tonight"), c(4000, 6000, "under city lights")]);
    const b = pass([c(1200, 3200, "I walk alone tonight"), c(4100, 6100, "under the city light")]);
    const lines = mergePasses([a, b]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ text: "I walk alone tonight", locked: true, votes: 2, start: 1100, end: 3100 });
    expect(lines[1].locked).toBe(false); // a missing word is a real difference: checked again next play
  });

  it("picks the text most plays agree on", () => {
    const lines = mergePasses([
      pass([c(1000, 3000, "hold me closer", 0.9)]),
      pass([c(1000, 3000, "cold me closer", 0.95)]),
      pass([c(1000, 3000, "hold me closer", 0.7)]),
    ]);
    expect(lines[0].text).toBe("hold me closer");
    expect(lines[0].votes).toBe(3); // "cold me closer" is within SAME of it
  });

  it("drops a lonely unsure line the other plays didn't hear", () => {
    const a = pass([c(1000, 3000, "real line"), c(10_000, 12_000, "thanks for listening", 0.4)]);
    const b = pass([c(1000, 3000, "real line")]);
    expect(mergePasses([a, b]).map((l) => l.text)).toEqual(["real line"]);
    // …but keeps it while only one play has heard that stretch
    const b2 = pass([c(1000, 3000, "real line")], [[0, 5000]]);
    expect(mergePasses([a, b2]).map((l) => l.text)).toEqual(["real line", "thanks for listening"]);
  });

  it("keeps the better play's line split when another play joined two lines", () => {
    const a = pass([c(1000, 3000, "first half here"), c(3200, 6000, "second half there")], undefined);
    const b = pass([c(1000, 6000, "first half here second half there")]);
    const c3 = pass([c(1000, 3000, "first half here"), c(3200, 6000, "second half there")]);
    const lines = mergePasses([a, b, c3]);
    expect(lines.map((l) => l.text)).toEqual(["first half here", "second half there"]);
  });

  it("hand fixes win and can remove lines", () => {
    const a = pass([c(1000, 3000, "wrong words"), c(4000, 6000, "noise")]);
    const lines = mergePasses([a], [
      { start: 1000, end: 3000, text: "right words" },
      { start: 4000, end: 6000, text: "" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "right words", hand: true, locked: true });
  });
});

describe("planning", () => {
  it("skips settled stretches on later plays only", () => {
    const a = pass([c(1000, 3000, "same line")]);
    const b = pass([c(1000, 3000, "same line")]);
    const lines = mergePasses([a, b]);
    expect(canSkip(lines, [a], 0, 28_000)).toBe(false);
    expect(canSkip(lines, [a, b, pass([], [[0, 0]], false)], 0, 28_000)).toBe(true);
    const unsure = mergePasses([a, pass([c(1000, 3000, "something else")])]);
    expect(canSkip(unsure, [a, b, pass([], [[0, 0]], false)], 0, 28_000)).toBe(false);
  });

  it("settles after enough agreeing plays or MAX_PASSES", () => {
    const a = pass([c(1000, 3000, "x y z")]);
    expect(settled([a], mergePasses([a]))).toBe(false);
    expect(settled([a, a], mergePasses([a, a]))).toBe(true);
    const odd = [a, pass([c(1000, 3000, "q r s t u")])];
    expect(settled(odd, mergePasses(odd))).toBe(false);
    expect(settled([a, a, a, a, a].map((p, i) => (i % 2 ? odd[1] : p)), [])).toBe(true);
  });
});

describe("hand fixes from an edited copy", () => {
  it("takes changed lines (or all) and needs one line per line", () => {
    const lines = mergePasses([pass([c(1000, 3000, "a b c"), c(4000, 6000, "d e f")])]);
    expect(handFixes(lines, ["a b c", "d e g"], false)).toEqual([{ start: 4000, end: 6000, text: "d e g" }]);
    expect(handFixes(lines, ["a b c", "d e f"], true)).toHaveLength(2);
    expect(() => handFixes(lines, ["only one"], false)).toThrow(/one line per line/);
    const merged = addHandFixes([{ start: 4000, end: 6000, text: "old" }, { start: 9000, end: 9500, text: "keep" }], [{ start: 4000, end: 6000, text: "new" }]);
    expect(merged.map((h) => h.text)).toEqual(["new", "keep"]);
  });
});

describe("saved AI lyrics", () => {
  it("turns a version 1 transcript into the first pass", () => {
    const v1 = { v: 1 as const, lines: [{ start: 1000, end: 3000, text: "hello there", words: null }], doneTo: 200_000, lang: "en", complete: true, model: "base" };
    const v2 = upgradeSaved(v1, "x");
    expect(v2.v).toBe(2);
    expect(v2.passes).toHaveLength(1);
    expect(v2.passes[0]).toMatchObject({ complete: true, doneTo: 200_000 });
    expect(v2.lines[0].text).toBe("hello there");
    expect(upgradeSaved(undefined, "x").passes).toEqual([]);
  });
});
