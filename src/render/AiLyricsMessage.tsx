// Step 16: what the lyric view shows while a song has no lyrics and AI lyrics are on — and, when
// listening is off or Whisper isn't downloaded yet, a button that sets that up.
import { useState } from "react";
import { setUpAiLyrics, useAiLyricsStatus } from "../core/ai/aiLyrics";
import { sizeText } from "../core/ai/transcribe";

export function AiLyricsMessage({ title }: { title: string }) {
  const st = useAiLyricsStatus();
  const [asked, setAsked] = useState(false);
  const mb = st.download?.mb ?? 0;
  const setup = st.need && !asked && !st.download?.busy;
  const detail = st.need
    ? asked || st.phase === "error" || st.download?.busy
      ? st.detail
      : `MLP can write them with AI from what it hears. It all runs on this PC${mb ? ` (a one-time ${sizeText(mb)} download)` : ""}.`
    : st.phase === "error"
      ? `AI lyrics: ${st.detail}`
      : "Listening — MLP is writing the lyrics with AI. Lines appear about half a minute after they're sung.";
  return (
    <div className="lr-message">
      <p className="lr-message-title">{title}</p>
      <p className="lr-message-detail">{detail}</p>
      {setup && (
        <div className="lr-message-action">
          <button
            className="lr-ai-btn"
            onClick={() => {
              setAsked(true);
              void setUpAiLyrics().finally(() => setAsked(false));
            }}
          >
            {st.phase === "error" ? "Try again" : "Write lyrics with AI"}
          </button>
        </div>
      )}
    </div>
  );
}
