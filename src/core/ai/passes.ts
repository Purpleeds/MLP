// AI lyrics that get better every time a song plays: each play's Whisper transcript is kept as a
// "pass"; passes are merged line by line (lines that agree are locked in, timing is tightened to the
// median, lonely low-confidence lines that other plays didn't hear are dropped), and hand corrections
// override everything. Pure logic (tested); `aiLyrics.ts` runs the passes.
import type { LyricLine } from "../lyrics/model";

/** One line Whisper wrote in one pass (song time, ms). */
export interface Cand {
  start: number;
  end: number;
  text: string;
  /** 0–1: mean word probability (or exp(avg logprob) without words) */
  conf: number;
}

export interface AiPass {
  /** when the pass started (epoch ms) */
  at: number;
  model: string;
  /** song-time stretches this pass transcribed (skipped locked stretches are not in here) */
  spans: [number, number][];
  cands: Cand[];
  doneTo: number;
  complete: boolean;
}

/** A line fixed by hand: always wins over the AI ("" = the line shouldn't be there). */
export interface HandFix {
  start: number;
  end: number;
  text: string;
}

export interface AiLine extends LyricLine {
  conf: number;
  /** passes that wrote (about) this text */
  votes: number;
  /** passes that listened to this stretch */
  seen: number;
  /** settled: enough passes agree, or fixed by hand */
  locked: boolean;
  hand?: boolean;
}

/** Plays after which a song is left alone, and the locked share that counts as finished. */
export const MAX_PASSES = 5;
export const SETTLED_SHARE = 0.9;
/** Texts at least this similar count as the same line. */
export const SAME = 0.8;

const letters = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");

