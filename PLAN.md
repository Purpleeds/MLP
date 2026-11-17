# MLP — Build Plan

Floating lyrics for Windows 11. Follows Spotify / YouTube Music and shows LRCLIB time-synced lyrics in an Apple Music / YT Music style window: always on top, draggable, rounded, opaque, tray icon near the clock, romanization (romaji / pinyin / Korean RR / other scripts), multiple display modes, everything configurable.

**Workflow:** user says "do step X" → do only that step → verify → update `CLAUDE.md` (Status + Log) → stop.
**Effort** = recommended reasoning effort for that step. Model stays **Opus 5.5** for every step.

## Architecture

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2 (Rust) | small exe, native WinRT access, tray / always-on-top / transparent window built in |
| UI | React + TypeScript + Vite | custom renderer + settings UI; previewable in a normal browser |
| Now playing | Windows GSMTC (`Windows.Media.Control`) via `windows` crate | Spotify, browsers (YT Music), YTM desktop all publish to it |
| Lyrics | LRCLIB (`/api/get`, `/api/search`) via `@tauri-apps/plugin-http` | open DB; line-synced + some word-synced (`lyricsfile`, `hasWordSync`) |
| Renderer | Custom DOM + WebGL background | AMLL rejected: AGPL-3.0, "not for production", pixi v7 deps, few styling hooks. Behavior reference only — never copy its code |
| Japanese | `Windows.Globalization.JapanesePhoneticAnalyzer` (Rust) → romaji via `wanakana` | built into Windows, zero dictionary size; kuromoji has Vite `.gz` issues and is ~12 MB |
| Chinese / Korean / other | `pinyin-pro` · Revised Romanization (lib or own) · `any-ascii` | |
| Settings | `@tauri-apps/plugin-store` JSON + schema-driven settings UI | live-apply across windows |

Rust is a thin native layer (GSMTC, Japanese readings, tray, window, fonts, extension bridge). All app logic lives in TS so it is unit-testable (vitest) and previewable in **mock mode** (plain browser → fake track + clock + sample lyrics).

Data flow: GSMTC / extension → `now-playing` event → NowPlaying store → LyricsService (cache → LRCLIB) → parse → timing → romanize → renderer (rAF + PlaybackClock).

```
src/            core/{platform,playback,lyrics,timing,romanize}  render/  app/ (main window)  settings/ (settings window)
src-tauri/src/  lib.rs  media.rs  japanese.rs  tray.rs  window.rs  fonts.rs  bridge.rs
extension/      YT Music bridge (Step 3, only if needed)
docs/ref/       reference screenshots: apple-music-1.png, apple-music-2.webp, youtube-music.webp
```

## Steps

### Step 1 — Scaffold + native window shell · effort: medium
- [x] `create-tauri-app` (React + TS, npm) in repo root; app "MLP", id `com.mlp.lyrics`; `git init` + `.gitignore`.
- [x] Main window: `decorations:false`, `transparent:true`, `shadow:false`, `alwaysOnTop:true`, `skipTaskbar:true`, resizable, min size, `visible:false` until first paint (no white flash). First launch: bottom-right, just above the taskbar near the clock.
- [x] Opaque rounded card (CSS radius var, `overflow:hidden`); html/body transparent. Fallback if edge artifacts: native Win11 corners (`shadow:true`, fixed radius).
- [x] Drag anywhere (`startDragging()` on mousedown, except `[data-no-drag]`), resize grips (`startResizeDragging`), no maximize on double-click.
- [x] Tray icon (notification area): left-click show/hide; menu: Show/Hide, Lock (click-through), Settings…, Quit.
- [x] Plugins: single-instance, window-state (remember pos/size), store.
- [x] Settings skeleton: typed schema + defaults + `useSettings()`; Tauri store ↔ localStorage in mock; cross-window change events.
- [x] Platform adapter + mock mode (`isTauri()`), sample track/lyrics fixtures; `.claude/launch.json` for the Vite dev server (built-in browser preview).
- Done when: `npm run tauri dev` shows a rounded opaque on-top window you can drag/resize, tray works; mock UI renders in the built-in browser.
- Skills: `run`, built-in browser.

