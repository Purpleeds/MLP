import { describe, expect, it } from "vitest";
import type { Lyrics } from "../lyrics/model";
import { anchorsOf, applySync, fitMap, nextSequential, plainToLines, SEQ_TRIES, syncLines, toFix, type LineFix, type WordTime } from "./autosync";
import { buildTimeline } from "../timing/timeline";

const PLAIN: Lyrics = {
  kind: "plain",
  lines: [],
  plain: "[Verse 1]\nFolded up the evening into paper satellites\nThrew them past the streetlights just to watch them fly\n\n(Chorus)\nEvery little signal says you're somewhere close\nNo, I won't let the static win\nWe're louder than the radio",
  source: "lrclib",
  id: 3,
  trackName: "t",
  artistName: "a",
  durationMs: 120_000,
};

describe("plain lyrics auto-sync", () => {
  it("turns plain text into placeholder-timed lines without section labels", () => {
    const l = plainToLines(PLAIN);
    expect(l.estimated).toBe(true);
    expect(l.lines.map((x) => x.text)).toEqual([
      "Folded up the evening into paper satellites",
      "Threw them past the streetlights just to watch them fly",
      "Every little signal says you're somewhere close",
      "No, I won't let the static win",
      "We're louder than the radio",
    ]);
    expect(l.lines[1].start).toBeGreaterThan(l.lines[0].end);
  });

  it("finds every line in order, skipping a long instrumental", () => {
    const l = plainToLines(PLAIN);
    const lines = syncLines(l, null);
    // Real singing: starts at 20 s, a 30 s break after line 2.
    const sungAt = [20_000, 25_000, 60_000, 65_500, 70_000];
    const sung = (idx: number) => sungAt[idx];
    const fixes: Record<number, LineFix> = {};
    const tries = new Map<number, number>();
    const coverage: [number, number][] = [[0, 90_000]];
    for (let guard = 0; guard < 60; guard++) {
      const w = nextSequential(lines, fixes, (i) => tries.get(i) ?? 0, coverage, 120_000);
      if (!w) break;
      w.lines.forEach((ln, k) => {
        const t0 = sung(ln.idx);
        const inside = t0 >= w.from && t0 + 3_000 <= w.to;
        const res: (WordTime | null)[] = ln.words.map((_, j) => (inside ? { start: t0 + j * 300, end: t0 + j * 300 + 200, score: -0.1 } : null));
        const f = toFix(ln, res);
        if (f) fixes[ln.idx] = f;
        else if (k === 0) tries.set(ln.idx, (tries.get(ln.idx) ?? 0) + 1);
      });
    }
    expect(Object.keys(fixes).map(Number).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(lines.map((x) => fixes[x.idx].start)).toEqual(sungAt);
    // The synced view uses the found times.
    const tl = applySync(buildTimeline(l), l, lines, fixes, fitMap(anchorsOf(lines, fixes)));
    expect(tl.lines[2].start).toBe(60_000);
  });

  it("gives up on a line that is never sung", () => {
    const lines = syncLines(plainToLines(PLAIN), null);
    const w = nextSequential(lines, {}, (i) => (i === 0 ? SEQ_TRIES : 0), [[0, 90_000]], 120_000);
    expect(w?.lines[0].idx).toBe(1);
    expect(nextSequential(lines, {}, () => 0, [[0, 8_000]], 120_000)).toBeNull(); // not enough audio yet
  });
});
