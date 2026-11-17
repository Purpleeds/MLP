// Light mode for laptops / integrated graphics: AI kept to auto-sync on a small CPU budget, no
// GPU-heavy visuals. Turned on once automatically on PCs without a graphics card.
import { DEFAULT_SETTINGS, setPath, type Settings } from "./schema";

/** What light mode changes (value when on). Turning it off puts these back to their defaults. */
export const LIGHT_VALUES: [path: string, on: unknown][] = [
  ["ai.isolateVocals", false], // HT-Demucs on the CPU: the heaviest AI part
  ["ai.lyrics", false], // Whisper: needs a GPU to be practical
  ["ai.threads", 2],
  ["ai.lowPriority", true],
  ["background.type", "art"], // blurred cover instead of the animated WebGL background
  ["lyrics.blur", false], // per-line blur filters cost GPU time
  ["lyrics.fps", 30],
  ["app.batterySaver", true],
];

const get = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

/** Settings with light mode switched on or off (only the values above change, plus the flag). */
export function withLightMode(s: Settings, on: boolean): Settings {
  let out = setPath(s, "app.lightMode", on);
  for (const [path, value] of LIGHT_VALUES) out = setPath(out, path, on ? value : get(DEFAULT_SETTINGS, path));
  return out;
}

/** Integrated vs dedicated graphics from the WebGL renderer string (ANGLE on Windows). */
export function gpuKind(renderer: string): "integrated" | "discrete" | null {
  const r = renderer.toLowerCase();
  if (!r) return null;
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b|radeon\s*(rx|pro|vii)|\bfirepro\b|intel.*\barc\b/.test(r)) return "discrete";
  if (/intel|\buhd\b|iris|radeon(\(tm\))?\s*(\d{3}m\s*)?graphics|vega\s*\d*\s*graphics|adreno|mali|basic render|swiftshader|llvmpipe|warp/.test(r)) return "integrated";
  return null;
}

/** The GPU the app's web view renders with, or null when it can't be told. */
export function detectGpu(): "integrated" | "discrete" | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return "integrated"; // no WebGL at all: treat as a weak GPU
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext(); // throwaway context only
    return gpuKind(renderer);
  } catch {
    return null;
  }
}
