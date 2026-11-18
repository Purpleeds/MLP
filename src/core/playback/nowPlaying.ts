// Now-playing store: real GSMTC data from Rust in the app, a looping fake track in mock mode.
import { useEffect, useSyncExternalStore } from "react";
import { isTauri, platform } from "../platform";
import { MOCK_TRACK, mockArtwork } from "../mock/fixtures";
import { getSettings } from "../settings/store";
import { PlaybackClock, type NowPlaying } from "./clock";

export type { NowPlaying };
export const clock = new PlaybackClock();

let current: NowPlaying | null = null;
const listeners = new Set<() => void>();
const set = (np: NowPlaying | null) => {
  if (np?.artworkSame && current) np = { ...np, artwork: current.artwork };
  current = np;
  if (np) clock.update(np);
  listeners.forEach((l) => l());
};

let started = false;
export function startNowPlaying(): void {
  if (started) return;
  started = true;
  if (isTauri()) {
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const mock = await invoke<string | null>("dev_mock").catch(() => null);
      if (mock) return startMock(mock === "ai");
      await pushMediaConfig();
      await platform.on<NowPlaying | null>("now-playing", set);
      set(await invoke<NowPlaying | null>("get_now_playing"));
    })();
  } else {
    startMock();
  }
}

/** Send source-selection settings to the Rust media service. */
export async function pushMediaConfig(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const s = getSettings().sources;
  await invoke("set_media_config", {
    config: { allowOther: s.allowOther, ignore: s.ignore, prefer: s.prefer },
  });
}

export type MediaControl =
  | { action: "play" | "pause" | "toggle" | "next" | "prev" }
  | { action: "seek"; ms: number };

export async function mediaControl(c: MediaControl): Promise<void> {
  if (!isTauri()) return mockControl?.(c);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("media_control", { control: c });
}

/** Mock mode: seek / play / pause / prev / next drive the fake clock (for trying controls in the browser). */
let mockControl: ((c: MediaControl) => void) | null = null;

function startMock(asReal = false) {
  let startedAt = Date.now();
  // Dev aid: ?song=Artist|Title|durationMs simulates a real track (lyrics fetched from LRCLIB).
  const [artist, title, dur] = (new URLSearchParams(location.search).get("song") ?? "").split("|");
  const track = title
    ? { title, artist, album: "", durationMs: Number(dur) || 0 }
    : { title: MOCK_TRACK.title, artist: MOCK_TRACK.artist, album: MOCK_TRACK.album, durationMs: MOCK_TRACK.durationMs };
  const loop = track.durationMs || MOCK_TRACK.durationMs;
  const artwork = mockArtwork();
  // Dev aid: ?t=seconds starts the mock clock at that position.
  const startAt = Number(new URLSearchParams(location.search).get("t")) * 1000 || 0;
  let pausedAt: number | null = null;
  const sample = (): NowPlaying => {
    const now = pausedAt ?? Date.now();
    const elapsed = (now - startedAt + startAt) % loop;
    return {
      sourceApp: "mock",
      sourceKind: asReal ? "other" : "mock",
      ...track,
      artwork,
      status: pausedAt === null ? "playing" : "paused",
      positionMs: elapsed,
      updatedAtMs: Date.now(),
      rate: pausedAt === null ? 1 : 0,
      timelineOk: true,
      canSeek: true,
    };
  };
  mockControl = (c) => {
    const now = pausedAt ?? Date.now();
    const pause = c.action === "pause" || (c.action === "toggle" && pausedAt === null);
    const play = c.action === "play" || (c.action === "toggle" && pausedAt !== null);
    if (c.action === "seek" || c.action === "prev" || c.action === "next") startedAt = now + startAt - (c.action === "seek" ? c.ms : 0);
    else if (pause && pausedAt === null) pausedAt = Date.now();
    else if (play && pausedAt !== null) {
      startedAt += Date.now() - pausedAt;
      pausedAt = null;
    }
    set(sample());
  };
  set(sample());
  setInterval(() => set(sample()), 1000);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useNowPlaying(): NowPlaying | null {
  useEffect(startNowPlaying, []);
  return useSyncExternalStore(subscribe, () => current);
}

/** Re-render at a fixed rate (for clock-driven UI such as the debug overlay). */
export function useTicker(ms: number): number {
  return useSyncExternalStore(
    (l) => {
      const t = setInterval(l, ms);
      return () => clearInterval(t);
    },
    () => Math.floor(Date.now() / ms),
  );
}
