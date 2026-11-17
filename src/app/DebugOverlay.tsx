import { clock, useTicker, type NowPlaying } from "../core/playback/nowPlaying";
import { useSyncStatus } from "../core/ai/engine";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Live diagnostics for the now-playing pipeline (toggle: settings.debug.overlay). */
export function DebugOverlay({ np }: { np: NowPlaying | null }) {
  useTicker(100);
  const ai = useSyncStatus();
  if (!np) return <div className="debug">no session</div>;
  const pos = clock.position();
  const reported = np.positionMs + (np.status === "playing" ? Date.now() - np.updatedAtMs : 0);
  return (
    <div className="debug">
      <div>
        {np.sourceKind} · {np.sourceApp}
      </div>
      <div>
        {np.status} · {fmt(pos)} / {np.durationMs ? fmt(np.durationMs) : "?"} ·{" "}
        {clock.estimated ? "ESTIMATED" : "timeline"}
      </div>
      <div>
        src pos {fmt(np.positionMs)} · age {np.updatedAtMs ? ((Date.now() - np.updatedAtMs) / 1000).toFixed(1) : "?"}s ·
        Δ {(pos - reported).toFixed(0)}ms · slew {clock.drift().toFixed(0)}ms
      </div>
      <div>
        art {np.artwork ? "yes" : "no"} · seek {np.canSeek ? "yes" : "no"} · rate {np.rate}
      </div>
      {ai.phase !== "off" && (
        <div>
          sync {ai.phase} {ai.aligned}/{ai.total} · ×{ai.tempo ?? 1} {ai.offsetMs ?? 0}ms {ai.source ?? ""} {ai.tookMs ? `${ai.tookMs}ms` : ""} {ai.phase === "error" ? ai.detail : ""}
        </div>
      )}
    </div>
  );
}
