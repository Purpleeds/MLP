# Possible upgrades

Effort = suggested reasoning effort if built as a step (model stays Opus 5.5).

## Lyrics quality
| # | Upgrade | Why | Effort |
|---|---|---|---|
| 1 | ✅ done — Extra word-synced source: community **AMLL TTML database** (open, GitHub) as a fallback after LRCLIB | Many more songs with real per-word timing, duets and background vocals | high |
| 2 | ✅ done — **Sync it yourself**: tap a key on each line/word while the song plays, then publish to LRCLIB | Fixes songs that only have plain lyrics, and helps everyone | high |
| 3 | ✅ done — **Translation line** under the lyrics (local model or an API key you provide) | Understand foreign songs, not just read them | medium |
| 4 | ✅ done — **Furigana** (small readings above kanji) as an alternative to full romaji | Closer to how Japanese lyric videos look | medium |
| 5 | ✅ done — Duet colours: different colour per singer when the lyrics say who sings | Clearer duets / features | medium |
| 6 | ✅ done — Better romanization: Cantonese (jyutping), proper Thai (RTGS), Korean pronunciation rules (않아 → ana) | More accurate reading | medium |

## Player & sync
| # | Upgrade | Why | Effort |
|---|---|---|---|
| 7 | ✅ done — Optional **Spotify login** (official Web API) | Exact track IDs, perfect matching, HD cover art | high |
| 8 | ✅ done — Skip YouTube Music ads and non-music videos (no album / "Advertisement") | No wrong lyrics during ads | low |
| 9 | ✅ done — Click a lyric line to jump the song there (Apple-style) | Fast replay of a part | low |
| 10 | ✅ done — Auto-learn timing offset per app (remember your corrections) | Fewer manual nudges | medium |

## Look & modes
| # | Upgrade | Why | Effort |
|---|---|---|---|
| 11 | ✅ done — **Overlay mode**: no card, outlined text floating over games/videos, click-through by default | Karaoke over anything | medium |
| 12 | ✅ done — **Taskbar bar**: thin lyrics strip docked right above the taskbar / next to the clock | Always visible, takes no space | high |
| 13 | ✅ done — Theme gallery: save, share and import themes; accent colour taken from the cover | Easier customizing | medium |
| 14 | ✅ done — Share card: export the current line + cover as an image | Share favourite lines | low |
| 15 | ✅ done — Snap to screen edges and remember position per monitor | Tidier multi-monitor use | low |

## App & performance
| # | Upgrade | Why | Effort |
|---|---|---|---|
| 16 | 🟡 auto-update ✅ (0.2.0 released on GitHub, feed built in, signature verified); code signing not done (needs a certificate) — **Auto-update** from GitHub Releases + code signing | No SmartScreen warning, updates by themselves | medium |
| 17 | ✅ done — Download the Japanese dictionary only when a Japanese song plays | exe 55 MB → ~10 MB | medium |
| 18 | ✅ done — Battery saver: lower frame rate on battery, pause when the window is covered | Less CPU / GPU | low |
| 19 | ✅ done — OBS / stream overlay: local web page or WebSocket with the current line | Streamers can show lyrics | medium |
| 20 | ✅ done — Settings UI in more languages; accessibility (screen reader, high contrast) | Reach more people | medium |
| 21 | ✅ builds on GitHub CI for macOS (dmg) and Linux (deb, AppImage); not tried on a real Mac / Linux PC — macOS / Linux builds (MediaRemote / MPRIS instead of Windows media controls) | Other platforms | high |
