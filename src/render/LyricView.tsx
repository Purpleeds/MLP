// Lyrics area: picks the state (loading / synced / plain / instrumental / none) and mounts the renderer.
import { useEffect, useMemo, useRef, useState } from "react";
import type { NowPlaying } from "../core/playback/clock";
import { clock, mediaControl } from "../core/playback/nowPlaying";
import type { Lyrics } from "../core/lyrics/model";
import { useLyrics, useSongOffset } from "../core/lyrics/service";
import { useSettings } from "../core/settings/store";
import type { Settings } from "../core/settings/schema";
import type { Timeline } from "../core/timing/timeline";
import { jpDictVersion, onJpDict, romanizeLyrics, type RomanLine } from "../core/romanize";
import { romanTimeline } from "../core/romanize/timeline";
import type { TranslateDeps } from "../core/translate";
import { getTranslations } from "../core/translationFiles";
import { displayMeta } from "../core/display";
import { isTauri, platform } from "../core/platform";

/** fetch for translation services: plain fetch (CORS) for MyMemory, Tauri's HTTP client for DeepL (no CORS). */
const translationFetch: TranslateDeps["fetchJson"] = async (url, init) => {
  const useTauri = isTauri() && url.includes("deepl.com");
  const f = useTauri ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
  const res = await f(url, init);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, json };
};
import { lyricTime, totalOffsetMs } from "../core/timing/offset";
import { adMarker, isAd, isLongVideo } from "../core/playback/ads";
import { useAutoSync, useSyncView } from "../core/ai/engine";
import { setLineProvider } from "../core/currentLine";
import { fpsCaps, usePower } from "../core/power";
import { lineAt } from "../core/timing/timeline";
import { applySync, plainToLines } from "../core/ai/autosync";
import { useAiLyrics } from "../core/ai/aiLyrics";
import { AiLyricsMessage } from "./AiLyricsMessage";
import { MOCK_TRACK } from "../core/mock/fixtures";
import { LyricRenderer, type RendererOptions } from "./LyricRenderer";

const MOCK_LYRICS: Lyrics = {
  kind: "line",
  source: "lrclib",
  id: 0,
  trackName: MOCK_TRACK.title,
  artistName: MOCK_TRACK.artist,
  durationMs: MOCK_TRACK.durationMs,
  lines: MOCK_TRACK.lines
    .map(([start, text], i, all) => ({ start, end: all[i + 1]?.[0] ?? MOCK_TRACK.durationMs, text, words: null }))
    .filter((l) => l.text)
    // Mock dev aid `?duet`: alternate singers (1, 2, together) to preview duet colours.
    .map((l, i) => (typeof location !== "undefined" && /[?&]duet\b/.test(location.search) ? { ...l, voice: [1, 2, 0][i % 3], duet: i % 3 === 1 } : l)),
};

/** Rough script of the lyrics → `lang` for CJK font selection (refined in Step 9). */
export function detectLang(text: string): string | undefined {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (/\p{Script=Han}/u.test(text)) return "zh";
  return undefined;
}

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function rendererOptions(s: Settings): RendererOptions {
  const l = s.lyrics;
  return {
    anchor: l.anchor,
    lineGap: l.lineGap,
    blur: l.blur,
    blurStep: l.blurStep,
    blurMax: l.blurMax,
    inactiveScale: l.inactiveScale,
    spring: l.spring,
    springStiffness: l.springStiffness,
    springDamping: l.springDamping,
    stagger: l.stagger,
    lift: l.lift,
    emphasis: l.emphasis,
    glowColor: l.glowColor,
    interludeDots: l.interludeDots,
    edgeFade: l.edgeFade,
    align: s.appearance.align,
    reducedMotion: reduced(),
    fps: l.fps,
  };
}

export type LyricVariant = "normal" | "mini" | "overlay" | "bar";