### Step 2 — Now playing (GSMTC) + playback clock · effort: high
- [x] `media.rs`: `windows` crate (Media_Control, Foundation, Foundation_Collections, Storage_Streams); own MTA thread; events SessionsChanged / CurrentSessionChanged / MediaPropertiesChanged / PlaybackInfoChanged / TimelinePropertiesChanged + 1 s poll fallback.
- [x] Session pick: allowed sources (Spotify, Chrome/Edge/Brave/Opera/Firefox, YTM desktop/PWA AUMIDs), prefer Playing, priority + ignore list (settings).
- [x] Emit `now-playing` {sourceApp, kind, title, artist, album, durationMs, artwork data URL + hash, status, positionMs, updatedAt, rate, timelineOk}; command `media_control(play|pause|next|prev|seek)`.
- [x] TS `PlaybackClock`: pos = pos + (now − updatedAt) · rate while playing; slew small drift, snap > 300 ms; no timeline → 0 at track change + pause/resume tracking (`estimated` flag).
- [x] Debug overlay (source, title, pos/dur, drift).
- [x] Test Spotify + YT Music in the user's browser (pause/seek/skip). Log whether the browser timeline works → decides Step 3.
- Done when: correct track + position within ~0.3 s on Spotify; browser behavior recorded in CLAUDE.md.
- Note: 2021 reports say Chrome doesn't publish the SMTC timeline (Firefox ≥ 125 does) — verify on current Chrome/Edge.

### Step 3 — YT Music bridge extension · SKIPPED (Chromium publishes the SMTC timeline; revisit only if real Chrome misbehaves) · effort: medium
- [ ] MV3 extension (Chrome/Edge; Firefox-compatible) for `music.youtube.com`: `<video>` currentTime/duration/paused/rate + `mediaSession.metadata` (hi-res artwork) on timeupdate/seeked/play/pause + 1 s heartbeat.
- [ ] `bridge.rs`: WebSocket server on 127.0.0.1 only (shared token); merge: extension overrides SMTC for the matching browser track.
- [ ] Load-unpacked instructions.
- Done when: browser YT Music position drift < 100 ms through seeks.

### Step 4 — Lyrics provider (LRCLIB) + parsers + cache · effort: high
- [x] HTTP via plugin-http (scope: lrclib.net, itunes.apple.com); identify with `Lrclib-Client: MLP/<version>` (no personal data); sequential queue ≥ 250 ms apart, 8 s timeout, 2 retries, 429 → Retry-After + jitter.
- [x] Query cleanup: YT junk ("(Official Video)", "[MV]", "(Lyrics)", "Visualizer", "HD/4K", 【…】), " - Topic", "VEVO", "Artist - Title" split when artist is a channel, feat./ft. variants, "- Remastered 20xx".
- [x] Strategy: cache → `/api/get` (title, artist, album, duration) → without album → `/api/search` (track_name + artist_name) → `/api/search?q=` → score (title/artist similarity + duration Δ ≤ 3 s); prefer word-sync > synced > plain; honor `instrumental`.
- [x] Disk cache (app data `lyrics/`), negative cache 24 h, per-song pin (LRCLIB id) + per-song offset (`songs.json`).
- [x] Parsers → model `{kind: word|line|plain|instrumental, lines[{start, end, text, words?[{start,end,text}], bg?}]}`: LRC (multi-stamps, `[offset:]`, ms precision, empty stamped line = break), enhanced LRC `<mm:ss.xx>`, LRCLIB `lyricsfile` YAML (inspect a real `hasWordSync` record first).
- [x] Vitest: cleanup, scoring, parsers (fixtures incl. EN/JA/ZH/KO).
- Done when: sample queries (incl. messy YT titles) resolve correctly; tests pass.
- Skills: `engineering:testing-strategy` (quick pass); web search for edge cases.

### Step 5 — Timing engine (word fill follows the singing) · effort: high
- [x] Real word timings (lyricsfile / enhanced LRC) used as-is — exact "noooo" length.
- [x] Otherwise synthesize: split words (Latin by spaces + hyphen syllables; kana by mora with small kana/ー attached; Han per char; Hangul per block); weight = syllable estimate + elongation bonus (repeated letters "noooo"/"yeahhh", "~", "…") + final-word hold; distribute across the line.
- [x] Line end = min(next start − 50 ms, start + syllables / songPace × 1.25); songPace = median syllables/s of dense lines (clamped).
- [x] Interludes: gap ≥ 4 s → dots marker. Background vocals: parenthesized lines/segments → `bg`.
- [x] Offsets: global + per-song + per-source latency.
- [x] Tests: durations sum to line length, monotonic, held words get a longer share.
- Done when: tests pass; debug view shows plausible word timings on real songs.

