// Declarative description of every setting. The settings window renders controls from this,
// so later steps only add entries here.
// `adv` hides a field or group until "Advanced options" is on; `when` hides it while it can't apply
// (e.g. gradient colours unless the background is a gradient).
import { DISPLAY_MODES, type Settings } from "../core/settings/schema";

interface Common {
  /** only shown with "Advanced options" on */
  adv?: boolean;
  /** only shown while this returns true */
  when?: (s: Settings) => boolean;
}

export type Field = Common &
  (
    | { kind: "toggle"; path: string; label: string; help?: string; style?: boolean }
    | { kind: "slider"; path: string; label: string; min: number; max: number; step: number; unit?: string; pct?: boolean; help?: string; style?: boolean }
    | { kind: "select"; path: string; label: string; options: { value: string | number; label: string }[]; help?: string; style?: boolean }
    | { kind: "color"; path: string; label: string; help?: string; style?: boolean }
    | { kind: "text"; path: string; label: string; placeholder?: string; help?: string }
    | { kind: "list"; path: string; label: string; placeholder?: string; help?: string }
    | { kind: "font"; path: string; label: string; help?: string; style?: boolean }
    | { kind: "hotkey"; path: string; label: string; help?: string }
    | { kind: "custom"; id: "presets" | "corners" | "lock" | "clear-cache" | "backup" | "song" | "autostart" | "sync" | "capture" | "vocals" | "autosync" | "spotify" | "ailyrics" | "learned" | "aimodels" | "themes" | "aieval" | "updates" | "obs" | "translations"; label: string; help?: string }
  );

export interface Group extends Common {
  title: string;
  /** shown when the group only applies in some situations */
  note?: string;
  fields: Field[];
}

export interface Section {
  id: string;
  title: string;
  /** older tab ids that now open this section (links from the lyrics window, saved tab) */
  aliases?: string[];
  /** settings paths reset by "Reset section" */
  resets: string[];
  groups: Group[];
}

const ms = { unit: "ms" };
const offset = { min: -3000, max: 3000, step: 50, ...ms };

