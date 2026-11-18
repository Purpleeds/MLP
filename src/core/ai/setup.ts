// One-click AI setup from the lyric view: download whatever AI files a feature still needs, with
// progress. Shared by "Write lyrics with AI" (Whisper) and "Time with AI" (auto-sync's aligner).
import { platform } from "../platform";
import type { AssetInfo } from "./transcribe";

export interface AiStatusReply {
  gpu: string | null;
  assets: AssetInfo[];
}

/** What's installed / downloading (undefined when Rust can't be asked). */
export const aiStatus = () => platform.invoke<AiStatusReply>("ai_status").catch(() => undefined);

/**
 * Download each missing file in turn; `report` gets "Downloading X… 42 %". A download that Settings
 * already started is waited for. Throws the first download error.
 */
export async function downloadAssets(missing: AssetInfo[], report: (detail: string) => void): Promise<void> {
  const waiting = new Map<string, { ok: () => void; fail: (e: string) => void }>();
  const off = await platform.on<{ id: string; received: number; total: number; done: boolean; error: string | null }>("ai-download", (p) => {
    const a = missing.find((m) => m.id === p.id);
    if (!a) return;
    if (p.done) waiting.get(p.id)?.ok();
    else if (p.error) waiting.get(p.id)?.fail(p.error);
    else if (p.total) report(`Downloading ${a.name}… ${Math.round((p.received / p.total) * 100)} %`);
  });
  try {
    for (const a of missing) {
      report(`Downloading ${a.name}…`);
      const finished = new Promise<void>((ok, fail) => waiting.set(a.id, { ok, fail }));
      finished.catch(() => undefined); // only awaited when Settings already started it
      // Already downloading (started in Settings): wait for that download to finish.
      await platform.invoke("ai_download", { id: a.id }).catch((e) => {
        if (String(e).includes("already downloading")) return finished;
        throw e;
      });
    }
  } finally {
    off();
  }
}