### Step 6 — Apple-style lyrics renderer + backgrounds · effort: xhigh
- [x] Load `frontend-design` skill; compare against `docs/ref/*` throughout.
- [x] Line list (render only nearby lines) with word spans; active word fill = soft-edged gradient driven by a CSS var per frame (`background-clip:text`); sung / unsung / passed colors.
- [x] Motion: spring scroll with Apple-like stagger; distance-based blur / opacity / scale; smooth seek handling.
- [x] Emphasis on held words (≥ 1 s, short): glow + lift + per-letter wave ("noooo").
- [x] Interlude breathing dots; bg-vocal sub-lines; romanization sub-line slot (filled in Step 9).
- [x] States: loading, no lyrics (search button), instrumental, plain lyrics (static / time-proportional scroll).
- [x] Backgrounds (all opaque): Fluid (WebGL shader from album-art palette, FPS cap), Blurred art, Solid / Gradient (custom colors), Dark (YT style).
- [x] Presets: Apple Music, YouTube Music, Minimal.
- [x] Fonts: "SF Pro Display" → "Segoe UI Variable Display" → bundled Inter (OFL) + CJK fallbacks (Yu Gothic UI, Microsoft YaHei UI, Malgun Gothic).
- [x] Perf: rAF only while playing (200 ms idle poll when paused), style writes only on change, FPS caps. Measured ~60% of one core while playing (≈2.5% of machine), ~2% idle → deeper profiling in Step 11.
- Done when: mock-mode screenshots match the reference look; smooth on real playback; low CPU.
- Skills: `frontend-design`, built-in browser screenshots (mock mode).

### Step 7 — Display modes & layouts · effort: high
- [x] Modes: Full (art + title/artist + lyrics; side-by-side when wide, stacked when narrow) · Lyrics + title · Lyrics only · Now Playing card ("music profile": art + title/artist + progress) · Title only (marquee) · Mini karaoke (current + next line bar) · Custom (any element combo).
- [x] Element toggles: art, title, artist, album, progress, times, controls, lyrics, romanization, source icon.
- [x] Per-mode remembered window size; fade/slide transitions; switch via tray submenu, hotkey (Step 10), settings.
- [x] Optional controls (prev / play-pause / next / seek) → `media_control`.
- [x] Hi-res art: if thumbnail < 300 px → iTunes Search API lookup (cached; setting).
- [x] Idle behavior: hide / idle card / keep last song.
- Done when: every mode switches live and looks right small and large.
- Skills: `frontend-design`.

### Step 8 — Settings window (fully customizable) · effort: high
- [x] Second window `settings` (normal, decorated); open from tray.
- [x] Schema-driven UI (field defs → controls) so later steps just add fields; live apply to main window; versioned schema + migration; import/export JSON; reset per section.
- [x] Sections: General (autostart, show in taskbar, always on top, tray click action, idle behavior) · Window (radius, padding, opacity default 100 %, border, position presets incl. near clock, lock) · Mode & layout · Lyrics style (preset, font family/size/weight/line height/spacing, alignment, sung/unsung/passed/bg-vocal/glow colors, fill softness, blur, scale, spring stiffness/damping, emphasis, visible lines, interlude dots) · Background (type, colors, blur, flow speed, brightness, FPS) · Timing (global offset, word mode: estimated / linear sweep / line-only, source latency) · Sources (follow policy, priority, ignore list, bridge) · Provider (LRCLIB URL, prefer word-sync, clear cache) · Hotkeys · Advanced (debug overlay).
- [x] Font picker from installed fonts (`fonts.rs`, `fontdb` or `font-kit`).
- Done when: every setting persists across restart and applies live.
- Skills: `frontend-design`.

