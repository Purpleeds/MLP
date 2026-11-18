// Songs without singing: what the lyric view says when no lyrics database has a song.
import type { NowPlaying } from "../playback/clock";

/** Title or album says there's no singing: "(Instrumental)", "Inst.", "Off Vocal", karaoke, … */
const INSTRUMENTAL =
  /\b(?:instrumental|inst\b\.?|off[\s-]?vocal|karaoke(?:\s+version)?|backing\s+track|minus\s+one|no\s+vocals?|without\s+vocals?)|インスト|オフボーカル|カラオケ|伴奏|纯音乐|純音樂|반주|인스트/i;

/** Film / game / series music: usually (not always) instrumental. */
const SOUNDTRACK =
  /\b(?:soundtrack|o\.?s\.?t\b|original\s+(?:motion\s+picture\s+|film\s+|game\s+|video\s+game\s+|series\s+|television\s+)?score|film\s+score|bgm)|サウンドトラック|サントラ|原声带|原聲帶|사운드트랙/i;

export type NoLyricsHint = "instrumental" | "soundtrack" | null;

/**
 * Why a song with no lyrics anywhere may simply have none. "instrumental" = the metadata says so;
 * "soundtrack" = film / game music, which is most often instrumental but can be sung.
 */
export function noLyricsHint(np: Pick<NowPlaying, "title" | "album">): NoLyricsHint {
  const meta = `${np.title ?? ""} ${np.album ?? ""}`;
  if (INSTRUMENTAL.test(meta)) return "instrumental";
  if (SOUNDTRACK.test(meta)) return "soundtrack";
  return null;
}
