// Sync editor: tap along with the song to time lyrics (per line, or per word — hold the key for long
// notes), try the result on the song, and optionally publish it to LRCLIB for everyone.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { clock, mediaControl, useNowPlaying, useTicker } from "../core/playback/nowPlaying";
import { displayMeta, fmtTime } from "../core/display";
import { loadLyrics, setLocalLyrics, songKey, songs } from "../core/lyrics/service";
import { lrcTime, publishToLrclib, syncUnits, toLrc, validatePublish, type Stamp, type SyncMode } from "../core/lyrics/sync";
import { getSettings } from "../core/settings/store";
import { isTauri, platform } from "../core/platform";
import { aiTimingLrc, lrcToPlain } from "../core/ai/export";
import { CLIENT_ID } from "../core/version";

const SEEK_BACK_MS = 5000;

export function SyncEditor() {
  const np = useNowPlaying();
  useTicker(50);
  const key = np ? songKey(np) : "";
  const [text, setText] = useState("");
  const [mode, setMode] = useState<SyncMode>("lines");
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const [latency, setLatency] = useState(120);
  const [hasLocal, setHasLocal] = useState(false);
  const [msg, setMsg] = useState("");
  const holding = useRef<number | null>(null);
  const list = useRef<HTMLOListElement>(null);

  // Prefill with the song's current lyrics (plain or synced) when the song changes.
  useEffect(() => {
    if (!np) return;
    setStamps([]);
    setMsg("");
    void songs.get(key).then((p) => setHasLocal(!!p?.localLrc));
    void loadLyrics(np)
      .then(async (l) => {
        // No lyrics anywhere: start from the AI lyrics (Step 16) so they can be fixed and synced.
        if (!l) return setText((await songs.get(key))?.aiLyrics?.lines.map((x) => x.text).join("\n") ?? "");
        setText(l.kind === "plain" ? (l.plain ?? "") : l.lines.filter((x) => !x.bg).map((x) => x.text).join("\n"));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const { lines, units } = useMemo(() => syncUnits(text, mode), [text, mode]);
  const cursor = stamps.length;
  const done = units.length > 0 && cursor >= units.length;
  const now = () => Math.max(0, clock.position() - latency);

  useEffect(() => {
    list.current?.querySelector(".cur")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [cursor]);

  // Auto-sync's timing for this song, ready to review, use or publish (Step 15).
  // (Hooks stay above the early return below: a song arriving later must not change the hook order.)
  const [ai, setAi] = useState<{ key: string; lrc: string; lines: number; aligned: number } | null>(null);
  const [showAiPublish, setShowAiPublish] = useState(false);
  useEffect(() => {
    if (!np) return;
    setShowAiPublish(false);
    void aiTimingLrc(np).then((r) => setAi(r ? { key, ...r } : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!np) return <p className="help">Play the song you want to sync, then come back here.</p>;
  const m = displayMeta(np);
  const lrc = toLrc(lines, units, stamps, mode);

  const tapDown = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (e.repeat || done) return;
      if (mode === "words") holding.current = cursor;
      setStamps((s) => [...s, { start: now() }]);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      setStamps((s) => s.slice(0, -1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      void seekBack();
    }
  };
  const tapUp = (e: KeyboardEvent) => {
    if ((e.key === " " || e.key === "Enter") && holding.current !== null) {
      const i = holding.current;
      holding.current = null;
      const end = now();
      setStamps((s) => s.map((st, k) => (k === i ? { ...st, end } : st)));
    }
  };
  const seekBack = async () => {
    const to = Math.max(0, clock.position() - SEEK_BACK_MS);
    setStamps((s) => s.filter((st) => st.start < to - latency));
    await mediaControl({ action: "seek", ms: to });
  };
  const restart = async () => {
    setStamps([]);
    await mediaControl({ action: "seek", ms: 0 });
    await mediaControl({ action: "play" });
  };
  const shiftAll = (d: number) => setStamps((s) => s.map((st) => ({ start: Math.max(0, st.start + d), ...(st.end ? { end: st.end + d } : {}) })));

  return (
    <div className="sync">
      <div className="song-now">
        <strong>{m.title}</strong>
        <span>
          {m.artist} · {fmtTime(clock.position())} / {np.durationMs ? fmtTime(np.durationMs) : "?"}
          {!np.canSeek && " · this player can't seek, so restart / −5 s won't work"}
        </span>
      </div>

      {ai?.key === key && (
        <details className="sync-text">
          <summary>
            Timing from auto-sync ({ai.aligned} of {ai.lines} lines lined up by listening)
          </summary>
          <textarea readOnly value={ai.lrc} rows={6} spellCheck={false} />
          <div className="inline">
            <button className="btn" onClick={() => void setLocalLyrics(np, ai.lrc).then(() => (setHasLocal(true), setMsg("Using the auto-sync timing on this song.")))}>
              Use on this song
            </button>
            <button className="btn" onClick={() => setShowAiPublish((v) => !v)}>
              {showAiPublish ? "Hide publishing" : "Review and publish to LRCLIB…"}
            </button>
          </div>
          {ai.aligned < ai.lines && <p className="help">Lines auto-sync didn't hear are estimated — check them before publishing, or tap the song through below.</p>}
          {showAiPublish && <PublishForm np={np} lrc={ai.lrc} plain={lrcToPlain(ai.lrc)} />}
        </details>
      )}

      <details className="sync-text" open={!text}>
        <summary>Lyrics text ({lines.length} lines)</summary>
        <textarea value={text} onChange={(e) => (setText(e.target.value), setStamps([]))} rows={8} spellCheck={false} placeholder="Paste the lyrics, one line per row" />
      </details>

      <div className="inline">
        <div className="segmented" role="radiogroup" aria-label="Sync by">
          {(["lines", "words"] as const).map((x) => (
            <button key={x} role="radio" aria-checked={mode === x} className={mode === x ? "on" : ""} onClick={() => (setMode(x), setStamps([]))}>
              {x === "lines" ? "Per line" : "Per word"}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => void restart()}>
          Restart song
        </button>
        <button className="btn" onClick={() => void seekBack()}>
          −5 s
        </button>
        <button className="btn" onClick={() => void mediaControl({ action: "toggle" })}>
          {np.status === "playing" ? "Pause" : "Play"}
        </button>
        <label className="latency">
          Reaction delay
          <input type="range" min={0} max={400} step={10} value={latency} onChange={(e) => setLatency(Number(e.target.value))} />
          <output>{latency} ms</output>
        </label>
      </div>

      <div className="tap" tabIndex={0} onKeyDown={tapDown} onKeyUp={tapUp} aria-label="Tap area: press Space at the start of each line">
        <p className="tap-hint">
          {done
            ? "All synced. Try it on the song, or publish it below."
            : mode === "lines"
              ? "Click here, then press Space when each line starts. Backspace undoes, ← jumps back 5 s."
              : "Click here, then press Space as each word starts and hold it while the word lasts (hold long for “noooo”). Backspace undoes, ← jumps back 5 s."}
        </p>
        <ol ref={list} className="tap-list">
          {units.map((u, i) => (
            <li key={i} className={i === cursor ? "cur" : i < cursor ? "done" : ""}>
              <span className="tap-time">{stamps[i] ? lrcTime(stamps[i].start) : ""}</span>
              <span>{u.text}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="inline">
        <button className="btn" disabled={!stamps.length} onClick={() => shiftAll(-100)}>
          All −0.1 s
        </button>
        <button className="btn" disabled={!stamps.length} onClick={() => shiftAll(100)}>
          All +0.1 s
        </button>
        <button
          className="btn"
          disabled={!done}
          onClick={() =>
            void setLocalLyrics(np, lrc).then(() => {
              setHasLocal(true);
              setMsg("Your version is now used for this song.");
            })
          }
        >
          Use on this song
        </button>
        {hasLocal && (
          <button
            className="btn quiet"
            onClick={() =>
              void setLocalLyrics(np, undefined).then(() => {
                setHasLocal(false);
                setMsg("Back to the downloaded lyrics.");
              })
            }
          >
            Remove my version
          </button>
        )}
        {msg && <span className="flash">{msg}</span>}
      </div>

      {done && <PublishForm np={np} lrc={lrc} plain={lines.join("\n")} />}
    </div>
  );
}

function PublishForm({ np, lrc, plain }: { np: NonNullable<ReturnType<typeof useNowPlaying>>; lrc: string; plain: string }) {
  const m = displayMeta(np);
  const [f, setF] = useState({ trackName: m.title, artistName: m.artist, albumName: np.album, durationSec: Math.round(np.durationMs / 1000) });
  const [ok, setOk] = useState(false);
  const [status, setStatus] = useState<{ busy: boolean; text: string; done?: boolean }>({ busy: false, text: "" });
  const input = { ...f, plainLyrics: plain, syncedLyrics: lrc };
  const invalid = validatePublish(input);

  const publish = async () => {
    setStatus({ busy: true, text: "Starting…" });
    try {
      const { fetch } = await import("@tauri-apps/plugin-http");
      await publishToLrclib(
        input,
        {
          fetch: (url, init) => fetch(url, init),
          solve: async (prefix, target) => (await platform.invoke<string>("lrclib_solve", { prefix, target })) ?? "",
          base: (getSettings().provider?.baseUrl || "https://lrclib.net/api").replace(/\/+$/, ""),
          client: CLIENT_ID,
        },
        (s) => setStatus({ busy: true, text: s }),
      );
      setStatus({ busy: false, text: "Published to LRCLIB. Thanks for sharing!", done: true });
    } catch (e) {
      setStatus({ busy: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="publish">
      <h3>Share on LRCLIB</h3>
      <p className="help">Published lyrics are public and help everyone using LRCLIB. Check the details match this exact recording.</p>
      <div className="publish-grid">
        <label>
          Title
          <input type="text" value={f.trackName} onChange={(e) => setF({ ...f, trackName: e.target.value })} />
        </label>
        <label>
          Artist
          <input type="text" value={f.artistName} onChange={(e) => setF({ ...f, artistName: e.target.value })} />
        </label>
        <label>
          Album
          <input type="text" value={f.albumName} onChange={(e) => setF({ ...f, albumName: e.target.value })} placeholder="Required" />
        </label>
        <label>
          Length (seconds)
          <input type="text" inputMode="numeric" value={f.durationSec || ""} onChange={(e) => setF({ ...f, durationSec: Number(e.target.value) || 0 })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />I synced these myself and they match this recording.
      </label>
      <div className="inline">
        <button className="btn primary" disabled={!ok || !!invalid || status.busy || status.done || !isTauri()} onClick={() => void publish()}>
          {status.busy ? "Publishing…" : status.done ? "Published" : "Publish to LRCLIB"}
        </button>
        <span className="flash">{invalid ?? status.text}</span>
      </div>
    </div>
  );
}
