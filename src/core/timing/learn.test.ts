import { describe, expect, it } from "vitest";
import { addSample, learnedOffset, type OffsetSample } from "./learn";

describe("learned offsets", () => {
  it("needs a few agreeing corrections", () => {
    let l: OffsetSample[] = [];
    l = addSample(l, "a", 300);
    l = addSample(l, "b", 400);
    expect(learnedOffset(l)).toBeNull(); // two songs only
    l = addSample(l, "c", 350);
    expect(learnedOffset(l)).toBe(350);
    l = addSample(l, "a", 500); // a song corrected again replaces its sample
    expect(l.filter((x) => x.song === "a")).toHaveLength(1);
    expect(learnedOffset(l)).toBe(400);
  });
  it("ignores small or disagreeing corrections", () => {
    expect(learnedOffset([{ song: "a", offset: 50, at: 0 }, { song: "b", offset: 60, at: 0 }, { song: "c", offset: 40, at: 0 }])).toBeNull();
    expect(learnedOffset([{ song: "a", offset: 500, at: 0 }, { song: "b", offset: -400, at: 0 }, { song: "c", offset: 300, at: 0 }, { song: "d", offset: -300, at: 0 }])).toBeNull();
  });
  it("keeps the latest corrections only", () => {
    let l: OffsetSample[] = [];
    for (let i = 0; i < 20; i++) l = addSample(l, `s${i}`, 200);
    expect(l).toHaveLength(12);
    expect(l[0].song).toBe("s8");
  });
});
