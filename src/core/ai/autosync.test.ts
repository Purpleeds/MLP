import { describe, expect, it } from "vitest";
import type { Lyrics } from "../lyrics/model";
import { buildTimeline } from "../timing/timeline";
import { alignWord, anchorsOf, applySync, fitMap, lyricsSig, mapTime, nextWindow, syncLines, toFix, type LineFix, type SyncLine, type WordTime } from "./autosync";

const TEXTS = [
  "Folded up the evening into paper satellites",
  "Threw them past the streetlights just to watch them fly",
  "(Hold on)",
  "Every little signal says you're somewhere close",
  "No, I won't let the static win",
  "We're louder than the radio",
  "Folded up the evening, let it go",
  "Paper satellites",
];
/** Line-synced lyrics, one line every 5 s from 10 s (the "(Hold on)" line is a background line). */
function lyrics(): Lyrics {
  const lines = TEXTS.map((text, i) => ({ start: 10_000 + i * 5_000, end: 10_000 + (i + 1) * 5_000, text, words: null }));
  return { kind: "line", lines, source: "lrclib", id: 7, trackName: "t", artistName: "a", durationMs: 60_000 };
}

/** Fake aligner: words sung at `truth(expected)` spread over 70 % of the line. */
function sing(line: SyncLine, truth: (t: number) => number, noise = 0): (WordTime | null)[] {
  const n = line.words.length;
  const dur = (line.end - line.start) * 0.7;
  let seed = line.idx * 7 + 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise;
  return line.words.map((w, k) => {
    if (!w) return null;
    const s = truth(line.start + (dur * k) / n) + rnd();
    return { start: s, end: s + dur / n / 2, score: -0.1 };
  });
}

