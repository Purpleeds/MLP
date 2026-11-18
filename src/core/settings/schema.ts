// Typed settings with defaults. Later steps add sections/fields here (Step 8 renders a UI from this).

export type DisplayMode = "full" | "lyrics-title" | "lyrics" | "card" | "title" | "mini" | "overlay" | "bar" | "custom";
export const DISPLAY_MODES: { id: DisplayMode; label: string }[] = [
  { id: "full", label: "Full (art + info + lyrics)" },
  { id: "lyrics-title", label: "Lyrics + title" },
  { id: "lyrics", label: "Lyrics only" },
  { id: "card", label: "Now playing card" },
  { id: "title", label: "Title only" },
  { id: "mini", label: "Mini karaoke" },
  { id: "overlay", label: "Overlay (text over games / videos)" },
  { id: "bar", label: "Taskbar bar (one line by the clock)" },
  { id: "custom", label: "Custom" },
];
export interface Elements {
  art: boolean;
  title: boolean;
  artist: boolean;
  album: boolean;
  progress: boolean;
  times: boolean;
  controls: boolean;
  lyrics: boolean;
}

export interface Settings {
  version: 1;
  window: {
    alwaysOnTop: boolean;
    showInTaskbar: boolean;
    cornerRadius: number; // px
    opacity: number; // 0..1, default fully opaque
    padding: number; // px
    /** snap to screen edges after moving (Upgrade 15) */
    snapEdges: boolean;
    /** remember the position per monitor and return there when it comes back */
    perMonitor: boolean;
  };
  appearance: {
    /** last applied preset (values below can be tweaked individually) */
    preset: "apple" | "ytmusic" | "minimal" | "custom";
    fontFamily: string;
    fontSize: number; // px, lyric lines
    fontWeight: number;
    lineHeight: number; // unitless
    letterSpacing: number; // em
    align: "left" | "center" | "right";
    /** sung / active text */
    activeColor: string;
    /** unsung / inactive text */
    inactiveColor: string;
    /** blend inactive text with the background (Apple style tint) */
    blendInactive: boolean;
    /** title / artist text color */
    infoColor: string;
    /** duets: sung text in a colour per singer (when the lyrics say who sings) */
    voiceColors: boolean;
    voice2Color: string;
    voice3Color: string;
    /** lines sung together */
    groupColor: string;
    /** sung text takes a colour from the cover art (Upgrade 13) */
    accentFromArt: boolean;
  };
  lyrics: {
    /** 0..1, where the active line sits vertically */
    anchor: number;
    /** space between lines, em */
    lineGap: number;
    blur: boolean;
    /** blur px added per line of distance from the active line */
    blurStep: number;
    blurMax: number;
    /** scale of inactive lines (1 = none) */
    inactiveScale: number;
    spring: boolean;
    springStiffness: number;
    springDamping: number;
    /** cascade delay between lines when scrolling, ms */
    stagger: number;
    /** soft edge of the fill, em */
    fillSoftness: number;
    /** words rise slightly while sung, em */
    lift: number;
    /** glow + letter wave on long held words */
    emphasis: boolean;
    /** which effect: "auto" = matched to the song, or one style everywhere */
    effectStyle: "auto" | "glow" | "bloom" | "shimmer" | "wave" | "shake" | "glitch";
    glowColor: string;
    interludeDots: boolean;
    /** fade lines near the top/bottom edges */
    edgeFade: boolean;
    /** background-vocal size relative to main lines */
    bgScale: number;
    /** auto-scroll unsynced lyrics with song progress */
    plainAutoScroll: boolean;
    /** animation frame-rate cap (30 saves CPU) */
    fps: number;
    /** click a line to jump the song there */
    clickToSeek: boolean;
  };
  background: {
    type: "fluid" | "art" | "solid" | "gradient" | "dark";
    color1: string;
    color2: string;
    /** 0..1 darkening scrim for legibility */
    dim: number;
    saturation: number; // 1 = unchanged
    /** fluid flow speed multiplier */
    flowSpeed: number;
    /** fluid background frame-rate cap */
    fps: number;
  };
  layout: {
    mode: DisplayMode;
    /** element visibility for the "custom" mode */
    elements: Elements;
    /** remembered window size per mode (logical px) */
    sizes: Record<DisplayMode, { w: number; h: number }>;
    /** what to show when nothing is playing ("hide" is legacy → migrated to autoHide) */
    idle: "card" | "keep" | "hide";
    /** hide the window when nothing is playing; it comes back when music starts */
    autoHide: boolean;
    /** treat paused / stopped as "nothing playing" for auto-hide */
    autoHideWhenPaused: boolean;
    /** seconds to wait before hiding */
    autoHideDelay: number;
    /** look up sharper cover art (iTunes Search) when the player's thumbnail is small */
    hiResArt: boolean;
    /** overlay mode: clicks pass through to the game / video underneath */
    overlayClickThrough: boolean;
    /** taskbar bar: just above the taskbar, or on it next to the tray icons (experimental) */
    barPlacement: "above" | "taskbar";
    /** prev / play-pause / next: always in the window, in the hover toolbar, or nowhere */
    controls: "always" | "hover" | "never";
  };
  timing: {
    /** estimated = per-word fill from syllables; linear = even sweep; line = highlight whole line */
    wordMode: "estimated" | "linear" | "line";
    /** + shows lyrics earlier (ms) */
    globalOffsetMs: number;
    /** per-source latency compensation (ms, + shows lyrics earlier) */
    sourceOffsetMs: { spotify: number; browser: number; "ytmusic-app": number; other: number };
    /** songs without their own offset start with what most corrected songs from the same app needed */
    learnOffsets: boolean;
  };
  translation: {
    enabled: boolean;
    /** file = only translations shipped with the lyrics; mymemory = free online (small daily limit); deepl = your DeepL API key */
    provider: "file" | "mymemory" | "deepl";
    /** target language code, e.g. en, es, de, ja */
    target: string;
    deeplKey: string;
  };
  romanization: {
    /** roman-main: romanized lyrics with the original underneath; original-main: the reverse */
    /** furigana: Japanese keeps its kanji with small readings above; other languages show romanization below */
    mode: "roman-main" | "original-main" | "roman-only" | "furigana" | "off";
    ja: boolean;
    zh: boolean;
    ko: boolean;
    /** Cyrillic, Greek, Hindi, … */
    other: boolean;
    /** Arabic / Hebrew / Persian / Urdu: auto = only lines written with vowel marks (most leave them out) */
    abjad: "auto" | "on" | "off";
    pinyinTones: "symbol" | "num" | "none";
    /** Chinese: Mandarin pinyin, Cantonese jyutping, or auto (jyutping when the text uses Cantonese-only characters) */
    chinese: "pinyin" | "jyutping" | "auto";
    /** Korean: romanize as pronounced (않아 → ana) instead of letter by letter (anha) */
    koreanPronunciation: boolean;
    /** Thai → RTGS */
    th: boolean;
    /** "plain" = kyou, "macron" = kyō */
    romajiLong: "plain" | "macron";
    capitalize: boolean;
  };
  sources: {
    /** auto | spotify | browser */
    prefer: "auto" | "spotify" | "browser";
    /** also follow other media apps (Windows Media Player, VLC, …) */
    allowOther: boolean;
    /** app-id substrings to ignore */
    ignore: string[];
    /** no lyrics during ads; long browser videos (mixes, podcasts) aren't looked up */
    skipAds: boolean;
  };
  hotkeys: {
    toggleWindow: string;
    lock: string;
    offsetEarlier: string;
    offsetLater: string;
    nextMode: string;
    openSettings: string;
  };
  app: {
    /** start with Windows (hidden in the tray until opened) */
    autostart: boolean;
    /** first-run tip about pinning the tray icon was shown */
    tipShown: boolean;
    /** release feed (latest.json on GitHub Releases); empty = no update checks (Upgrade 16) */
    updateUrl: string;
    /** look for updates once a day */
    autoUpdateCheck: boolean;
    /** lower frame rates on battery and while the window is covered (Upgrade 18) */
    batterySaver: boolean;
    /** laptops / integrated graphics: lighter AI and visuals (see settings/light.ts) */
    lightMode: boolean;
    /** the one-time graphics check (light mode on for integrated graphics) has run */
    lightChecked: boolean;
    /** settings window language (Upgrade 20): auto | en | ja | es */
    uiLanguage: string;
    /** announce each new lyric line to screen readers */
    screenReader: boolean;
    /** local overlay page for OBS / streaming (Upgrade 19) */
    obs: boolean;
    obsPort: number;
    lastUpdateCheck: number;
  };
  provider: {
    /** LRCLIB API base URL (self-hosted mirrors work too) */
    baseUrl: string;
    /** also try the community word-synced database (AMLL TTML DB) when LRCLIB has no word timing */
    amll: boolean;
  };
  spotify: {
    /** use the connected Spotify account (Web API) for exact track info and HD covers */
    enabled: boolean;
    /** Client ID of the user's own Spotify app (PKCE, no secret) */
    clientId: string;
  };
  ai: {
    /** capture the player's audio (Phase 2); stays in memory, never uploaded */
    listen: boolean;
    /** correction for output latency: captured audio is placed this much earlier (ms) */
    captureLatencyMs: number;
    /** separate the singing from the captured audio (Step 14) */
    isolateVocals: boolean;
    /** line the lyrics up with the singing and keep it per song (Step 15) */
    autoSync: boolean;
    /** pause AI work while a full-screen game / video / presentation runs */
    pauseFullscreen: boolean;
    /** write lyrics with Whisper for songs no database has (Step 16) */
    lyrics: boolean;
    whisperModel: "large-v3-turbo-q5_0" | "large-v3-turbo-q8_0" | "base";
    /** auto = NVIDIA GPU when there is one */
    whisperRuntime: "auto" | "gpu" | "cpu";
    /** which lyrics auto-sync checks: all, only line-synced ones, or keep checking only while they're off */
    autoSyncWhen: "always" | "line" | "off";
    /** CPU threads for AI models (0 = automatic) */
    threads: number;
    /** run AI work below normal priority */
    lowPriority: boolean;
    /** small status pill in the lyrics window while AI works */
    indicator: boolean;
  };
  debug: {
    overlay: boolean;
  };
}

