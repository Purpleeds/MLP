// Turn messy now-playing metadata (esp. YouTube titles) into LRCLIB search queries, and score candidates.

export interface Query {
  track: string;
  artist: string;
  album?: string;
}

const JUNK_WORDS =
  "official|video|audio|lyrics?|lyric video|music video|mv|m/v|visuali[sz]er|hd|hq|4k|8k|remaster(ed)?|explicit|clean|color coded|performance video|topic|full version|vietsub|engsub|sub español|subtitulado|legendado|letra|tradução|official clip";
const BRACKETED_JUNK = new RegExp(
  `\\s*[\\(\\[【〖](?=[^\\)\\]】〗]*\\b(?:${JUNK_WORDS})\\b)[^\\)\\]】〗]*[\\)\\]】〗]`,
  "gi",
);
// "(feat. X)", "[with X]", or a bare trailing "feat. X" — but never a plain "with" ("Stay With Me").
const FEAT = /\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s+.+$/gi;
const DASH_SUFFIX = /\s+[-–—]\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|mono|stereo|single version|radio edit)(?:\s+\d{4})?(?:\s+version)?\s*$/i;
const SEPARATOR = /\s+[-–—|]\s+/;

export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function cleanTitle(t: string): string {
  return t
    .replace(BRACKETED_JUNK, "")
    .replace(/\s*[\(\[]\s*\b(?:official|lyrics?)\b[^\)\]]*$/i, "") // unclosed junk at the end
    .replace(DASH_SUFFIX, "")
    .replace(/^\s*【[^】]*】\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function cleanArtist(a: string): string {
  return a
    .replace(/\s+-\s+topic$/i, "")
    .replace(/\s*vevo$/i, "")
    .replace(/\s*(official|officiel|oficial)(\s+(channel|youtube))?$/i, "")
    .trim();
}

const primaryArtist = (a: string) => a.split(/\s*(?:,|&|\/|;|\bx\b|\bfeat\.?|\bft\.?|\band\b|、)\s*/i)[0].trim();
const stripFeat = (t: string) => t.replace(FEAT, "").replace(/\s{2,}/g, " ").trim();

/** Query variants, most specific first, deduplicated. */
export function buildQueries(title: string, artist: string, album = ""): Query[] {
  const out: Query[] = [];
  const add = (track: string, art: string, alb?: string) => {
    track = track.trim();
    art = art.trim();
    if (!track) return;
    const key = `${normalize(track)}|${normalize(art)}|${alb ? normalize(alb) : ""}`;
    if (!out.some((q) => `${normalize(q.track)}|${normalize(q.artist)}|${q.album ? normalize(q.album) : ""}` === key))
      out.push({ track, artist: art, ...(alb ? { album: alb } : {}) });
  };

  let t = cleanTitle(title);
  let a = cleanArtist(artist);

  // "Artist - Title" style video titles.
  const parts = t.split(SEPARATOR);
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join(" - ");
    const leftN = normalize(left);
    const artN = normalize(a);
    if (!a || leftN.includes(artN) || artN.includes(leftN)) {
      a = a && artN.length > leftN.length ? a : left;
      t = right;
    } else {
      // Unknown which side is which: try both orders after the literal one.
      add(cleanTitle(t), a, album);
      add(right, left);
      add(left, right);
    }
  }

  // Japanese style: アーティスト「曲名」
  const quoted = /[「『]([^」』]+)[」』]/.exec(t);

  add(t, a, album || undefined);
  if (album) add(t, a);
  add(stripFeat(t), primaryArtist(a));
  if (quoted) add(quoted[1], a);
  return out;
}

/** Dice coefficient over character bigrams of normalized strings (0..1). */
export function similarity(x: string, y: string): number {
  const a = normalize(x).replace(/ /g, "");
  const b = normalize(y).replace(/ /g, "");
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85 * (Math.min(a.length, b.length) / Math.max(a.length, b.length)) + 0.1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let hit = 0;
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return (2 * hit) / total;
}

export interface Candidate {
  trackName: string;
  artistName: string;
  duration: number; // s
  instrumental: boolean;
  syncedLyrics: string | null;
  plainLyrics: string | null;
  hasWordSync?: boolean;
}

/** Score a candidate against what is playing (0..~1.1). Returns -1 for impossible matches. */
export function scoreCandidate(c: Candidate, q: Query, durationMs: number): number {
  const title = Math.max(similarity(c.trackName, q.track), similarity(stripFeat(c.trackName), stripFeat(q.track)));
  const artist = q.artist
    ? Math.max(similarity(c.artistName, q.artist), similarity(primaryArtist(c.artistName), primaryArtist(q.artist)))
    : 0.5;
  let dur = 0.5;
  if (durationMs > 0) {
    const d = Math.abs(c.duration * 1000 - durationMs) / 1000;
    if (d > 15) return -1;
    dur = d <= 2 ? 1 : d <= 5 ? 0.6 : d <= 10 ? 0.25 : 0;
  }
  const richness = c.hasWordSync || /<\d+:\d+/.test(c.syncedLyrics ?? "") ? 0.08 : c.syncedLyrics ? 0.05 : c.plainLyrics ? 0 : c.instrumental ? 0 : -1;
  if (richness < 0) return -1;
  return title * 0.5 + artist * 0.3 + dur * 0.2 + richness;
}

export const MIN_SCORE = 0.62;
