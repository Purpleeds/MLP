import { describe, expect, it } from "vitest";
import { accelFromEvent, formatColor, parseColor } from "./controls";

const ev = (o: Partial<{ key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) => ({
  key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o,
});

describe("hotkey capture", () => {
  it("builds Tauri accelerators", () => {
    expect(accelFromEvent(ev({ key: "l", code: "KeyL", ctrlKey: true, altKey: true }))).toBe("CommandOrControl+Alt+L");
    expect(accelFromEvent(ev({ key: "ArrowUp", code: "ArrowUp", ctrlKey: true }))).toBe("CommandOrControl+Up");
    expect(accelFromEvent(ev({ key: "!", code: "Digit1", shiftKey: true, altKey: true }))).toBe("Alt+Shift+1");
    expect(accelFromEvent(ev({ key: "F9", code: "F9" }))).toBe("F9");
  });
  it("ignores modifier-only and unmodified keys", () => {
    expect(accelFromEvent(ev({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeNull();
    expect(accelFromEvent(ev({ key: "a", code: "KeyA" }))).toBeNull();
  });
});

describe("colors", () => {
  it("round-trips hex and rgba", () => {
    expect(parseColor("rgba(255,255,255,0.32)")).toEqual({ hex: "#ffffff", a: 0.32 });
    expect(parseColor("#abc")).toEqual({ hex: "#aabbcc", a: 1 });
    expect(formatColor("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)");
    expect(formatColor("#ff0000", 1)).toBe("#ff0000");
  });
});