### Step 9 — Romanization · effort: high
- [x] Detect per song + per line: kana → JA; Hangul → KO; Han without kana → ZH; Cyrillic / Greek / Thai / Devanagari / Arabic / … → any-ascii.
- [x] JA: `japanese.rs` command `jp_readings` → Lindera + embedded IPADIC (WinRT analyzer returns nothing without the Japanese language pack) → [{display, yomi, pos, pos1}] → romaji via `wanakana` (particles は→wa / へ→e / を→o; verb endings attach, copulas separate; macron option).
- [x] ZH: `pinyin-pro` (tones: marks / numbers / none). KO: Revised Romanization with basic sound-change rules (search for a maintained lib first). Others: `any-ascii`.
- [x] Token mapping so word timings carry over to romanized text (karaoke fill works on romaji / pinyin).
- [x] Display: Romanized main + original below (default) · Original main + romanized below · Romanized only · Off. Cache per song.
- [x] Settings section (per-language toggles, tones, style).
- Done when: JA / ZH / KO test songs show correct-ish romanization with aligned fill.

### Step 10 — Power features · effort: medium
- [x] Global hotkeys (rebindable): show/hide, lock, offset ±100 ms (per song), next mode, settings.
- [x] Lock = click-through (`setIgnoreCursorEvents`); unlock from tray / hotkey; toast on change.
- [x] Hover toolbar: mode, lock, offset, search, settings.
- [x] Manual lyrics search dialog (LRCLIB candidates with sync type + duration) → pin; unpin / reset.
- [x] Autostart (start hidden to tray); tray: modes submenu, song tooltip; first-run tip to pin the tray icon (Win11 hides new icons in the overflow).
- Done when: all of the above work end-to-end.

