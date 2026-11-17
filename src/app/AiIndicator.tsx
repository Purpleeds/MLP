// Step 17: small status pill in the lyrics window — what auto-sync / AI lyrics are doing right now.
import { useSyncStatus } from "../core/ai/engine";
import { useAiLyricsStatus } from "../core/ai/aiLyrics";

export function AiIndicator() {
  const sync = useSyncStatus();
  const lyr = useAiLyricsStatus();
  let text = "";
  let busy = false;
  let title = "";
  if (lyr.phase === "transcribing") {
    text = "Writing lyrics…";
    busy = true;
    title = lyr.detail;
  } else if (sync.phase === "aligning") {
    text = `Syncing ${sync.aligned}/${sync.total}`;
    busy = true;
  } else if (sync.phase === "error" || lyr.phase === "error") {
    text = "AI problem";
    title = sync.phase === "error" ? sync.detail : lyr.detail;
  } else if (sync.phase === "paused" || lyr.phase === "paused") {
    text = "AI paused";
    title = "Paused while a full-screen app runs.";
  } else if (lyr.phase === "listening" && lyr.lines) {
    text = `AI lyrics · ${lyr.lines} lines`;
  } else if (sync.total && sync.aligned) {
    text = sync.aligned === sync.total ? "Synced" : `Synced ${sync.aligned}/${sync.total}`;
  } else if (sync.phase === "listening" || lyr.phase === "listening") {
    text = "Listening";
  }
  if (!text) return null;
  return (
    <div className={`ai-indicator ${busy ? "busy" : ""}`} title={title || "AI listening — Settings → AI listening"} data-no-drag>
      <span className="ai-dot" />
      {text}
    </div>
  );
}
