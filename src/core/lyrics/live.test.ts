// Live check against the real LRCLIB API. Skipped unless LIVE=1 (polite: few requests, sequential).
//   LIVE=1 npx vitest run src/core/lyrics/live.test.ts
import { describe, expect, it } from "vitest";
import { findRecord } from "./service";
import { recordToLyrics } from "./parse";

const cases: [title: string, artist: string, album: string, durationMs: number, expectTrack: RegExp][] = [
  ["Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", "Rick Astley", "", 213_061, /never gonna give you up/i],
  ["YOASOBI「夜に駆ける」 Official Music Video", "Ayase / YOASOBI", "", 261_000, /夜に駆ける|yoru ni kakeru/i],
  ["ROSÉ & Bruno Mars - APT. (Official Music Video)", "ROSÉ", "", 173_000, /apt/i],
  ["Blinding Lights", "The Weeknd", "After Hours", 200_040, /blinding lights/i],
  ["晴天", "周杰倫", "葉惠美", 269_000, /晴天/],
  ["밤양갱", "BIBI", "밤양갱", 146_000, /밤양갱|bam yang gang/i],
  ["Deeper Well", "Kacey Musgraves", "Deeper Well", 216_000, /deeper well/i],
  ["All Of Me", "Nao", "Jupiter", 165_000, /all of me/i],
];

describe.skipIf(!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LIVE)("LRCLIB live", () => {
  it.each(cases)("%s — %s", async (title, artist, album, durationMs, expectTrack) => {
    const r = await findRecord({ title, artist, album, durationMs });
    expect(r, "no match").not.toBeNull();
    const l = recordToLyrics(r!);
    console.log(`${title} → #${r!.id} ${r!.artistName} – ${r!.trackName} (${r!.duration}s) kind=${l.kind} lines=${l.lines.length}`);
    expect(r!.trackName).toMatch(expectTrack);
  }, 60_000);
});

// Accuracy check of the estimator: hide real word stamps, estimate, compare.
describe.skipIf(!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LIVE)("estimator vs real word timing", () => {
  it.each([[1009665], [390], [13618589]])("record %i", async (id) => {
    const { lrclib } = await import("./lrclib");
    const { buildTimeline } = await import("../timing/timeline");
    const r = (await lrclib.getById(id))!;
    const exact = recordToLyrics(r);
    const est = buildTimeline({ ...exact, lines: exact.lines.map((l) => ({ ...l, words: null })) });
    const errs: number[] = [];
    const lineErr: number[] = [];
    exact.lines.forEach((l, i) => {
      if (!l.words || l.words.length !== est.lines[i].words.length) return;
      l.words.forEach((w, k) => errs.push(Math.abs(w.start - est.lines[i].words[k].start)));
      lineErr.push(Math.abs(l.words.at(-1)!.end - est.lines[i].end));
    });
    errs.sort((a, b) => a - b);
    const med = errs[errs.length >> 1];
    const p90 = errs[Math.floor(errs.length * 0.9)];
    console.log(`#${id} ${r.trackName}: words=${errs.length} median err ${med} ms, p90 ${p90} ms, line-end median ${lineErr.sort((a, b) => a - b)[lineErr.length >> 1]} ms, pace ${est.pace.toFixed(2)}`);
    expect(med).toBeLessThan(600);
  }, 60_000);
});

describe.skipIf(!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LIVE)("AMLL live", () => {
  it("finds word-synced TTML via iTunes id", async () => {
    const { findAmll } = await import("./amll");
    const r = await findAmll({ title: "祝福", artist: "YOASOBI", album: "", durationMs: 181_000 });
    console.log("AMLL", r?.id, r?.xml.length);
    expect(r?.xml).toContain("<tt");
  }, 60_000);
});
