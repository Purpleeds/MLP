import { describe, expect, it } from "vitest";
import type { Timeline } from "../timing/timeline";
import { lrcToPlain, timelineToLrc } from "./export";

describe("AI timing export", () => {
  it("writes LRC with word stamps for exact lines", () => {
    const tl: Timeline = {
      pace: 4,
      interludes: [],
      lines: [
        { start: 1000, end: 2600, text: "hold me", exact: true, fill: "words", bg: false, words: [{ text: "hold ", start: 1000, end: 1400, bg: false }, { text: "me", start: 1400, end: 2600, bg: false }] },
        { start: 3000, end: 4000, text: "(ooh)", exact: false, fill: "words", bg: true, words: [] },
        { start: 65_500, end: 67_000, text: "close", exact: false, fill: "words", bg: false, words: [{ text: "close", start: 65_500, end: 67_000, bg: false }] },
      ],
    };
    const lrc = timelineToLrc(tl);
    expect(lrc).toBe("[00:01.00]<00:01.00>hold <00:01.40>me <00:02.60>\n[01:05.50]close");
    expect(lrcToPlain(lrc)).toBe("hold me\nclose");
  });
});
