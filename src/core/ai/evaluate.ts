// Step 18 — measuring the AI on real songs: word/line start errors of auto-sync against word-synced
// reference lyrics, and how close AI lyrics come to the real text (WER / CER). Pure logic (tested);
// `evalRun.ts` runs it on a captured song from Settings.
import type { Lyrics } from "../lyrics/model";
import type { LineFix, SyncLine } from "./autosync";

const cjk = (s: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

function edit<T>(a: T[], b: T[]): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** Word error rate (Latin) or character error rate (CJK) of `hyp` against `ref`. */
export function errorRate(ref: string, hyp: string): { rate: number; errors: number; n: number; unit: "word" | "char" } {
  const r = norm(ref);
  const h = norm(hyp);
  const unit = cjk(r) ? "char" : "word";
  const toks = (s: string) => (unit === "char" ? [...s.replace(/\s/g, "")] : s.split(" ").filter(Boolean));
  const a = toks(r);
  const b = toks(h);
  const errors = edit(a, b);
  return { rate: a.length ? errors / a.length : 0, errors, n: a.length, unit };
}

const stats = (xs: number[]) => {
  const s = [...xs].map(Math.abs).sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN);
  return { n: s.length, median: q(0.5), p90: q(0.9), within150: s.length ? s.filter((x) => x <= 150).length / s.length : 0 };
};

/**
 * Compare auto-sync against the reference timing: per word where the reference has word times and
 * the aligned words map 1:1 (Latin), per line otherwise. `lines`/`fixes` index into `reference.lines`.
 */
export function timingErrors(reference: Lyrics, lines: SyncLine[], fixes: Record<number, LineFix>) {
  const words: number[] = [];
  const starts: number[] = [];
  for (const l of lines) {
    const fix = fixes[l.idx];
    const ref = reference.lines[l.idx];
    if (!fix || !ref) continue;
    starts.push(fix.start - (ref.words?.[0]?.start ?? ref.start));
    if (ref.words && ref.words.length === l.words.length) {
      ref.words.forEach((w, k) => {
        const got = fix.words[k];
        if (got && l.words[k]) words.push(got[0] - w.start);
      });
    }
  }
  return { words: stats(words), lines: stats(starts), aligned: Object.keys(fixes).length, total: lines.length };
}

/** Line-synced copy of word-synced lyrics with deliberately wrong timing (drift test). */
export function perturb(l: Lyrics, scale: number, shiftMs: number): Lyrics {
  const f = (t: number) => Math.max(0, Math.round((t - shiftMs) / scale));
  return { ...l, kind: "line", lines: l.lines.map((x) => ({ ...x, start: f(x.start), end: f(x.end), words: null })) };
}
