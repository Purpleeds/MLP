// Plain (untimed) lyrics: a note above them that says whether AI is timing them, and — when listening
// or auto-sync is off, or the aligner model isn't downloaded — a one-click "Time with AI" button.
import { useState } from "react";
import { setUpAutoSync, useSyncStatus, type SyncStatus } from "../core/ai/engine";
import { sizeText } from "../core/ai/transcribe";
import { useSettings } from "../core/settings/store";

export interface TimingNote {
  text: string;
  /** button label, when there's something to turn on / download */
  button?: string;
}

/** What the note says, from the AI settings, the auto-sync status and whether the button was just pressed. */
export function timingNote(ai: { autoSync: boolean; listen: boolean }, st: SyncStatus, asked: boolean): TimingNote {
  const need = !ai.autoSync || !ai.listen ? "turn-on" : st.need;
  if (st.phase === "error" && st.need) return { text: st.detail, button: "Try again" };
  if (asked || (need === "download" && st.download?.busy)) return { text: st.detail || "Setting up AI timing…" };
  if (need) {
    const mb = st.download?.mb ?? 0;
    const dl = mb ? ` (a one-time ${sizeText(mb)} download)` : "";
    const ask = need === "turn-on" ? "Turn on AI listening to time them" : "MLP can time them with AI from what it hears";
    return { text: `These lyrics aren't timed. ${ask}${dl}. It all runs on this PC.`, button: "Time with AI" };
  }
  if (st.phase === "done") return { text: "These lyrics aren't timed. MLP couldn't line them up with the song this time." };
  if (st.phase === "paused") return { text: "These lyrics aren't timed yet. AI timing is paused while a full-screen app runs." };
  if (st.phase === "error") return { text: `These lyrics aren't timed yet. AI timing: ${st.detail}` };
  return { text: "These lyrics aren't timed yet. MLP is timing them with AI: they follow the singing once the first lines are heard." };
}

export function AiTimingNote() {
  const ai = useSettings().ai;
  const st = useSyncStatus();
  const [asked, setAsked] = useState(false);
  const note = timingNote(ai, st, asked);
  return (
    <div className="lr-plain-note lr-timing-note" role="status">
      <span>{note.text}</span>
      {note.button && (
        <span className="lr-message-action">
          <button
            className="lr-ai-btn"
            onClick={() => {
              setAsked(true);
              void setUpAutoSync().finally(() => setAsked(false));
            }}
          >
            {note.button}
          </button>
        </span>
      )}
    </div>
  );
}
