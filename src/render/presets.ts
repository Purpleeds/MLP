// Style presets: each sets a coherent group of appearance / lyrics / background values.
import type { Settings } from "../core/settings/schema";
import { DEFAULT_SETTINGS } from "../core/settings/schema";

export type PresetName = Exclude<Settings["appearance"]["preset"], "custom">;

type PresetValues = {
  appearance: Partial<Settings["appearance"]>;
  lyrics: Partial<Settings["lyrics"]>;
  background: Partial<Settings["background"]>;
};

export const PRESETS: Record<PresetName, PresetValues> = {
  // Defaults are the Apple look.
  apple: {
    appearance: { ...DEFAULT_SETTINGS.appearance },
    lyrics: { ...DEFAULT_SETTINGS.lyrics },
    background: { ...DEFAULT_SETTINGS.background },
  },
  // Flat list, dark tinted background, no blur, white active / grey inactive.
  ytmusic: {
    appearance: {
      preset: "ytmusic",
      fontSize: 22,
      fontWeight: 700,
      lineHeight: 1.25,
      letterSpacing: 0,
      align: "left",
      activeColor: "#ffffff",
      inactiveColor: "rgba(255,255,255,0.55)",
      blendInactive: false,
    },
    lyrics: {
      anchor: 0.42,
      lineGap: 0.55,
      blur: false,
      inactiveScale: 1,
      spring: true,
      springStiffness: 170,
      springDamping: 26,
      stagger: 0,
      lift: 0,
      emphasis: false,
      edgeFade: true,
    },
    background: { type: "dark", dim: 0 },
  },
  // Quiet, centered, solid background.
  minimal: {
    appearance: {
      preset: "minimal",
      fontSize: 24,
      fontWeight: 600,
      lineHeight: 1.22,
      letterSpacing: -0.01,
      align: "center",
      activeColor: "#f5f5f7",
      inactiveColor: "rgba(245,245,247,0.28)",
      blendInactive: false,
    },
    lyrics: { anchor: 0.42, blur: false, inactiveScale: 0.98, stagger: 25, lift: 0.03, emphasis: true },
    background: { type: "solid", color1: "#17171c", dim: 0 },
  },
};

export function applyPreset(s: Settings, name: PresetName): Settings {
  const p = PRESETS[name];
  return {
    ...s,
    appearance: { ...s.appearance, ...p.appearance, preset: name },
    lyrics: { ...s.lyrics, ...p.lyrics },
    background: { ...s.background, ...p.background },
  };
}
