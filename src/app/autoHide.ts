// Auto-hide: fade the lyrics window away when nothing is playing, bring it back when music starts.
// If the user shows the window themselves while idle (tray, hotkey), it stays until the next song plays.
import { useEffect, useRef, useState } from "react";
import { isTauri, platform } from "../core/platform";
import type { NowPlaying } from "../core/playback/clock";
import type { Settings } from "../core/settings/schema";

const FADE_MS = 260;

/** Is there "nothing playing" for auto-hide purposes? */
export function isIdle(np: Pick<NowPlaying, "status"> | null, whenPaused: boolean): boolean {
  if (!np) return true;
  return whenPaused && np.status !== "playing" && np.status !== "changing";
}

let manualShowAt = 0;
/** Call when the user explicitly shows the window (hotkey / toolbar). */
export const noteManualShow = () => (manualShowAt = Date.now());

/** Returns true while the window is fading out (the card should go transparent). */
export function useAutoHide(live: NowPlaying | null, layout: Settings["layout"]): boolean {
  const [fading, setFading] = useState(false);
  const hiddenByUs = useRef(false);
  const idle = layout.autoHide && isIdle(live, layout.autoHideWhenPaused);

  // Tray "Show" / second instance → user override.
  useEffect(() => {
    const off = platform.on("main-shown", () => {
      if (hiddenByUs.current) hiddenByUs.current = false;
      noteManualShow();
      setFading(false);
    });
    return () => void off.then((f) => f());
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    if (!idle) {
      // Music again (or auto-hide turned off): come back if we were the ones who hid it.
      if (hiddenByUs.current) {
        hiddenByUs.current = false;
        void platform.show().then(() => setFading(false));
      } else setFading(false);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setTimeout(async () => {
      // Shown on purpose during this idle stretch: leave it until the next song.
      if (manualShowAt >= startedAt) return;
      if (!(await platform.isVisible())) return;
      setFading(true);
      window.setTimeout(async () => {
        hiddenByUs.current = true;
        await platform.hide();
      }, FADE_MS);
    }, Math.max(0, layout.autoHideDelay) * 1000);
    return () => clearTimeout(timer);
  }, [idle, layout.autoHideDelay]);

  return fading;
}
