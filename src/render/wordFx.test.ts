import { describe, expect, it } from "vitest";
import type { Timeline, TimedLine } from "../core/timing/timeline";
import { keywordStyle, planWordFx, titleWords } from "./wordFx";

/** One line from [text, durationMs] words, laid end to end. */
function line(start: number, words: [string, number][], exact = true): TimedLine {
  let t = start;
  const ws = words.map(([text, d], i) => {
    const w = { text: i < words.length - 1 ? `${text} ` : text, start: t, end: t + d, bg: false };
    t += d;
    return w;
  });
  return { start, end: t, text: ws.map((w) => w.text).join(""), words: ws, exact, fill: "words", bg: false };
}

const tl = (lines: TimedLine[], pace = 4): Timeline => ({ lines, interludes: [], pace });

describe("word effects", () => {
  it("keyword families", () => {
    expect(keywordStyle("insanity,")).toBe("glitch");
    expect(keywordStyle("love's")).toBe("glow");
    expect(keywordStyle("Stars")).toBe("shimmer");
    expect(keywordStyle("start")).toBeNull(); // "star" is whole-word only
    expect(keywordStyle("warm")).toBe("glow"); // not "war"
    expect(keywordStyle("the")).toBeNull();
  });

  it("title words: short titles only, without the feat. part", () => {
    expect([...titleWords("Clarity (feat. Foxes)")]).toEqual(["clarity"]);
    expect(titleWords("Never Gonna Give You Up").size).toBe(0);
  });

  it("Clarity: held title word blooms, insanity glitches, love glows", () => {
    const lines = [
      line(0, [["If", 200], ["our", 300], ["love's", 1200], ["insanity", 1400]]),
      line(4000, [["Why", 200], ["are", 200], ["you", 200], ["my", 200], ["clarity?", 1600]]),
      line(8000, [["Walk", 300], ["on", 300], ["through", 300], ["a", 200], ["red", 300], ["parade", 400]]),
    ];
    const fx = planWordFx(tl(lines), { choice: "auto", title: "Clarity" });
    expect(fx.words[0][2]?.style).toBe("glow");
    expect(fx.words[0][3]?.style).toBe("glitch");
    expect(fx.words[1][4]?.style).toBe("bloom");
    expect(fx.words[1][4]!.strength).toBeGreaterThan(fx.words[0][2]!.strength);
    expect(fx.words[2].every((w) => w === null)).toBe(true); // nothing held, no keywords
  });

  it("a short keyword counts once per line, and not when a held word already has an effect", () => {
    const fx = planWordFx(tl([line(0, [["fire", 600], ["and", 200], ["light", 800], ["now", 300]])]), { choice: "auto" });
    expect(fx.words[0].map((w) => w?.style ?? null)).toEqual([null, null, "shimmer", null]);
    const held = planWordFx(tl([line(0, [["fire", 600], ["noooo", 1500]], false)]), { choice: "auto" });
    expect(held.words[0][0]).toBeNull();
    expect(held.words[0][1]).not.toBeNull();
  });

  it("estimated timing: a long keyword counts, a short one doesn't", () => {
    expect(planWordFx(tl([line(0, [["baby", 1200]], false)]), { choice: "auto" }).words[0][0]?.style).toBe("glow");
    expect(planWordFx(tl([line(0, [["love", 650]], false)]), { choice: "auto" }).words[0]).toEqual([null]);
  });

  it("song style from pace when the lyrics have no theme; a fixed choice wins", () => {
    const lines = [line(0, [["walk", 300], ["away", 1500]])];
    expect(planWordFx(tl(lines, 7.5), { choice: "auto" }).base).toBe("shimmer");
    expect(planWordFx(tl(lines, 2.2), { choice: "auto" }).base).toBe("wave");
    expect(planWordFx(tl(lines, 4.2), { choice: "auto" }).words[0][1]?.style).toBe("glow");
    const fixed = planWordFx(tl([line(0, [["insanity", 1500]])]), { choice: "wave" });
    expect(fixed.words[0][0]?.style).toBe("wave");
  });

  it("song style from its keywords", () => {
    const lines = [0, 1, 2].map((i) => line(i * 4000, [["crazy", 300], ["broken", 300], ["away", 1500]]));
    expect(planWordFx(tl(lines), { choice: "auto" }).base).toBe("glitch");
  });

  it("no effects on lines without word fill", () => {
    const l = { ...line(0, [["love", 1500]]), fill: "none" as const };
    expect(planWordFx(tl([l]), { choice: "auto" }).words[0]).toEqual([null]);
  });
});
