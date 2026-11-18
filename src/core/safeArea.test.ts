import { describe, expect, it } from "vitest";
import { clampInto, safeArea, type Taskbars } from "./safeArea";

const mon = { x: 0, y: 0, w: 2560, h: 1440 };
const below = { x: 0, y: 1440, w: 2560, h: 1440 };
const full = { ...mon };

describe("safe area", () => {
  it("keeps the work area of a normal taskbar", () => {
    const work = { x: 0, y: 0, w: 2560, h: 1392 };
    const tb: Taskbars = { autoHide: false, bars: [{ x: 0, y: 1392, w: 2560, h: 48, edge: "bottom" }] };
    expect(safeArea(work, mon, [mon], tb, 72)).toEqual(work);
  });

  it("keeps clear of an auto-hidden taskbar, shown or hidden", () => {
    const shown: Taskbars = { autoHide: true, bars: [{ x: 0, y: 1392, w: 2560, h: 48, edge: "bottom" }] };
    expect(safeArea(full, mon, [mon], shown, 72)).toEqual({ x: 0, y: 0, w: 2560, h: 1440 - 72 });
    // hidden: moved down so 2 px show; a monitor below doesn't claim it
    const hidden: Taskbars = { autoHide: true, bars: [{ x: 0, y: 1438, w: 2560, h: 72, edge: "bottom" }] };
    expect(safeArea(full, mon, [mon, below], hidden, 48).h).toBe(1440 - 72);
    expect(safeArea(below, below, [mon, below], hidden, 48)).toEqual(below);
  });

  it("finds the edge of another monitor's taskbar", () => {
    const right = { x: 2560, y: 0, w: 1920, h: 1080 };
    const tb: Taskbars = { autoHide: true, bars: [{ x: 2560, y: 0, w: 1920, h: 2, edge: null }] }; // shrunk to 2 px at the top
    expect(safeArea(right, right, [mon, right], tb, 72)).toEqual({ x: 2560, y: 72, w: 1920, h: 1008 });
    expect(safeArea(full, mon, [mon, right], tb, 72)).toEqual(full);
  });

  it("moves a window the least to fit", () => {
    const area = { x: 0, y: 0, w: 2560, h: 1368 };
    expect(clampInto({ x: 2000, y: 1100, w: 500, h: 320 }, area)).toEqual({ x: 2000, y: 1048, w: 500, h: 320 });
    expect(clampInto({ x: 10, y: 10, w: 500, h: 320 }, area)).toBeNull();
  });
});
