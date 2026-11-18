import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { isTauri, platform, type ResizeDirection } from "../core/platform";
import { getSettings, updateSettings, useSettings } from "../core/settings/store";
import { detectGpu } from "../core/settings/light";
import { updateFeed } from "../core/version";
import type { DisplayMode, Elements } from "../core/settings/schema";
import { pushMediaConfig, useNowPlaying, type NowPlaying } from "../core/playback/nowPlaying";
import { displayMeta, elementsFor } from "../core/display";
import { useArtwork } from "../core/art/hires";
import { useSpotifyTrack } from "../core/spotify";
import { AiIndicator } from "./AiIndicator";
import { useWindowPlacement } from "../core/placement";
import { currentLine } from "../core/currentLine";
import { accentFrom, extractPalette, hex } from "../render/palette";
import { Background } from "../render/Background";
import { LyricView } from "../render/LyricView";
import { Art, Controls, Marquee, Progress } from "./parts";
import { DebugOverlay } from "./DebugOverlay";
import { useAutoHide } from "./autoHide";
import { adMarker, maybeAdLength } from "../core/playback/ads";
import { Toolbar, useActions, useHotkeys, useToast } from "./power";
import { onQuotaReached } from "../core/translationFiles";
import "../styles.css";

const GRIPS: [ResizeDirection, string][] = [
  ["North", "n"], ["South", "s"], ["East", "e"], ["West", "w"],
  ["NorthEast", "ne"], ["NorthWest", "nw"], ["SouthEast", "se"], ["SouthWest", "sw"],
];

/** Drop a trailing generic family so the per-language CJK fallbacks still apply. */
const userFonts = (stack: string) => stack.replace(/,\s*(sans-serif|serif|system-ui)\s*$/i, "");

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Window size follows the display mode; manual resizes are remembered per mode. */
function useModeWindowSize(mode: DisplayMode) {
  const programmaticUntil = useRef(0);
  const first = useRef(true);
  useEffect(() => {
    // On startup keep the restored window size; afterwards apply the mode's remembered size.
    if (first.current) {
      first.current = false;
      return;
    }
    const { w, h } = getSettings().layout.sizes[mode];
    programmaticUntil.current = performance.now() + 800;
    void platform.resizeAnchored(w, h);
  }, [mode]);
  useEffect(() => {
    let timer = 0;
    const off = platform.onResized(() => {
      clearTimeout(timer);
      timer = window.setTimeout(async () => {
        if (performance.now() < programmaticUntil.current) return;
        const size = await platform.size();
        void updateSettings(`layout.sizes.${getSettings().layout.mode}`, size);
      }, 500);
    });
    return () => {
      clearTimeout(timer);
      void off.then((f) => f());
    };
  }, []);
}

