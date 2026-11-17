// Step 17: every AI download (engines + models) with size, status, download / delete, disk use,
// and forgetting the AI data kept per song.
import { useEffect, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { songs } from "../core/lyrics/service";

interface Asset {
  id: string;
  name: string;
  kind: string;
  note: string;
  installed: boolean;
  downloading: boolean;
  sizeMb: number;
}
interface AiStatus {
  gpu: string | null;
  assets: Asset[];
  dir: string;
}
interface DownloadProgress {
  id: string;
  received: number;
  total: number;
  done: boolean;
  error: string | null;
}

/** Remove auto-sync timing and AI lyrics from every song (pins, offsets and own syncs stay). */
export async function forgetAllAiData(): Promise<number> {
  let n = 0;
  for (const [k, p] of await songs.entries()) {
    if (!p.aiSync && !p.aiLyrics) continue;
    await songs.set(k, { ...p, aiSync: undefined, aiLyrics: undefined });
    n++;
  }
  return n;
}

export function AiModelsPanel() {
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [msg, setMsg] = useState("");
  const [aiSongs, setAiSongs] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    const tick = () => void platform.invoke<AiStatus>("ai_status").then((a) => a && setAi(a));
    tick();
    const id = setInterval(tick, 2000);
    void songs.entries().then((all) => setAiSongs(all.filter(([, p]) => p.aiSync || p.aiLyrics).length));
    const off = platform.on<DownloadProgress>("ai-download", (p) =>
      setProgress((x) => {
        const n = { ...x };
        if (p.done || p.error) delete n[p.id];
        else n[p.id] = p;
        return n;
      }),
    );
    return () => {
      clearInterval(id);
      void off.then((f) => f());
    };
  }, []);

  if (!isTauri()) return <p className="help">Available in the app.</p>;
  const used = (ai?.assets ?? []).filter((a) => a.installed).reduce((s, a) => s + a.sizeMb, 0);

  return (
    <div className="capture">
      <p className="help">
        {ai?.gpu ? `GPU: ${ai.gpu}. ` : "No NVIDIA GPU found. "}On disk: {used >= 1000 ? `${(used / 1000).toFixed(1)} GB` : `${used} MB`}.
      </p>
      <div className="models">
        {ai?.assets.map((a) => {
          const p = progress[a.id];
          return (
            <div className="model-row" key={a.id}>
              <div className="model-name">
                {a.name}
                <span className="help">
                  {a.sizeMb} MB · {a.note}
                </span>
              </div>
              {a.installed ? (
                <button
                  className="btn quiet"
                  onClick={() =>
                    void platform
                      .invoke("ai_delete", { id: a.id })
                      .then(() => setMsg(`Deleted ${a.name}.`))
                      .catch((e) => setMsg(String(e)))
                  }
                >
                  Delete
                </button>
              ) : (
                <button className="btn" disabled={!!p || a.downloading} onClick={() => void platform.invoke("ai_download", { id: a.id }).catch((e) => setMsg(String(e)))}>
                  {p ? `${Math.round((p.received / Math.max(1, p.total)) * 100)}%` : "Download"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="inline">
        <button className="btn" disabled={!aiSongs} onClick={() => void forgetAllAiData().then((n) => (setAiSongs(0), setMsg(`Forgot AI timing and lyrics for ${n} songs.`)))}>
          Forget AI data for all songs ({aiSongs})
        </button>
      </div>
      {msg && <p className="help">{msg}</p>}
    </div>
  );
}
