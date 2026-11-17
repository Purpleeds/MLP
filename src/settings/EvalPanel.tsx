// Step 18: "Measure accuracy" — run auto-sync and AI lyrics on the song just played and compare with
// its word-synced lyrics; results are kept so tuning can be compared across songs.
import { useEffect, useState } from "react";
import { isTauri } from "../core/platform";
import { useNowPlaying } from "../core/playback/nowPlaying";
import { evalLog, evaluateSong, type EvalReport } from "../core/ai/evalRun";

const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)} ms` : "—");
const pct = (x: number) => `${Math.round(x * 100)} %`;

export function summary(r: EvalReport): string {
  const t = r.timing;
  const words = t.words.n ? `word start median ${ms(t.words.median)}, p90 ${ms(t.words.p90)} (${t.words.n} words, ${pct(t.words.within150)} within 150 ms); ` : "";
  const parts = [
    `${r.song} (${r.source}, ${r.ref === "line" ? "line-synced reference, " : ""}${pct(r.coverage)} heard)`,
    `auto-sync ${t.aligned}/${t.total} lines; ${words}line start median ${ms(t.lines.median)}, p90 ${ms(t.lines.p90)}`,
  ];
  if (r.text) parts.push(`AI lyrics ${r.text.unit === "word" ? "WER" : "CER"} ${pct(r.text.rate)} (${r.text.errors}/${r.text.n})`);
  parts.push(`${r.seconds} s`);
  return parts.join(" · ");
}

export function EvalPanel() {
  const np = useNowPlaying();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [history, setHistory] = useState<EvalReport[]>([]);
  const reload = () =>
    void evalLog.entries().then((e) =>
      setHistory(
        e
          .map(([, r]) => r)
          .sort((a, b) => b.at - a.at)
          .slice(0, 8),
      ),
    );
  useEffect(reload, []);
  if (!isTauri()) return <p className="help">Available in the app.</p>;

  const run = async () => {
    if (!np) return;
    setBusy(true);
    try {
      const r = await evaluateSong(np, setMsg);
      setMsg(summary(r));
      reload();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="capture">
      <p className="help">
        Play a song that has synced lyrics (word-synced is best) with listening on (ideally to the end), then measure. Auto-sync gets a copy of the lyrics that is 3 % too fast and 1.5 s early and has to find the real timing.
      </p>
      <div className="inline">
        <button className="btn" disabled={!np || busy} onClick={() => void run()}>
          {busy ? "Measuring…" : "Measure this song"}
        </button>
        {history.length > 0 && (
          <button className="btn quiet" onClick={() => void navigator.clipboard.writeText(history.map(summary).join("\n"))}>
            Copy results
          </button>
        )}
      </div>
      {msg && <p className="help">{msg}</p>}
      {history.length > 0 && (
        <ul className="help eval-history">
          {history.map((r) => (
            <li key={r.at}>{summary(r)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
