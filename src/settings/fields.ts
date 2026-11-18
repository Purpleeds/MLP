// Declarative description of every setting. The settings window renders controls from this,
// so later steps only add entries here.
import { DISPLAY_MODES } from "../core/settings/schema";

export type Field =
  | { kind: "toggle"; path: string; label: string; help?: string; style?: boolean }
  | { kind: "slider"; path: string; label: string; min: number; max: number; step: number; unit?: string; pct?: boolean; help?: string; style?: boolean }
  | { kind: "select"; path: string; label: string; options: { value: string | number; label: string }[]; help?: string; style?: boolean }
  | { kind: "color"; path: string; label: string; help?: string; style?: boolean }
  | { kind: "text"; path: string; label: string; placeholder?: string; help?: string }
  | { kind: "list"; path: string; label: string; placeholder?: string; help?: string }
  | { kind: "font"; path: string; label: string; help?: string; style?: boolean }
  | { kind: "hotkey"; path: string; label: string; help?: string }
  | { kind: "custom"; id: "presets" | "corners" | "lock" | "clear-cache" | "backup" | "song" | "autostart" | "sync" | "capture" | "vocals" | "autosync" | "spotify" | "ailyrics" | "learned" | "aimodels" | "themes" | "aieval" | "updates" | "obs" | "translations"; label: string; help?: string };

export interface Group {
  title: string;
  /** shown when the group only applies in some situations */
  note?: string;
  fields: Field[];
}

export interface Section {
  id: string;
  title: string;
  /** settings paths reset by "Reset section" */
  resets: string[];
  groups: Group[];
}

const ms = { unit: "ms" };

