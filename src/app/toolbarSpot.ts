// Where the hover toolbar goes: the first window corner where it covers none of the song info,
// buttons or progress bar (top right, bottom right, top left, bottom left), else the corner where
// it covers the least. Lyrics may be covered: the toolbar only shows while the mouse is over the window.

export type Spot = "tr" | "br" | "tl" | "bl";
export const SPOTS: Spot[] = ["tr", "br", "tl", "bl"];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Elements the toolbar should not cover, and how much covering each one matters. */
export const KEEP_CLEAR: [selector: string, weight: number][] = [
  [".controls", 1],
  [".info-title", 1],
  [".info-sub", 1],
  [".art", 0.5],
  [".progress", 1],
  [".ai-indicator", 0.3],
];

/** Gap between the toolbar and the window edges (matches styles.css `.toolbar`). */
export const GAP = { x: 10, y: 8 };

export function spotBox(spot: Spot, win: { w: number; h: number }, bar: { w: number; h: number }): Box {
  return {
    x: spot.endsWith("r") ? win.w - GAP.x - bar.w : GAP.x,
    y: spot.startsWith("t") ? GAP.y : win.h - GAP.y - bar.h,
    w: bar.w,
    h: bar.h,
  };
}

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

export function pickSpot(win: { w: number; h: number }, bar: { w: number; h: number }, keep: { box: Box; weight: number }[]): Spot {
  let best: Spot = "tr";
  let bestCost = Infinity;
  for (const spot of SPOTS) {
    const at = spotBox(spot, win, bar);
    const cost = keep.reduce((sum, k) => sum + overlap(at, k.box) * k.weight, 0);
    if (cost === 0) return spot;
    if (cost < bestCost) {
      best = spot;
      bestCost = cost;
    }
  }
  return best;
}

/** Measure the window's elements and pick the toolbar corner. */
export function measureSpot(card: HTMLElement, bar: HTMLElement): Spot {
  const c = card.getBoundingClientRect();
  const keep: { box: Box; weight: number }[] = [];
  for (const [sel, weight] of KEEP_CLEAR) {
    card.querySelectorAll(sel).forEach((el) => {
      if (bar.contains(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) keep.push({ box: { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height }, weight });
    });
  }
  return pickSpot({ w: c.width, h: c.height }, { w: bar.offsetWidth, h: bar.offsetHeight }, keep);
}