describe("auto-sync", () => {
  it("normalizes words to the aligner alphabet", () => {
    expect(alignWord("Don’t")).toBe("don't");
    expect(alignWord("nǐ")).toBe("ni");
    expect(alignWord("kyō,")).toBe("kyo");
    expect(alignWord("123")).toBe("");
  });

  it("picks main lines with romanized words", () => {
    const ls = syncLines(lyrics(), null);
    expect(ls.map((l) => l.idx)).toEqual([0, 1, 3, 4, 5, 6, 7]); // "(Hold on)" is a background line
    expect(ls[0].words).toEqual(["folded", "up", "the", "evening", "into", "paper", "satellites"]);
    expect(ls[3].words.slice(0, 2)).toEqual(["no", "i"]);
  });

  it("accepts confident lines and rejects doubtful ones", () => {
    const line = syncLines(lyrics(), null)[0];
    const good = sing(line, (t) => t + 300);
    expect(toFix(line, good)?.start).toBe(10_300);
    expect(toFix(line, good.map((w) => w && { ...w, score: -3 }))).toBeNull(); // wrong text scores ≈ −3…−8
    expect(toFix(line, good.map((w, k) => (k < 4 ? null : w)))).toBeNull(); // too few words found
  });

  it("fits tempo and offset robustly", () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ exp: 10_000 + i * 8_000, act: 1.05 * (10_000 + i * 8_000) + 2_000 }));
    pts[4].act += 6_000; // one wrong match (a repeated chorus line)
    const m = fitMap(pts);
    expect(m.a).toBeCloseTo(1.05, 3);
    expect(Math.abs(mapTime(m, 90_000) - (1.05 * 90_000 + 2_000))).toBeLessThan(5);
    // The app's end-to-end case: 4 lines over 11 s, lyrics 3 % fast and 1.5 s early → tempo found.
    const e2e = [[602, 2121], [4300, 5963], [7573, 9284], [11557, 13406]].map(([exp, act]) => ({ exp, act }));
    const fe = fitMap(e2e);
    expect(fe.a).toBeGreaterThan(1.02);
    expect(Math.abs(mapTime(fe, 15_138) - 17_095)).toBeLessThan(120); // the 5th line, not aligned yet
    // One anchor never moves the song (it may be a wrong match); two that agree do.
    expect(mapTime(fitMap([{ exp: 10_000, act: 11_500 }]), 30_000)).toBe(30_000);
    expect(mapTime(fitMap([{ exp: 10_000, act: 11_500 }, { exp: 14_000, act: 15_500 }]), 30_000)).toBe(31_500);
    // Two that disagree: still nothing moves.
    expect(mapTime(fitMap([{ exp: 10_000, act: 11_500 }, { exp: 14_000, act: 9_000 }]), 30_000)).toBe(30_000);
    // A section cut out of the recording: lines after it follow their own neighbours.
    const cut = [0, 1, 2, 3, 4, 5].map((i) => ({ exp: 10_000 + i * 6_000, act: 10_000 + i * 6_000 - (i >= 3 ? 8_000 : 0) }));
    expect(mapTime(fitMap(cut), 46_000)).toBeCloseTo(38_000, -2);
  });

  it("plans windows only over captured audio, wider until the offset is known", () => {
    const ls = syncLines(lyrics(), null);
    expect(nextWindow(ls, () => false, [[0, 12_000]], fitMap([]), 60_000)).toBeNull();
    const w = nextWindow(ls, () => false, [[0, 40_000]], fitMap([]), 60_000)!;
    expect(w.lines.map((l) => l.idx)).toEqual([0, 1]);
    expect(w.from).toBe(4_000); // 6 s margin
    const known = fitMap([{ exp: 10_000, act: 10_000 }, { exp: 15_000, act: 15_000 }]);
    const w2 = nextWindow(ls, (i) => i < 2, [[0, 40_000]], known, 60_000)!;
    expect(w2.lines[0].idx).toBe(3);
    expect(w2.from).toBe(25_000 - 2_500);
  });

  it("retimes aligned lines word by word and moves the rest with the map", () => {
    const ly = lyrics();
    const ls = syncLines(ly, null);
    const tl = buildTimeline(ly);
    const truth = (t: number) => t + 1_200;
    const fixes: Record<number, LineFix> = { 0: toFix(ls[0], sing(ls[0], truth))!, 1: toFix(ls[1], sing(ls[1], truth))! };
    const out = applySync(tl, ly, ls, fixes, fitMap(anchorsOf(ls, fixes)));
    expect(out.lines[0].start).toBe(11_200);
    expect(out.lines[0].exact).toBe(true);
    expect(out.lines[0].words[1].start).toBe(Math.round(fixes[0].words[1]![0]));
    // Unaligned line 4 moves by the same 1.2 s (two agreeing anchors).
    expect(out.lines[4].start).toBe(tl.lines[4].start + 1_200);
    // The original timeline is untouched.
    expect(tl.lines[0].start).toBe(10_000);
  });

  it("keeps a drifting song in sync live (lyrics 4 % too fast + 1.5 s late start)", () => {
    // Long song: a line every 4 s for 3 minutes.
    const lines = Array.from({ length: 45 }, (_, i) => ({ start: 8_000 + i * 4_000, end: 12_000 + i * 4_000, text: TEXTS[i % TEXTS.length].replace(/[()]/g, ""), words: null }));
    const ly: Lyrics = { kind: "line", lines, source: "lrclib", id: 1, trackName: "t", artistName: "a", durationMs: 200_000 };
    const ls = syncLines(ly, null);
    const truth = (t: number) => 1.04 * t + 1_500;
    const fixes: Record<number, LineFix> = {};
    let map = fitMap([]);
    const errors: number[] = [];
    // Audio arrives in real time; every 2 s the engine aligns what it can, then predicts the next line.
    for (let now = 0; now < 190_000; now += 2_000) {
      for (let w = nextWindow(ls, (i) => !!fixes[i], [[0, now]], map, 200_000); w; w = nextWindow(ls, (i) => !!fixes[i], [[0, now]], map, 200_000)) {
        for (const l of w.lines) {
          const sungEnd = truth(l.end);
          // Only lines sung inside the window can be found; others come back unmatched.
          const res = truth(l.start) >= w.from && sungEnd <= w.to ? sing(l, truth, 40) : l.words.map(() => null);
          const f = toFix(l, res);
          if (f) fixes[l.idx] = f;
          else fixes[l.idx] = fixes[l.idx]; // stays missing → retried later by the engine
        }
        map = fitMap(anchorsOf(ls, fixes));
        if (w.lines.every((l) => !fixes[l.idx])) break;
      }
      // Prediction error for the next line not sung yet.
      const next = ls.find((l) => truth(l.start) > now + 1_000);
      if (next && Object.keys(fixes).length >= 3) errors.push(Math.abs(mapTime(map, next.start) - truth(next.start)));
    }
    errors.sort((a, b) => a - b);
    expect(errors.length).toBeGreaterThan(20);
    expect(errors[errors.length >> 1]).toBeLessThan(150); // median
    expect(errors[Math.floor(errors.length * 0.9)]).toBeLessThan(400); // p90 (early anchors, before the tempo is known)
  });

  it("fingerprints lyrics text", () => {
    const a = lyrics();
    const b = lyrics();
    b.lines[2].text = "changed";
    expect(lyricsSig(a)).toBe(lyricsSig(lyrics()));
    expect(lyricsSig(a)).not.toBe(lyricsSig(b));
  });
});
