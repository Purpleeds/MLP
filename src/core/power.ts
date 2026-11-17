// Upgrade 18: battery saver — on battery the lyrics animate at ≤ 30 fps and the fluid background at
// ≤ 12 fps; while the window is completely covered by another window, both nearly stop.
import { useEffect, useSyncExternalStore } from "react";
import { isTauri, platform } from "./platform";
import { getSettings } from "./settings/store";

export interface PowerState {
  onBattery: boolean;
  covered: boolean;
}

let state: PowerState = { onBattery: false, covered: false };
const listeners = new Set<() => void>();
const set = (p: Partial<PowerState>) => {
  const next = { ...state, ...p };
  if (next.onBattery === state.onBattery && next.covered === state.covered) return;
  state = next;
  listeners.forEach((l) => l());
};

/** Frame-rate caps for the current power state (null = no cap). */
export function fpsCaps(p: PowerState, saver: boolean): { lyrics: number | null; background: number | null } {
  if (!saver) return { lyrics: null, background: null };
  if (p.covered) return { lyrics: 2, background: 1 };
  if (p.onBattery) return { lyrics: 30, background: 12 };
  return { lyrics: null, background: null };
}

interface BatteryManager extends EventTarget {
  charging: boolean;
}

let started = false;
function start() {
  if (started) return;
  started = true;
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
  void nav.getBattery?.().then((b) => {
    const update = () => set({ onBattery: !b.charging });
    update();
    b.addEventListener("chargingchange", update);
  });
  if (isTauri()) {
    // Fully covered by another window (Rust checks the windows above ours) — every 2 s, cheap.
    setInterval(() => {
      if (!getSettings().app.batterySaver) return set({ covered: false });
      void platform
        .invoke<boolean>("window_covered")
        .then((c) => set({ covered: !!c }))
        .catch(() => undefined);
    }, 2000);
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function usePower(): PowerState {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => state);
}
