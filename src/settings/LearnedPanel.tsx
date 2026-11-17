// Upgrade 10: what MLP learned from the user's per-song timing corrections, per player.
import { useEffect, useState } from "react";
import { platform } from "../core/platform";
import { forgetLearned, learnedSummary } from "../core/timing/learnStore";

const NAMES: Record<string, string> = { spotify: "Spotify", browser: "Browser", "ytmusic-app": "YouTube Music app", other: "Other players" };

export function LearnedPanel() {
  const [rows, setRows] = useState<{ source: string; offset: number | null; songs: number }[]>([]);
  useEffect(() => {
    const load = () => void learnedSummary().then(setRows);
    load();
    const off = platform.on("offset-learned", load);
    return () => void off.then((f) => f());
  }, []);
  return (
    <div className="capture">
      {!rows.length && <p className="help">Nothing yet — nudge the timing of a few songs (toolbar −/+ or Ctrl+Alt+↑/↓).</p>}
      {rows.map((r) => (
        <div className="capture-row" key={r.source}>
          <span className="capture-label">{NAMES[r.source] ?? r.source}</span>
          <span>
            {r.offset === null
              ? `${r.songs} corrected song${r.songs === 1 ? "" : "s"} — not enough agreement yet`
              : `${r.offset > 0 ? "+" : "−"}${(Math.abs(r.offset) / 1000).toFixed(2)} s (lyrics ${r.offset > 0 ? "earlier" : "later"}) · from ${r.songs} songs`}
          </span>
        </div>
      ))}
      {!!rows.length && (
        <div className="inline">
          <button className="btn" onClick={() => void forgetLearned().then(() => setRows([]))}>
            Forget what was learned
          </button>
        </div>
      )}
    </div>
  );
}
