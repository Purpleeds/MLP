import { describe, expect, it } from "vitest";
import { buildQueries, cleanArtist, cleanTitle, MIN_SCORE, scoreCandidate, similarity } from "./query";

describe("cleanTitle / cleanArtist", () => {
  it.each([
    ["Never Gonna Give You Up (Official Video) (4K Remaster)", "Never Gonna Give You Up"],
    ["Song [Official Music Video]", "Song"],
    ["【MV】夜に駆ける", "夜に駆ける"],
    ["Song (Lyrics)", "Song"],
    ["Here Comes The Sun - Remastered 2009", "Here Comes The Sun"],
    ["Song (Live)", "Song (Live)"],
    ["Song (feat. Someone)", "Song (feat. Someone)"],
  ])("%s", (raw, clean) => expect(cleanTitle(raw)).toBe(clean));

  it("cleans channel names", () => {
    expect(cleanArtist("Rick Astley - Topic")).toBe("Rick Astley");
    expect(cleanArtist("TaylorSwiftVEVO")).toBe("TaylorSwift");
    expect(cleanArtist("YOASOBI Official")).toBe("YOASOBI");
  });
});

describe("buildQueries", () => {
  it("splits 'Artist - Title' YouTube titles", () => {
    const q = buildQueries("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", "Rick Astley");
    expect(q[0]).toEqual({ track: "Never Gonna Give You Up", artist: "Rick Astley" });
  });
  it("keeps clean YT Music / Spotify metadata and adds a feat-less variant", () => {
    const q = buildQueries("Song (feat. B)", "A, B", "Album");
    expect(q[0]).toEqual({ track: "Song (feat. B)", artist: "A, B", album: "Album" });
    expect(q).toContainEqual({ track: "Song", artist: "A" });
  });
  it("keeps 'with' that is part of the title", () => {
    expect(buildQueries("Stay With Me", "Sam Smith")).toEqual([{ track: "Stay With Me", artist: "Sam Smith" }]);
    expect(buildQueries("Song [with Friend]", "A")).toContainEqual({ track: "Song", artist: "A" });
    expect(buildQueries("Song feat. B", "A")).toContainEqual({ track: "Song", artist: "A" });
  });
  it("tries both orders when the channel does not match", () => {
    const q = buildQueries("Daft Punk - Get Lucky", "SomeUploader");
    expect(q).toContainEqual({ track: "Get Lucky", artist: "Daft Punk" });
  });
  it("extracts Japanese quoted titles", () => {
    expect(buildQueries("YOASOBI「夜に駆ける」 Official Music Video", "Ayase / YOASOBI")).toContainEqual({
      track: "夜に駆ける",
      artist: "Ayase / YOASOBI",
    });
  });
});

describe("scoring", () => {
  const c = { trackName: "Get Lucky", artistName: "Daft Punk", duration: 248, instrumental: false, syncedLyrics: "[00:01.00]x", plainLyrics: "x" };
  it("similarity basics", () => {
    expect(similarity("Hello", "hello!")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });
  it("accepts good matches and rejects far durations", () => {
    expect(scoreCandidate(c, { track: "Get Lucky", artist: "Daft Punk" }, 248_500)).toBeGreaterThan(0.9);
    expect(scoreCandidate(c, { track: "Get Lucky", artist: "Daft Punk" }, 300_000)).toBe(-1);
    expect(scoreCandidate(c, { track: "Other Song", artist: "Someone" }, 248_000)).toBeLessThan(MIN_SCORE);
  });
});
