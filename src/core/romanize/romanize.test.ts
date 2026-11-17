import { describe, expect, it } from "vitest";
import { abjadLine, hasVowelMarks, jaLine, koLine, lineScript, otherLine, romanizeLyrics, songLanguage, zhLine, type JaWord } from "./index";
import { romanTimeline } from "./timeline";
import { DEFAULT_SETTINGS } from "../settings/schema";
import type { Lyrics } from "../lyrics/model";

const W = (display: string, yomi: string, pos = "名詞", pos1 = ""): JaWord => ({ display, yomi, pos, pos1 });

describe("detection", () => {
  it("finds the song language and per-line script", () => {
    expect(songLanguage(["夜空に光る", "空"])).toBe("ja");
    expect(songLanguage(["晴天"])).toBe("zh");
    expect(songLanguage(["밤양갱"])).toBe("ko");
    expect(songLanguage(["hello"])).toBeNull();
    expect(lineScript("空", "ja")).toBe("ja");
    expect(lineScript("空", "zh")).toBe("zh");
    expect(lineScript("Привет", null)).toBe("other");
    expect(lineScript("Hello, world!", null)).toBe("latin");
  });
});

describe("japanese", () => {
  const words = [W("今日", "キョウ"), W("は", "ハ", "助詞", "係助詞"), W("いい", "イイ", "形容詞"), W("天気", "テンキ"), W("です", "デス", "助動詞")];
  it("reads particles and attaches auxiliaries", () => {
    expect(jaLine(words, "plain").text).toBe("kyou wa ii tenki desu");
    expect(jaLine(words, "macron").text).toBe("kyō wa ii tenki desu");
  });
});

describe("chinese / korean / other", () => {
  it("romanizes", () => {
    expect(zhLine("晴天", "symbol")).toBe("qíng tiān");
    expect(zhLine("我们 OK", "none")).toBe("wo men OK");
    expect(koLine("밤양갱")).toBe("bamyanggaeng");
    expect(otherLine("Привет")).toBe("Privet");
  });
  it("romanizes Arabic / Hebrew only when the vowels are written (auto)", async () => {
    expect(lineScript("قلبي وروحي", null)).toBe("abjad");
    expect(hasVowelMarks("قلبي وروحي")).toBe(false);
    expect(hasVowelMarks("قَلْبِي وَرُوحِي")).toBe(true);
    expect(abjadLine("حَبِيبِي")).toBe("habibi");
    expect(abjadLine("אַהֲבָה")).toBe("'ahavah");
    const lyrics: Lyrics = {
      kind: "line", source: "lrclib", id: 77, trackName: "t", artistName: "a", durationMs: 60_000,
      lines: [
        { start: 0, end: 1000, text: "قلبي وروحي", words: null },
        { start: 1000, end: 2000, text: "قَلْبِي وَرُوحِي", words: null },
      ],
    };
    const auto = await romanizeLyrics(lyrics, DEFAULT_SETTINGS.romanization);
    expect(auto.map((r) => r?.text ?? null)).toEqual([null, "qalbi waruhi"]);
    const on = await romanizeLyrics(lyrics, { ...DEFAULT_SETTINGS.romanization, abjad: "on" });
    expect(on[0]?.text).toBe("qlby wrwhy");
  });
});

describe("romanTimeline", () => {
  const lyrics: Lyrics = {
    kind: "line", source: "lrclib", id: 9, trackName: "t", artistName: "a", durationMs: 60_000,
    lines: [
      { start: 0, end: 3000, text: "晴天", words: null },
      { start: 3000, end: 6000, text: "Hello there", words: null },
    ],
  };
  it("swaps in romanized lines and keeps the original underneath", async () => {
    const roman = await romanizeLyrics(lyrics, DEFAULT_SETTINGS.romanization);
    expect(roman[1]).toBeNull();
    const tl = romanTimeline(lyrics, roman, "roman-main", "estimated");
    expect(tl.lines[0]).toMatchObject({ text: "qíng tiān", sub: "晴天" });
    expect(tl.lines[0].words.map((w) => w.text.trim())).toEqual(["qíng", "tiān"]);
    expect(tl.lines[1].sub).toBeUndefined();
    expect(romanTimeline(lyrics, roman, "original-main", "estimated").lines[0]).toMatchObject({ text: "晴天", sub: "qíng tiān" });
  });
  it("maps exact word timings onto pinyin", async () => {
    const exact: Lyrics = { ...lyrics, id: 10, lines: [{ start: 0, end: 2000, text: "晴天", words: [{ text: "晴", start: 0, end: 900 }, { text: "天", start: 900, end: 2000 }] }] };
    const tl = romanTimeline(exact, await romanizeLyrics(exact, DEFAULT_SETTINGS.romanization), "roman-main", "estimated");
    expect(tl.lines[0].words.map((w) => [w.text, w.start])).toEqual([["qíng ", 0], ["tiān", 900]]);
  });
});
