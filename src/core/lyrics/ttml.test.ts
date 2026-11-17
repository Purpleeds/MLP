// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseTtml, ttmlTime } from "./ttml";
import { buildTimeline } from "../timing/timeline";

const TTML = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal">
<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head>
<body><div>
<p begin="00:01.000" end="00:04.000" ttm:agent="v1" itunes:key="L1"><span begin="00:01.000" end="00:01.400">Hold</span> <span begin="00:01.400" end="00:03.900">on</span><span ttm:role="x-bg"><span begin="00:02.500" end="00:03.000">(ooh</span> <span begin="00:03.000" end="00:03.800">yeah)</span></span><span ttm:role="x-translation" xml:lang="zh-CN">坚持</span></p>
<p begin="00:05.000" end="00:07.000" ttm:agent="v2" itunes:key="L2"><span begin="00:05.000" end="00:06.900">Noooo</span></p>
</div></body></tt>`;

describe("ttml", () => {
  it("parses times", () => {
    expect(ttmlTime("01:02.500")).toBe(62_500);
    expect(ttmlTime("1:01:02.5")).toBe(3_662_500);
    expect(ttmlTime("2.5s")).toBe(2_500);
    expect(ttmlTime("1500ms")).toBe(1_500);
  });
  it("reads words, background vocals and duets; ignores translations", () => {
    const lines = parseTtml(TTML);
    expect(lines.map((l) => [l.text, l.start, !!l.bg, !!l.duet])).toEqual([
      ["Hold on", 1000, false, false],
      ["ooh yeah", 2500, true, false],
      ["Noooo", 5000, false, true],
    ]);
    expect(lines[0].words!.map((w) => [w.text, w.start, w.end])).toEqual([["Hold ", 1000, 1400], ["on", 1400, 3900]]);
  });
  it("numbers singers for duet colours (people in order, groups 0, single singer none)", () => {
    const lines = parseTtml(TTML);
    expect(lines.map((l) => l.voice)).toEqual([1, 1, 2]);
    const group = TTML.replace('<ttm:agent type="person" xml:id="v2"/>', '<ttm:agent type="group" xml:id="v2"/>');
    expect(parseTtml(group).map((l) => l.voice)).toEqual([1, 1, 0]);
    const solo = TTML.replace('ttm:agent="v2"', 'ttm:agent="v1"');
    expect(parseTtml(solo).every((l) => l.voice === undefined)).toBe(true);
    const tl = buildTimeline({ kind: "word", lines, source: "amll", id: 1, trackName: "t", artistName: "a", durationMs: 10_000 });
    expect(tl.lines.map((l) => l.voice)).toEqual([1, 1, 2]);
  });
  it("keeps long held notes and doesn't let background lines cut the main line", () => {
    const tl = buildTimeline({ kind: "word", lines: parseTtml(TTML), source: "amll", id: 1, trackName: "t", artistName: "a", durationMs: 10_000 });
    expect(tl.lines[0].end).toBe(3900); // not cut at the bg line start (2.5 s)
    expect(tl.lines[2].words[0].end).toBe(6900); // 1.9 s "Noooo" kept
    expect(tl.lines[2].duet).toBe(true);
  });
});
