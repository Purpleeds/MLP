import { describe, expect, it } from "vitest";
import { pickSpot, spotBox } from "./toolbarSpot";

const win = { w: 450, h: 300 };
const bar = { w: 300, h: 32 };
const k = (x: number, y: number, w: number, h: number, weight = 1) => ({ box: { x, y, w, h }, weight });

describe("toolbar spot", () => {
  it("stays top right when nothing is there (lyrics only)", () => {
    expect(pickSpot(win, bar, [])).toBe("tr");
  });

  it("moves to the bottom when the header with title and buttons is at the top", () => {
    // art, title, artist, prev/pause/next, progress bar (lyrics-title with controls, as in the report)
    const header = [k(20, 20, 70, 70), k(105, 24, 200, 26), k(105, 52, 200, 20), k(320, 34, 110, 30), k(20, 104, 410, 6)];
    expect(pickSpot(win, bar, header)).toBe("br");
  });

  it("covers the least when every corner covers something", () => {
    const keep = [k(0, 0, 450, 60), k(0, 250, 450, 50, 0.3)];
    expect(pickSpot(win, bar, keep)).toBe("br");
  });

  it("puts the box inside the window at each corner", () => {
    expect(spotBox("tr", win, bar)).toEqual({ x: 140, y: 8, w: 300, h: 32 });
    expect(spotBox("bl", win, bar)).toEqual({ x: 10, y: 260, w: 300, h: 32 });
  });
});
