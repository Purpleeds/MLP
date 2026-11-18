// Power features in the lyrics window: global hotkeys, toast messages, hover toolbar.
import { currentLine } from "../core/currentLine";
import { renderShareCard } from "../core/shareCard";
import { displayMeta } from "../core/display";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { getSettings, updateSettings } from "../core/settings/store";
import { DISPLAY_MODES, type Settings } from "../core/settings/schema";
import { adjustSongOffset, useSongOffset } from "../core/lyrics/service";
import { noteManualShow } from "./autoHide";
import type { NowPlaying } from "../core/playback/clock";
import { mediaControl } from "../core/playback/nowPlaying";

const OFFSET_STEP = 100;

// ---------- toast ----------
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; id: number } | null>(null);
  const timer = useRef(0);
  const show = useCallback((text: string, ms = 1600) => {
    clearTimeout(timer.current);
    setMsg({ text, id: Date.now() });
    timer.current = window.setTimeout(() => setMsg(null), ms);
  }, []);
  const node = msg ? (
    <div className="toast" key={msg.id} role="status">
      {msg.text}
    </div>
  ) : null;
  return { show, node };
}

const fmtOffset = (ms: number) => (ms === 0 ? "in sync" : `${ms > 0 ? "+" : "−"}${(Math.abs(ms) / 1000).toFixed(1)} s ${ms > 0 ? "earlier" : "later"}`);

// ---------- actions shared by hotkeys and toolbar ----------
export function useActions(np: NowPlaying | null, locked: boolean, toast: (t: string, ms?: number) => void, art: string | null = null) {
  const npRef = useRef(np);
  npRef.current = np;
  const artRef = useRef(art);
  artRef.current = art;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  return useRef({
    toggleWindow: async () => {
      if (await platform.isVisible()) await platform.hide();
      else {
        noteManualShow(); // don't let auto-hide take it away again right away
        await platform.show();
      }
    },
    lock: async () => {
      await platform.invoke("set_click_through", { locked: !lockedRef.current });
      toast(lockedRef.current ? "Unlocked" : "Locked — clicks pass through. Unlock from the tray or the hotkey.", 2600);
    },
    offset: async (delta: number) => {
      const cur = npRef.current;
      if (!cur) return toast("Nothing playing");
      const v = await adjustSongOffset(cur, delta);
      toast(`Lyrics ${fmtOffset(v)}`);
    },
    nextMode: () => {
      const i = DISPLAY_MODES.findIndex((m) => m.id === getSettings().layout.mode);
      const next = DISPLAY_MODES[(i + 1) % DISPLAY_MODES.length];
      void updateSettings("layout.mode", next.id);
      toast(next.label);
    },
    openSettings: (tab?: string) => void platform.invoke("open_settings_window", { tab: tab ?? null }),
    /** Upgrade 14: the current line + cover as an image — copied and saved to Pictures\MLP. */
    share: async () => {
      const cur = npRef.current;
      const line = currentLine();
      if (!cur || !line?.text) return toast("No lyric line to share right now");
      try {
        const m = displayMeta(cur);
        const blob = await renderShareCard({ line: line.text, sub: line.sub, title: m.title, artist: m.artist, art: artRef.current }, getComputedStyle(document.body).fontFamily);
        const copied = await navigator.clipboard
          .write([new ClipboardItem({ "image/png": blob })])
          .then(() => true)
          .catch(() => false);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let b64 = "";
        for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const path = await platform.invoke<string>("save_image", { name: `${m.artist} - ${m.title}`, pngBase64: btoa(b64) }).catch(() => null);
        toast([copied && "Copied", path && `saved to ${path}`].filter(Boolean).join(" and ") || "Couldn't save the image", 3500);
      } catch (e) {
        toast(String(e), 4000);
      }
    },
  }).current;
}

// ---------- global hotkeys ----------
export function useHotkeys(hotkeys: Settings["hotkeys"], actions: ReturnType<typeof useActions>, toast: (t: string, ms?: number) => void) {
  // Settings objects are rebuilt on every change from another window: key on the values, not identity.
  const sig = JSON.stringify(hotkeys);
  useEffect(() => {
    const keys = JSON.parse(sig) as Settings["hotkeys"];
    if (!isTauri()) return;
    let cancelled = false;
    const bindings: [string, () => unknown][] = [
      [keys.toggleWindow, actions.toggleWindow],
      [keys.lock, actions.lock],
      [keys.offsetEarlier, () => actions.offset(OFFSET_STEP)],
      [keys.offsetLater, () => actions.offset(-OFFSET_STEP)],
      [keys.nextMode, actions.nextMode],
      [keys.openSettings, () => actions.openSettings()],
    ];
    // Registration is serialized: effect cleanups (and React's dev double-mount) must not interleave.
    hotkeyChain = hotkeyChain.then(async () => {
      const gs = await import("@tauri-apps/plugin-global-shortcut");
      await gs.unregisterAll().catch((e) => platform.log(`hotkeys: unregisterAll failed: ${e}`));
      if (cancelled) return;
      const failed: string[] = [];
      for (const [accel, fn] of bindings) {
        if (!accel) continue;
        try {
          await gs.register(accel, (e) => {
            if (e.state !== "Pressed") return;
            platform.log(`hotkey ${accel}`);
            void fn();
          });
        } catch (e) {
          platform.log(`hotkeys: register ${accel} failed: ${e}`);
          failed.push(accel);
        }
      }
      platform.log(`hotkeys: registered ${bindings.length - failed.length}/${bindings.length}`);
      if (failed.length) toast(`Hotkey in use by another app: ${failed.join(", ")}`, 3500);
    });
    return () => {
      cancelled = true;
      hotkeyChain = hotkeyChain.then(() => import("@tauri-apps/plugin-global-shortcut").then((gs) => gs.unregisterAll()));
    };
  }, [sig, actions, toast]);
}

