// Japanese dictionary on demand: romaji must not stay off after one failed download or a broken copy.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lyrics } from "../lyrics/model";
import { DEFAULT_SETTINGS } from "../settings/schema";

const fake = vi.hoisted(() => ({
  dictWorks: false,
  ensureFails: 1,
  calls: [] as string[],
  events: new Map<string, () => void>(),
}));

vi.mock("../platform", () => ({
  isTauri: () => true,
  platform: {
    log: () => undefined,
    on: async (event: string, cb: () => void) => {
      fake.events.set(event, cb);
      return () => undefined;
    },
    invoke: async (cmd: string, args?: { lines?: string[] }) => {
      fake.calls.push(cmd);
      if (cmd === "jp_readings") {
        // Without the dictionary Rust has no readings at all.
        if (!fake.dictWorks) return args!.lines!.map(() => []);
        return args!.lines!.map(() => [
          { display: "大丈夫", yomi: "ダイジョウブ", pos: "名詞", pos1: "形容動詞語幹" },
          { display: "です", yomi: "デス", pos: "助動詞", pos1: "" },
        ]);
      }
      if (cmd === "jp_dict_ensure") {
        if (fake.ensureFails-- > 0) throw new Error("download failed: error sending request");
        fake.dictWorks = true;
        return null;
      }
      return undefined;
    },
  },
}));

const { DICT_RETRY_MS, onJpDict, romanizeLyrics } = await import("./index");

const song: Lyrics = {
  kind: "line",
  source: "lrclib",
  id: 7,
  trackName: "Want To",
  artistName: "Abuse",
  durationMs: 200_000,
  lines: [{ start: 1000, end: 4000, text: "大丈夫です", words: null }],
};

afterEach(() => vi.useRealTimers());

describe("japanese dictionary on demand", () => {
  it("retries a failed dictionary download and romanizes the song once it works", async () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    onJpDict(ready);

    // No dictionary yet: the kanji line stays as written, and the dictionary is asked for.
    expect(await romanizeLyrics(song, DEFAULT_SETTINGS.romanization)).toEqual([null]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((c) => c === "jp_dict_ensure")).toHaveLength(1);
    expect(ready).not.toHaveBeenCalled();

    // The first attempt failed (network hiccup): it is tried again on its own, without a new song.
    await vi.advanceTimersByTimeAsync(DICT_RETRY_MS[0]);
    expect(fake.calls.filter((c) => c === "jp_dict_ensure")).toHaveLength(2);
    expect(ready).toHaveBeenCalledTimes(1);

    // The view re-romanizes and now gets romaji.
    const [line] = await romanizeLyrics(song, DEFAULT_SETTINGS.romanization);
    expect(line?.text).toBe("daijoubu desu");

    // Working dictionary: no more set-up calls.
    await vi.advanceTimersByTimeAsync(DICT_RETRY_MS[DICT_RETRY_MS.length - 1] * 2);
    expect(fake.calls.filter((c) => c === "jp_dict_ensure")).toHaveLength(2);
  });
});
