// "This song": per-song timing offset and manual lyrics search / pinning.
import { useEffect, useState } from "react";
import { useNowPlaying } from "../core/playback/nowPlaying";
import { displayMeta, fmtTime } from "../core/display";
import { pinLyrics, searchCandidates, setSongOffset, songKey, songs, useSongOffset } from "../core/lyrics/service";
import type { LrclibRecord } from "../core/lyrics/model";
import { resetTranslation } from "../core/translationFiles";
import { useSettings } from "../core/settings/store";

const syncKind = (r: LrclibRecord) =>
  r.instrumental ? "Instrumental" : r.hasWordSync || /<\d+:\d+/.test(r.syncedLyrics ?? "") ? "Word-synced" : r.syncedLyrics ? "Line-synced" : r.plainLyrics ? "Not synced" : "Empty";

export function SongPanel() {
  const np = useNowPlaying();
  const offset = useSongOffset(np);
  const [pinId, setPinId] = useState<number | undefined>();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LrclibRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trMsg, setTrMsg] = useState("");
  const translating = useSettings().translation.enabled;
  const key = np ? songKey(np) : "";

  useEffect(() => {
    if (!np) return;
    const m = displayMeta(np);
    setQ(`${m.artist} ${m.title}`.trim());
    setResults(null);
    void songs.get(key).then((p) => setPinId(p?.pinId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!np) return <p className="help">Play a song to adjust its lyrics.</p>;
  const m = displayMeta(np);

  const search = async () => {
    setBusy(true);
    setError("");
    try {
      setResults(await searchCandidates(q));
    } catch {
      setError("Couldn't reach LRCLIB. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  const pin = async (id: number | undefined) => {
    await pinLyrics(np, id);
    setPinId(id);
  };

  return (
    <div className="song">
      <div className="song-now">
        <strong>{m.title}</strong>
        <span>
          {m.artist}
          {np.durationMs ? ` · ${fmtTime(np.durationMs)}` : ""}
        </span>
      </div>

      <div className="song-offset">
        <span>Timing offset</span>
        <button className="btn" onClick={() => void setSongOffset(np, offset - 100)} aria-label="Show lyrics later">
          −0.1 s
        </button>
        <output>{offset === 0 ? "In sync" : `${offset > 0 ? "+" : "−"}${(Math.abs(offset) / 1000).toFixed(1)} s`}</output>
        <button className="btn" onClick={() => void setSongOffset(np, offset + 100)} aria-label="Show lyrics earlier">
          +0.1 s
        </button>
        {offset !== 0 && (
          <button className="btn quiet" onClick={() => void setSongOffset(np, 0)}>
            Reset
          </button>
        )}
      </div>
      <p className="help">Plus shows lyrics earlier. Saved for this song only.</p>

      {translating && (
        <div className="inline">
          <button
            className="btn"
            onClick={() =>
              void resetTranslation(m).then(
                () => (setTrMsg("Translating again…"), setTimeout(() => setTrMsg(""), 2500)),
                (e) => setTrMsg(String(e)),
              )
            }
          >
            Reset translation
          </button>
          {trMsg && <span className="flash">{trMsg}</span>}
        </div>
      )}

      <form
        className="song-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Artist and song title" spellCheck={false} />
        <button className="btn" type="submit" disabled={busy || !q.trim()}>
          {busy ? "Searching…" : "Search LRCLIB"}
        </button>
      </form>
      {pinId !== undefined && (
        <div className="inline">
          <span className="help">You picked lyrics #{pinId} for this song.</span>
          <button className="btn quiet" onClick={() => void pin(undefined)}>
            Go back to automatic
          </button>
        </div>
      )}
      {error && <p className="help">{error}</p>}
      {results && (
        <ul className="results">
          {results.length === 0 && <li className="help">No results. Try fewer words, or only the song title.</li>}
          {results.map((r) => {
            const diff = np.durationMs ? Math.round(r.duration - np.durationMs / 1000) : null;
            return (
              <li key={r.id} className={r.id === pinId ? "on" : ""}>
                <div className="result-text">
                  <strong>{r.trackName}</strong>
                  <span>
                    {r.artistName}
                    {r.albumName ? ` · ${r.albumName}` : ""}
                  </span>
                  <span className="result-meta">
                    {syncKind(r)} · {fmtTime(r.duration * 1000)}
                    {diff !== null && Math.abs(diff) >= 2 ? ` (${diff > 0 ? "+" : ""}${diff} s vs. playing)` : ""}
                  </span>
                </div>
                <button className="btn" disabled={r.id === pinId} onClick={() => void pin(r.id)}>
                  {r.id === pinId ? "In use" : "Use these"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