function SyncedLyrics({ timeline, offsetMs, lang, variant, canSeek }: { timeline: Timeline; offsetMs: number; lang?: string; variant: LyricVariant; canSeek?: boolean }) {
  const s = useSettings();
  const host = useRef<HTMLDivElement>(null);
  const r = useRef<LyricRenderer | null>(null);
  const offset = useRef(offsetMs);
  offset.current = offsetMs;
  const caps = fpsCaps(usePower(), s.app.batterySaver);
  const opts = useMemo(() => {
    const o: RendererOptions = {
      ...rendererOptions(s),
      fps: caps.lyrics ? Math.min(s.lyrics.fps, caps.lyrics) : s.lyrics.fps,
      // Upgrade 9: click a line to jump there (lyric time = position + offset).
      onLineClick: canSeek && s.lyrics.clickToSeek ? (start: number) => void mediaControl({ action: "seek", ms: Math.max(0, start - offset.current) }) : null,
    };
    // Mini karaoke: current line at the top, next line below, nothing else.
    if (variant === "mini") return { ...o, anchor: 0.06, blur: false, edgeFade: false, inactiveScale: 1, stagger: 0, lineGap: 0.35, window: 1 };
    // Overlay: current + next line, centred, nothing blurred (Upgrade 11).
    // Taskbar bar: just the line being sung, shrunk to fit (Upgrade 12).
    if (variant === "bar") return { ...o, anchor: 0, blur: false, edgeFade: false, inactiveScale: 1, stagger: 0, lineGap: 0, window: 0, fitWidth: true, interludeDots: false };
    if (variant === "overlay") return { ...o, anchor: 0.08, blur: false, edgeFade: false, inactiveScale: 0.92, stagger: 0, lineGap: 0.3, window: 1, align: "center" as const };
    return o;
  }, [s, variant, canSeek, caps.lyrics]);

  useEffect(() => {
    r.current = new LyricRenderer(host.current!, () => lyricTime(clock.position(), offset.current), opts);
    return () => {
      r.current?.destroy();
      r.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; options/timeline pushed below
  }, []);
  useEffect(() => r.current?.setOptions(opts), [opts]);
  useEffect(() => r.current?.setTimeline(timeline), [timeline]);
  // Share card (Upgrade 14): the line being sung now.
  useEffect(() => {
    setLineProvider(() => {
      const t = lyricTime(clock.position(), offset.current);
      const i = lineAt(timeline.lines, t);
      const l = timeline.lines[Math.max(0, i)];
      const next = timeline.lines.slice(Math.max(0, i) + 1).find((x) => !x.bg);
      return l
        ? { text: l.text, sub: l.sub, start: l.start, end: l.end, words: l.fill === "none" ? [] : l.words.map((w) => ({ s: w.start, e: w.end })), next: next?.text, t }
        : null;
    });
    return () => setLineProvider(null);
  }, [timeline]);
  useEffect(() => r.current?.kick(), [offsetMs]);

  return <div ref={host} className="lr-root" lang={lang} />;
}

function PlainLyrics({ text, durationMs, autoScroll }: { text: string; durationMs: number; autoScroll: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const userAt = useRef(0);
  useEffect(() => {
    if (!autoScroll) return;
    const id = setInterval(() => {
      const el = ref.current;
      if (!el || !durationMs || performance.now() - userAt.current < 4000) return;
      const k = Math.min(1, Math.max(0, (clock.position() - 8000) / Math.max(1, durationMs - 20000)));
      el.scrollTo({ top: k * (el.scrollHeight - el.clientHeight), behavior: "smooth" });
    }, 1000);
    return () => clearInterval(id);
  }, [durationMs, autoScroll]);
  return (
    <div ref={ref} className="lr-plain" lang={detectLang(text)} onWheel={() => (userAt.current = performance.now())}>
      <p className="lr-plain-note">These lyrics aren't time-synced.</p>
      {text}
    </div>
  );
}

function Message({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="lr-message">
      <p className="lr-message-title">{title}</p>
      {detail && <p className="lr-message-detail">{detail}</p>}
    </div>
  );
}

function Loading() {
  return (
    <div className="lr-loading" aria-label="Looking for lyrics">
      <span style={{ width: "72%" }} />
      <span style={{ width: "54%" }} />
      <span style={{ width: "64%" }} />
    </div>
  );
}

/** Plain lyrics: auto-sync lines them up in the background; once lines are found they're shown synced. */
function PlainWithSync({ lyrics, np, variant }: { lyrics: Lyrics; np: NowPlaying; variant: LyricVariant }) {
  const s = useSettings();
  const lines = useMemo(() => plainToLines(lyrics), [lyrics]);
  const enabled = s.ai.autoSync && isTauri() && lines.lines.length > 0;
  useAutoSync(enabled ? np : null, lines, enabled);
  const sync = useSyncView(enabled ? lines : null);
  if (!sync) return <PlainLyrics text={lyrics.plain ?? ""} durationMs={np.durationMs || lyrics.durationMs} autoScroll={s.lyrics.plainAutoScroll} />;
  return <Timed lyrics={lines} np={np} variant={variant} external />;
}

function Timed({ lyrics, np, variant, mock, external }: { lyrics: Lyrics; np: NowPlaying; variant: LyricVariant; mock?: boolean; external?: boolean }) {
  const s = useSettings();
  const live = useSongOffset(np);
  const songOffsetMs = mock ? 0 : live;
  const ro = s.romanization;
  const [roman, setRoman] = useState<{ for: Lyrics; lines: (RomanLine | null)[] } | null>(null);
  // Re-romanize when the Japanese dictionary finishes downloading (Upgrade 17).
  const [dictV, setDictV] = useState(jpDictVersion());
  useEffect(() => onJpDict(() => setDictV(jpDictVersion())), []);
  useEffect(() => {
    if (ro.mode === "off") return;
    let alive = true;
    void romanizeLyrics(lyrics, ro).then((lines) => alive && setRoman({ for: lyrics, lines }));
    return () => {
      alive = false;
    };
  }, [lyrics, ro, dictV]);
  const romanLines = roman?.for === lyrics ? roman.lines : null;
  const tro = s.translation;
  const troSig = JSON.stringify({ ...tro, deeplKey: undefined }); // what the shown lines depend on
  const keySig = `${troSig}|${tro.deeplKey}`;
  const meta = displayMeta(np);
  const [trans, setTrans] = useState<{ for: Lyrics; sig: string; lines: (string | null)[] } | null>(null);
  const [trRun, setTrRun] = useState(0); // bumped by resets and by coming back online
  useEffect(() => {
    const off = platform.on("translations-reset", () => setTrRun((n) => n + 1));
    const online = () => setTrRun((n) => n + 1);
    window.addEventListener("online", online);
    return () => {
      void off.then((f) => f());
      window.removeEventListener("online", online);
    };
  }, []);
  const lastTr = useRef<{ lyrics: Lyrics | null; sig: string }>({ lyrics: null, sig: "" });
  useEffect(() => {
    if (!tro.enabled || mock) return;
    let alive = true;
    // Debounce typing in the DeepL key field and AI lyrics that grow line by line; songs start at once.
    const prev = lastTr.current;
    const wait = prev.lyrics === lyrics && prev.sig !== keySig ? 900 : lyrics.source === "ai" && prev.lyrics ? 1500 : 0;
    lastTr.current = { lyrics, sig: keySig };
    const t = setTimeout(() => {
      void getTranslations(lyrics, meta, tro, { fetchJson: translationFetch })
        .then((r) => alive && setTrans({ for: lyrics, sig: troSig, lines: r.lines }))
        .catch((e) => platform.log(`translation: ${e}`));
    }, wait);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run when the song, translation settings or a reset change
  }, [lyrics, keySig, mock, trRun]);
  const transLines = useMemo(() => {
    if (!tro.enabled || !trans || trans.sig !== troSig) return null;
    if (trans.for === lyrics) return trans.lines;
    // AI lyrics growing: keep showing the lines already translated while the new ones are fetched.
    if (lyrics.source !== "ai" || trans.for.source !== "ai" || trans.for.trackName !== lyrics.trackName) return null;
    const byText = new Map(trans.for.lines.map((l, i) => [l.text, trans.lines[i]]));
    return lyrics.lines.map((l) => byText.get(l.text) ?? null);
  }, [tro.enabled, trans, troSig, lyrics]);
  const base = useMemo(
    () => romanTimeline(lyrics, romanLines, ro.mode, s.timing.wordMode, transLines),
    [lyrics, romanLines, ro.mode, s.timing.wordMode, transLines],
  );
  // Auto-sync (Step 15): lines heard so far take their sung times, the rest follow the time map.
  useAutoSync(mock || external ? null : np, lyrics, s.ai.autoSync && !external);
  const sync = useSyncView(s.ai.autoSync ? lyrics : null);
  const timeline = useMemo(() => (sync ? applySync(base, lyrics, sync.lines, sync.fixes, sync.map) : base), [base, lyrics, sync]);
  const lang = useMemo(() => detectLang(lyrics.lines.map((l) => l.text).join("")), [lyrics]);
  // AI timing already includes what the per-song offset used to fix.
  return <SyncedLyrics timeline={timeline} offsetMs={totalOffsetMs(s, np, sync ? 0 : songOffsetMs)} lang={lang} variant={variant} canSeek={np.canSeek} />;
}

/** How long the lyrics run (the record's duration, or the last line when that's later). */
const lyricsLength = (l: Lyrics) => Math.max(l.durationMs || 0, ...l.lines.map((x) => x.start));

export function LyricView({ np, variant = "normal" }: { np: NowPlaying; variant?: LyricVariant }) {
  const s = useSettings();
  const skip = s.sources.skipAds !== false && np.sourceKind !== "mock";
  const adNow = skip && adMarker(np);
  const longVideo = skip && isLongVideo(np);
  const st = useLyrics(adNow || longVideo ? null : np);
  // Step 16: no lyrics anywhere → write them with AI from what MLP hears.
  const aiWanted = st.status === "notfound" && s.ai.lyrics && !adNow && !longVideo && np.sourceKind !== "mock";
  const ai = useAiLyrics(np, aiWanted);
  let body;
  if (adNow || (skip && st.status === "found" && isAd(np, lyricsLength(st.lyrics)))) body = <Message title="Ad" detail="Lyrics continue after the ad." />;
  else if (longVideo) body = <Message title="Long video" detail="Lyrics are looked up for songs, not for mixes, streams or videos over 15 minutes." />;
  else if (st.status === "found") {
    const { lyrics } = st;
    if (lyrics.kind === "instrumental") body = <Message title="♪" detail="Instrumental" />;
    else if (lyrics.kind === "plain") body = <PlainWithSync lyrics={lyrics} np={np} variant={variant} />;
    else body = <Timed lyrics={lyrics} np={np} variant={variant} />;
  } else if (st.status === "loading" || st.status === "idle") body = <Loading />;
  else if (st.status === "error")
    body = st.error.includes("429") ? (
      <Message title="LRCLIB is busy" detail="Too many lookups right now. Trying again shortly." />
    ) : (
      <Message title="Can't reach LRCLIB" detail="Check your internet connection. Lyrics load as soon as you're back online." />
    );
  else if (np.sourceKind === "mock") body = <Timed lyrics={MOCK_LYRICS} np={np} variant={variant} mock />;
  else if (ai) body = <Timed lyrics={ai} np={np} variant={variant} />;
  else if (aiWanted) body = <AiLyricsMessage title="No lyrics for this song" />;
  else body = <Message title="No lyrics for this song" detail={`LRCLIB has no match for “${np.title}”.`} />;
  return (
    <section className={`lyrics-area ${variant}`}>
      {body}
      {ai && !adNow && (
        <span className="ai-badge" title="Lyrics written by AI from the audio — may contain mistakes. Fix them in Settings → This song.">
          AI
        </span>
      )}
    </section>
  );
}
