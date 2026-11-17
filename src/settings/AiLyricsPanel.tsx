// Step 16: AI lyrics — downloads (Whisper engine for GPU / CPU + the chosen model), what the
// main window is doing, and forgetting a song's AI lyrics.
import { useEffect, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { useSettings } from "../core/settings/store";
import { useNowPlaying } from "../core/playback/nowPlaying";
import { forgetAiLyrics, type AiLyricsStatus } from "../core/ai/aiLyrics";

interface Asset {
  id: string;
  name: string;
  installed: boolean;
  downloading: boolean;
  sizeMb: number;
}
interface AiStatus {
  gpu: string | null;
  assets: Asset[];
}
interface DownloadProgress {
  id: string;
  received: number;
  total: number;
  done: boolean;
  error: string | null;
}

export function AiLyricsPanel() {
  const s = useSettings();
  const np = useNowPlaying();
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [st, setSt] = useState<AiLyricsStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    const tick = () => void platform.invoke<AiStatus>("ai_status").then((a) => a && setAi(a));
    tick();
    const id = setInterval(tick, 2000);
    const offs = [
      platform.on<AiLyricsStatus>("ai-lyrics-status", setSt),
      platform.on<DownloadProgress>("ai-download", (p) =>
        setProgress((x) => {
          const n = { ...x };
          if (p.done || p.error) delete n[p.id];
          else n[p.id] = p;
          return n;
        }),
      ),
    ];
    void platform.emit("ai-lyrics-status-request");
    return () => {
      clearInterval(id);
      offs.forEach((p) => void p.then((f) => f()));
    };
  }, []);

  if (!isTauri()) return <p className="help">Available in the app.</p>;

  const find = (id: string) => ai?.assets.find((a) => a.id === id);
  const wantGpu = s.ai.whisperRuntime === "gpu" || (s.ai.whisperRuntime === "auto" && !!ai?.gpu);
  const engine = find(wantGpu ? "whisper-cuda" : "whisper-cpu");
  const model = find(s.ai.whisperModel);
  const need = [engine, model].filter((a): a is Asset => !!a && !a.installed);

  const download = (a: Asset) => void platform.invoke("ai_download", { id: a.id }).catch((e) => setMsg(String(e)));

  return (
    <div className="capture">
      {need.map((a) => {
        const p = progress[a.id];
        return (
          <div className="inline" key={a.id}>
            <button className="btn" disabled={!!p || a.downloading} onClick={() => download(a)}>
              {p ? `Downloading… ${Math.round((p.received / Math.max(1, p.total)) * 100)}%` : `Download ${a.name} (${a.sizeMb} MB)`}
            </button>
          </div>
        );
      })}
      {!need.length && (
        <>
          <div className="capture-row">
            <span className="capture-label">Status</span>
            <span>{!s.ai.lyrics ? "Off" : st?.detail || "Ready — starts when a song without lyrics plays."}</span>
          </div>
          {!!st?.lines && (
            <div className="capture-row">
              <span className="capture-label">Written</span>
              <span>
                {st.lines} lines
                {st.lang ? ` · ${st.lang}` : ""}
                {st.runtime ? ` · ${st.runtime === "whisper-cuda" ? "GPU" : "CPU"}` : ""}
                {st.source ? ` · ${st.source === "vocals" ? "isolated vocals" : "full mix"}` : ""}
                {st.tookMs ? ` · ${(st.tookMs / 1000).toFixed(1)} s per chunk` : ""}
              </span>
            </div>
          )}
        </>
      )}
      <p className="help">
        {ai?.gpu ? `GPU: ${ai.gpu}. ` : "No NVIDIA GPU found — the CPU engine is used. "}
        Audio stays on this PC; nothing is uploaded.
      </p>
      <div className="inline">
        <button className="btn" disabled={!np} onClick={() => np && void forgetAiLyrics(np).then(() => setMsg(`Forgot the AI lyrics for “${np.title}”.`))}>
          Forget AI lyrics for this song
        </button>
      </div>
      {msg && <p className="help">{msg}</p>}
    </div>
  );
}