/** Overlay mode: clicks pass through by default (Upgrade 11); leaving it undoes the automatic lock. */
function useOverlayClickThrough(mode: DisplayMode, enabled: boolean, locked: boolean, toast: (t: string, ms?: number) => void) {
  const autoLocked = useRef(false);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    if (!isTauri()) return;
    if (mode === "overlay" && enabled && !lockedRef.current) {
      autoLocked.current = true;
      void platform.invoke("set_click_through", { locked: true });
      toast("Overlay: clicks pass through to what's underneath. Unlock from the tray or with Ctrl+Alt+K.", 4000);
    } else if (mode !== "overlay" && autoLocked.current) {
      autoLocked.current = false;
      if (lockedRef.current) void platform.invoke("set_click_through", { locked: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the mode changes
  }, [mode]);
}

/** Upgrade 13: a readable colour from the cover for the sung text. */
function useAccent(art: string | null, enabled: boolean): string | null {
  const [v, setV] = useState<{ art: string; color: string } | null>(null);
  useEffect(() => {
    if (!enabled || !art) return;
    let alive = true;
    void extractPalette(art).then((p) => alive && setV({ art, color: hex(accentFrom(p)) }));
    return () => {
      alive = false;
    };
  }, [art, enabled]);
  return enabled && art && v?.art === art ? v.color : null;
}

/** Upgrade 19: feed the local stream-overlay server with the line being sung. */
function useObsBridge(np: NowPlaying | null, enabled: boolean, port: number) {
  const npRef = useRef(np);
  npRef.current = np;
  useEffect(() => {
    if (!isTauri()) return;
    void platform.invoke("obs_set", { enabled, port }).catch((e) => platform.log(`obs: ${e}`));
    if (!enabled) return;
    const id = setInterval(() => {
      const n = npRef.current;
      const l = currentLine();
      const m = n ? displayMeta(n) : null;
      void platform.invoke("obs_update", {
        state: l && m ? { ...l, line: l.text, pos: l.t, playing: n!.status === "playing", title: m.title, artist: m.artist } : {},
      });
    }, 250);
    return () => clearInterval(id);
  }, [enabled, port]);
}

/** Upgrade 20: screen readers hear each new lyric line (polite live region, visually hidden). */
function LineAnnouncer() {
  const [text, setText] = useState("");
  useEffect(() => {
    const id = setInterval(() => {
      const l = currentLine()?.text ?? "";
      setText((cur) => (cur === l ? cur : l));
    }, 300);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}

function Info({ np, el, big }: { np: NowPlaying; el: Elements; big?: boolean }) {
  const m = displayMeta(np);
  const sub = [el.artist && m.artist, el.album && m.album].filter(Boolean).join(" — ");
  return (
    <div className={`info ${big ? "big" : ""}`}>
      {el.title && <Marquee className="info-title">{m.title}</Marquee>}
      {sub && <Marquee className="info-sub">{sub}</Marquee>}
    </div>
  );
}

function Body({ np, mode, el, wide, aspect, art }: { np: NowPlaying; mode: DisplayMode; el: Elements; wide: boolean; aspect: number; art: string | null }) {
  if (mode === "title") {
    const m = displayMeta(np);
    return (
      <div className="title-row">
        {el.art && <Art src={art} className="tiny" />}
        <Marquee className="title-text">{el.artist ? `${m.title} — ${m.artist}` : m.title}</Marquee>
      </div>
    );
  }
  if (mode === "mini") return <LyricView np={np} variant="mini" />;
  if (mode === "overlay") return <LyricView np={np} variant="overlay" />;
  if (mode === "bar") return <LyricView np={np} variant="bar" />;

  const anyNow = el.art || el.title || el.artist || el.album || el.progress || el.controls;
  const extras = (
    <>
      {el.progress && <Progress np={np} times={el.times} />}
      {el.controls && <Controls np={np} />}
    </>
  );

  if (!el.lyrics) {
    // Now-playing card ("music profile").
    return (
      <div className={`np-card ${aspect >= 1.15 ? "row" : "col"}`}>
        {el.art && <Art src={art} className="card-art" />}
        <div className="np-card-text">
          <Info np={np} el={el} big />
          {extras}
        </div>
      </div>
    );
  }

  if (wide && el.art && anyNow) {
    // Apple Music layout: big art + info on the left, lyrics on the right.
    return (
      <div className="split">
        <div className="split-side">
          <Art src={art} className="side-art" />
          <Info np={np} el={el} />
          {extras}
        </div>
        <LyricView np={np} />
      </div>
    );
  }

  return (
    <>
      {anyNow && (
        <header className="np">
          {el.art && <Art src={art} className="small" />}
          <Info np={np} el={el} />
          {el.controls && <Controls np={np} />}
        </header>
      )}
      {el.progress && <Progress np={np} times={el.times} />}
      <LyricView np={np} />
    </>
  );
}

export default function App() {
  const s = useSettings();
  const live = useNowPlaying();
  const [locked, setLocked] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(card);
  const mode = s.layout.mode;
  const el = elementsFor(s);

  // Idle behavior: keep the last song, show an idle card, or hide the window.
  const last = useRef<NowPlaying | null>(null);
  if (live) last.current = live;
  const np = live ?? (s.layout.idle === "keep" ? last.current : null);
  const spotify = useSpotifyTrack(np);
  const fallbackArt = useArtwork(np, s.layout.hiResArt && !spotify?.art);
  const art = spotify?.art ?? fallbackArt;
  const autoHiding = useAutoHide(live, s.layout);

  // Hotkeys, toolbar actions, toasts.
  const toast = useToast();
  const actions = useActions(live, locked, toast.show, art);
  useHotkeys(s.hotkeys, actions, toast.show);
  // Free translation limit used up: say so once (it stays quiet until translating works again).
  useEffect(() => onQuotaReached(() => toast.show("Free translation limit reached for today — translations continue tomorrow.", 5000)), [toast.show]);
  // First start on this PC: integrated graphics only → light mode (once; the user can turn it off).
  useEffect(() => {
    if (s.app.lightChecked || !isTauri()) return;
    const gpu = detectGpu();
    void (async () => {
      if (gpu === "integrated" && !s.app.lightMode) {
        await updateSettings("app.lightMode", true);
        toast.show("Light mode is on for this PC (integrated graphics). Change it in Settings → General → Performance.", 9000);
      }
      await updateSettings("app.lightChecked", true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (s.app.tipShown || !isTauri()) return;
    toast.show("Tip: Windows may hide the MLP tray icon under ^ near the clock — drag it onto the taskbar to keep it visible.", 9000);
    void updateSettings("app.tipShown", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Started hidden by autostart: appear when music starts.
  useEffect(() => {
    if (live?.status === "playing" && (window as { __mlpHidden?: boolean }).__mlpHidden) {
      (window as { __mlpHidden?: boolean }).__mlpHidden = false;
      void platform.show();
    }
  }, [live?.status]);

  // Window-level settings.
  useEffect(() => void platform.setAlwaysOnTop(s.window.alwaysOnTop), [s.window.alwaysOnTop]);
  useEffect(() => void platform.setSkipTaskbar(!s.window.showInTaskbar), [s.window.showInTaskbar]);
  useEffect(() => void pushMediaConfig(), [s.sources]);
  // Pause listening during (possible) ads so ad audio never lands on the song's timeline.
  const adPause = s.sources.skipAds !== false && !!live && (adMarker(live) || maybeAdLength(live));
  useEffect(() => void platform.invoke("set_capture", { enabled: s.ai.listen && !adPause }), [s.ai.listen, adPause]);
  useEffect(() => void platform.invoke("vocals_set", { enabled: s.ai.isolateVocals }).catch(() => undefined), [s.ai.isolateVocals]);
  useEffect(() => void platform.invoke("set_capture_latency", { ms: s.ai.captureLatencyMs }), [s.ai.captureLatencyMs]);
  // Step 17: AI budget; listening off = models unloaded (≈ 0 cost).
  useEffect(
    () => void platform.invoke("ai_set_limits", { threads: s.ai.threads, lowPriority: s.ai.lowPriority, pauseFullscreen: s.ai.pauseFullscreen }),
    [s.ai.threads, s.ai.lowPriority, s.ai.pauseFullscreen],
  );
  useEffect(() => {
    if (!s.ai.listen) void platform.invoke("ai_unload").catch(() => undefined);
  }, [s.ai.listen]);
  useEffect(() => {
    const off = platform.on<{ id: string; done: boolean; error: string | null }>("ai-download", (p) => {
      if (p.error) toast.show(`Download failed: ${p.error}`, 5000);
      else if (p.done) toast.show("Download finished — AI listening can use it now.", 3500);
    });
    return () => void off.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useModeWindowSize(mode);
  useWindowPlacement();
  useObsBridge(live, s.app.obs, s.app.obsPort);
  // Upgrade 16: once a day, quietly look for a new version.
  useEffect(() => {
    const { updateUrl, autoUpdateCheck, lastUpdateCheck } = getSettings().app;
    if (!isTauri() || !autoUpdateCheck || Date.now() - lastUpdateCheck < 24 * 3600_000) return;
    const t = setTimeout(async () => {
      const r = await platform.invoke<{ version: string | null }>("update_check", { url: updateFeed(updateUrl) }).catch(() => null);
      void updateSettings("app.lastUpdateCheck", Date.now());
      if (r?.version) toast.show(`MLP ${r.version} is available — install it in Settings → General.`, 8000);
    }, 20_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useOverlayClickThrough(mode, s.layout.overlayClickThrough, locked, toast.show);
  // Taskbar bar: dock by the clock (Upgrade 12); leaving the mode stops the on-taskbar keeper.
  useEffect(() => {
    if (!isTauri()) return;
    if (mode !== "bar") return void platform.invoke("undock_bar").catch(() => undefined);
    const { w, h } = getSettings().layout.sizes.bar;
    const t = setTimeout(() => void platform.invoke("dock_bar", { placement: s.layout.barPlacement, width: w, height: h }).catch((e) => toast.show(String(e), 4000)), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, s.layout.barPlacement]);

  useEffect(() => {
    const offs = [
      platform.on<boolean>("lock-changed", setLocked),
      platform.on<DisplayMode>("set-mode", (m) => void updateSettings("layout.mode", m)),
      platform.on<"tl" | "tr" | "bl" | "br">("main-move", (c) => void platform.moveToCorner(c)),
    ];
    return () => offs.forEach((p) => p.then((off) => off()));
  }, []);

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-no-drag], button")) return;
    if (target.closest(".lr-root.seekable .lr-line")) {
      // A lyric line: click = seek (Upgrade 9); only start dragging once the mouse really moves.
      const x0 = e.clientX;
      const y0 = e.clientY;
      const move = (m: globalThis.MouseEvent) => {
        if (!(m.buttons & 1)) return done();
        if (Math.hypot(m.clientX - x0, m.clientY - y0) > 4) {
          done();
          void platform.startDragging();
        }
      };
      const done = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", done);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", done);
      return;
    }
    void platform.startDragging();
  };

  const a = s.appearance;
  const accent = useAccent(art, a.accentFromArt);
  const mockSize = !isTauri() ? s.layout.sizes[mode] : null;
  const style = {
    "--radius": `${s.window.cornerRadius}px`,
    "--pad": `${mode === "title" ? Math.min(12, s.window.padding) : s.window.padding}px`,
    "--lr-font": userFonts(a.fontFamily),
    "--lr-size": `${a.fontSize}px`,
    "--lr-weight": a.fontWeight,
    "--lr-lh": a.lineHeight,
    "--lr-ls": `${a.letterSpacing}em`,
    "--lr-active": accent ?? a.activeColor,
    "--lr-inactive": a.inactiveColor,
    "--lr-soft": `${s.lyrics.fillSoftness}em`,
    "--lr-bg-scale": s.lyrics.bgScale,
    "--info": a.infoColor,
    "--lr-voice2": a.voice2Color,
    "--lr-voice3": a.voice3Color,
    "--lr-voice-group": a.groupColor,
    opacity: s.window.opacity,
    ...(mockSize ? { width: mockSize.w, height: mockSize.h } : {}),
  } as React.CSSProperties;
  const wide = w >= 520 && w / Math.max(1, h) >= 1.15;

  return (
    <div
      ref={card}
      className={`card mode-${mode} ${wide ? "wide" : "narrow"} ${isTauri() ? "" : "mock"} ${a.blendInactive ? "blend" : ""} ${a.voiceColors ? "voices" : ""} ${autoHiding ? "autohiding" : ""} ${locked ? "locked" : ""}`}
      style={style}
      onMouseDown={onMouseDown}
    >
      {mode !== "overlay" && <Background bg={s.background} artwork={art} seed={np ? `${np.artist}${np.title}` : "idle"} playing={np?.status === "playing"} />}

      {np ? (
        <Body np={np} mode={mode} el={el} wide={wide} aspect={w / Math.max(1, h)} art={art} />
      ) : mode === "overlay" ? (
        !locked && <div className="overlay-idle">Overlay — waiting for music</div>
      ) : (
        <div className="idle">
          <Art src={null} className={mode === "title" ? "tiny" : "small"} />
          <div className="info">
            <div className="info-title">Nothing playing</div>
            {mode !== "title" && mode !== "mini" && mode !== "bar" && <div className="info-sub">Play a song in Spotify or YouTube Music</div>}
          </div>
        </div>
      )}

      {s.debug.overlay && <DebugOverlay np={live} />}
      {!locked && <Toolbar np={np} actions={actions} />}
      {s.ai.indicator && s.ai.listen && mode !== "overlay" && <AiIndicator />}
      {toast.node}
      {s.app.screenReader && <LineAnnouncer />}
      {locked && <div className="lock-badge">Locked</div>}
      {!isTauri() && <div className="mock-badge">mock</div>}

      {GRIPS.map(([dir, cls]) => (
        <div
          key={cls}
          data-no-drag
          className={`grip grip-${cls}`}
          onMouseDown={(e) => {
            e.stopPropagation();
            void platform.startResize(dir);
          }}
        />
      ))}
    </div>
  );
}
