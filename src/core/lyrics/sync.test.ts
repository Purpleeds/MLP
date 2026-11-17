import { describe, expect, it } from "vitest";
import { lrcTime, publishToLrclib, syncUnits, toLrc, validatePublish, type PublishInput } from "./sync";
import { parseLrc } from "./parse";

describe("sync units + LRC", () => {
  it("splits into lines or words and drops LRC tags", () => {
    expect(syncUnits("[ar:X]\nHello there\n\nNoooo", "lines").units.map((u) => u.text)).toEqual(["Hello there", "Noooo"]);
    expect(syncUnits("Hello there\n晴天", "words").units.map((u) => u.text.trim())).toEqual(["Hello", "there", "晴", "天"]);
  });
  it("formats times", () => {
    expect(lrcTime(62_345)).toBe("01:02.35");
    expect(lrcTime(-5)).toBe("00:00.00");
  });
  it("writes line LRC with offset", () => {
    const { lines, units } = syncUnits("A\nB", "lines");
    expect(toLrc(lines, units, [{ start: 1000 }, { start: 2500 }], "lines", -100)).toBe("[00:00.90]A\n[00:02.40]B");
  });
  it("writes enhanced LRC that round-trips, keeping a held last word", () => {
    const { lines, units } = syncUnits("I won't let go\nNoooo", "words");
    const stamps = [{ start: 1000 }, { start: 1300 }, { start: 1700 }, { start: 2000, end: 2400 }, { start: 3000, end: 6000 }];
    const lrc = toLrc(lines, units, stamps, "words");
    expect(lrc).toBe("[00:01.00] <00:01.00>I <00:01.30>won't <00:01.70>let <00:02.00>go <00:02.40>\n[00:03.00] <00:03.00>Noooo <00:06.00>");
    const parsed = parseLrc(lrc);
    expect(parsed[1].words![0]).toMatchObject({ text: "Noooo", start: 3000, end: 6000 });
  });
});

describe("publish", () => {
  const input: PublishInput = { trackName: "T", artistName: "A", albumName: "Al", durationSec: 200, plainLyrics: "x", syncedLyrics: "[00:01.00]x" };
  it("validates required fields", () => {
    expect(validatePublish({ ...input, albumName: " " })).toMatch(/album/);
    expect(validatePublish({ ...input, durationSec: 0 })).toMatch(/length/);
    expect(validatePublish(input)).toBeNull();
  });
  it("requests a challenge, solves it and publishes with the token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith("/request-challenge")
        ? new Response(JSON.stringify({ prefix: "P", target: "00FF" }), { status: 200 })
        : new Response(null, { status: 201 });
    };
    await publishToLrclib(input, { fetch, solve: async () => "42", base: "https://x/api", client: "MLP" });
    expect(calls[1].url).toBe("https://x/api/publish");
    expect((calls[1].init.headers as Record<string, string>)["X-Publish-Token"]).toBe("P:42");
    expect(JSON.parse(calls[1].init.body as string)).toMatchObject({ trackName: "T", duration: 200, syncedLyrics: "[00:01.00]x" });
  });
  it("reports server errors readably", async () => {
    const fetch = async (url: string) =>
      url.endsWith("/request-challenge") ? new Response(JSON.stringify({ prefix: "P", target: "0" })) : new Response(JSON.stringify({ message: "bad token" }), { status: 400 });
    await expect(publishToLrclib(input, { fetch, solve: async () => "1", base: "b", client: "c" })).rejects.toThrow(/bad token/);
  });
});
