# MLP — floating lyrics for Windows

A small always-on-top window that shows time-synced lyrics for whatever Spotify or YouTube Music is playing. Lines fill word by word as they're sung, in an Apple Music–style view (or a YouTube Music–style one), and lyrics in Japanese, Chinese, Korean and other scripts can be shown romanized.

![MLP showing lyrics](docs/dev/step6-real-app.png)

## Features

- **Follows your player** through Windows media controls: Spotify, YouTube Music in Chrome / Edge / Firefox, and the YouTube Music desktop app.
- **Lyrics from [LRCLIB](https://lrclib.net)** (open, community-run). Messy YouTube titles are cleaned up before searching; results are cached.
- **Second source for word timing**: when LRCLIB only has line timing, MLP checks the community [AMLL TTML database](https://github.com/amll-dev/amll-ttml-db) (CC0) for word-synced lyrics, including background vocals and duets.
- **Sync it yourself**: Settings → Sync lyrics — tap along (per line, or per word holding the key for long notes), use the result right away, and optionally publish it to LRCLIB.
- **Word-by-word fill.** Exact when LRCLIB has word timing, otherwise estimated from syllables, so held words like "noooo" fill slowly and glow.
- **Romanization**: Japanese → romaji, Chinese → pinyin, Korean → Revised Romanization, plus Cyrillic, Greek, Thai, Arabic, Hindi and more. Shown above or below the original, or instead of it.
- **Display modes**: full (cover + info + lyrics), lyrics + title, lyrics only, now-playing card, title only, mini karaoke bar, or your own mix.
- **Looks**: flowing album-color background, blurred cover, dark, solid or gradient; presets for Apple Music, YouTube Music and Minimal; fonts, colors, blur, motion and timing are all adjustable.
- **Window**: frameless, rounded, opaque, draggable, resizable, always on top, tray icon by the clock, click-through lock, optional auto-hide when nothing is playing (Settings → General).
- **Light mode** for laptops and integrated graphics (Settings → General → Performance): static cover background, 30 fps, no blur; AI listening keeps only auto-sync on 2 CPU threads. It turns on by itself the first time MLP starts on a PC without a graphics card.
- **Hotkeys** (change them in Settings → Hotkeys):

  | Action | Default |
  |---|---|
  | Show / hide | Ctrl+Alt+L |
  | Lock / unlock click-through | Ctrl+Alt+K |
  | Lyrics earlier / later for this song (0.1 s) | Ctrl+Alt+Up / Down |
  | Next display mode | Ctrl+Alt+Shift+M |
  | Settings | Ctrl+Alt+S |

- **Wrong lyrics?** Hover the window → search icon (or Settings → This song) to search LRCLIB and pick the right ones, or nudge the timing.

## Install

Download `MLP_x.y.z_x64-setup.exe` from Releases and run it (no admin needed). Windows 11 includes the WebView2 runtime the app uses.

Windows hides new tray icons under the **^** arrow near the clock — drag the MLP icon onto the taskbar to keep it visible.

## Use

1. Start MLP and play a song in Spotify or YouTube Music.
2. Drag the window anywhere; resize from its edges.
3. Right-click the tray icon for display modes, lock, settings and quit. Left-click shows or hides the window.

## macOS and Linux

The app also builds for macOS (dmg) and Linux (deb, AppImage) — `.github/workflows/build.yml` builds and tests all three on GitHub. There it follows players through MPRIS (Linux) or AppleScript for Spotify and Music (macOS). Listening to the player (AI auto-sync, AI lyrics), the taskbar bar and the covered-window check are Windows-only for now. These builds haven't been tried on a real Mac or Linux PC yet.

## Build from source

Requirements: Windows 10/11, Node.js 20+, Rust (stable, MSVC) and Visual Studio C++ build tools.

```bash
npm install
npm run tauri dev      # run with hot reload
npm test               # TypeScript unit tests
npm run tauri build    # installer in src-tauri/target/release/bundle/nsis
```

`npm run dev` serves the UI alone in a browser with a built-in demo song (`?song=Artist|Title|durationMs`, `?mode=full`, `?preset=ytmusic`, `?window=settings` are handy for UI work).

The AI features (vocal isolation, auto-sync) are built in by default (ONNX Runtime); `cargo build --no-default-features` makes a smaller app without them. The installer puts `DirectML.dll` and the MSVC C++ runtime next to `mlp.exe` (`scripts/prepare-redist.mjs`, `src-tauri/windows/hooks.nsh`). AI models and the Whisper engine are downloaded from Settings → AI listening, not bundled.

Dev aids (debug builds): `MLP_MOCK=1` (demo song in the app), `MLP_MOCK=ai` (demo song as a real track → AI lyrics), `MLP_FAKE_CAPTURE="file.wav|sourceApp|artist|title"` (pretend that audio was heard), `MLP_DEV_MULTI=1` (run beside an installed copy).

## How it works

- `src-tauri/` (Rust, Tauri 2): reads now-playing info from Windows (GSMTC), Japanese readings (Lindera + IPADIC), tray, windows, global hotkeys.
- `src/` (React + TypeScript): lyrics search and parsing, timing engine, romanization, the lyric renderer, backgrounds and the settings window.

## Privacy

MLP sends the title, artist, album and length of the playing song to LRCLIB to find lyrics, and to Apple's iTunes Search to find sharper cover art and the Apple Music id used for the community lyrics database (both can be turned off in Settings). The community lyrics files come from GitHub. Lyrics you sync are only published to LRCLIB when you press Publish. If you connect your own Spotify developer app (optional), MLP asks Spotify's Web API what is playing.

AI listening (off by default) records only the music app's audio into memory while a song plays. Vocal isolation, auto-sync and AI lyrics run on your PC (ONNX Runtime and whisper.cpp); the audio is never uploaded or saved to disk unless you press "Save". Models are downloaded once from Hugging Face / GitHub when you ask for them. Nothing else leaves your PC.

## Credits

Lyrics: LRCLIB, AMLL TTML DB. AI models: HT-Demucs FT (MIT), MMS-300m forced aligner (Meta, CC-BY-NC 4.0), Whisper large-v3 turbo via whisper.cpp (MIT). Libraries: Tauri, React, Lindera with IPADIC, pinyin-pro, WanaKana, @romanize/korean, any-ascii, Inter typeface. The look is inspired by Apple Music and YouTube Music; no code or assets from them are used.
