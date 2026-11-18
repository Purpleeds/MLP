import { describe, expect, it } from "vitest";
import { detectedLanguage, filterSegments, isLoop, missingWhisper, nextChunk, segmentsFrom, segmentsToLines, settle, type AssetInfo, type Seg } from "./transcribe";

const seg = (start: number, end: number, text: string, extra: Partial<Seg> = {}): Seg => ({ start, end, text, words: [], avgLogprob: -0.2, noSpeech: 0.01, ...extra });

describe("AI lyrics", () => {
  it("reads Whisper's JSON in song time", () => {
    const json = {
      segments: [{ start: 1.5, end: 3.0, text: " Hello world", avg_logprob: -0.1, no_speech_prob: 0.01, words: [{ word: " Hello", start: 1.5, end: 2.0, probability: 0.9 }, { word: " world", start: 2.1, end: 3.0, probability: 0.8 }, { word: "[_TT_150]", start: 3, end: 3 }] }],
      language_probabilities: { en: 0.93, de: 0.02 },
    };
    const s = segmentsFrom(json, 60_000);
    expect(s[0]).toMatchObject({ start: 61_500, end: 63_000, text: "Hello world" });
    expect(s[0].words.map((w) => w.start)).toEqual([61_500, 62_100]);
    expect(detectedLanguage(json)).toEqual({ code: "en", p: 0.93 });
  });

  it("drops hallucinations and keeps real lines", () => {
    const out = filterSegments([
      seg(0, 3000, "Thank you for watching!"),
      seg(3000, 6000, "♪ ♪"),
      seg(6000, 8000, "[Music]"),
      seg(6000, 8000, "【音楽】"),
      seg(6000, 8000, "（拍手）"),
      seg(8000, 11000, "I can see the city lights"),
      seg(11000, 14000, "ご視聴ありがとうございました"),
      seg(14000, 17000, "la la la la la la la la la la"),
      seg(17000, 20000, "some mumbled words", { noSpeech: 0.9, avgLogprob: -1.1 }),
      seg(20000, 20100, "Hi"),
      seg(21000, 24000, "Hold me close"),
      seg(24000, 27000, "Hold me close"),
      seg(27000, 30000, "Hold me close"),
      seg(30000, 33000, "♪ Shining like the morning ♪"),
    ]);
    expect(out.map((s) => s.text)).toEqual(["I can see the city lights", "Hold me close", "Hold me close", "Shining like the morning"]);
    expect(isLoop("あああああああああああああああああ")).toBe(true);
    expect(isLoop("夜空に光る紙の星を見上げて")).toBe(false);
  });

  it("keeps sung lines whole; splits long ones at a pause or comma, never leaving a scrap", () => {
    const words = (text: string, t0 = 0, gapAt = -1, gap = 0) =>
      text.split(" ").map((w, i) => ({ text: ` ${w}`, start: t0 + i * 300 + (gapAt >= 0 && i >= gapAt ? gap : 0), end: t0 + i * 300 + 250 + (gapAt >= 0 && i >= gapAt ? gap : 0), p: 1 }));
    // 11 words, small breath before the last two → one line (was split into "…watch" / "them fly.")
    const one = segmentsToLines([seg(0, 4000, "", { words: words("Threw them past the streetlights just to watch them fly.", 0, 9, 600) })]);
    expect(one.map((l) => l.text)).toEqual(["Threw them past the streetlights just to watch them fly."]);
    // 16 words with a comma in the middle → two lines at the comma
    const two = segmentsToLines([seg(0, 6000, "", { words: words("I walk alone through the city lights, every night I wait for you to come home") })]);
    expect(two.map((l) => l.text)).toEqual(["I walk alone through the city lights,", "every night I wait for you to come home"]);
    // a long pause inside a short segment splits it
    const gap = segmentsToLines([seg(0, 6000, "", { words: words("Hold my hand tonight and never let me go", 0, 4, 2000) })]);
    expect(gap.map((l) => l.text)).toEqual(["Hold my hand tonight", "and never let me go"]);
    expect(gap[1].start).toBe(4 * 300 + 2000);
  });

  it("plans chunks over captured audio and redoes a cut-off last segment", () => {
    expect(nextChunk(0, [[0, 20_000]], false, 200_000)).toBeNull(); // wait for a full chunk
    expect(nextChunk(0, [[0, 30_000]], false, 200_000)).toEqual({ from: 0, to: 28_000, final: false });
    expect(nextChunk(0, [[0, 10_000]], true, 200_000)).toEqual({ from: 0, to: 10_000, final: false }); // paused
    expect(nextChunk(0, [[50_000, 90_000]], false, 200_000)).toEqual({ from: 50_000, to: 78_000, final: false }); // joined late
    expect(nextChunk(190_000, [[0, 199_000]], false, 200_000)).toEqual({ from: 190_000, to: 199_000, final: true });
    const r = settle([seg(1000, 5000, "a"), seg(6000, 12000, "b"), seg(25000, 28000, "cut off")], { from: 0, to: 28_000, final: false });
    expect(r.kept.map((s) => s.text)).toEqual(["a", "b"]);
    expect(r.doneTo).toBe(12_000);
    expect(settle([], { from: 0, to: 28_000, final: false }).doneTo).toBe(25_000); // instrumental: move on
  });
});

describe("missingWhisper", () => {
  const asset = (id: string, installed: boolean, sizeMb = 100): AssetInfo => ({ id, name: id, installed, downloading: false, sizeMb });
  const ids = (a: AssetInfo[]) => a.map((x) => x.id);

  it("asks for the GPU engine and the model on a fresh PC with an NVIDIA GPU", () => {
    const assets = [asset("whisper-cuda", false), asset("whisper-cpu", false), asset("large-v3-turbo-q5_0", false)];
    expect(ids(missingWhisper(assets, "RTX", "auto", "large-v3-turbo-q5_0"))).toEqual(["whisper-cuda", "large-v3-turbo-q5_0"]);
    expect(ids(missingWhisper(assets, null, "auto", "large-v3-turbo-q5_0"))).toEqual(["whisper-cpu", "large-v3-turbo-q5_0"]);
    expect(ids(missingWhisper(assets, "RTX", "cpu", "large-v3-turbo-q5_0"))).toEqual(["whisper-cpu", "large-v3-turbo-q5_0"]);
  });

  it("any installed engine will do; nothing missing once the model is there", () => {
    const assets = [asset("whisper-cuda", false), asset("whisper-cpu", true), asset("base", true), asset("large-v3-turbo-q5_0", false)];
    expect(ids(missingWhisper(assets, "RTX", "auto", "base"))).toEqual([]);
    expect(ids(missingWhisper(assets, "RTX", "auto", "large-v3-turbo-q5_0"))).toEqual(["large-v3-turbo-q5_0"]);
  });
});
