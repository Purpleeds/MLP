import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, setPath } from "./schema";

describe("mergeSettings", () => {
  it("returns defaults for garbage input", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("x")).toEqual(DEFAULT_SETTINGS);
  });
  it("keeps valid stored values, fills missing, drops wrong types and unknown keys", () => {
    const m = mergeSettings({ window: { cornerRadius: 4, opacity: "bad" }, junk: 1 });
    expect(m.window.cornerRadius).toBe(4);
    expect(m.window.opacity).toBe(1);
    expect(m.appearance).toEqual(DEFAULT_SETTINGS.appearance);
    expect("junk" in m).toBe(false);
  });
});

describe("setPath", () => {
  it("updates immutably", () => {
    const next = setPath(DEFAULT_SETTINGS, "window.cornerRadius", 9);
    expect(next.window.cornerRadius).toBe(9);
    expect(DEFAULT_SETTINGS.window.cornerRadius).toBe(18);
    expect(next.appearance).toBe(DEFAULT_SETTINGS.appearance);
  });
});
