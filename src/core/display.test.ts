import { describe, expect, it } from "vitest";
import { displayMeta, elementsFor, fmtTime, MODE_ELEMENTS } from "./display";
import { DEFAULT_SETTINGS, setPath } from "./settings/schema";

describe("display", () => {
  it("cleans YouTube metadata but leaves Spotify untouched", () => {
    expect(displayMeta({ title: "Rick Astley - Together Forever (Official HD Video)", artist: "Rick Astley", album: "", sourceKind: "browser" }))
      .toMatchObject({ title: "Together Forever", artist: "Rick Astley" });
    expect(displayMeta({ title: "Song (Live)", artist: "A", album: "B", sourceKind: "spotify" }).title).toBe("Song (Live)");
  });
  it("custom mode uses its own element toggles", () => {
    expect(elementsFor(DEFAULT_SETTINGS)).toEqual(MODE_ELEMENTS["lyrics-title"]);
    const custom = setPath(DEFAULT_SETTINGS, "layout.mode", "custom");
    expect(elementsFor(custom)).toBe(custom.layout.elements);
    expect(MODE_ELEMENTS.card.lyrics).toBe(false);
  });
  it("formats times", () => expect(fmtTime(65_400)).toBe("1:05"));
});