export const SECTIONS: Section[] = [
  {
    id: "song",
    title: "This song",
    resets: [],
    groups: [{ title: "Now playing", fields: [{ kind: "custom", id: "song", label: "Lyrics and timing", help: "Wrong lyrics or out of sync? Fix it here." }] }],
  },
  {
    id: "sync",
    title: "Sync lyrics",
    resets: [],
    groups: [
      {
        title: "Sync it yourself",
        note: "For songs with no timing (or bad timing): tap along while the song plays.",
        fields: [{ kind: "custom", id: "sync", label: "Tap along", help: "Works with any player; restart and −5 s need a player that can seek (Spotify, browsers)." }],
      },
    ],
  },
  {
    id: "general",
    title: "General",
    resets: ["layout.mode", "layout.idle", "window.alwaysOnTop", "window.showInTaskbar", "layout.hiResArt"],
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
            path: "layout.controls",
            label: "Playback controls",
            help: "Previous, play / pause and next for Spotify or the browser. Mini, overlay and taskbar modes have no room, so there they appear on hover.",
            options: [
              { value: "always", label: "Show in the window" },
              { value: "hover", label: "Show when the mouse is over the window" },
              { value: "never", label: "Hide" },
            ],
          },
          {
            kind: "select",
            path: "layout.barPlacement",
            label: "Taskbar bar sits",
            options: [
              { value: "above", label: "Just above the taskbar, by the clock" },
              { value: "taskbar", label: "On the taskbar, left of the tray icons (experimental)" },
            ],
          },
          { kind: "toggle", path: "layout.overlayClickThrough", label: "Overlay mode: clicks pass through", help: "Unlock from the tray or with the lock hotkey to move or resize it." },
          {
            kind: "select",
            path: "layout.idle",
            label: "When nothing is playing",
            options: [
              { value: "card", label: "Show “Nothing playing”" },
              { value: "keep", label: "Keep the last song" },
            ],
          },
          { kind: "toggle", path: "layout.autoHide", label: "Auto-hide when nothing is playing", help: "The window fades away and comes back by itself when music starts." },
          { kind: "toggle", path: "layout.autoHideWhenPaused", label: "Also hide when paused", help: "Off: only hide when no player is open." },
          { kind: "slider", path: "layout.autoHideDelay", label: "Hide after", min: 0, max: 60, step: 1, unit: "s" },
          { kind: "toggle", path: "layout.hiResArt", label: "Sharper cover art", help: "Looks the song up on iTunes when the player only gives a small or video-shaped image." },
        ],
      },
      {
        title: "Performance",
        fields: [
          {
            kind: "toggle",
            path: "app.lightMode",
            label: "Light mode (laptops, integrated graphics)",
            help: "Static cover background, 30 fps, no blur. AI listening keeps only auto-sync (2 CPU threads): no vocal isolation, no AI-written lyrics. Turns on by itself on PCs without a graphics card; turning it off restores the full settings.",
          },
        ],
      },
      {
        title: "Window",
        fields: [
          { kind: "custom", id: "autostart", label: "Start with Windows", help: "Starts quietly in the tray and appears when music plays." },
          { kind: "text", path: "app.updateUrl", label: "Update feed", help: "Leave empty for the official MLP releases on GitHub.", placeholder: "https://github.com/Purpleeds/MLP/releases/latest/download/latest.json" },
          { kind: "toggle", path: "app.autoUpdateCheck", label: "Look for updates once a day" },
          { kind: "custom", id: "updates", label: "Updates" },
          { kind: "toggle", path: "window.alwaysOnTop", label: "Keep on top of other windows" },
          { kind: "toggle", path: "window.showInTaskbar", label: "Show a taskbar button", help: "The tray icon near the clock is always there." },
          { kind: "toggle", path: "window.snapEdges", label: "Snap to screen edges" },
          { kind: "toggle", path: "window.perMonitor", label: "Remember the position on each monitor", help: "When a monitor is plugged in again, the window goes back to it." },
          { kind: "custom", id: "corners", label: "Move window to" },
          { kind: "custom", id: "lock", label: "Click-through", help: "Locked windows ignore the mouse. Unlock from the tray icon." },
        ],
      },
    ],
  },
  {
    id: "window",
    title: "Window look",
    resets: ["window.cornerRadius", "window.padding", "window.opacity"],
    groups: [
      {
        title: "Shape",
        fields: [
          { kind: "slider", path: "window.cornerRadius", label: "Corner radius", min: 0, max: 36, step: 1, unit: "px" },
          { kind: "slider", path: "window.padding", label: "Padding", min: 6, max: 44, step: 1, unit: "px" },
          { kind: "slider", path: "window.opacity", label: "Window opacity", min: 0.3, max: 1, step: 0.01, pct: true, help: "100% is fully opaque." },
        ],
      },
    ],
  },
  {
    id: "layout",
    title: "Custom layout",
    resets: ["layout.elements"],
    groups: [
      {
        title: "Parts to show",
        note: "Used by the Custom display mode.",
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
    ],
  },
  {
    id: "text",
    title: "Lyrics text",
    resets: ["appearance"],
    groups: [
      { title: "Style preset", fields: [{ kind: "custom", id: "presets", label: "Preset", help: "Sets text, motion and background together. Tweak anything afterwards." }] },
      {
        title: "My themes",
        note: "Save the current look (text, colours, motion, background, corners) and share it as a code.",
        fields: [
          { kind: "custom", id: "themes", label: "Themes" },
          { kind: "toggle", path: "appearance.accentFromArt", label: "Sung text in a colour from the cover", help: "Picks a light, colourful tone from each song's artwork.", style: true },
        ],
      },
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
          { kind: "slider", path: "appearance.lineHeight", label: "Line height", min: 0.9, max: 1.8, step: 0.01, style: true },
          { kind: "slider", path: "appearance.letterSpacing", label: "Letter spacing", min: -0.06, max: 0.12, step: 0.005, unit: "em", style: true },
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
        ],
      },
      {
        title: "Colors",
        fields: [
          { kind: "color", path: "appearance.activeColor", label: "Sung / current text", style: true },
          { kind: "color", path: "appearance.inactiveColor", label: "Other lines", style: true },
          { kind: "toggle", path: "appearance.blendInactive", label: "Tint other lines with the background", style: true },
          { kind: "color", path: "lyrics.glowColor", label: "Glow on held words", style: true },
          { kind: "color", path: "appearance.infoColor", label: "Title and artist", style: true },
        ],
      },
      {
        title: "Duets",
        note: "Only for lyrics that say who sings (word-synced lyrics from the community database).",
        fields: [
          { kind: "toggle", path: "appearance.voiceColors", label: "A colour for each singer", style: true },
          { kind: "color", path: "appearance.voice2Color", label: "Second singer", style: true },
          { kind: "color", path: "appearance.voice3Color", label: "Third singer", style: true },
          { kind: "color", path: "appearance.groupColor", label: "Sung together", style: true },
        ],
      },
    ],
  },
  {
    id: "motion",
    title: "Motion & effects",
    resets: ["lyrics"],
    groups: [
      {
        title: "Layout",
        fields: [
          { kind: "slider", path: "lyrics.anchor", label: "Current line position", min: 0.05, max: 0.7, step: 0.01, pct: true, help: "Distance from the top of the lyrics area.", style: true },
          { kind: "slider", path: "lyrics.lineGap", label: "Space between lines", min: 0.1, max: 1.6, step: 0.01, unit: "em", style: true },
          { kind: "slider", path: "lyrics.bgScale", label: "Background vocal size", min: 0.4, max: 1, step: 0.01, pct: true, style: true },
          { kind: "toggle", path: "lyrics.edgeFade", label: "Fade lines at the edges", style: true },
          { kind: "toggle", path: "lyrics.interludeDots", label: "Dots during instrumental breaks", style: true },
          { kind: "toggle", path: "lyrics.plainAutoScroll", label: "Auto-scroll unsynced lyrics" },
          { kind: "toggle", path: "app.batterySaver", label: "Battery saver", help: "On battery: lyrics at 30 fps and a slower background. While the window is completely covered, animation almost stops." },
          { kind: "toggle", path: "lyrics.clickToSeek", label: "Click a line to jump there", help: "Needs a player that allows seeking (Spotify, most browsers). Dragging a line still moves the window." },
        ],
      },
      {
        title: "Word fill",
        fields: [
          { kind: "slider", path: "lyrics.fillSoftness", label: "Fill edge softness", min: 0, max: 2, step: 0.05, unit: "em", style: true },
          { kind: "slider", path: "lyrics.lift", label: "Word lift while sung", min: 0, max: 0.15, step: 0.005, unit: "em", style: true },
          { kind: "toggle", path: "lyrics.emphasis", label: "Glow and wave on held words", style: true },
        ],
      },
      {
        title: "Other lines",
        fields: [
          { kind: "toggle", path: "lyrics.blur", label: "Blur", style: true },
          { kind: "slider", path: "lyrics.blurStep", label: "Blur per line", min: 0, max: 3, step: 0.1, unit: "px", style: true },
          { kind: "slider", path: "lyrics.blurMax", label: "Maximum blur", min: 0, max: 10, step: 0.5, unit: "px", style: true },
          { kind: "slider", path: "lyrics.inactiveScale", label: "Size", min: 0.85, max: 1, step: 0.005, pct: true, style: true },
        ],
      },
      {
        title: "Scrolling",
        fields: [
          { kind: "toggle", path: "lyrics.spring", label: "Springy scrolling", style: true },
          { kind: "slider", path: "lyrics.springStiffness", label: "Stiffness", min: 40, max: 400, step: 5, style: true },
          { kind: "slider", path: "lyrics.springDamping", label: "Damping", min: 5, max: 60, step: 1, style: true },
          { kind: "slider", path: "lyrics.stagger", label: "Cascade delay", min: 0, max: 150, step: 5, ...ms, style: true },
          {
            kind: "select",
            path: "lyrics.fps",
            label: "Frame rate",
            help: "30 uses less CPU.",
            options: [
              { value: 30, label: "30 fps" },
              { value: 60, label: "60 fps" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "background",
    title: "Background",
    resets: ["background"],
    groups: [
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
          { kind: "color", path: "background.color1", label: "Color", help: "Solid and gradient backgrounds.", style: true },
          { kind: "color", path: "background.color2", label: "Second gradient color", style: true },
          { kind: "slider", path: "background.dim", label: "Darken", min: 0, max: 0.8, step: 0.01, pct: true, style: true },
          { kind: "slider", path: "background.saturation", label: "Color intensity", min: 0.4, max: 2, step: 0.05, pct: true, style: true },
          { kind: "slider", path: "background.flowSpeed", label: "Flow speed", min: 0, max: 3, step: 0.05, pct: true, style: true },
          { kind: "slider", path: "background.fps", label: "Flow frame rate", min: 10, max: 60, step: 1, unit: "fps" },
        ],
      },
    ],
  },
  {
    id: "timing",
    title: "Timing",
    resets: ["timing"],
    groups: [
      {
        title: "Word fill",
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
        ],
      },
      {
        title: "Offsets",
        note: "Positive values show lyrics earlier.",
        fields: [
          { kind: "slider", path: "timing.globalOffsetMs", label: "All songs", min: -3000, max: 3000, step: 50, ...ms },
          { kind: "slider", path: "timing.sourceOffsetMs.spotify", label: "Spotify", min: -3000, max: 3000, step: 50, ...ms },
          { kind: "slider", path: "timing.sourceOffsetMs.browser", label: "Browser (YouTube Music)", min: -3000, max: 3000, step: 50, ...ms },
          { kind: "slider", path: "timing.sourceOffsetMs.ytmusic-app", label: "YouTube Music app", min: -3000, max: 3000, step: 50, ...ms },
          { kind: "slider", path: "timing.sourceOffsetMs.other", label: "Other players", min: -3000, max: 3000, step: 50, ...ms },
        ],
      },
      {
        title: "Learn from my corrections",
        note: "When you nudge several songs from the same player by about the same amount, new songs from that player start with it.",
        fields: [
          { kind: "toggle", path: "timing.learnOffsets", label: "Learn timing per player" },
          { kind: "custom", id: "learned", label: "Learned so far" },
        ],
      },
    ],
  },
  {
    id: "romanization",
    title: "Romanization",
    resets: ["romanization"],
    groups: [
      {
        title: "Display",
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
          { kind: "toggle", path: "romanization.capitalize", label: "Capitalize each line" },
        ],
      },
      {
        title: "Languages",
        fields: [
          { kind: "toggle", path: "romanization.ja", label: "Japanese → romaji" },
          { kind: "toggle", path: "romanization.zh", label: "Chinese → pinyin" },
          { kind: "toggle", path: "romanization.ko", label: "Korean → Revised Romanization" },
          { kind: "toggle", path: "romanization.th", label: "Thai → RTGS" },
          { kind: "toggle", path: "romanization.other", label: "Other scripts", help: "Cyrillic, Greek, Hindi and more." },
          {
            kind: "select",
            path: "romanization.abjad",
            label: "Arabic / Hebrew",
            help: "These scripts usually leave short vowels out, so a romanization would be a guess. Auto romanizes only lines written with vowel marks.",
            options: [
              { value: "auto", label: "Auto (lines with vowel marks)" },
              { value: "on", label: "Always" },
              { value: "off", label: "Never" },
            ],
          },
          {
            kind: "select",
            path: "romanization.chinese",
            label: "Chinese",
            options: [
              { value: "auto", label: "Auto (Cantonese → jyutping)" },
              { value: "pinyin", label: "Mandarin pinyin" },
              { value: "jyutping", label: "Cantonese jyutping" },
            ],
          },
          { kind: "toggle", path: "romanization.koreanPronunciation", label: "Korean as pronounced", help: "않아 → ana instead of anha." },
          {
            kind: "select",
            path: "romanization.pinyinTones",
            label: "Pinyin tones",
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
            options: [
              { value: "plain", label: "kyou" },
              { value: "macron", label: "kyō" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "translation",
    title: "Translation",
    resets: ["translation"],
    groups: [
      {
        title: "Translation line",
        note: "Shown under foreign-language lyrics.",
        fields: [
          { kind: "toggle", path: "translation.enabled", label: "Show translations" },
          {
            kind: "select",
            path: "translation.target",
            label: "Translate into",
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
            help: "Translations that come with the lyrics are always used first. MyMemory is free but allows only a few songs a day; DeepL needs your own API key.",
            options: [
              { value: "file", label: "Only translations in the lyrics file" },
              { value: "mymemory", label: "MyMemory (free, online)" },
              { value: "deepl", label: "DeepL (your API key)" },
            ],
          },
          { kind: "text", path: "translation.deeplKey", label: "DeepL API key", placeholder: "xxxxxxxx-xxxx-…:fx", help: "Free keys end with :fx. Stored on this PC only." },
        ],
      },
      {
        title: "Saved translations",
        note: "Each song's translation is saved as a text file, so it's only fetched once.",
        fields: [{ kind: "custom", id: "translations", label: "Translation files", help: "Reset one song from the This song tab." }],
      },
    ],
  },
  {
    id: "sources",
    title: "Players & lyrics",
    resets: ["sources", "provider"],
    groups: [
      {
        title: "Which player to follow",
        fields: [
          {
            kind: "select",
            path: "sources.prefer",
            label: "Prefer",
            help: "Used when several players are open. A playing source always wins over a paused one.",
            options: [
              { value: "auto", label: "Whatever is playing" },
              { value: "spotify", label: "Spotify" },
              { value: "browser", label: "Browser / YouTube Music" },
            ],
          },
          { kind: "toggle", path: "sources.allowOther", label: "Also follow other media apps", help: "For example Windows Media Player or VLC." },
          {
            kind: "toggle",
            path: "sources.skipAds",
            label: "Skip ads and long videos",
            help: "Shows “Ad” instead of the song's lyrics during YouTube ads, and doesn't look up lyrics for browser videos longer than 15 minutes.",
          },
          { kind: "list", path: "sources.ignore", label: "Ignore apps", placeholder: "e.g. msedge, vlc", help: "Comma-separated parts of app names." },
        ],
      },
      {
        title: "Spotify account (optional)",
        note: "Connect your own Spotify developer app for exact song info and sharp 640 px covers. Only used while Spotify is the player.",
        fields: [
          { kind: "text", path: "spotify.clientId", label: "Client ID", placeholder: "from developer.spotify.com/dashboard" },
          { kind: "custom", id: "spotify", label: "Account" },
        ],
      },
      {
        title: "Stream overlay (OBS)",
        note: "A local web page with the current line, for a Browser Source in OBS or Streamlabs. Only this PC can open it.",
        fields: [
          { kind: "toggle", path: "app.obs", label: "Serve the overlay page" },
          { kind: "slider", path: "app.obsPort", label: "Port", min: 1025, max: 65000, step: 1 },
          { kind: "custom", id: "obs", label: "Address" },
        ],
      },
      {
        title: "Lyrics source",
        fields: [
          { kind: "text", path: "provider.baseUrl", label: "LRCLIB server", placeholder: "https://lrclib.net/api" },
          {
            kind: "toggle",
            path: "provider.amll",
            label: "Word-synced lyrics from the community database",
            help: "When LRCLIB only has line timing, also check the AMLL TTML database (looks the song up on iTunes, then GitHub).",
          },
          { kind: "custom", id: "clear-cache", label: "Saved lyrics", help: "Lyrics are saved after the first lookup. Clear them to fetch fresh copies." },
        ],
      },
    ],
  },
  {
    id: "hotkeys",
    title: "Hotkeys",
    resets: ["hotkeys"],
    groups: [
      {
        title: "Global hotkeys",
        note: "Work from any app. Click a box and press the new keys; Backspace clears it.",
        fields: [
          { kind: "hotkey", path: "hotkeys.toggleWindow", label: "Show / hide lyrics" },
          { kind: "hotkey", path: "hotkeys.lock", label: "Lock / unlock (click-through)" },
          { kind: "hotkey", path: "hotkeys.offsetEarlier", label: "Lyrics earlier (+0.1 s, this song)" },
          { kind: "hotkey", path: "hotkeys.offsetLater", label: "Lyrics later (−0.1 s, this song)" },
          { kind: "hotkey", path: "hotkeys.nextMode", label: "Next display mode" },
          { kind: "hotkey", path: "hotkeys.openSettings", label: "Open settings" },
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
        note: "Records only the music app (Spotify or your browser) into memory, lined up with the song's timeline, for auto-sync and AI lyrics. Everything runs on this PC: the audio is never uploaded or saved unless you press Save. Off = no listening, no AI work, models unloaded.",
        fields: [
          { kind: "toggle", path: "ai.listen", label: "Listen to the player" },
          { kind: "slider", path: "ai.captureLatencyMs", label: "Timing correction", min: -500, max: 500, step: 5, unit: "ms", help: "Set automatically by Check timing." },
          { kind: "custom", id: "capture", label: "What MLP hears" },
        ],
      },
      {
        title: "Vocal isolation",
        note: "Separates the singing from the music in what MLP heard, which helps AI-written lyrics (auto-sync works on the full mix). Runs in the background on your PC.",
        fields: [{ kind: "custom", id: "vocals", label: "Vocals only" }],
      },
      {
        title: "Auto-sync",
        note: "Finds when each line is really sung and fixes lyrics that are early, late, too fast or too slow. Lines move into place as the song plays; next time the song plays they're right from the start.",
        fields: [
          { kind: "toggle", path: "ai.autoSync", label: "Line up lyrics with the singing" },
          {
            kind: "select",
            path: "ai.autoSyncWhen",
            label: "Check",
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
        note: "For songs no lyrics database has: MLP writes the lyrics with Whisper from what it hears (a little behind the singing on the first listen) and keeps them for next time. They can contain mistakes — fix them in Sync lyrics.",
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
        title: "Performance",
        note: "AI work runs in the background below normal priority. With fewer threads it takes longer but leaves more of the CPU free.",
        fields: [
          { kind: "slider", path: "ai.threads", label: "CPU threads (0 = automatic)", min: 0, max: 16, step: 1 },
          { kind: "toggle", path: "ai.lowPriority", label: "Run at low priority" },
          { kind: "toggle", path: "ai.pauseFullscreen", label: "Pause while a full-screen game or video runs" },
          { kind: "toggle", path: "ai.indicator", label: "Show what the AI is doing in the lyrics window" },
        ],
      },
      {
        title: "Models & data",
        fields: [{ kind: "custom", id: "aimodels", label: "Models" }],
      },
      {
        title: "Measure accuracy",
        note: "For checking and tuning the AI on your own songs. Nothing is uploaded.",
        fields: [{ kind: "custom", id: "aieval", label: "This song" }],
      },
    ],
  },
  {
    id: "advanced",
    title: "Advanced",
    resets: ["debug"],
    groups: [
      {
        title: "Accessibility",
        fields: [
          { kind: "toggle", path: "app.screenReader", label: "Read lyric lines to screen readers", help: "Announces each new line (for blind and low-vision listeners)." },
        ],
      },
      {
        title: "Backup",
        fields: [{ kind: "custom", id: "backup", label: "Settings file", help: "Copy your settings as text, or paste settings to restore them." }],
      },
      { title: "Diagnostics", fields: [{ kind: "toggle", path: "debug.overlay", label: "Show debug info in the lyrics window" }] },
    ],
  },
];

export const getPath = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
