# MLP privacy policy

MLP has no accounts, no analytics and no telemetry. It doesn't collect anything about you for itself.
To show lyrics it has to ask online services about the song that's playing; this page lists every
connection the app makes, what it sends and how to turn it off. Everything else stays on your PC.

## What goes where

| Service | When | What is sent | Turn it off |
|---|---|---|---|
| [LRCLIB](https://lrclib.net) | Every new song | Title, artist, album and length of the song, and the app name + version (`MLP/0.2.0`) | It's how lyrics are found. Settings → Players & lyrics → *LRCLIB server* can point to your own LRCLIB server |
| [Apple iTunes Search](https://performance-partners.apple.com/search-api) | New songs, for sharper cover art and to find word-synced lyrics | Title, artist and album | Settings → General → *Sharper cover art* and Settings → Players & lyrics → *Word-synced lyrics from the community database* |
| [AMLL TTML database](https://github.com/amll-dev/amll-ttml-db) (GitHub) | When LRCLIB has no word timing | The Apple Music track number of the song | Settings → Players & lyrics → *Word-synced lyrics from the community database* |
| [MyMemory](https://mymemory.translated.net) (on by default) or [DeepL](https://www.deepl.com) (your key) | Songs in another language than your translation language | The lyric lines to translate | Settings → Translation → *Show translations* off, or provider "only translations in the lyrics file" |
| LRCLIB publish | Only when you press *Publish to LRCLIB* in the sync editor | The lyrics and timing you made, with the song's title, artist, album and length | Don't press it |
| [Spotify](https://www.spotify.com) | Only if you connect your account (off by default) | Spotify login with your own app id; MLP reads what's playing | Settings → Players & lyrics → Spotify account → disconnect |
| GitHub Releases | Once a day | A request for the latest version number | Settings → General → *Look for updates once a day* |
| Hugging Face / GitHub | When you download an AI model, and the Japanese dictionary on the first Japanese song | A normal file download | Don't download the models; turn off Japanese romanization (Settings → Romanization) |

Every request also carries your IP address, as any internet connection does; the services' own
privacy policies apply to what they do with it.

## What stays on your PC

- **Player audio (AI listening, off by default):** captured only from the music app, kept in memory
  for the current song, never saved and never uploaded. *Save WAV* in Settings writes a file to
  your Downloads folder only when you press it.
- Lyrics, timing fixes, translations, settings and AI results are cached in
  `%APPDATA%\com.mlp.lyrics`. Settings → Players & lyrics → *Saved lyrics* clears saved lyrics, Settings → AI listening forgets AI data. Uninstalling removes the program; delete that folder to remove the data too.
- The OBS overlay (off by default) listens on `127.0.0.1` only, so only your own PC can reach it.

## Contact

Questions or concerns: open an issue at https://github.com/Purpleeds/MLP/issues.
