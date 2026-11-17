import { describe, expect, it } from "vitest";
import { adMarker, isAd, isLongVideo, maybeAdLength } from "./ads";

const yt = { title: "Blinding Lights", artist: "The Weeknd", sourceKind: "browser" as const, durationMs: 200_000 };

describe("ads", () => {
  it("spots ads named as such", () => {
    expect(adMarker({ ...yt, title: "Advertisement" })).toBe(true);
    expect(adMarker({ ...yt, title: "Ad · 0:15" })).toBe(true);
    expect(adMarker({ ...yt, title: "広告" })).toBe(true);
    expect(adMarker({ ...yt, title: "Spotify", artist: "Advertisement", sourceKind: "spotify" })).toBe(false); // title isn't an ad word
    expect(adMarker({ title: "Advertisement", artist: "", sourceKind: "spotify" })).toBe(true);
    // A real song called "Advertisement" in Spotify stays a song.
    expect(adMarker({ title: "Advertisement", artist: "Some Band", sourceKind: "spotify" })).toBe(false);
    expect(adMarker({ ...yt, title: "Ad Astra" })).toBe(false);
  });
  it("spots ads by a short duration under the song's title", () => {
    expect(isAd({ ...yt, durationMs: 15_000 }, 200_000)).toBe(true);
    expect(isAd({ ...yt, durationMs: 15_000 }, 0)).toBe(false); // no lyrics length to compare
    expect(isAd({ ...yt, durationMs: 50_000 }, 62_000)).toBe(false); // a short song
    expect(isAd({ ...yt, sourceKind: "spotify", durationMs: 15_000 }, 200_000)).toBe(false);
    expect(maybeAdLength({ ...yt, durationMs: 30_000 })).toBe(true);
    expect(maybeAdLength({ ...yt, durationMs: 0 })).toBe(false);
  });
  it("skips long browser videos", () => {
    expect(isLongVideo({ ...yt, durationMs: 3_600_000 })).toBe(true);
    expect(isLongVideo({ ...yt, durationMs: 400_000 })).toBe(false);
    expect(isLongVideo({ ...yt, sourceKind: "spotify", durationMs: 3_600_000 })).toBe(false);
  });
});
