import { describe, expect, it } from "vitest";
import { fromRelative, monitorKey, snapRect, toRelative } from "./placement";

const area = { x: 0, y: 0, w: 2560, h: 1392 };

describe("window placement", () => {
  it("snaps edges close to the screen edge", () => {
    expect(snapRect({ x: 10, y: 500, w: 400, h: 500 }, area, 18, 8)).toEqual({ x: 8, y: 500, w: 400, h: 500 });
    expect(snapRect({ x: 2150, y: 880, w: 400, h: 500 }, area, 18, 8)).toEqual({ x: 2152, y: 884, w: 400, h: 500 });
    expect(snapRect({ x: 600, y: 500, w: 400, h: 500 }, area, 18, 8)).toBeNull();
  });
  it("remembers positions relative to the monitor", () => {
    const r = toRelative({ x: 2152, y: 884, w: 400, h: 500 }, area);
    expect(r.fx).toBeCloseTo(1, 2);
    // Same corner on a smaller second monitor to the left.
    const small = { x: -1920, y: 0, w: 1920, h: 1040 };
    const p = fromRelative(r, 400, 500, small);
    expect(p.x).toBeGreaterThan(-420 - 10);
    expect(p.y).toBeGreaterThan(500);
    expect(monitorKey({ name: "\\\\.\\DISPLAY2", position: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 } })).toBe("\\\\.\\DISPLAY2@-1920,0:1920x1080");
  });
});
