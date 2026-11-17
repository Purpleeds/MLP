import { describe, expect, it } from "vitest";
import { guessLanguage, translateLyrics, type TranslateDeps } from "./translate";
import { DEFAULT_SETTINGS } from "./settings/schema";
import type { Lyrics } from "./lyrics/model";

const lyr = (texts: string[], extra: Partial<Lyrics["lines"][number]>[] = []): Lyrics => ({
  kind: "line", source: "lrclib", id: Math.floor(Math.random() * 1e9), trackName: "t", artistName: "a", durationMs: 1,
  lines: texts.map((text, i) => ({ start: i * 1000, end: i * 1000 + 900, text, words: null, ...extra[i] })),
});

describe("translation", () => {
  it("guesses languages", () => {
    expect(guessLanguage(["I don't know what to do with you"])).toBe("en");
    expect(guessLanguage(["夜空に光る"])).toBe("ja");
    expect(guessLanguage(["Te quiero mucho"])).toBeNull();
  });
  it("uses translations shipped with the lyrics for the right language", async () => {
    const l = lyr(["你好"], [{ translation: "Hello", translationLang: "en" }]);
    expect(await translateLyrics(l, DEFAULT_SETTINGS.translation, { fetchJson: async () => ({ ok: false, status: 500, json: null }) })).toEqual(["Hello"]);
  });
  it("skips songs already in the target language", async () => {
    let calls = 0;
    const deps: TranslateDeps = { fetchJson: async () => (calls++, { ok: true, status: 200, json: {} }) };
    expect(await translateLyrics(lyr(["I love you and you love me"]), DEFAULT_SETTINGS.translation, deps)).toEqual([null]);
    expect(calls).toBe(0);
  });
  it("batches MyMemory requests, translates repeats once and drops identical results", async () => {
    const urls: string[] = [];
    const deps: TranslateDeps = {
      fetchJson: async (url) => {
        urls.push(url);
        const q = decodeURIComponent(/q=([^&]*)/.exec(url)![1]);
        return { ok: true, status: 200, json: { responseData: { translatedText: q.split("\n").map((x) => (x === "OK" ? "OK" : `EN(${x})`)).join("\n") } } };
      },
    };
    const out = await translateLyrics(lyr(["夜空", "星", "夜空", "OK"]), DEFAULT_SETTINGS.translation, deps);
    expect(out).toEqual(["EN(夜空)", "EN(星)", "EN(夜空)", null]);
    expect(urls).toHaveLength(1);
  });
  it("stops quietly when the free quota is used up", async () => {
    const deps: TranslateDeps = { fetchJson: async () => ({ ok: true, status: 200, json: { quotaFinished: true } }) };
    expect(await translateLyrics(lyr(["夜空"]), DEFAULT_SETTINGS.translation, deps)).toEqual([null]);
  });
});