/** Default font stack: SF Pro if installed, else bundled Inter, then Windows fonts; CJK handled by :lang() stacks. */
export const FONT_STACK =
  '"SF Pro Display", "SF Pro Text", "Inter Variable", "Segoe UI Variable Display", "Segoe UI", sans-serif';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  window: {
    alwaysOnTop: true,
    showInTaskbar: false,
    cornerRadius: 18,
    opacity: 1,
    padding: 20,
    snapEdges: true,
    perMonitor: true,
  },
  appearance: {
    preset: "apple",
    fontFamily: FONT_STACK,
    fontSize: 28,
    fontWeight: 700,
    lineHeight: 1.18,
    letterSpacing: -0.015,
    align: "left",
    activeColor: "#ffffff",
    inactiveColor: "rgba(255,255,255,0.32)",
    blendInactive: true,
    infoColor: "#ffffff",
    voiceColors: true,
    voice2Color: "#9ad4ff",
    voice3Color: "#ffb0d2",
    groupColor: "#ffdf94",
    accentFromArt: false,
  },
  lyrics: {
    anchor: 0.3,
    lineGap: 0.62,
    blur: true,
    blurStep: 1.1,
    blurMax: 4,
    inactiveScale: 0.965,
    spring: true,
    springStiffness: 120,
    springDamping: 21,
    stagger: 45,
    fillSoftness: 0.9,
    lift: 0.05,
    emphasis: true,
    effectStyle: "auto",
    glowColor: "rgba(255,255,255,0.55)",
    interludeDots: true,
    edgeFade: true,
    bgScale: 0.68,
    plainAutoScroll: true,
    fps: 60,
    clickToSeek: true,
  },
  background: {
    type: "fluid",
    color1: "#1d1b2b",
    color2: "#3a2140",
    dim: 0.28,
    saturation: 1.35,
    flowSpeed: 1,
    fps: 24,
  },
  layout: {
    mode: "lyrics-title",
    elements: { art: true, title: true, artist: true, album: false, progress: true, times: false, controls: false, lyrics: true },
    sizes: {
      full: { w: 760, h: 430 },
      "lyrics-title": { w: 420, h: 560 },
      lyrics: { w: 420, h: 480 },
      card: { w: 400, h: 150 },
      title: { w: 380, h: 64 },
      mini: { w: 560, h: 124 },
      overlay: { w: 900, h: 170 },
      bar: { w: 520, h: 40 },
      custom: { w: 420, h: 560 },
    },
    idle: "card",
    autoHide: false,
    autoHideWhenPaused: true,
    autoHideDelay: 5,
    hiResArt: true,
    overlayClickThrough: true,
    barPlacement: "above",
    controls: "hover",
  },
  timing: {
    wordMode: "estimated",
    globalOffsetMs: 0,
    sourceOffsetMs: { spotify: 0, browser: 0, "ytmusic-app": 0, other: 0 },
    learnOffsets: true,
  },
  translation: { enabled: true, provider: "mymemory", target: "en", deeplKey: "" },
  romanization: {
    mode: "roman-main",
    ja: true,
    zh: true,
    ko: true,
    other: true,
    abjad: "auto",
    pinyinTones: "symbol",
    chinese: "auto",
    koreanPronunciation: true,
    th: true,
    romajiLong: "plain",
    capitalize: false,
  },
  sources: { prefer: "auto", allowOther: false, ignore: [], skipAds: true },
  hotkeys: {
    toggleWindow: "CommandOrControl+Alt+L",
    lock: "CommandOrControl+Alt+K",
    offsetEarlier: "CommandOrControl+Alt+Up",
    offsetLater: "CommandOrControl+Alt+Down",
    nextMode: "CommandOrControl+Alt+Shift+M",
    openSettings: "CommandOrControl+Alt+S",
  },
  app: { autostart: false, tipShown: false, updateUrl: "", autoUpdateCheck: true, lastUpdateCheck: 0, batterySaver: true, lightMode: false, lightChecked: false, uiLanguage: "auto", screenReader: false, obs: false, obsPort: 7272 },
  provider: { baseUrl: "https://lrclib.net/api", amll: true },
  spotify: { enabled: false, clientId: "" },
  ai: { listen: false, captureLatencyMs: 0, isolateVocals: false, autoSync: true, pauseFullscreen: true, lyrics: true, whisperModel: "large-v3-turbo-q5_0", whisperRuntime: "auto", autoSyncWhen: "always", threads: 0, lowPriority: true, indicator: true },
  debug: { overlay: false },
};

type Plain = Record<string, unknown>;
const isObj = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-merge stored values over defaults so new fields always get a default. */
export function mergeSettings(stored: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const merge = (d: Plain, s: unknown): Plain => {
    if (!isObj(s)) return d;
    const out: Plain = { ...d };
    for (const k of Object.keys(d)) {
      const dv = d[k];
      const sv = s[k];
      if (isObj(dv)) out[k] = merge(dv, sv);
      else if (sv !== undefined && typeof sv === typeof dv) out[k] = sv;
    }
    return out;
  };
  const out = merge(defaults as unknown as Plain, stored) as unknown as Settings;
  // Migration: the old "Hide the window" idle choice is now the auto-hide toggle.
  if (out.layout.idle === "hide") out.layout = { ...out.layout, idle: "card", autoHide: true, autoHideWhenPaused: false };
  return out;
}

/** Immutable update by dotted path, e.g. setPath(s, "window.cornerRadius", 12). */
export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const cur = (obj as Plain)[head];
  return {
    ...obj,
    [head]: rest.length ? setPath((cur ?? {}) as object, rest.join("."), value) : value,
  } as T;
}
