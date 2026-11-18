// Where the main window may sit on a monitor: its work area, minus any taskbar on it. An
// auto-hidden taskbar isn't taken out of the work area by Windows, but it pops up over a window at
// that edge (and a click on our always-on-top window then puts us over it). Pure geometry + loader.
import { platform } from "./platform";
import type { Rect } from "./placement";

export interface TaskbarRect {
  x: number;
  y: number;
  w: number;
  h: number;
  edge: "top" | "bottom" | "left" | "right" | null;
}
export interface Taskbars {
  autoHide: boolean;
  bars: TaskbarRect[];
}

type Edge = NonNullable<TaskbarRect["edge"]>;

/**
 * Which monitor edge a taskbar sits on: the monitor edge that runs through the taskbar (a hidden
 * one sits almost off its monitor, so this still finds it), with the edge Windows reports first,
 * then bottom / top / right / left. Null = no monitor (a stale rect).
 */
export function attach(bar: TaskbarRect, monitors: Rect[]): { mon: number; edge: Edge } | null {
  const across = (lo: number, hi: number, at: number) => at >= lo - 4 && at <= hi + 4;
  const horizontal = bar.w >= bar.h;
  const order: Edge[] = bar.edge ? [bar.edge] : horizontal ? ["bottom", "top"] : ["right", "left"];
  for (const edge of order) {
    const mon = monitors.findIndex((m) => {
      const spans = horizontal ? Math.min(bar.x + bar.w, m.x + m.w) - Math.max(bar.x, m.x) > bar.w / 2 : Math.min(bar.y + bar.h, m.y + m.h) - Math.max(bar.y, m.y) > bar.h / 2;
      if (!spans) return false;
      if (edge === "bottom") return across(bar.y, bar.y + bar.h, m.y + m.h);
      if (edge === "top") return across(bar.y, bar.y + bar.h, m.y);
      if (edge === "right") return across(bar.x, bar.x + bar.w, m.x + m.w);
      return across(bar.x, bar.x + bar.w, m.x);
    });
    if (mon >= 0) return { mon, edge };
  }
  return null;
}

/**
 * The work area of a monitor minus the taskbars on it. `minThick` = the least room kept for an
 * auto-hidden taskbar (in case Windows reports it shrunk while hidden).
 */
export function safeArea(work: Rect, mon: Rect, monitors: Rect[], tb: Taskbars, minThick: number): Rect {
  const self = monitors.findIndex((m) => m.x === mon.x && m.y === mon.y && m.w === mon.w && m.h === mon.h);
  let left = work.x;
  let top = work.y;
  let right = work.x + work.w;
  let bottom = work.y + work.h;
  for (const bar of tb.bars) {
    const at = attach(bar, monitors);
    if (!at || at.mon !== self) continue;
    const { edge } = at;
    const across = edge === "top" || edge === "bottom" ? bar.h : bar.w;
    const along = edge === "top" || edge === "bottom" ? mon.h : mon.w;
    const thick = Math.min(Math.round(along / 3), tb.autoHide ? Math.max(across, minThick) : across);
    if (edge === "bottom") bottom = Math.min(bottom, mon.y + mon.h - thick);
    else if (edge === "top") top = Math.max(top, mon.y + thick);
    else if (edge === "left") left = Math.max(left, mon.x + thick);
    else right = Math.min(right, mon.x + mon.w - thick);
  }
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

/** Move `win` the least so it sits inside `area` (a window larger than the area keeps its top-left in). */
export function clampInto(win: Rect, area: Rect): Rect | null {
  const x = Math.max(area.x, Math.min(win.x, area.x + area.w - win.w));
  const y = Math.max(area.y, Math.min(win.y, area.y + area.h - win.h));
  return x !== win.x || y !== win.y ? { ...win, x, y } : null;
}

interface Mon {
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea: { position: { x: number; y: number }; size: { width: number; height: number } };
  scaleFactor: number;
}
const monRect = (m: Mon): Rect => ({ x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height });

/** Safe area (physical px) of a Tauri monitor; falls back to its work area. */
export async function safeAreaOf(mon: Mon): Promise<Rect> {
  const work = { x: mon.workArea.position.x, y: mon.workArea.position.y, w: mon.workArea.size.width, h: mon.workArea.size.height };
  try {
    const tb = await platform.invoke<Taskbars>("taskbars");
    if (!tb?.bars.length) return work;
    const { availableMonitors } = await import("@tauri-apps/api/window");
    const all = ((await availableMonitors()) as unknown as Mon[]).map(monRect);
    return safeArea(work, monRect(mon), all, tb, Math.round(48 * mon.scaleFactor));
  } catch {
    return work;
  }
}
