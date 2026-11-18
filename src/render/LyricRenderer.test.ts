// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTimeline } from "../core/timing/timeline";
import type { Lyrics } from "../core/lyrics/model";
import { LyricRenderer, type RendererOptions } from "./LyricRenderer";

// happy-dom has no layout: give the root a size and every line a height.
const ROOT_H = 400;
const LINE_H = 40;

const opts: RendererOptions = {
  anchor: 0.35,
  lineGap: 0.5,
  blur: true,
  blurStep: 1.2,
  blurMax: 6,
  inactiveScale: 0.92,
  spring: true,
  springStiffness: 120,
  springDamping: 20,
  stagger: 45,
  lift: 0,
  emphasis: false,
  glowColor: "#fff",
  interludeDots: false,
  edgeFade: false,
  align: "left",
  reducedMotion: false,
  fps: 30, // below 60: the frame cap must not delay the first layout
};

const lyrics: Lyrics = {
  kind: "line",
  source: "lrclib",
  id: 1,
  trackName: "T",
  artistName: "A",
  durationMs: 60_000,
  lines: Array.from({ length: 8 }, (_, i) => ({ start: 1000 + i * 3000, end: 3800 + i * 3000, text: `line number ${i}`, words: null })),
};

let frames: FrameRequestCallback[] = [];
let now = 1000;
const runFrame = () => {
  const fs = frames;
  frames = [];
  now += 16;
  for (const f of fs) f(now);
};

const ys = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(".lr-item")].map((el) => Number(/translate3d\(0,(-?[\d.]+)px/.exec(el.style.transform)?.[1] ?? NaN));

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (frames.push(f), frames.length));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => ROOT_H });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => LINE_H });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.textContent = "";
});

function setup(t: number) {
  const root = document.createElement("div");
  root.style.fontSize = "20px";
  document.body.appendChild(root);
  const r = new LyricRenderer(root, () => t, opts);
  r.setTimeline(buildTimeline(lyrics));
  return { root, r };
}

describe("LyricRenderer first layout", () => {
  it("hides the lines until they are laid out", () => {
    const { root } = setup(0);
    expect(root.querySelector(".lr-list")!.classList.contains("unplaced")).toBe(true);
    runFrame();
    expect(root.querySelector(".lr-list")!.classList.contains("unplaced")).toBe(false);
  });

  it("puts every line at its own place on the first frame (no fly-in from one spot)", () => {
    for (const t of [0, 1000, 10_500]) {
      const { root, r } = setup(t);
      runFrame();
      const first = ys(root);
      expect(new Set(first).size).toBe(first.length); // all distinct
      const steps = first.slice(1).map((y, i) => y - first[i]);
      for (const s of steps) expect(s).toBeCloseTo(LINE_H + 0.5 * 20, 1);
      // Nothing left to move: later frames keep the same positions.
      for (let i = 0; i < 5; i++) runFrame();
      expect(ys(root)).toEqual(first);
      r.destroy();
      document.body.textContent = "";
    }
  });

  it("lays rebuilt lyrics out in place too (romanization / translations arriving)", () => {
    const { root, r } = setup(4500);
    runFrame();
    const before = ys(root);
    r.setTimeline(buildTimeline({ ...lyrics, lines: lyrics.lines.map((l) => ({ ...l, text: l.text.toUpperCase() })) }));
    runFrame();
    expect(ys(root)).toEqual(before);
  });
});