### Step 11 — Hardening + release build · effort: high
- [x] Perf: profile the ~60%-of-a-core playing cost (GPU process ≈ 35%, renderer ≈ 20%); targets < 2 % CPU while playing, ~0 % idle, < 150 MB RAM; throttle when hidden / locked.
- [x] Edge cases checkable without a player (2026-11-17, mock UI): offline / LRCLIB down → no negative cache, retries on the `online` event and every 30 s (verified); 429 → own message; RTL (Arabic / Hebrew): `dir=rtl`, fill right to left, Latin runs isolated, mirrored side + interlude dots, sub-line stays under its line (verified on an Arabic LRCLIB song); emoji keep their colours inside the clipped fill (verified; Windows shows flags as letters); no letter-splitting for Arabic / Indic / emoji; syllable weights for Cyrillic / Greek / Arabic / Hebrew / Indic.
- [ ] (needs real playback by the user) Edge cases: YT ads / non-music videos / podcasts, source switching, replay.
- [ ] (needs real playback by the user) Test matrix: Spotify / Chrome / Edge / Firefox / YTM desktop × EN / JA / ZH / KO / other.
- [ ] Press-test global hotkeys by hand (registration verified; injected keys can't reach hotkeys from the agent session).
- [x] `/code-review` (high): 6 findings, all fixed (with-in-title stripping, stale metadata lookup, artwork resent per event, hotkey re-registration, offset race, WebGL context release).
- [x] App icons (`tauri icon`, source `docs/dev/icon-source.html`), README.
- [x] `npm run tauri build` → `target/release/mlp.exe` (55 MB, portable) + `bundle/nsis/MLP_0.1.0_x64-setup.exe` (10.3 MB); release smoke test in demo mode OK (lyrics, fill, romaji via Lindera).
- Done when: installer + exe built and smoke-tested.

## Phase 2 — AI listening (local, on your GPU)

Goal: (a) **Auto-sync** — listen to the player's audio and line the known lyrics up with the singing, word by word, correcting songs whose timing drifts or doesn't match (different version / tempo); (b) **AI lyrics** — transcribe songs that no database has. Everything runs locally; audio never leaves the PC and is never saved.

Hardware (checked 2026-11-16): RTX 5060 Ti 16 GB (Blackwell → CUDA 12.8+), 32 GB RAM, 28 threads.

Key facts from research:
- Whisper's own word timestamps are unreliable on music; forced alignment (CTC, WhisperX-style) is the robust way to time *known* text.
- Feeding separated vocals to Whisper can *hurt* long-form transcription; it tends to help alignment → make separation per-task and measure.
- Per-app audio capture: Windows process-loopback (`AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`, Win 11) — `wasapi` crate `new_application_loopback_client(pid, include_tree)`.
- `whisper-rs` (whisper.cpp) has a `cuda` feature (needs CUDA toolkit + LLVM/clang + cmake); Vulkan is the no-toolkit fallback.
- Lyrics can't be shown *before* they're heard on a first listen: live mode corrects upcoming lines from what was just heard; results are cached so the next play is exact.

### Step 12 — AI groundwork + feasibility spike · effort: high
- [x] Cargo feature `onnx` (default since Step 18; `--no-default-features` = small build). No toolkit installs needed: whisper.cpp ships as a downloaded sidecar (CUDA 12.4 build runs on the RTX 5060 Ti via PTX JIT).
- [x] Model manager (`ai.rs`): download on demand to app data with progress, resume (Range; stale part → restart), SHA-256 check before use (URLs pinned to a revision), delete; never bundled.
- [x] Spike → whisper.cpp `whisper-server` sidecar instead of whisper-rs (24.6 s audio in 0.84 s on the GPU after a ~70 s first-run JIT) + `ort` for HT-Demucs / MMS (CPU; see Step 14 for the GPU story).
- Done when: both runtimes work on the GPU in a test binary; numbers logged in CLAUDE.md.

### Step 13 — Player audio capture · effort: high
- [x] Map the GSMTC source (Spotify.exe / chrome / msedge …) to its process id; capture only that app via process loopback (no system sounds / notifications).
- [x] 16 kHz mono ring buffer (~10 min) in Rust; every chunk stamped with the PlaybackClock song position (audio time ↔ song time), seek/pause = discontinuity markers.
- [x] Debug view: live level meter + "captured 0:00–1:23 of this song".
- [x] Live check (2026-11-17, test page in the built-in browser → real GSMTC session + claude.exe capture): seek placed correctly, 39 beeps, median 79.6 ms late, p90 80.7 ms → constant output latency, fixed by Check timing's one-click correction (per player).
- Done when: captured audio lines up with song position within ±50 ms after seeks and pauses.

### Step 14 — Vocal isolation · effort: high
- [x] HT-Demucs FT vocals (ONNX, MIT, 158 MB download) per chunk; background streaming over captured audio (≥ 8 s blocks, 1 s context, 7.8 s segments with ¼ overlap-add); Settings → AI listening → Vocal isolation (download, on/off, device, speed, coverage, save WAV).
- [x] Speed: CPU 3.2× faster than real time (RTF 0.31, 28 threads; 2× within the default AI thread budget). GPU (2026-11-17): DirectML fails at run time with its graph fusion (`DmlFusedNode` E_OUTOFMEMORY) and without fusion hangs the GPU (DXGI_ERROR_DEVICE_HUNG) after returning wrong segments → CPU is the default, DirectML opt-in (`MLP_VOCALS_GPU=dml`), and a GPU failure redoes the whole block on the CPU. pyke's WebGPU ORT build doesn't link with VS 2022 (needs the MSVC 14.50 / VS 2026 STL) → needs your OK to install VS 2026 Build Tools; CUDA EP needs CUDA 13 + cuDNN (~1 GB) → not worth it for a lyrics app.
- [x] Quality on a known mix (TTS speech + synthetic band at 0 dB): SI-SDR 0 dB → 12 dB.
- [x] A/B on real songs (2026-11-17, YouTube Music in the built-in browser): alignment is *worse* on isolated vocals (晴天 53 vs 56/62 lines within 0.2 s, Super Shy 23 vs 32/42) → auto-sync always aligns on the full mix; AI lyrics are better on vocals (Super Shy CER 39 % vs 46 %) → isolation stays an option for AI lyrics only (off by default).
- Done when: isolation runs faster than real time and the A/B decision is logged.

### Step 15 — Auto-sync: align known lyrics to the singing · effort: xhigh
- [x] Forced alignment with MMS-300m forced aligner (ONNX int8, 317 MB, CPU within the AI thread budget) + CTC Viterbi with wildcard `<star>` edges (lines inside ±2.5–6 s windows, unrelated singing absorbed); text side = our romanizer (romaji / pinyin without tones / RR / any-ascii). TTS lines in a clip with unrelated lines around: line starts within ±40 ms (clean and 0 dB synthetic band), wrong / cut-off text scores −2.5…−8 vs ≈0.
- [x] Live mode: engine (`src/core/ai/engine.ts`) plans windows over captured (or isolated) audio → `ai_align` → confidence gate (≥ 60 % words, median ≥ −1.5) → anchors → RANSAC time map (tempo 0.8–1.25 + offset, local residual for cut sections) → upcoming lines follow the map. Simulated drift (lyrics 4 % fast, 1.5 s late): next-line prediction median < 150 ms.
- [x] Everything heard → per-line fixes saved per song (songs.json `aiSync`, tied to the lyrics text) → exact on the next play; Settings → AI listening → Auto-sync (model download, progress, tempo/offset, forget per song). Per-song manual offset is ignored while AI timing applies.
- [x] Sync editor → "Timing from auto-sync": the saved AI timing as (enhanced) LRC to review, "Use on this song" or publish to LRCLIB (user decides; unaligned lines flagged as estimated).
- [x] Line-synced (word times from the aligner; Latin words 1:1, other scripts by position) and word-synced (source word timings kept, line moved) lyrics.
- [x] Plain (unsynced) lyrics: placeholder times from singing length, sequential planner (next lines searched in the ~24 s after the last one found, +10 s per miss, give up after 6), shown synced once lines are found, saved per song.
- [x] Real songs (2026-11-17): first run found 6–9 of ~60 lines. Causes: (1) blanks inside a line were free, so with ±5 s windows a line's letters spread out and it landed ~2.5 s early (oracle ±1 s windows were fine: 61/62 lines, word starts 45 ms) → `blankPenalty` −1.15 (lines within 0.2 s: 5 → 56/62 晴天, 2 → 32/42 Super Shy; −0.75 and ≤ −2 fail); (2) real singing scores ≈ −2.25 (wrong ≈ −3.0), the −1.5 gate rejected almost every right line → gate −2.9 / −3.2 + `dropOutliers` (700 ms off the map); (3) one wrong anchor shifted the whole song (晴天 −10.8 s) → the map needs two agreeing anchors; (4) engine bug: an interrupted song switch filed the previous song's fixes under the new one → `own()` guard. Live on Rick Astley (YouTube Music): lines found, map +0.87 s = that upload's offset vs LRCLIB and Apple.
- Done when: on the test set median word-start error < 150 ms after one listen, and drifting songs stay in sync live.

### Step 16 — AI lyrics for songs no database has · effort: high
- [x] Whisper large-v3-turbo q5 via whisper-server (CUDA build runs on the RTX 5060 Ti, auto CPU fallback; `-sns`, thread cap, below-normal priority); 28 s chunks over captured audio (or isolated vocals), a cut-off last segment is redone with the next chunk, paused → flush once; language detected then locked (p ≥ 0.7) and the last line passed as prompt. Hallucination filters: subtitle/outro phrases (EN/JA/ZH/KO/RU/DE/FR), sound tags, no-speech + low log-prob, impossible speed, repeat loops (also CJK), 3rd identical segment in a row. VAD: not used (filters + vocals instead).
- [x] Live display with an "AI" badge (lines appear after each chunk, ~30 s behind on the first listen); Step 15 auto-sync aligns AI lines too (fixes keyed by song, kept while lines are appended); saved per song (songs.json `aiLyrics`).
- [x] "Fix in Sync editor": the sync editor starts from the AI lyrics when no lyrics exist → correct text → sync → publish (user decides).
- [x] E2E in the real app (fake capture of 47 s TTS speech): 2 chunks, 16 lines word-perfect, 3.1 s per 28 s chunk on the GPU, auto-sync then aligned every line (scores ≈ 0).
- [x] Real songs: Super Shy CER 46 % (mix) / 39 % (vocals) — usable as a draft for songs nobody has lyrics for, not as final text.
- Done when: test songs without lyrics show readable, timed AI lyrics; nothing is sent anywhere.

### Step 17 — AI settings, UX, performance · effort: high
- [x] Settings → AI listening: listen (master), vocal isolation, auto-sync (+ which lyrics: all / only line-synced / stop once in time), AI lyrics (model, GPU/CPU/auto), Performance (CPU threads 0 = auto, low priority, pause while full-screen, status pill), Models & data (every engine/model with size, download/delete, disk use, GPU name; forget AI data for all songs).
- [x] Status pill in the lyrics window (listening · syncing n/m · writing lyrics · paused · problem), download-finished/failed toasts; full-screen pause for auto-sync, AI lyrics and the vocal-isolation worker (`perf::paused`); ORT threads capped + low-priority worker threads; whisper-server `-t` + below-normal priority class (restarts when limits change).
- [x] Privacy note in Settings (AI section) + README.
- [x] Idle cost ≈ 0 with listening off: no capture, vocals worker stopped, `ai_unload` frees the aligner and stops whisper-server; engines only keep a cheap 1.5–2 s check.
- Done when: everything is switchable and idle cost is ~0 with AI off.

### Step 18 — Evaluation, tuning, release · effort: high
- [x] Measuring tool in the app (Settings → AI listening → Measure accuracy): on a played song with word-synced lyrics (AMLL / LRCLIB word sync = ground truth) it runs auto-sync on a drifting line-synced copy (3 % fast, 1.5 s early) and Whisper on the same audio → word/line start error (median, p90, share ≤ 150 ms) and WER (Latin) / CER (CJK); results kept in eval-log.json, "Copy results". `core/ai/evaluate.ts` tested.
- [x] Tuning on what can be measured here: star log-prob −1 (no edge eating), accept gate (≥ 60 % words, median ≥ −1.5, mean ≥ −2.2; wrong text scores −2.5…−8), RANSAC tempo fit (tie → lowest error), margins 6 → 12 → 2.5 s, 28 s Whisper chunks, line splitting (≤ 12 words / 20 CJK chars, split at ≥ 1.5 s pauses or commas, never a < 3-word scrap). Synthetic results: line starts ±40 ms (clean + 0 dB band), drift prediction median < 150 ms, AI text word-perfect on TTS.
- [x] Real-song test set (2026-11-17, "Measure this song" = lyrics 3 % fast + 1.5 s early, app code): 晴天 (ZH, Apple word timing) 1 → 57/62 lines, line starts median 106 ms / p90 166 ms, words median 107 ms (83 % ≤ 150 ms); Super Shy (KO/EN, LRCLIB lines) 9 → 38/80 lines, median 144 ms / p90 319 ms. Rick Astley (EN, LRCLIB words) 27/58 lines, all ≈ +0.84 s (p90 0.91 s) = that YouTube upload's own offset vs LRCLIB and Apple, spread < 0.1 s; Young Girl A (JA, Vocaloid, LRCLIB lines) 18/44 lines, median 118 ms / p90 390 ms. Live in the app (real player): Rick Astley ≈ half the lines placed, map +0.86–0.93 s; Young Girl A lines 0–7 in a row. Tooling: `debug_load_audio` + saved WAVs re-run any change without replaying.
- [x] Release build with the AI built in (`onnx` default feature, models downloaded on demand); installer carries DirectML.dll + MSVC C++ runtime app-local (`scripts/prepare-redist.mjs` + `windows/hooks.nsh`); README updated.
- [x] Installer check on a clean PC (2026-11-17, Windows Sandbox: no VC++ runtime): installs per-user in 5 s without admin, app-local DirectML + MSVC DLLs load, window shows by the clock, second instance hands over, uninstall removes everything.
- Done when: metrics meet Step 15/16 targets and the installer works on a clean PC.

## Risks
- Browser timeline via SMTC may be missing or stale → Step 3 extension.
- Word timing is estimated when LRCLIB only has line sync; exact only for `hasWordSync` records.
- Japanese kanji readings in lyrics can be artistic or irregular → analyzer guesses may be wrong.
- Transparent frameless window quirks on Win11 (border / shadow) → native-corner fallback.
- LRCLIB rate limits → cache + sequential queue.

## References
- Process loopback capture: https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params · wasapi-rs: https://github.com/HEnquist/wasapi-rs
- whisper-rs: https://lib.rs/crates/whisper-rs · WhisperX forced alignment: https://www.isca-archive.org/interspeech_2023/bain23_interspeech.pdf · Source separation vs Whisper: https://arxiv.org/html/2506.15514v1
- LRCLIB API: https://lrclib.net/docs (raw: docs.md)
- AMLL (behavior reference only, AGPL-3.0): https://github.com/amll-dev/applemusic-like-lyrics
- GSMTC: https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager
- JapanesePhoneticAnalyzer: https://learn.microsoft.com/en-us/uwp/api/windows.globalization.japanesephoneticanalyzer
- Chrome SMTC timeline report: https://bugzilla.mozilla.org/show_bug.cgi?id=1698283 · Firefox fix: https://bugzilla.mozilla.org/show_bug.cgi?id=1689538
- win-gsmtc (pattern reference): https://lib.rs/crates/win-gsmtc
- kuromoji + Vite `.gz` issue: https://zenn.dev/inaniwaudon/scraps/dffdc876ccaf6d
