// Step 13 debug view: what MLP hears from the player (app, level, how much of the song is captured),
// a WAV export, and a self-serve timing check with the beep test page.
import { useEffect, useState } from "react";
import { platform, isTauri } from "../core/platform";
import { useNowPlaying } from "../core/playback/nowPlaying";
import { getSettings, updateSettings, useSettings } from "../core/settings/store";
import { fmtTime } from "../core/display";

interface Status {
  enabled: boolean;
  pid: number;
  app: string;
  level: number;
  song: string | null;
  covered: [number, number][];
  seconds: number;
  error: string | null;
}
interface BeepCheck {
  beeps: number;
  meanMs: number;
  medianAbsMs: number;
  p90AbsMs: number;
}

export function CapturePanel() {
  const s = useSettings();
  const np = useNowPlaying();
  const [st, setSt] = useState<Status | null>(null);
  const [msg, setMsg] = useState("");
  const [check, setCheck] = useState<BeepCheck | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const tick = () => void platform.invoke<Status>("capture_status").then((x) => x && setSt(x));
    tick();
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, []);

  if (!isTauri()) return <p className="help">Available in the app.</p>;
  const dur = np?.durationMs || Math.max(60_000, ...(st?.covered.map(([, b]) => b) ?? [0]));
  const level = Math.min(1, (st?.level ?? 0) * 6);

  const save = async () => {
    const { downloadDir, join } = await import("@tauri-apps/api/path");
    const path = await join(await downloadDir(), "MLP-capture.wav");
    try {
      setMsg(`Saved ${await platform.invoke<string>("capture_dump", { path })} to ${path}`);
    } catch (e) {
      setMsg(String(e));
    }
  };
  const runCheck = async () => {
    try {
      const r = (await platform.invoke<BeepCheck>("capture_beep_check"))!;
      setCheck(r);
      setMsg("");
    } catch (e) {
      setCheck(null);
      setMsg(String(e));
    }
  };

  return (
    <div className="capture">
      <div className="capture-row">
        <span className="capture-label">Hearing</span>
        <span>{st?.enabled ? (st.app ? `${st.app} (process ${st.pid})` : "waiting for a player…") : "off"}</span>
      </div>
      <div className="capture-row">
        <span className="capture-label">Level</span>
        <div className="meter" aria-label="Audio level">
          <div style={{ width: `${(level * 100).toFixed(0)}%` }} />
        </div>
      </div>
      <div className="capture-row">
        <span className="capture-label">Captured</span>
        <div className="coverage" title="Parts of the song MLP has heard">
          {st?.covered.map(([a, b]) => (
            <span key={a} style={{ left: `${(a / dur) * 100}%`, width: `${Math.max(0.4, ((b - a) / dur) * 100)}%` }} />
          ))}
        </div>
        <span className="capture-time">
          {fmtTime((st?.seconds ?? 0) * 1000)} of {fmtTime(dur)}
        </span>
      </div>
      {st?.error && <p className="help">{st.error}</p>}
      <div className="inline">
        <button className="btn" disabled={!st?.seconds} onClick={() => void save()}>
          Save captured audio
        </button>
        <button className="btn" onClick={() => void platform.invoke("open_capture_test")}>
          Open timing test page
        </button>
        <button className="btn" disabled={!st?.enabled} onClick={() => void runCheck()}>
          Check timing
        </button>
      </div>
      {check && (
        <div className="capture-result">
          <p>
            {check.beeps} beeps: typical error <b>{check.medianAbsMs.toFixed(0)} ms</b>, 90 % within {check.p90AbsMs.toFixed(0)} ms. Captured audio sits{" "}
            {Math.abs(check.meanMs).toFixed(0)} ms {check.meanMs >= 0 ? "late" : "early"} on average.
          </p>
          {Math.abs(check.meanMs) >= 10 && (
            <button
              className="btn"
              onClick={() =>
                void updateSettings("ai.captureLatencyMs", Math.round(getSettings().ai.captureLatencyMs + check.meanMs)).then(() => {
                  setCheck(null);
                  setMsg("Correction saved. Run the test page again to confirm.");
                })
              }
            >
              Correct by {check.meanMs.toFixed(0)} ms
            </button>
          )}
        </div>
      )}
      {msg && <p className="help">{msg}</p>}
      <p className="help">Current correction: {s.ai.captureLatencyMs} ms. Audio stays in memory and is never uploaded.</p>
    </div>
  );
}
