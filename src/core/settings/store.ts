// Settings persistence: Tauri plugin-store (shared by all windows) or localStorage in mock mode.
import { useEffect, useSyncExternalStore } from "react";
import { isTauri } from "../platform";
import { DEFAULT_SETTINGS, mergeSettings, setPath, type Settings } from "./schema";
import { withLightMode } from "./light";
import { applyPreset, PRESETS, type PresetName } from "../../render/presets";

const FILE = "settings.json";
const KEY = "settings";
const LS_KEY = "mlp.settings";

let current: Settings = DEFAULT_SETTINGS;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

type TauriStore = Awaited<ReturnType<typeof import("@tauri-apps/plugin-store").load>>;
let store: TauriStore | null = null;
let ready: Promise<void> | null = null;

export function initSettings(): Promise<void> {
  ready ??= (async () => {
    if (isTauri()) {
      const { load } = await import("@tauri-apps/plugin-store");
      store = await load(FILE, { defaults: {}, autoSave: 200 });
      current = mergeSettings(await store.get(KEY));
      // Changes made by another window (e.g. the settings window) arrive here.
      await store.onKeyChange<Settings>(KEY, (v) => {
        current = mergeSettings(v);
        notify();
      });
    } else {
      try {
        current = mergeSettings(JSON.parse(localStorage.getItem(LS_KEY) ?? "null"));
      } catch {
        current = DEFAULT_SETTINGS;
      }
      // Dev aid: ?preset=ytmusic previews a preset in mock mode (not saved).
      const preset = new URLSearchParams(location.search).get("preset") as PresetName | null;
      if (preset && preset in PRESETS) current = applyPreset(current, preset);
      // Dev aid: ?mode=full previews a display mode in mock mode.
      const mode = new URLSearchParams(location.search).get("mode");
      if (mode && mode in current.layout.sizes) current = setPath(current, "layout.mode", mode);
      window.addEventListener("storage", (e) => {
        if (e.key !== LS_KEY) return;
        try {
          current = mergeSettings(JSON.parse(e.newValue ?? "null"));
          notify();
        } catch {
          /* ignore malformed */
        }
      });
    }
    notify();
  })();
  return ready;
}

export const getSettings = () => current;

export async function updateSettings(path: string, value: unknown): Promise<void> {
  // Light mode switches a group of settings together (see light.ts).
  current = path === "app.lightMode" ? withLightMode(current, value === true) : setPath(current, path, value);
  notify();
  if (store) await store.set(KEY, current);
  else {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(current));
    } catch {
      /* storage unavailable */
    }
  }
}

/** Replace all settings at once (presets, import). */
export async function replaceSettings(next: unknown): Promise<void> {
  current = mergeSettings(next);
  notify();
  if (store) await store.set(KEY, current);
  else {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(current));
    } catch {
      /* storage unavailable */
    }
  }
}

export async function resetSettings(): Promise<void> {
  current = DEFAULT_SETTINGS;
  notify();
  if (store) await store.set(KEY, current);
  else localStorage.removeItem(LS_KEY);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** React hook: live settings, re-renders on any change (any window). */
export function useSettings(): Settings {
  useEffect(() => {
    void initSettings();
  }, []);
  return useSyncExternalStore(subscribe, getSettings);
}
