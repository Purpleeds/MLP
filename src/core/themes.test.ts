import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings/schema";
import { applyTheme, captureTheme, decodeTheme, encodeTheme } from "./themes";
import { accentFrom, hex } from "../render/palette";

describe("themes", () => {
  it("round-trips through a share code and only touches the look", () => {
    const s = { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, activeColor: "#ffcc00", fontSize: 34 }, background: { ...DEFAULT_SETTINGS.background, type: "solid" as const } };
    const code = encodeTheme("Gold", captureTheme(s));
    expect(code.startsWith("mlp-theme:")).toBe(true);
    expect(code.length).toBeLessThan(200); // only the differences
    const back = decodeTheme(code)!;
    expect(back.name).toBe("Gold");
    const applied = applyTheme({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, listen: true } }, back.data);
    expect(applied.appearance.activeColor).toBe("#ffcc00");
    expect(applied.appearance.fontSize).toBe(34);
    expect(applied.background.type).toBe("solid");
    expect(applied.appearance.preset).toBe("custom");
    expect(applied.ai.listen).toBe(true); // behaviour untouched
  });
  it("rejects junk and wrongly typed values", () => {
    expect(decodeTheme("hello")).toBeNull();
    expect(decodeTheme("mlp-theme:%%%")).toBeNull();
    const evil = "mlp-theme:" + btoa(JSON.stringify({ n: "x", a: { fontSize: "huge", activeColor: "#123456" }, l: { clickToSeek: false } }));
    const t = decodeTheme(evil)!;
    expect(t.data.appearance.fontSize).toBe(DEFAULT_SETTINGS.appearance.fontSize);
    expect(t.data.appearance.activeColor).toBe("#123456");
    expect("clickToSeek" in t.data.lyrics).toBe(false);
  });
  it("picks a light, colourful accent from the cover", () => {
    const [r, g] = accentFrom([[20, 20, 20], [200, 30, 40], [240, 240, 240]]);
    expect(r).toBeGreaterThan(220); // light…
    expect(r - g).toBeGreaterThan(60); // …and red
    expect(hex([255, 0, 16])).toBe("#ff0010");
    expect(accentFrom([[128, 128, 128], [30, 30, 30]])).toEqual([255, 255, 255]); // grey cover → white
  });
});
