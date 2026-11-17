import { describe, expect, it } from "vitest";
import { PlaybackClock, type NowPlaying } from "./clock";

const np = (o: Partial<NowPlaying> = {}): NowPlaying => ({
  sourceApp: "Spotify.exe",
  sourceKind: "spotify",
  title: "Song",
  artist: "Artist",
  album: "",
  durationMs: 200_000,
  artwork: null,
  status: "playing",
  positionMs: 10_000,
  updatedAtMs: 1_000_000,
  rate: 1,
  timelineOk: true,
  canSeek: true,
  ...o,
});

describe("PlaybackClock", () => {
  it("extrapolates from the source timestamp while playing", () => {
    const c = new PlaybackClock();
    c.update(np(), 1_000_500);
    expect(c.position(1_002_000)).toBeCloseTo(12_000);
  });

  it("holds position while paused", () => {
    const c = new PlaybackClock();
    c.update(np({ status: "paused" }), 1_000_000);
    expect(c.position(1_050_000)).toBe(10_000);
  });

  it("snaps on seeks and blends small drift", () => {
    const c = new PlaybackClock();
    c.update(np(), 1_000_000);
    c.update(np({ positionMs: 60_000, updatedAtMs: 1_001_000 }), 1_001_000);
    expect(c.position(1_001_000)).toBeCloseTo(60_000); // seek → snap
    c.update(np({ positionMs: 61_100, updatedAtMs: 1_002_000 }), 1_002_000); // 100 ms drift
    expect(c.position(1_002_000)).toBeCloseTo(61_000); // still shows old timeline
    expect(c.position(1_004_000)).toBeCloseTo(63_100, -1); // converged
  });

  it("estimates when the source has no timeline", () => {
    const c = new PlaybackClock();
    const t = { timelineOk: false, positionMs: 0, durationMs: 0, updatedAtMs: 0 };
    c.update(np(t), 5_000);
    expect(c.estimated).toBe(true);
    expect(c.position(8_000)).toBe(3_000);
    c.update(np({ ...t, status: "paused" }), 9_000);
    expect(c.position(20_000)).toBe(4_000);
    c.update(np({ ...t, status: "playing" }), 20_000);
    expect(c.position(21_000)).toBe(5_000);
    c.update(np({ ...t, title: "Next" }), 22_000);
    expect(c.position(22_500)).toBe(500);
  });

  it("clamps to duration and ignores future timestamps", () => {
    const c = new PlaybackClock();
    c.update(np({ updatedAtMs: 9_999_999_999 }), 1_000_000);
    expect(c.position(1_000_000)).toBeCloseTo(10_000);
    expect(c.position(1_500_000)).toBe(200_000);
  });
});