let hotkeyChain: Promise<unknown> = Promise.resolve();

// ---------- hover toolbar ----------
const I = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
    <path d={d} fill="currentColor" />
  </svg>
);
const ICON = {
  mode: "M4 5h16v4H4zm0 6h7v8H4zm9 0h7v8h-7z",
  minus: "M5 11h14v2H5z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  search: "M10 4a6 6 0 0 1 4.8 9.6l4.3 4.3-1.4 1.4-4.3-4.3A6 6 0 1 1 10 4zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  lock: "M7 10V8a5 5 0 0 1 10 0v2h1v10H6V10zm2 0h6V8a3 3 0 0 0-6 0z",
  share: "M18 16a3 3 0 0 0-2.4 1.2l-6.7-3.4a3 3 0 0 0 0-1.6l6.7-3.4A3 3 0 1 0 15 7l-6.7 3.4a3 3 0 1 0 0 3.2L15 17a3 3 0 1 0 3-1z",
  prev: "M6 5h2v14H6zM9.5 12 19 5v14z",
  next: "M16 5h2v14h-2zM14.5 12 5 19V5z",
  play: "M7 4.5v15L19.5 12z",
  pause: "M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z",
  gear: "M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM10.5 2h3l.5 2.6 1.9.8 2.2-1.5 2.1 2.1-1.5 2.2.8 1.9 2.5.4v3l-2.6.5-.8 1.9 1.5 2.2-2.1 2.1-2.2-1.5-1.9.8-.4 2.5h-3l-.5-2.6-1.9-.8-2.2 1.5-2.1-2.1 1.5-2.2-.8-1.9L2 13.5v-3l2.6-.5.8-1.9-1.5-2.2 2.1-2.1 2.2 1.5 1.9-.8z",
};

export function Toolbar({ np, actions, playback }: { np: NowPlaying | null; actions: ReturnType<typeof useActions>; playback: boolean }) {
  const offset = useSongOffset(np);
  const playing = np?.status === "playing";
  return (
    <div className="toolbar" data-no-drag role="toolbar" aria-label="Lyrics window tools">
      {np && playback && (
        <span className="toolbar-playback">
          <button title="Previous track" aria-label="Previous track" onClick={() => void mediaControl({ action: "prev" })}>
            <I d={ICON.prev} />
          </button>
          <button title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"} onClick={() => void mediaControl({ action: "toggle" })}>
            <I d={playing ? ICON.pause : ICON.play} />
          </button>
          <button title="Next track" aria-label="Next track" onClick={() => void mediaControl({ action: "next" })}>
            <I d={ICON.next} />
          </button>
        </span>
      )}
      <button title="Next display mode" aria-label="Next display mode" onClick={actions.nextMode}>
        <I d={ICON.mode} />
      </button>
      {np && (
        <>
          <button title="Show lyrics later (−0.1 s)" aria-label="Show lyrics later" onClick={() => void actions.offset(-OFFSET_STEP)}>
            <I d={ICON.minus} />
          </button>
          <span className="toolbar-offset" title="Timing offset for this song">
            {offset === 0 ? "0.0" : `${offset > 0 ? "+" : "−"}${(Math.abs(offset) / 1000).toFixed(1)}`}
          </span>
          <button title="Show lyrics earlier (+0.1 s)" aria-label="Show lyrics earlier" onClick={() => void actions.offset(OFFSET_STEP)}>
            <I d={ICON.plus} />
          </button>
          <button title="Wrong lyrics? Search" aria-label="Search lyrics for this song" onClick={() => actions.openSettings("song")}>
            <I d={ICON.search} />
          </button>
        </>
      )}
      {np && (
        <button title="Share this line as an image" aria-label="Share this line" onClick={() => void actions.share()}>
          <I d={ICON.share} />
        </button>
      )}
      <button title="Lock (click-through)" aria-label="Lock window" onClick={() => void actions.lock()}>
        <I d={ICON.lock} />
      </button>
      <button title="Settings" aria-label="Settings" onClick={() => actions.openSettings()}>
        <I d={ICON.gear} />
      </button>
    </div>
  );
}
