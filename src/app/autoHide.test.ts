import { describe, expect, it } from "vitest";
import { isIdle } from "./autoHide";
import { DEFAULT_SETTINGS, mergeSettings } from "../core/settings/schema";

describe("auto-hide", () => {
  it("treats no player as idle, and paused only when asked", () => {
    expect(isIdle(null, false)).toBe(true);
    expect(isIdle({ status: "paused" }, true)).toBe(true);
    expect(isIdle({ status: "paused" }, false)).toBe(false);
    expect(isIdle({ status: "playing" }, true)).toBe(false);
    expect(isIdle({ status: "changing" }, true)).toBe(false); // track switch: don't flicker
  });
  it("migrates the old 'Hide the window' choice", () => {
    const s = mergeSettings({ layout: { idle: "hide" } });
    expect(s.layout).toMatchObject({ idle: "card", autoHide: true, autoHideWhenPaused: false });
    expect(DEFAULT_SETTINGS.layout.autoHide).toBe(false);
  });
});
