// Upgrade 15: snap the window to screen edges after a move, and remember where it sits on each
// monitor — when a monitor comes back (docking a laptop, turning a screen on) the window returns to it.
// Pure geometry (tested) + `useWindowPlacement` for the main window.
import { useEffect } from "react";
import { isTauri } from "./platform";
import { createKv } from "./storage/kv";
import { getSettings } from "./settings/store";
import { clampInto, safeAreaOf } from "./safeArea";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Snap edges that are within `dist` of the work area's edges to `margin` from them; null = nothing to do. */
export function snapRect(win: Rect, area: Rect, dist: number, margin: number): Rect | null {
  let { x, y } = win;
  const right = area.x + area.w;
  const bottom = area.y + area.h;
  if (Math.abs(win.x - area.x) <= dist) x = area.x + margin;
  else if (Math.abs(win.x + win.w - right) <= dist) x = right - margin - win.w;
  if (Math.abs(win.y - area.y) <= dist) y = area.y + margin;
  else if (Math.abs(win.y + win.h - bottom) <= dist) y = bottom - margin - win.h;
  return x !== win.x || y !== win.y ? { ...win, x, y } : null;
}

/** Position as fractions of the free room on the monitor (survives resolution / scaling changes). */
export interface RelPos {
  fx: number;
  fy: number;
}
export function toRelative(win: Rect, area: Rect): RelPos {
  const fx = area.w > win.w ? (win.x - area.x) / (area.w - win.w) : 0;
  const fy = area.h > win.h ? (win.y - area.y) / (area.h - win.h) : 0;
  return { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
}
export function fromRelative(r: RelPos, w: number, h: number, area: Rect): { x: number; y: number } {
  return { x: Math.round(area.x + r.fx * Math.max(0, area.w - w)), y: Math.round(area.y + r.fy * Math.max(0, area.h - h)) };
}

interface Mon {
  name: string | null;
  scaleFactor: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea: { position: { x: number; y: number }; size: { width: number; height: number } };
}
export const monitorKey = (m: Pick<Mon, "name" | "position" | "size">) => `${m.name ?? "?"}@${m.position.x},${m.position.y}:${m.size.width}x${m.size.height}`;
const areaOf = (m: Mon): Rect => ({ x: m.workArea.position.x, y: m.workArea.position.y, w: m.workArea.size.width, h: m.workArea.size.height });

interface Places {
  preferred: string | null;
  at: Record<string, RelPos>;
}
const store = createKv<Places>("window-places.json");

/** Main window: snap after moves; return to the preferred monitor when it reappears. */
export function useWindowPlacement() {
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let timer = 0;
    let programmatic = 0;
    let lastSet = "";
    const offs: Promise<() => void>[] = [];
    void (async () => {
      const { getCurrentWindow, currentMonitor, availableMonitors, PhysicalPosition } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      const rectNow = async (): Promise<Rect> => {
        const p = await w.outerPosition();
        const s = await w.outerSize();
        return { x: p.x, y: p.y, w: s.width, h: s.height };
      };
      const settle = async () => {
        if (!alive || performance.now() < programmatic) return;
        const mon = (await currentMonitor()) as Mon | null;
        if (!mon) return;
        let r = await rectNow();
        // The bar docks itself (on or above the taskbar); everything else stays off the taskbar.
        const docked = getSettings().layout.mode === "bar";
        const area = docked ? areaOf(mon) : await safeAreaOf(mon);
        const scale = mon.scaleFactor ?? 1;
        const moved = (getSettings().window.snapEdges && snapRect(r, area, Math.round(18 * scale), Math.round(8 * scale))) || r;
        const fixed = docked ? (moved !== r ? moved : null) : (clampInto(moved, area) ?? (moved !== r ? moved : null));
        if (fixed) {
          programmatic = performance.now() + 600;
          await w.setPosition(new PhysicalPosition(fixed.x, fixed.y));
          r = fixed;
        }
        if (getSettings().window.perMonitor) {
          const key = monitorKey(mon);
          const places = (await store.get("main")) ?? { preferred: null, at: {} };
          await store.set("main", { preferred: key, at: { ...places.at, [key]: toRelative(r, area) } });
        }
      };
      const later = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => void settle(), 350);
      };
      offs.push(w.onMoved(later), w.onResized(later));
      // Start-up: a window saved over the taskbar (e.g. an auto-hidden one) moves off it.
      window.setTimeout(() => void settle(), 1500);
      // Monitors coming and going: put the window back where the user last had it.
      const check = async () => {
        if (!alive || !getSettings().window.perMonitor) return;
        const mons = ((await availableMonitors()) as Mon[]) ?? [];
        const set = mons.map(monitorKey).sort().join("|");
        if (set === lastSet) return;
        const first = lastSet === "";
        lastSet = set;
        if (first) return; // startup: the window-state plugin already restored the position
        const places = await store.get("main");
        const target = places?.preferred ? mons.find((m) => monitorKey(m) === places.preferred) : undefined;
        const cur = (await currentMonitor()) as Mon | null;
        if (!target || !places || (cur && monitorKey(cur) === places.preferred)) return;
        const r = await rectNow();
        const pos = fromRelative(places.at[places.preferred!] ?? { fx: 1, fy: 1 }, r.w, r.h, await safeAreaOf(target));
        programmatic = performance.now() + 800;
        await w.setPosition(new PhysicalPosition(pos.x, pos.y));
      };
      void check();
      const iv = window.setInterval(() => void check(), 4000);
      offs.push(Promise.resolve(() => clearInterval(iv)));
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
      offs.forEach((p) => void p.then((f) => f()));
    };
  }, []);
}