export const SECTIONS: Section[] = [
  {
    id: "song",
    title: "This song",
    aliases: ["sync"],
    resets: [],
    groups: [
      { title: "Now playing", fields: [{ kind: "custom", id: "song", label: "Lyrics and timing", help: "Wrong lyrics or out of sync? Fix it here." }] },
      {
        title: "Sync it yourself",
        note: "No timing, or bad timing? Tap along while the song plays.",
        fields: [{ kind: "custom", id: "sync", label: "Tap along", help: "Restart and −5 s need a player that can seek." }],
      },
    ],
  },
  {
    id: "general",
    title: "General",
    aliases: ["hotkeys", "advanced"],
    resets: [
      "layout.mode", "layout.controls", "layout.barPlacement", "layout.overlayClickThrough", "layout.idle", "layout.autoHide", "layout.autoHideWhenPaused",
      "layout.autoHideDelay", "layout.hiResArt", "window.alwaysOnTop", "window.showInTaskbar", "window.snapEdges", "window.perMonitor", "hotkeys", "debug",
    ],
    groups: [
      {
        title: "Display",
        fields: [
          {
            kind: "select",
            path: "app.uiLanguage",
            label: "Interface language",
            options: [
              { value: "auto", label: "Automatic (Windows language)" },
              { value: "en", label: "English" },
              { value: "ja", label: "日本語" },
              { value: "es", label: "Español" },
            ],
          },
          { kind: "select", path: "layout.mode", label: "Display mode", options: DISPLAY_MODES.map((m) => ({ value: m.id, label: m.label })) },
          {
            kind: "select",
            path: "layout.barPlacement",
            label: "Taskbar bar sits",
            when: (s) => s.layout.mode === "bar",
            options: [
              { value: "above", label: "Just above the taskbar, by the clock" },
              { value: "taskbar", label: "On the taskbar, left of the tray icons (experimental)" },
            ],
          },
          {
            kind: "toggle",
            path: "layout.overlayClickThrough",
            label: "Overlay mode: clicks pass through",
            help: "Unlock from the tray or the lock hotkey to move it.",
            when: (s) => s.layout.mode === "overlay",
          },
          {
            kind: "select",
            path: "layout.controls",
            label: "Playback controls",
            help: "Mini, overlay and taskbar modes show them on hover.",
            options: [
              { value: "always", label: "Always" },
              { value: "hover", label: "On hover" },
              { value: "never", label: "Never" },
            ],
          },
          {
            kind: "select",
            path: "layout.idle",
            label: "When nothing is playing",
            options: [
              { value: "card", label: "Show “Nothing playing”" },
              { value: "keep", label: "Keep the last song" },
            ],
          },
          { kind: "toggle", path: "layout.autoHide", label: "Auto-hide when nothing is playing", help: "Comes back by itself when music starts." },
          { kind: "toggle", path: "layout.autoHideWhenPaused", label: "Also hide when paused", when: (s) => s.layout.autoHide },
          { kind: "slider", path: "layout.autoHideDelay", label: "Hide after", min: 0, max: 60, step: 1, unit: "s", when: (s) => s.layout.autoHide },
          { kind: "toggle", path: "layout.hiResArt", label: "Sharper cover art", help: "Finds a bigger cover on iTunes when the player's is small.", adv: true },
          { kind: "toggle", path: "app.screenReader", label: "Read lyric lines to screen readers" },
        ],
      },
      {
        title: "Window",
        fields: [
          { kind: "toggle", path: "window.alwaysOnTop", label: "Keep on top of other windows" },
          { kind: "custom", id: "autostart", label: "Start with Windows" },
          { kind: "custom", id: "corners", label: "Move window to" },
          { kind: "custom", id: "lock", label: "Click-through", help: "Unlock from the tray icon." },
          { kind: "toggle", path: "window.showInTaskbar", label: "Show a taskbar button", adv: true },
          { kind: "toggle", path: "window.snapEdges", label: "Snap to screen edges", adv: true },
          { kind: "toggle", path: "window.perMonitor", label: "Remember the position on each monitor", adv: true },
        ],
      },
      {
        title: "Performance",
        fields: [
          {
            kind: "toggle",
            path: "app.lightMode",
            label: "Light mode (laptops, integrated graphics)",
            help: "Static background, 30 fps, no blur, lighter AI. On by itself without a graphics card.",
          },
          { kind: "toggle", path: "app.batterySaver", label: "Battery saver", help: "Slower animation on battery or when covered." },
          {
            kind: "select",
            path: "lyrics.fps",
            label: "Frame rate",
            adv: true,
            options: [
              { value: 30, label: "30 fps" },
              { value: 60, label: "60 fps" },
            ],
          },
        ],
      },
      {
        title: "Hotkeys",
        note: "Work in any app. Click a box and press keys; Backspace clears.",
        fields: [
          { kind: "hotkey", path: "hotkeys.toggleWindow", label: "Show / hide lyrics" },
          { kind: "hotkey", path: "hotkeys.lock", label: "Lock / unlock (click-through)" },
          { kind: "hotkey", path: "hotkeys.offsetEarlier", label: "Lyrics earlier (+0.1 s, this song)" },
          { kind: "hotkey", path: "hotkeys.offsetLater", label: "Lyrics later (−0.1 s, this song)" },
          { kind: "hotkey", path: "hotkeys.nextMode", label: "Next display mode", adv: true },
          { kind: "hotkey", path: "hotkeys.openSettings", label: "Open settings", adv: true },
        ],
      },
      {
        title: "Updates",
        fields: [
          { kind: "custom", id: "updates", label: "Updates" },
          { kind: "toggle", path: "app.autoUpdateCheck", label: "Look for updates once a day" },
          { kind: "text", path: "app.updateUrl", label: "Update feed", help: "Empty = official releases.", placeholder: "https://github.com/Purpleeds/MLP/releases/latest/download/latest.json", adv: true },
        ],
      },
      {
        title: "Backup & diagnostics",
        adv: true,
        fields: [
          { kind: "custom", id: "backup", label: "Settings file", help: "Copy your settings as text, or paste them to restore." },
          { kind: "toggle", path: "debug.overlay", label: "Show debug info in the lyrics window" },
        ],
      },
    ],
  },
  {
    id: "look",
    title: "Look",
    aliases: ["text", "window", "layout", "background"],
    resets: ["appearance", "background", "window.cornerRadius", "window.padding", "window.opacity", "layout.elements"],
    groups: [
      { title: "Style preset", fields: [{ kind: "custom", id: "presets", label: "Preset", help: "Sets text, motion and background together." }] },
      {
        title: "Font",
        fields: [
          { kind: "font", path: "appearance.fontFamily", label: "Font", style: true },
          { kind: "slider", path: "appearance.fontSize", label: "Size", min: 12, max: 64, step: 1, unit: "px", style: true },
          {
            kind: "select",
            path: "appearance.fontWeight",
            label: "Weight",
            style: true,
            options: [400, 500, 600, 700, 800, 900].map((w) => ({ value: w, label: String(w) })),
          },
          {
            kind: "select",
            path: "appearance.align",
            label: "Alignment",
            style: true,
            options: [
              { value: "left", label: "Left" },
              { value: "center", label: "Center" },
              { value: "right", label: "Right" },
            ],
          },
          { kind: "slider", path: "appearance.lineHeight", label: "Line height", min: 0.9, max: 1.8, step: 0.01, style: true, adv: true },
          { kind: "slider", path: "appearance.letterSpacing", label: "Letter spacing", min: -0.06, max: 0.12, step: 0.005, unit: "em", style: true, adv: true },
        ],
      },
      {
        title: "Colors",
        fields: [
          { kind: "color", path: "appearance.activeColor", label: "Sung / current text", style: true },
          { kind: "color", path: "appearance.inactiveColor", label: "Other lines", style: true },
          { kind: "toggle", path: "appearance.accentFromArt", label: "Sung text in a colour from the cover", style: true },
          { kind: "toggle", path: "appearance.blendInactive", label: "Tint other lines with the background", style: true, adv: true },
          { kind: "color", path: "lyrics.glowColor", label: "Glow on held words", style: true, adv: true },
          { kind: "color", path: "appearance.infoColor", label: "Title and artist", style: true, adv: true },
        ],
      },
      {
        title: "Background",
        fields: [
          {
            kind: "select",
            path: "background.type",
            label: "Type",
            style: true,
            options: [
              { value: "fluid", label: "Flowing album colors" },
              { value: "art", label: "Blurred cover art" },
              { value: "dark", label: "Dark (YouTube Music)" },
              { value: "solid", label: "Solid color" },
              { value: "gradient", label: "Gradient" },
            ],
          },
          { kind: "color", path: "background.color1", label: "Color", style: true, when: (s) => s.background.type === "solid" || s.background.type === "gradient" },
          { kind: "color", path: "background.color2", label: "Second gradient color", style: true, when: (s) => s.background.type === "gradient" },
          { kind: "slider", path: "background.dim", label: "Darken", min: 0, max: 0.8, step: 0.01, pct: true, style: true },
          { kind: "slider", path: "background.saturation", label: "Color intensity", min: 0.4, max: 2, step: 0.05, pct: true, style: true, adv: true },
          { kind: "slider", path: "background.flowSpeed", label: "Flow speed", min: 0, max: 3, step: 0.05, pct: true, style: true, when: (s) => s.background.type === "fluid" },
          { kind: "slider", path: "background.fps", label: "Flow frame rate", min: 10, max: 60, step: 1, unit: "fps", adv: true, when: (s) => s.background.type === "fluid" },
        ],
      },
      {
        title: "Window",
        fields: [
          { kind: "slider", path: "window.cornerRadius", label: "Corner radius", min: 0, max: 36, step: 1, unit: "px" },
          { kind: "slider", path: "window.opacity", label: "Window opacity", min: 0.3, max: 1, step: 0.01, pct: true },
          { kind: "slider", path: "window.padding", label: "Padding", min: 6, max: 44, step: 1, unit: "px", adv: true },
        ],
      },
      {
        title: "Parts to show",
        note: "Used by the Custom display mode.",
        when: (s) => s.layout.mode === "custom",
        fields: [
          { kind: "toggle", path: "layout.elements.art", label: "Cover art" },
          { kind: "toggle", path: "layout.elements.title", label: "Song title" },
          { kind: "toggle", path: "layout.elements.artist", label: "Artist" },
          { kind: "toggle", path: "layout.elements.album", label: "Album" },
          { kind: "toggle", path: "layout.elements.progress", label: "Progress bar" },
          { kind: "toggle", path: "layout.elements.times", label: "Elapsed / remaining time" },
          { kind: "toggle", path: "layout.elements.controls", label: "Play controls" },
          { kind: "toggle", path: "layout.elements.lyrics", label: "Lyrics" },
        ],
      },
      {
        title: "My themes",
        note: "Save the current look and share it as a code.",
        fields: [{ kind: "custom", id: "themes", label: "Themes" }],
      },
      {
        title: "Duets",
        note: "Only for lyrics that say who sings.",
        adv: true,
        fields: [
          { kind: "toggle", path: "appearance.voiceColors", label: "A colour for each singer", style: true },
          { kind: "color", path: "appearance.voice2Color", label: "Second singer", style: true, when: (s) => s.appearance.voiceColors },
          { kind: "color", path: "appearance.voice3Color", label: "Third singer", style: true, when: (s) => s.appearance.voiceColors },
          { kind: "color", path: "appearance.groupColor", label: "Sung together", style: true, when: (s) => s.appearance.voiceColors },
        ],
      },
    ],
  },
  {
    id: "motion",
    title: "Motion",
    resets: ["lyrics"],
    groups: [
      {
        title: "Lyrics",
        fields: [
          { kind: "slider", path: "lyrics.anchor", label: "Current line position", min: 0.05, max: 0.7, step: 0.01, pct: true, help: "From the top of the lyrics area.", style: true },
          { kind: "slider", path: "lyrics.lift", label: "Word lift while sung", min: 0, max: 0.15, step: 0.005, unit: "em", style: true },
          { kind: "toggle", path: "lyrics.emphasis", label: "Effects on held and key words", style: true },
          {
            kind: "select",
            path: "lyrics.effectStyle",
            label: "Word effect style",
            help: "Auto picks effects to fit each song and word.",
            options: [
              { value: "auto", label: "Auto (match the song)" },
              { value: "glow", label: "Glow" },
              { value: "bloom", label: "Bloom" },
              { value: "shimmer", label: "Shimmer" },
              { value: "wave", label: "Wave" },
              { value: "shake", label: "Shake" },
              { value: "glitch", label: "Glitch" },
            ],
            style: true,
            when: (s) => s.lyrics.emphasis,
          },
          { kind: "toggle", path: "lyrics.blur", label: "Blur other lines", style: true },
          { kind: "toggle", path: "lyrics.spring", label: "Springy scrolling", style: true },
          { kind: "toggle", path: "lyrics.interludeDots", label: "Dots during instrumental breaks", style: true },
          { kind: "toggle", path: "lyrics.clickToSeek", label: "Click a line to jump there", help: "Needs a player that can seek." },
          { kind: "toggle", path: "lyrics.edgeFade", label: "Fade lines at the edges", style: true, adv: true },
          { kind: "toggle", path: "lyrics.plainAutoScroll", label: "Auto-scroll unsynced lyrics", adv: true },
          { kind: "slider", path: "lyrics.lineGap", label: "Space between lines", min: 0.1, max: 1.6, step: 0.01, unit: "em", style: true, adv: true },
          { kind: "slider", path: "lyrics.bgScale", label: "Background vocal size", min: 0.4, max: 1, step: 0.01, pct: true, style: true, adv: true },
        ],
      },
      {
        title: "Fine-tuning",
        adv: true,
        fields: [
          { kind: "slider", path: "lyrics.fillSoftness", label: "Fill edge softness", min: 0, max: 2, step: 0.05, unit: "em", style: true },
          { kind: "slider", path: "lyrics.inactiveScale", label: "Size of other lines", min: 0.85, max: 1, step: 0.005, pct: true, style: true },
          { kind: "slider", path: "lyrics.blurStep", label: "Blur per line", min: 0, max: 3, step: 0.1, unit: "px", style: true, when: (s) => s.lyrics.blur },
          { kind: "slider", path: "lyrics.blurMax", label: "Maximum blur", min: 0, max: 10, step: 0.5, unit: "px", style: true, when: (s) => s.lyrics.blur },
          { kind: "slider", path: "lyrics.springStiffness", label: "Spring stiffness", min: 40, max: 400, step: 5, style: true, when: (s) => s.lyrics.spring },
          { kind: "slider", path: "lyrics.springDamping", label: "Spring damping", min: 5, max: 60, step: 1, style: true, when: (s) => s.lyrics.spring },
          { kind: "slider", path: "lyrics.stagger", label: "Cascade delay", min: 0, max: 150, step: 5, ...ms, style: true },
        ],
      },
    ],
  },
  {
    id: "sources",
    title: "Players & lyrics",
    aliases: ["timing"],
    resets: ["sources", "provider", "timing"],
    groups: [
      {
        title: "Players",
        fields: [
          {
            kind: "select",
            path: "sources.prefer",
            label: "Prefer",
            help: "When several players are open. Playing beats paused.",
            options: [
              { value: "auto", label: "Whatever is playing" },
              { value: "spotify", label: "Spotify" },
              { value: "browser", label: "Browser / YouTube Music" },
            ],
          },
          { kind: "toggle", path: "sources.allowOther", label: "Also follow other media apps", help: "For example Windows Media Player or VLC." },
          { kind: "toggle", path: "sources.skipAds", label: "Skip ads and long videos", help: "No lookups during YouTube ads or videos over 15 minutes." },
          { kind: "list", path: "sources.ignore", label: "Ignore apps", placeholder: "e.g. msedge, vlc", help: "Comma-separated parts of app names.", adv: true },
        ],
      },
      {
        title: "Lyrics",
        fields: [
          {
            kind: "select",
            path: "timing.wordMode",
            label: "When a song only has line timing",
            options: [
              { value: "estimated", label: "Estimate each word" },
              { value: "linear", label: "Sweep evenly" },
              { value: "line", label: "Highlight whole line" },
            ],
          },
          { kind: "toggle", path: "provider.amll", label: "Word-synced lyrics from the community database", help: "Checked when LRCLIB only has line timing." },
          { kind: "custom", id: "clear-cache", label: "Saved lyrics", help: "Clear to fetch fresh copies." },
          { kind: "text", path: "provider.baseUrl", label: "LRCLIB server", placeholder: "https://lrclib.net/api", adv: true },
        ],
      },
      {
        title: "Offsets",
        note: "Positive values show lyrics earlier.",
        fields: [
          { kind: "slider", path: "timing.globalOffsetMs", label: "All songs", ...offset },
          { kind: "toggle", path: "timing.learnOffsets", label: "Learn timing per player", help: "Reuses your usual nudge for each player." },
          { kind: "custom", id: "learned", label: "Learned so far", adv: true },
          { kind: "slider", path: "timing.sourceOffsetMs.spotify", label: "Spotify", ...offset, adv: true },
          { kind: "slider", path: "timing.sourceOffsetMs.browser", label: "Browser (YouTube Music)", ...offset, adv: true },
          { kind: "slider", path: "timing.sourceOffsetMs.ytmusic-app", label: "YouTube Music app", ...offset, adv: true },
          { kind: "slider", path: "timing.sourceOffsetMs.other", label: "Other players", ...offset, adv: true },
        ],
      },
      {
        title: "Spotify account (optional)",
        note: "Your own Spotify developer app gives exact song info and 640 px covers.",
        adv: true,
        fields: [
          { kind: "text", path: "spotify.clientId", label: "Client ID", placeholder: "from developer.spotify.com/dashboard" },
          { kind: "custom", id: "spotify", label: "Account" },
        ],
      },
      {
        title: "Stream overlay (OBS)",
        note: "A local page with the current line for an OBS Browser Source.",
        adv: true,
        fields: [
          { kind: "toggle", path: "app.obs", label: "Serve the overlay page" },
          { kind: "slider", path: "app.obsPort", label: "Port", min: 1025, max: 65000, step: 1, when: (s) => s.app.obs },
          { kind: "custom", id: "obs", label: "Address", when: (s) => s.app.obs },
        ],
      },
    ],
  },
  {
    id: "languages",
    title: "Languages",
    aliases: ["romanization", "translation"],
    resets: ["romanization", "translation"],
    groups: [
      {
        title: "Romanization",
        fields: [
          {
            kind: "select",
            path: "romanization.mode",
            label: "Show",
            options: [
              { value: "roman-main", label: "Romanized, original underneath" },
              { value: "original-main", label: "Original, romanized underneath" },
              { value: "roman-only", label: "Romanized only" },
              { value: "furigana", label: "Japanese with furigana (readings above kanji)" },
              { value: "off", label: "Original only" },
            ],
          },
          ...(
            [
              ["ja", "Japanese → romaji"],
              ["zh", "Chinese → pinyin"],
              ["ko", "Korean → Revised Romanization"],
              ["th", "Thai → RTGS"],
            ] as const
          ).map(([k, label]): Field => ({ kind: "toggle", path: `romanization.${k}`, label, when: (s) => s.romanization.mode !== "off" })),
          { kind: "toggle", path: "romanization.other", label: "Other scripts", help: "Cyrillic, Greek, Hindi and more.", when: (s) => s.romanization.mode !== "off" },
          { kind: "toggle", path: "romanization.capitalize", label: "Capitalize each line", adv: true },
          {
            kind: "select",
            path: "romanization.chinese",
            label: "Chinese",
            adv: true,
            options: [
              { value: "auto", label: "Auto (Cantonese → jyutping)" },
              { value: "pinyin", label: "Mandarin pinyin" },
              { value: "jyutping", label: "Cantonese jyutping" },
            ],
          },
          {
            kind: "select",
            path: "romanization.pinyinTones",
            label: "Pinyin tones",
            adv: true,
            options: [
              { value: "symbol", label: "Marks (nǐ)" },
              { value: "num", label: "Numbers (ni3)" },
              { value: "none", label: "None (ni)" },
            ],
          },
          {
            kind: "select",
            path: "romanization.romajiLong",
            label: "Romaji long vowels",
            adv: true,
            options: [
              { value: "plain", label: "kyou" },
              { value: "macron", label: "kyō" },
            ],
          },
          { kind: "toggle", path: "romanization.koreanPronunciation", label: "Korean as pronounced", help: "않아 → ana instead of anha.", adv: true },
          {
            kind: "select",
            path: "romanization.abjad",
            label: "Arabic / Hebrew",
            help: "Short vowels are usually unwritten; Auto only romanizes lines with vowel marks.",
            adv: true,
            options: [
              { value: "auto", label: "Auto (lines with vowel marks)" },
              { value: "on", label: "Always" },
              { value: "off", label: "Never" },
            ],
          },
        ],
      },
      {
        title: "Translation",
        note: "Shown under foreign-language lyrics.",
        fields: [
          { kind: "toggle", path: "translation.enabled", label: "Show translations" },
          {
            kind: "select",
            path: "translation.target",
            label: "Translate into",
            when: (s) => s.translation.enabled,
            options: [
              ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
              ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"], ["tr", "Turkish"], ["ar", "Arabic"],
              ["hi", "Hindi"], ["id", "Indonesian"], ["vi", "Vietnamese"], ["th", "Thai"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
            ].map(([value, label]) => ({ value, label })),
          },
          {
            kind: "select",
            path: "translation.provider",
            label: "Source",
            help: "Translations in the lyrics come first. MyMemory is free with a daily limit.",
            when: (s) => s.translation.enabled,
            options: [
              { value: "file", label: "Only translations in the lyrics file" },
              { value: "mymemory", label: "MyMemory (free, online)" },
              { value: "deepl", label: "DeepL (your API key)" },
            ],
          },
          {
            kind: "text",
            path: "translation.deeplKey",
            label: "DeepL API key",
            placeholder: "xxxxxxxx-xxxx-…:fx",
            help: "Free keys end with :fx. Stored on this PC only.",
            when: (s) => s.translation.enabled && s.translation.provider === "deepl",
          },
          { kind: "custom", id: "translations", label: "Saved translations", help: "One text file per song, fetched once." },
        ],
      },
    ],
  },
  {
    id: "ai",
    title: "AI listening",
    resets: ["ai"],
    groups: [
      {
        title: "Listen to the player",
        note: "Hears only the music app, for auto-sync and AI lyrics. Stays on this PC; nothing is uploaded or saved unless you press Save.",
        fields: [
          { kind: "toggle", path: "ai.listen", label: "Listen to the player" },
          { kind: "custom", id: "capture", label: "What MLP hears" },
          { kind: "slider", path: "ai.captureLatencyMs", label: "Timing correction", min: -500, max: 500, step: 5, unit: "ms", help: "Set automatically by Check timing.", adv: true },
        ],
      },
      {
        title: "Auto-sync",
        note: "Fixes lyrics that are early, late, too fast or too slow, and remembers it per song.",
        fields: [
          { kind: "toggle", path: "ai.autoSync", label: "Line up lyrics with the singing" },
          {
            kind: "select",
            path: "ai.autoSyncWhen",
            label: "Check",
            adv: true,
            options: [
              { value: "always", label: "All synced lyrics" },
              { value: "line", label: "Only line-synced lyrics (word-synced ones are usually exact)" },
              { value: "off", label: "Stop once the lyrics turn out to be in time" },
            ],
          },
          { kind: "custom", id: "autosync", label: "Progress" },
        ],
      },
      {
        title: "AI lyrics",
        note: "For songs no database has, Whisper writes the lyrics from what MLP hears. Fix mistakes in This song.",
        fields: [
          { kind: "toggle", path: "ai.lyrics", label: "Write lyrics with AI when none are found" },
          {
            kind: "select",
            path: "ai.whisperModel",
            label: "Model",
            options: [
              { value: "large-v3-turbo-q5_0", label: "Large v3 turbo (574 MB, recommended)" },
              { value: "large-v3-turbo-q8_0", label: "Large v3 turbo q8 (874 MB, a bit more accurate)" },
              { value: "base", label: "Base (148 MB, fast, rough)" },
            ],
          },
          {
            kind: "select",
            path: "ai.whisperRuntime",
            label: "Runs on",
            adv: true,
            options: [
              { value: "auto", label: "Automatic (NVIDIA GPU when there is one)" },
              { value: "gpu", label: "NVIDIA GPU (CUDA)" },
              { value: "cpu", label: "CPU" },
            ],
          },
          { kind: "custom", id: "ailyrics", label: "Downloads & progress" },
        ],
      },
      {
        title: "Vocal isolation",
        note: "Separates the singing from the music, which helps AI lyrics.",
        fields: [{ kind: "custom", id: "vocals", label: "Vocals only" }],
      },
      {
        title: "Models & data",
        fields: [{ kind: "custom", id: "aimodels", label: "Models" }],
      },
      {
        title: "Performance",
        note: "Fewer threads: slower, but more CPU left free.",
        adv: true,
        fields: [
          { kind: "slider", path: "ai.threads", label: "CPU threads (0 = automatic)", min: 0, max: 16, step: 1 },
          { kind: "toggle", path: "ai.lowPriority", label: "Run at low priority" },
          { kind: "toggle", path: "ai.pauseFullscreen", label: "Pause while a full-screen game or video runs" },
          { kind: "toggle", path: "ai.indicator", label: "Show what the AI is doing in the lyrics window" },
        ],
      },
      {
        title: "Measure accuracy",
        note: "Check the AI on your own songs. Nothing is uploaded.",
        adv: true,
        fields: [{ kind: "custom", id: "aieval", label: "This song" }],
      },
    ],
  },
];

/** The section a tab id (current or from an older version) opens. */
export const findSection = (id: string | null | undefined): Section | undefined =>
  SECTIONS.find((s) => s.id === id) ?? SECTIONS.find((s) => id != null && s.aliases?.includes(id));

/** Groups and fields to draw: `adv` ones only with advanced options on, `when` ones only while they apply. */
export function visibleGroups(sec: Section, s: Settings, advanced: boolean): { groups: Group[]; hidden: number } {
  let hidden = 0;
  const shows = (x: Common) => !x.when || x.when(s);
  const groups: Group[] = [];
  for (const g of sec.groups) {
    if (!shows(g)) continue;
    const applicable = g.fields.filter(shows);
    if (g.adv && !advanced) {
      hidden += applicable.length;
      continue;
    }
    const fields = applicable.filter((f) => advanced || !f.adv);
    hidden += applicable.length - fields.length;
    if (fields.length) groups.push({ ...g, fields });
  }
  return { groups, hidden };
}

export const getPath = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
