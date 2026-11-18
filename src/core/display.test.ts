import { describe, expect, it } from "vitest";
import { displayMeta, elementsFor, fmtTime, MODE_ELEMENTS, toolbarControls } from "./display";
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
  it("playback controls: in the window, on hover, or hidden", () => {
    const at = (mode: string, controls: string) => setPath(setPath(DEFAULT_SETTINGS, "layout.mode", mode), "layout.controls", controls);
    // Default (hover): the lyrics + title mode keeps its layout, the buttons sit in the hover toolbar.
    expect(elementsFor(at("lyrics-title", "hover")).controls).toBe(false);
    expect(toolbarControls(at("lyrics-title", "hover"))).toBe(true);
    // Full mode already shows them in the window → not twice.
    expect(toolbarControls(at("full", "hover"))).toBe(false);
    // Always: in the window where there's room, the toolbar where there isn't.
    expect(elementsFor(at("lyrics-title", "always")).controls).toBe(true);
    expect(toolbarControls(at("lyrics-title", "always"))).toBe(false);
    expect(elementsFor(at("mini", "always")).controls).toBe(false);
    expect(toolbarControls(at("mini", "always"))).toBe(true);
    // Never: gone everywhere, even in modes that normally show them.
    expect(elementsFor(at("full", "never")).controls).toBe(false);
    expect(toolbarControls(at("full", "never"))).toBe(false);
    expect(toolbarControls(at("mini", "never"))).toBe(false);
  });
  it("formats times", () => expect(fmtTime(65_400)).toBe("1:05"));
});
