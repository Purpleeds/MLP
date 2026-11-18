// @vitest-environment happy-dom
// useTicker re-renders on a timer. A slow render (busy PC, long lyrics in the sync editor) must not
// turn into a chain of forced re-renders: React gives up after 50 and unmounts the whole window.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useTicker } from "./nowPlaying";

// Real timers and real scheduling: act() would batch the ticks into one render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* simulate a slow render */
  }
};

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  root?.unmount();
  root = null;
});

describe("useTicker", () => {
  it("survives renders slower than its interval", async () => {
    const errors: unknown[] = [];
    let renders = 0;
    function Slow() {
      useTicker(5);
      renders++;
      busy(8);
      return null;
    }
    const el = document.createElement("div");
    root = createRoot(el, { onUncaughtError: (e) => errors.push(e) });
    root.render(createElement(Slow));
    await new Promise((r) => setTimeout(r, 300));
    expect(errors).toEqual([]);
    expect(renders).toBeGreaterThan(3);
  });
});
