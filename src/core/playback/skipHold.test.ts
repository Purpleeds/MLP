import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlaying } from "./clock";
import { createSkipHold, HOLD_MS } from "./skipHold";

const track = (title: string, status: NowPlaying["status"] = "playing"): NowPlaying => ({
  sourceApp: "Spotify.exe",
  sourceKind: "spotify",
  title,
  artist: "Artist",
  album: "",
  durationMs: 200_000,
  artwork: null,
  status,
  positionMs: 0,
  updatedAtMs: 0,
  rate: 1,
  timelineOk: true,
  canSeek: true,
});

describe("skip hold", () => {
  let shown: (string | null)[];
  let feed: (np: NowPlaying | null) => void;
  const last = () => shown[shown.length - 1];
  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
    feed = createSkipHold((np) => shown.push(np ? `${np.title}:${np.status}` : null));
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the old song through a skip and switches when the new one plays", () => {
    feed(track("A"));
    feed(null); // player reports nothing between tracks
    feed(track("B", "changing"));
    feed(track("B", "paused"));
    vi.advanceTimersByTime(1500);
    expect(shown).toEqual(["A:playing"]);
    feed(track("B"));
    expect(shown).toEqual(["A:playing", "B:playing"]);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(last()).toBe("B:playing"); // the cancelled hold doesn't fire later
  });

  it("shows nothing playing once a real stop outlasts the hold", () => {
    feed(track("A"));
    feed(null);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(last()).toBe("A:playing");
    vi.advanceTimersByTime(1);
    expect(last()).toBe(null);
  });

  it("shows a new track that stays paused once the hold ends", () => {
    feed(track("A"));
    feed(null);
    vi.advanceTimersByTime(1000);
    feed(track("B", "paused")); // later gap values don't restart the hold
    vi.advanceTimersByTime(HOLD_MS - 1000);
    expect(last()).toBe("B:paused");
  });

  it("passes the same song's state changes and changes while paused straight through", () => {
    feed(track("A"));
    feed(track("A", "paused"));
    expect(last()).toBe("A:paused");
    feed(track("B", "paused")); // picked another song while paused: no skip in progress
    expect(last()).toBe("B:paused");
    feed(null);
    expect(last()).toBe("B:paused"); // still held at first
  });
});