/** 0–1 similarity of two lines: 1 − character edit distance / longer length (letters and digits only). */
export function similarity(a: string, b: string): number {
  const x = [...letters(a)];
  const y = [...letters(b)];
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  const prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

const len = (a: { start: number; end: number }) => Math.max(1, a.end - a.start);
/** Shared time / the shorter of the two. */
export const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / Math.min(len(a), len(b));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** How many passes listened to most (≥ 80 %) of [from, to). */
export function seenBy(passes: AiPass[], from: number, to: number): number {
  const want = Math.max(1, to - from);
  return passes.filter((p) => {
    const heard = p.spans.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
    return heard >= 0.8 * want;
  }).length;
}

interface Member {
  pass: number;
  c: Cand;
}
interface Cluster {
  start: number;
  end: number;
  members: Member[];
}

/** One pass's take on a cluster: its lines there, joined. */
interface Group {
  pass: number;
  members: Cand[];
  text: string;
  conf: number;
  start: number;
  end: number;
}

function groups(cl: Cluster): Group[] {
  const by = new Map<number, Cand[]>();
  for (const m of cl.members) by.set(m.pass, [...(by.get(m.pass) ?? []), m.c]);
  return [...by].map(([pass, ms]) => {
    const w = ms.map((c) => Math.max(1, letters(c.text).length));
    const conf = ms.reduce((n, c, i) => n + c.conf * w[i], 0) / w.reduce((a, b) => a + b, 0);
    return { pass, members: ms, text: ms.map((c) => c.text).join(" "), conf, start: Math.min(...ms.map((c) => c.start)), end: Math.max(...ms.map((c) => c.end)) };
  });
}

const line = (c: { start: number; end: number; text: string }, extra: Omit<AiLine, keyof LyricLine>): AiLine => ({
  start: Math.round(c.start),
  end: Math.round(Math.max(c.end, c.start + 300)),
  text: c.text,
  words: null,
  ...extra,
});

/** All passes (and hand fixes) → the lines to show. */
export function mergePasses(passes: AiPass[], hand: HandFix[] = []): AiLine[] {
  const all: Member[] = passes.flatMap((p, pass) => p.cands.filter((c) => letters(c.text)).map((c) => ({ pass, c })));
  all.sort((a, b) => a.c.start - b.c.start || a.pass - b.pass);
  const clusters: Cluster[] = [];
  for (const m of all) {
    let best: Cluster | null = null;
    let bestOv = 0.5;
    for (let k = clusters.length - 1; k >= 0 && k >= clusters.length - 6; k--) {
      const ov = overlap(m.c, clusters[k]);
      if (ov >= bestOv) [best, bestOv] = [clusters[k], ov];
    }
    if (best) {
      best.members.push(m);
      best.start = Math.min(best.start, m.c.start);
      best.end = Math.max(best.end, m.c.end);
    } else clusters.push({ start: m.c.start, end: m.c.end, members: [m] });
  }

  const out: AiLine[] = [];
  for (const cl of clusters) {
    const gs = groups(cl);
    const score = (g: Group) => gs.reduce((n, o) => (o === g ? n : n + similarity(g.text, o.text)), 0) + 0.5 * g.conf;
    const best = gs.reduce((a, b) => (score(b) > score(a) ? b : a));
    const agree = gs.filter((g) => similarity(best.text, g.text) >= SAME);
    const votes = agree.length;
    const seen = Math.max(gs.length, seenBy(passes, cl.start, cl.end));
    // Written once although other plays heard this stretch too: probably a hallucination.
    if (votes === 1 && gs.length === 1 && ((seen >= 2 && best.conf < 0.6) || (seen >= 3 && best.conf < 0.85))) continue;
    const locked = votes >= 2 && votes * 2 > seen;
    if (best.members.length === 1) {
      // Tighten the timing: median of the passes that agree.
      const c = { start: median(agree.map((g) => g.start)), end: median(agree.map((g) => g.end)), text: best.text };
      out.push(line(c, { conf: best.conf, votes, seen, locked }));
    } else {
      for (const c of best.members) out.push(line(c, { conf: c.conf, votes, seen, locked }));
    }
  }

  // Hand fixes replace whatever the AI has there.
  const fixed = out.filter((l) => !hand.some((h) => overlap(h, l) >= 0.5));
  for (const h of hand) if (letters(h.text)) fixed.push(line(h, { conf: 1, votes: 0, seen: 0, locked: true, hand: true }));
  fixed.sort((a, b) => a.start - b.start);

  // Two lines over the same time: keep the better one.
  const rank = (l: AiLine) => (l.hand ? 1e6 : 0) + l.votes * 10 + l.conf;
  const res: AiLine[] = [];
  for (const l of fixed) {
    const prev = res[res.length - 1];
    if (prev && overlap(prev, l) >= 0.5) {
      if (rank(l) > rank(prev)) res[res.length - 1] = l;
      continue;
    }
    if (prev && prev.end > l.start) prev.end = Math.max(prev.start + 300, l.start - 50);
    res.push(l);
  }
  return res;
}

/** Share of the lines that are locked in (0 with no lines). */
export const lockedShare = (lines: AiLine[]) => (lines.length ? lines.filter((l) => l.locked).length / lines.length : 0);

/** Nothing left to learn about this song: enough plays, or (after two plays) nearly every line agrees. */
export const settled = (passes: AiPass[], lines: AiLine[]) =>
  passes.length >= MAX_PASSES || (passes.length >= 2 && passes.every((p) => p.complete) && lockedShare(lines) >= SETTLED_SHARE);

/**
 * Later passes skip stretches that are already settled: every line there is locked, or there are no
 * lines and two plays already heard nothing there.
 */
export function canSkip(lines: AiLine[], passes: AiPass[], from: number, to: number): boolean {
  if (passes.length < 2) return false;
  const here = lines.filter((l) => l.end > from && l.start < to);
  if (here.length) return here.every((l) => l.locked);
  return seenBy(passes.slice(0, -1), from, to) >= 2;
}

/** Hand corrections from an edited copy of the lines (same number of lines; "" removes a line). */
export function handFixes(lines: AiLine[], edited: string[], allCorrect: boolean): HandFix[] {
  if (edited.length !== lines.length) throw new Error(`Keep one line per line (${lines.length} lines; leave a line empty to remove it).`);
  return lines
    .map((l, i) => ({ l, text: edited[i].trim() }))
    .filter(({ l, text }) => allCorrect || l.hand || text !== l.text.trim())
    .map(({ l, text }) => ({ start: l.start, end: l.end, text }));
}

/** Old hand fixes that new ones don't replace, plus the new ones. */
export function addHandFixes(old: HandFix[], fresh: HandFix[]): HandFix[] {
  return [...old.filter((h) => !fresh.some((f) => overlap(f, h) >= 0.5)), ...fresh].sort((a, b) => a.start - b.start);
}
