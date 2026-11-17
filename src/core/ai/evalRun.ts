// Step 18 — "Measure accuracy" on the song just played: needs synced reference lyrics (word-synced from
// AMLL / LRCLIB for word starts; line-synced LRCLIB gives line starts only, themselves hand-tapped) and
// the song captured while listening. Runs auto-sync on a deliberately drifting
// line-synced copy (3 % fast, 1.5 s early) and Whisper on the same audio, then compares.
import { platform } from "../platform";
import { getSettings } from "../settings/store";
import { trackKey, type NowPlaying } from "../playback/clock";
import { loadLyrics } from "../lyrics/service";
import { createKv } from "../storage/kv";
import { romanizeLyrics } from "../romanize";
import { anchorsOf, dropOutliers, fitMap, IDENTITY, nextWindow, syncLines, toFix, type LineFix, type WordTime } from "./autosync";
import { ALIGN_ROMAN } from "./engine";
import { errorRate, perturb, timingErrors } from "./evaluate";
import { filterSegments, nextChunk, segmentsFrom, settle, type WhisperJson } from "./transcribe";

export interface EvalReport {
  song: string;
  at: number;
  source: "vocals" | "mix";
  /** what the reference timing is: word-synced, or line-synced (line starts only) */
  ref: "word" | "line";
  coverage: number;
  timing: ReturnType<typeof timingErrors>;
  text: ReturnType<typeof errorRate> | null;
  seconds: number;
}

export const evalLog = createKv<EvalReport>("eval-log.json");

interface Coverage {
  song: string | null;
  covered?: [number, number][];
  isolated?: [number, number][];
}

export async function evaluateSong(np: NowPlaying, progress: (msg: string) => void, opts: { text?: boolean; vocals?: boolean } = {}): Promise<EvalReport> {
  const withText = opts.text ?? true;
  const t0 = performance.now();
  const s = getSettings();
  const reference = await loadLyrics(np);
  if (!reference || (reference.kind !== "word" && reference.kind !== "line")) throw new Error("This song needs synced lyrics to compare with.");
  const cap = trackKey(np);
  // Auto-sync always aligns on the full mix (like the engine); isolated vocals only feed the AI lyrics.
  const vocals = opts.vocals ?? s.ai.isolateVocals;
  const capCov = await platform.invoke<Coverage>("capture_status");
  const ranges = capCov?.song === cap ? (capCov.covered ?? []) : [];
  const vocCov = vocals ? await platform.invoke<Coverage>("vocals_status") : null;
  const textRanges = vocals ? (vocCov?.song === cap ? (vocCov.isolated ?? []) : []) : ranges;
  const heard = ranges.reduce((a, [x, y]) => a + (y - x), 0);
  const dur = np.durationMs || reference.durationMs;
  if (!dur || heard < dur * 0.5) throw new Error(`Play at least half of the song with listening on first (${Math.round(heard / 1000)} s of ${Math.round(dur / 1000)} s heard).`);

  // 1) Auto-sync on a drifting copy.
  const test = perturb(reference, 1.03, 1500);
  const lines = syncLines(test, await romanizeLyrics(test, ALIGN_ROMAN).catch(() => null));
  const fixes: Record<number, LineFix> = {};
  const attempts = new Map<number, number>();
  let map = IDENTITY;
  for (let guard = 0; guard < 400; guard++) {
    const done = (i: number) => !!fixes[i] || (attempts.get(i) ?? 0) >= 2;
    const margin = map.anchors.length >= 2 ? 2_500 : attempts.size ? 12_000 : 6_000;
    const w = nextWindow(lines, done, ranges, map, dur, margin);
    if (!w) break;
    progress(`Lining up ${Object.keys(fixes).length}/${lines.length} lines…`);
    const res = await platform.invoke<{ lines: (WordTime | null)[][] }>("ai_align", {
      req: { key: cap, fromMs: w.from, toMs: w.to, lines: w.lines.map((l) => l.words), vocals: false },
    });
    const before = map.anchors.length;
    w.lines.forEach((l, k) => {
      const f = toFix(l, res?.lines[k] ?? []);
      if (f) fixes[l.idx] = f;
      else attempts.set(l.idx, (attempts.get(l.idx) ?? 0) + 1);
    });
    map = fitMap(anchorsOf(lines, fixes));
    const out = dropOutliers(lines, fixes, map);
    for (const i of out.dropped) {
      delete fixes[i];
      attempts.set(i, 2);
    }
    if (out.dropped.length) map = fitMap(anchorsOf(lines, fixes));
    if (before < 2 && map.anchors.length >= 2) attempts.clear();
  }
  const timing = timingErrors(reference, lines, fixes);

  // 2) AI lyrics on the same audio.
  let text: EvalReport["text"] = null;
  if (withText && textRanges.length) {
    let doneTo = 0;
    const out: string[] = [];
    let lang: string | null = null as string | null;
    const end = textRanges[textRanges.length - 1][1];
    for (let guard = 0; guard < 60; guard++) {
      const c = nextChunk(doneTo, textRanges, true, dur);
      if (!c) break;
      progress(`Writing lyrics ${Math.round(c.from / 1000)}–${Math.round(c.to / 1000)} s…`);
      const json: WhisperJson | undefined = await platform.invoke<WhisperJson>("ai_transcribe", {
        req: { key: cap, fromMs: c.from, toMs: c.to, vocals, language: lang, prompt: null, model: s.ai.whisperModel, runtime: s.ai.whisperRuntime },
      });
      const r = settle(filterSegments(segmentsFrom(json ?? {}, c.from)), { ...c, final: c.final || c.to >= end - 50 });
      out.push(...r.kept.map((x) => x.text));
      if (!lang) {
        const probs: [string, number][] = Object.entries(json?.language_probabilities ?? {}).sort((a, b) => b[1] - a[1]);
        if ((probs[0]?.[1] ?? 0) >= 0.7) lang = probs[0][0];
      }
      if (r.doneTo <= doneTo) break;
      doneTo = r.doneTo;
    }
    // Compare with the reference lines inside what was heard.
    const refText = reference.lines
      .filter((l) => !l.bg && textRanges.some(([a, b]) => l.start >= a && l.start < b))
      .map((l) => l.text)
      .join(" ");
    text = errorRate(refText, out.join(" "));
  }

  const report: EvalReport = {
    song: `${np.artist} — ${np.title}`,
    at: Date.now(),
    source: vocals ? "vocals" : "mix",
    ref: reference.kind === "word" ? "word" : "line",
    coverage: heard / dur,
    timing,
    text,
    seconds: Math.round((performance.now() - t0) / 1000),
  };
  await evalLog.set(`${report.at}`, report);
  return report;
}
