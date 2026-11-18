// Step 15: auto-sync status — model download, what the engine in the main window is doing,
// how far the song is lined up, the fitted tempo/offset, and forgetting a song's AI timing.
import { useEffect, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { useSettings } from "../core/settings/store";
import { useNowPlaying } from "../core/playback/nowPlaying";
import { forgetAutoSync, type SyncStatus } from "../core/ai/engine";
import { openTimingFolder } from "../core/ai/timingFiles";

const MODEL_ID = "mms-aligner";

interface AiStatus {
  assets: { id: string; installed: boolean; downloading: boolean; sizeMb: number }[];
}
interface DownloadProgress {
  id: string;
  received: number;
  total: number;
  done: boolean;
  error: string | null;
}

/** "Lyrics run 4 % fast · 1.5 s late" from the time map. */
export function describeMap(tempo?: number, offsetMs?: number): string {
  const parts: string[] = [];
  if (tempo && Math.abs(tempo - 1) >= 0.005) parts.push(`lyrics run ${Math.round(Math.abs(tempo - 1) * 1000) / 10} % ${tempo > 1 ? "fast" : "slow"}`);
  if (offsetMs !== undefined && Math.abs(offsetMs) >= 50) parts.push(`${(Math.abs(offsetMs) / 1000).toFixed(1)} s ${offsetMs > 0 ? "early" : "late"}`);
  return parts.length ? parts.join(" · ") : "on time";
}

export function AutoSyncPanel() {
  const s = useSettings();
  const np = useNowPlaying();
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [model, setModel] = useState<{ installed: boolean; downloading: boolean; sizeMb: number } | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    const offs = [
      platform.on<SyncStatus>("ai-sync-status", setSt),
      platform.on<DownloadProgress>("ai-download", (p) => p.id === MODEL_ID && setProgress(p.done || p.error ? null : p)),
    ];
    void platform.emit("ai-sync-status-request");
    const tick = () => void platform.invoke<AiStatus>("ai_status").then((a) => setModel(a?.assets.find((x) => x.id === MODEL_ID) ?? null));
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      clearInterval(id);
      offs.forEach((p) => void p.then((f) => f()));
    };
  }, []);

  if (!isTauri()) return <p className="help">Available in the app.</p>;

  if (!model?.installed)
    return (
      <div className="capture">
        <div className="inline">
          <button className="btn" disabled={!!progress || model?.downloading} onClick={() => void platform.invoke("ai_download", { id: MODEL_ID }).catch((e) => setMsg(String(e)))}>
            {progress ? `Downloading… ${Math.round((progress.received / Math.max(1, progress.total)) * 100)}%` : `Download model (${model?.sizeMb ?? 317} MB)`}
          </button>
          <span className="help">MMS-300m forced aligner (Meta, CC-BY-NC 4.0), runs on the CPU.</span>
        </div>
        {msg && <p className="help">{msg}</p>}
      </div>
    );

  const pct = st?.total ? Math.round((st.aligned / st.total) * 100) : 0;
  return (
    <div className="capture">
      <div className="capture-row">
        <span className="capture-label">Status</span>
        <span>{!s.ai.autoSync ? "Off" : st?.detail || (st?.phase === "idle" ? "Ready" : "Play a song with synced lyrics")}</span>
      </div>
      {s.ai.autoSync && !!st?.total && (
        <>
          <div className="capture-row">
            <span className="capture-label">Lined up</span>
            <div className="coverage">
              <span style={{ left: 0, width: `${pct}%` }} />
            </div>
            <span className="capture-time">
              {st.aligned}/{st.total}
            </span>
          </div>
          <div className="capture-row">
            <span className="capture-label">Timing</span>
            <span>
              {st.aligned ? describeMap(st.tempo, st.offsetMs) : "—"}
              {st.source ? ` · heard ${st.source === "vocals" ? "isolated vocals" : "the full mix"}` : ""}
              {st.tookMs ? ` · ${(st.tookMs / 1000).toFixed(1)} s per window` : ""}
            </span>
          </div>
        </>
      )}
      <div className="inline">
        <button
          className="btn"
          disabled={!np}
          onClick={() => np && void forgetAutoSync(np).then(() => setMsg(`Forgot the AI timing for “${np.title}”.`))}
        >
          Forget AI timing for this song
        </button>
        {isTauri() && (
          <button className="btn" onClick={() => void openTimingFolder().catch((e) => setMsg(String(e)))}>
            Open timing folder
          </button>
        )}
      </div>
      <p className="help">Each song's AI timing is saved as a readable file in the app's “ai\timing” folder.</p>
      {msg && <p className="help">{msg}</p>}
    </div>
  );
}
