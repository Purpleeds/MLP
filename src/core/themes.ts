// Upgrade 13: themes = the look (text, colours, motion, background, corners) saved by name,
// shared as a copy-paste code and imported again. Behaviour settings are never part of a theme.
import { createKv } from "./storage/kv";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "./settings/schema";

export interface ThemeData {
  appearance: Settings["appearance"];
  lyrics: Partial<Settings["lyrics"]>;
  background: Settings["background"];
  window: Pick<Settings["window"], "cornerRadius" | "padding" | "opacity">;
}
export interface Theme {
  id: string;
  name: string;
  data: ThemeData;
}

/** Lyrics settings that are about behaviour, not looks. */
const NOT_LOOK: (keyof Settings["lyrics"])[] = ["plainAutoScroll", "clickToSeek", "fps"];

export function captureTheme(s: Settings): ThemeData {
  const lyrics = { ...s.lyrics } as Partial<Settings["lyrics"]>;
  for (const k of NOT_LOOK) delete lyrics[k];
  return {
    appearance: { ...s.appearance },
    lyrics,
    background: { ...s.background },
    window: { cornerRadius: s.window.cornerRadius, padding: s.window.padding, opacity: s.window.opacity },
  };
}

/** Apply a theme over the current settings (unknown / wrongly typed values are ignored). */
export function applyTheme(s: Settings, d: Partial<ThemeData>): Settings {
  const lyrics = { ...(d.lyrics ?? {}) } as Partial<Settings["lyrics"]>;
  for (const k of NOT_LOOK) delete lyrics[k];
  const merged = mergeSettings({
    ...s,
    appearance: { ...s.appearance, ...(d.appearance ?? {}) },
    lyrics: { ...s.lyrics, ...lyrics },
    background: { ...s.background, ...(d.background ?? {}) },
    window: { ...s.window, ...(d.window ?? {}) },
  });
  return { ...merged, appearance: { ...merged.appearance, preset: "custom" } };
}

const PREFIX = "mlp-theme:";
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** Share code: only values that differ from the defaults, so codes stay short. */
export function encodeTheme(name: string, d: ThemeData): string {
  const base = captureTheme(DEFAULT_SETTINGS);
  const diff = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.fromEntries(Object.entries(a).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(b[k])));
  const body = {
    n: name,
    a: diff(d.appearance, base.appearance),
    l: diff(d.lyrics, base.lyrics),
    b: diff(d.background, base.background),
    w: diff(d.window, base.window),
  };
  return PREFIX + b64(JSON.stringify(body));
}

/** Read a share code back (null when it isn't one). Values are type-checked when applied. */
export function decodeTheme(code: string): { name: string; data: ThemeData } | null {
  const t = code.trim();
  if (!t.startsWith(PREFIX)) return null;
  try {
    const body = JSON.parse(unb64(t.slice(PREFIX.length)));
    if (!body || typeof body !== "object") return null;
    const full = applyTheme(DEFAULT_SETTINGS, { appearance: body.a, lyrics: body.l, background: body.b, window: body.w });
    const name = typeof body.n === "string" && body.n.trim() ? body.n.trim().slice(0, 40) : "Imported theme";
    return { name, data: captureTheme(full) };
  } catch {
    return null;
  }
}

const store = createKv<Theme>("themes.json");
export const listThemes = async () => (await store.entries()).map(([, t]) => t).sort((a, b) => a.name.localeCompare(b.name));
export async function saveTheme(name: string, data: ThemeData): Promise<Theme> {
  const t: Theme = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name.trim().slice(0, 40) || "My theme", data };
  await store.set(t.id, t);
  return t;
}
export const deleteTheme = (id: string) => store.delete(id);
