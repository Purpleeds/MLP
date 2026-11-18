// @vitest-environment happy-dom
// A crash inside Settings must leave a notice behind (not an empty, black window) and recover.
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";
import { describeError, formatUiError, pushUiError } from "../core/uiErrors";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.restoreAllMocks();
});

let broken = true;
function Flaky() {
  if (broken) throw new Error("boom");
  return h("p", null, "panel ok");
}

describe("ErrorBoundary", () => {
  it("keeps the rest of the page when one panel throws, and retries", () => {
    broken = true;
    act(() => root.render(h("div", null, h("p", null, "other row"), h(ErrorBoundary, { where: "test/panel", variant: "panel" }, h(Flaky)))));
    expect(el.textContent).toContain("other row");
    expect(el.textContent).toContain("This part of Settings hit a problem.");
    expect(el.querySelector("pre")?.textContent).toBe("Error: boom");

    broken = false;
    const retry = [...el.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    act(() => retry.click());
    expect(el.textContent).toContain("panel ok");
    expect(el.textContent).not.toContain("hit a problem");
  });

  it("clears the error when the reset key changes (another section picked)", () => {
    broken = true;
    let pick: (s: string) => void = () => undefined;
    function Page() {
      const [section, setSection] = useState("ai");
      pick = setSection;
      return h(ErrorBoundary, { where: "test/page", variant: "page", resetKey: section }, section === "ai" ? h(Flaky) : h("p", null, `section ${section}`));
    }
    act(() => root.render(h(Page)));
    expect(el.textContent).toContain("This page of Settings hit a problem.");
    act(() => pick("look"));
    expect(el.textContent).toBe("section look");
  });

  it("offers a reload when the whole window breaks", () => {
    broken = true;
    act(() => root.render(h(ErrorBoundary, { where: "test/window", variant: "window" }, h(Flaky))));
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toContain("Reload Settings");
  });
});

describe("UI error log", () => {
  const e = (where: string, message: string, at = 1) => ({ at, where, message });

  it("puts the newest first, merges repeats and keeps a few", () => {
    let list = pushUiError([], e("a", "x", 1));
    list = pushUiError(list, e("a", "x", 2));
    expect(list).toEqual([{ at: 2, where: "a", message: "x", count: 2 }]);
    list = pushUiError(list, e("b", "y", 3));
    expect(list.map((x) => x.where)).toEqual(["b", "a"]);
    for (let i = 0; i < 30; i++) list = pushUiError(list, e(`w${i}`, "z"), 5);
    expect(list).toHaveLength(5);
    expect(list[0].where).toBe("w29");
  });

  it("describes anything thrown", () => {
    expect(describeError(new TypeError("bad")).message).toBe("TypeError: bad");
    expect(describeError("text")).toEqual({ message: "text" });
    expect(describeError({ code: 1 }).message).toBe('{"code":1}');
    expect(describeError(undefined).message).toBe("undefined");
    expect(formatUiError({ where: "settings/page:ai", message: "Error: boom" })).toBe("MLP settings/page:ai\nError: boom");
  });
});
