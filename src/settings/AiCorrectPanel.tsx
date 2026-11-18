// Fix the words of a song's AI lyrics by hand (timing stays). Fixed lines are final: later plays
// never change them, and they count as ground truth for "Train on my songs".
import { useEffect, useState } from "react";
import { useNowPlaying } from "../core/playback/nowPlaying";
import { songKey, songs } from "../core/lyrics/service";
import { correctAiLyrics, upgradeSaved } from "../core/ai/aiLyrics";
import type { AiLine } from "../core/ai/passes";

export function AiCorrectPanel() {
  const np = useNowPlaying();
  const key = np ? songKey(np) : "";
  const [lines, setLines] = useState<AiLine[] | null>(null);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");

  const load = () =>
    void songs.get(key).then((p) => {
      const d = p?.aiLyrics ? upgradeSaved(p.aiLyrics, p.aiLyrics.model) : null;
      setLines(d?.lines ?? null);
      setText(d?.lines.map((l) => l.text).join("\n") ?? "");
    });
  useEffect(() => {
    setMsg("");
    if (key) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!np) return <p className="help">Play the song whose AI lyrics you want to fix.</p>;
  if (!lines?.length) return <p className="help">“{np.title}” has no AI lyrics yet.</p>;
  const locked = lines.filter((l) => l.locked).length;
  const hand = lines.filter((l) => l.hand).length;
  const save = (all: boolean) =>
    void correctAiLyrics(np, text.split("\n"), all).then(
      (n) => (setMsg(all ? `Saved: all ${lines.length} lines checked.` : `Saved ${n} corrected line${n === 1 ? "" : "s"}.`), load()),
      (e) => setMsg(e instanceof Error ? e.message : String(e)),
    );

  return (
    <div className="capture">
      <p className="help">
        {lines.length} lines · {locked} agreed on by several plays · {hand} fixed by hand. Keep one line per row; leave a row empty to remove that line.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false} />
      <div className="inline">
        <button className="btn" onClick={() => save(false)}>
          Save my corrections
        </button>
        <button className="btn" onClick={() => save(true)}>
          Save: every line is right
        </button>
      </div>
      {msg && <p className="help">{msg}</p>}
    </div>
  );
}
