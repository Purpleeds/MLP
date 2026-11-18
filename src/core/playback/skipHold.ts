// Skip hold: when a track is skipped, players briefly report nothing (or a new track that is still
// loading) before the next song plays. Keep showing the old song through that gap and switch once
// the new track plays; a real stop still shows "Nothing playing" after HOLD_MS.
import { trackKey, type NowPlaying } from "./clock";

export const HOLD_MS = 5000;

/** Whether `next` is a transition state worth hiding behind the `shown` song. */
export function isGap(shown: NowPlaying | null, next: NowPlaying | null): boolean {
  if (!shown) return false;
  if (!next) return true;
  if (trackKey(next) === trackKey(shown) || next.status === "playing") return false;
  // A new track that is paused right after a paused song is a real choice, not a skip in progress.
  return next.status !== "paused" || shown.status === "playing";
}

/** Wraps `apply` so gaps are held back for up to `ms`; the latest value wins once the hold ends. */
export function createSkipHold(apply: (np: NowPlaying | null) => void, ms = HOLD_MS) {
  let shown: NowPlaying | null = null;
  let pending: NowPlaying | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (np: NowPlaying | null) => {
    clearTimeout(timer);
    timer = undefined;
    shown = np;
    apply(np);
  };
  return (np: NowPlaying | null) => {
    if (!isGap(shown, np)) return show(np);
    pending = np;
    timer ??= setTimeout(() => show(pending), ms);
  };
}
