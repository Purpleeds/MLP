// "Train on my songs": what's been collected, the one-time trainer setup, training runs (≤ 5 h) and
// whether the tuned model beat the original on songs it never trained on.
import { useEffect, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { updateSettings, useSettings } from "../core/settings/store";
import { forgetTunedCache } from "../core/ai/training";

interface Job {
  kind: string;
  running: boolean;
  elapsedS: number;
  last: Record<string, unknown> | null;
  stage: { detail?: string } | null;
  log: string[];
  exit: number | null;
  error: string | null;
}
interface Result {
  at: string;
  smoke: boolean;
  metric: string;
  baseError: number | null;
  tunedError: number | null;
  better: boolean;
  enoughToJudge?: boolean;
  adopted: boolean;
  trainSongs: number;
  heldOutSongs: number;
  trainClips: number;
  heldOutClips: number;
  hours: number;
  stopped: string;
  exportError?: string;
}
interface Info {
  dir: string;
  songs: number;
  audioHours: number;
  trustedLines: number;
  heldOut: number;
  bytes: number;
  envReady: boolean;
  uv: string | null;
  job: Job | null;
  lastResult: Result | null;
  model: { path: string; baseError: number; tunedError: number; metric: string; at: string } | null;
}

/** Rough amount of singing a fine-tune needs before it's likely to help. */
const ENOUGH_HOURS = 2;
const pct = (x: number | null | undefined) => (x == null ? "–" : `${(x * 100).toFixed(1)} %`);
const hms = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);

export function TrainingPanel() {
  const s = useSettings();
  const [info, setInfo] = useState<Info | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [msg, setMsg] = useState("");
  const dir = s.ai.trainingDir;

  useEffect(() => {
    if (!isTauri()) return;
    const load = () => void platform.invoke<Info>("training_info", { dir }).then((i) => i && (setInfo(i), setJob(i.job)));
    load();
    const t = setInterval(load, 10_000);
    const off = platform.on<Job>("training-progress", (j) => {
      setJob(j);
      if (!j.running) {
        forgetTunedCache();
        load();
      }
    });
    return () => {
      clearInterval(t);
      void off.then((f) => f());
    };
  }, [dir]);

  if (!isTauri()) return <p className="help">Available in the app.</p>;
  if (!info) return <p className="help">Loading…</p>;

  const run = (cmd: string, args: Record<string, unknown> = {}) =>
    void platform.invoke(cmd, { dir, ...args }).then(() => setMsg(""), (e) => setMsg(String(e)));
  const busy = !!job?.running;
  const enough = info.audioHours >= ENOUGH_HOURS && info.songs >= 10;
  const r = info.lastResult;
  const last = job?.last as { event?: string; step?: number; steps?: number; loss?: number; etaS?: number } | null;

  return (
    <div className="capture">
      <div className="capture-row">
        <span className="capture-label">Collected</span>
        <span>
          {info.songs} songs · {info.audioHours.toFixed(2)} h of audio · {info.trustedLines} lyric lines · {(info.bytes / 1e9).toFixed(2)} GB
          {info.heldOut ? ` · ${info.heldOut} kept aside for testing` : ""}
        </span>
      </div>
      <div className="capture-row">
        <span className="capture-label">Folder</span>
        <span>
          {info.dir}{" "}
          <button className="btn" onClick={() => run("training_open_folder")}>
            Open
          </button>
        </span>
      </div>
      {!s.ai.saveTraining && <p className="help">Turn on “Save audio of songs with synced lyrics” above to collect training data while you listen.</p>}
      {s.ai.saveTraining && !s.ai.listen && <p className="help">“Listen to the player” is off, so nothing is collected.</p>}
      <p className="help">
        {enough
          ? "There's enough to try a real training run."
          : `A fine-tune starts to help after roughly ${ENOUGH_HOURS} hours of songs (about 30+ songs). Every song with synced lyrics you play adds to it; you can train earlier, and the tuned model is only used if it beats the original.`}
      </p>

      {!info.envReady ? (
        <div className="inline">
          <button className="btn" disabled={busy || !info.uv} onClick={() => run("training_setup")}>
            {busy && job?.kind === "setup" ? "Setting up…" : "Set up the trainer (about 5 GB, once)"}
          </button>
          {!info.uv && <span className="help">Needs uv: run “winget install astral-sh.uv” once, then reopen Settings.</span>}
        </div>
      ) : (
        <div className="inline">
          <button className="btn" disabled={busy || info.songs < 2} onClick={() => run("training_start", { maxHours: s.ai.trainHours, smoke: false })}>
            Train now (up to {s.ai.trainHours} h)
          </button>
          <button className="btn" disabled={busy || info.songs < 2} onClick={() => run("training_start", { maxHours: 1, smoke: true })}>
            Quick check
          </button>
          {busy && (
            <button className="btn" onClick={() => void platform.invoke("training_stop")}>
              Stop
            </button>
          )}
        </div>
      )}

      {job && (job.running || job.error) && (
        <div className="capture-row">
          <span className="capture-label">{job.running ? "Running" : "Last run"}</span>
          <span>
            {job.error ? `Stopped: ${job.error}` : (job.stage?.detail ?? "Starting…")}
            {last?.event === "progress" && last.steps ? ` · step ${last.step}/${last.steps}, loss ${last.loss}` : ""}
            {job.running ? ` · ${hms(job.elapsedS)}${last?.etaS ? `, about ${hms(last.etaS)} left` : ""}` : ""}
          </span>
        </div>
      )}
      {job?.running && job.log.length > 0 && <p className="help mono">{job.log[job.log.length - 1]}</p>}

      {r && (
        <div className="capture-row">
          <span className="capture-label">Last result</span>
          <span>
            {r.smoke ? "Quick check: " : ""}
            {r.metric} on {r.heldOutSongs} held-out songs: original {pct(r.baseError)} → tuned {pct(r.tunedError)}
            {" · "}
            {r.adopted
              ? "the tuned model is now used"
              : r.smoke
                ? "pipeline works (quick checks are never used)"
                : r.better && r.enoughToJudge === false
                  ? "better, but too few held-out songs to be sure, so the original stays"
                  : "not better, so the original stays"}
            {r.exportError ? ` · export failed: ${r.exportError}` : ""}
          </span>
        </div>
      )}
      {info.model && (
        <div className="capture-row">
          <span className="capture-label">Tuned model</span>
          <span>
            {info.model.metric} {pct(info.model.baseError)} → {pct(info.model.tunedError)} ({new Date(info.model.at).toLocaleDateString()})
            {" · "}
            <label>
              <input type="checkbox" checked={s.ai.useTuned} onChange={(e) => void updateSettings("ai.useTuned", e.target.checked).then(forgetTunedCache)} /> use it for AI lyrics
            </label>
          </span>
        </div>
      )}
      {msg && <p className="help">{msg}</p>}
    </div>
  );
}
