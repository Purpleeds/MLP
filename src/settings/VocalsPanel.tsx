// Step 14: vocal isolation status — model download, on/off, which device runs it, speed,
// how much of the song is isolated, and saving the isolated vocals as a WAV.
import { useEffect, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { updateSettings, useSettings } from "../core/settings/store";
import { useNowPlaying } from "../core/playback/nowPlaying";

const MODEL_ID = "htdemucs-vocals";

interface VocalsStatus {
  available: boolean;
  enabled: boolean;
  device: string;
  song: string | null;
  isolated: [number, number][];
  rtf: number;
  busy: boolean;
  error: string | null;
}
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

export function VocalsPanel() {
  const s = useSettings();
  const np = useNowPlaying();
  const [st, setSt] = useState<VocalsStatus | null>(null);
  const [model, setModel] = useState<{ installed: boolean; downloading: boolean; sizeMb: number } | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    const tick = () => {
      void platform.invoke<VocalsStatus>("vocals_status").then((x) => x && setSt(x));
      void platform.invoke<AiStatus>("ai_status").then((a) => setModel(a?.assets.find((x) => x.id === MODEL_ID) ?? null));
    };
    tick();
    const id = setInterval(tick, 1000);
    const off = platform.on<DownloadProgress>("ai-download", (p) => p.id === MODEL_ID && setProgress(p.done || p.error ? null : p));
    return () => {
      clearInterval(id);
      void off.then((f) => f());
    };
  }, []);

  if (!isTauri()) return <p className="help">Available in the app.</p>;
  if (st && !st.available) return <p className="help">This build doesn't include vocal isolation.</p>;

  const dur = np?.durationMs || 1;
  const isolatedSec = (st?.isolated ?? []).reduce((a, [x, y]) => a + (y - x), 0) / 1000;

  const toggle = async () => {
    const next = !s.ai.isolateVocals;
    try {
      await platform.invoke("vocals_set", { enabled: next });
      await updateSettings("ai.isolateVocals", next);
      setMsg("");
    } catch (e) {
      setMsg(String(e));
    }
  };
  const save = async () => {
    const { downloadDir, join } = await import("@tauri-apps/api/path");
    const path = await join(await downloadDir(), "MLP-vocals.wav");
    try {
      setMsg(`Saved ${await platform.invoke<string>("vocals_dump", { path })} to ${path}`);
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div className="capture">
      {!model?.installed ? (
        <div className="inline">
          <button className="btn" disabled={!!progress || model?.downloading} onClick={() => void platform.invoke("ai_download", { id: MODEL_ID }).catch((e) => setMsg(String(e)))}>
            {progress ? `Downloading… ${Math.round((progress.received / Math.max(1, progress.total)) * 100)}%` : `Download model (${model?.sizeMb ?? 158} MB)`}
          </button>
          <span className="help">HT-Demucs FT vocals, MIT license.</span>
        </div>
      ) : (
        <>
          <div className="capture-row">
            <span className="capture-label">Isolate</span>
            <button role="switch" aria-checked={s.ai.isolateVocals} aria-label="Isolate vocals" className={`switch ${s.ai.isolateVocals ? "on" : ""}`} onClick={() => void toggle()}>
              <span />
            </button>
            {!s.ai.listen && s.ai.isolateVocals && <span className="help">Turn on “Listen to the player” too.</span>}
          </div>
          <div className="capture-row">
            <span className="capture-label">Runs on</span>
            <span>
              {st?.device || "—"}
              {st?.rtf ? ` · ${(1 / st.rtf).toFixed(1)}× faster than real time` : ""}
              {st?.busy ? " · working…" : ""}
            </span>
          </div>
          <div className="capture-row">
            <span className="capture-label">Isolated</span>
            <div className="coverage">
              {st?.isolated.map(([a, b]) => (
                <span key={a} style={{ left: `${(a / dur) * 100}%`, width: `${Math.max(0.4, ((b - a) / dur) * 100)}%` }} />
              ))}
            </div>
            <span className="capture-time">{isolatedSec.toFixed(0)} s</span>
          </div>
          {st?.error && <p className="help">{st.error}</p>}
          <div className="inline">
            <button className="btn" disabled={!isolatedSec} onClick={() => void save()}>
              Save isolated vocals
            </button>
          </div>
        </>
      )}
      {msg && <p className="help">{msg}</p>}
    </div>
  );
}
