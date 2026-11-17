import { describe, expect, it } from "vitest";
import { koRoman, pronounce } from "./korean";
import { isCantonese, jyutChars, romanizeLyrics } from "./index";
import { applyFurigana, romanTimeline, rubySegments } from "./timeline";
import { buildTimeline } from "../timing/timeline";
import { DEFAULT_SETTINGS } from "../settings/schema";
import type { Lyrics } from "../lyrics/model";

const L = (lines: { text: string; start: number; end: number }[]): Lyrics => ({
  kind: "line", source: "lrclib", id: Math.random(), trackName: "t", artistName: "a", durationMs: 60_000,
  lines: lines.map((l) => ({ ...l, words: null })),
});

describe("korean pronunciation", () => {
  it.each([["않아", "ana"], ["좋아", "joa"], ["같이", "gachi"], ["국물", "gungmul"], ["신라", "silla"], ["입학", "ipak"], ["밤양갱", "bamyanggaeng"]])(
    "%s → %s",
    (k, r) => expect(koRoman(k, true)).toBe(r),
  );
  it("keeps word boundaries and can be switched off", () => {
    expect(pronounce("끝나지 않아")).toBe("끈나지 아나");
    expect(koRoman("않아", false)).toBe("anha");
  });
});

describe("cantonese", () => {
  it("detects and romanizes", () => {
    expect(isCantonese("我哋唔係")).toBe(true);
    expect(isCantonese("我们不是")).toBe(false);
    expect(jyutChars("我哋").join(" ")).toBe("ngo5 dei6");
  });
  it("auto mode uses jyutping for Cantonese lyrics", async () => {
    const r = await romanizeLyrics(L([{ text: "我哋一齊唱", start: 0, end: 2000 }]), DEFAULT_SETTINGS.romanization);
    expect(r[0]!.text).toMatch(/ngo5 dei6/);
  });
});

describe("furigana", () => {
  it("splits okurigana", () => {
    expect(rubySegments("裁か", "さばか")).toEqual([{ base: "裁", rt: "さば" }, { base: "か", rt: "" }]);
    expect(rubySegments("お茶", "おちゃ")).toEqual([{ base: "お", rt: "" }, { base: "茶", rt: "ちゃ" }]);
    expect(rubySegments("天気", "てんき")).toEqual([{ base: "天気", rt: "てんき" }]);
  });
  it("merges per-character words of a compound and attaches the reading", () => {
    const tl = buildTimeline(L([{ text: "天気です", start: 0, end: 3000 }]));
    const line = tl.lines[0];
    applyFurigana(line, [{ start: 0, end: 2, display: "天気", reading: "てんき" }], "天気です");
    expect(line.words[0]).toMatchObject({ text: "天気", ruby: [{ base: "天気", rt: "てんき" }] });
    expect(line.words.map((w) => w.text).join("")).toBe("天気です");
  });
  it("furigana mode keeps the original line and puts readings on words", () => {
    const lyr = L([{ text: "天気", start: 0, end: 2000 }]);
    const tl = romanTimeline(lyr, [{ text: "tenki", ruby: [{ start: 0, end: 2, display: "天気", reading: "てんき" }] }], "furigana", "estimated");
    expect(tl.lines[0].text).toBe("天気");
    expect(tl.lines[0].sub).toBeUndefined();
    expect(tl.lines[0].words[0].ruby?.[0].rt).toBe("てんき");
  });
});
