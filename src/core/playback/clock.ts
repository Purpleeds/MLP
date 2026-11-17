// PlaybackClock: turns sparse now-playing samples into a smooth, per-frame playback position.

export interface NowPlaying {
  sourceApp: string;
  sourceKind: "spotify" | "browser" | "ytmusic-app" | "other" | "mock";
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  artwork: string | null;
  status: "playing" | "paused" | "stopped" | "changing" | "opened" | "closed";
  positionMs: number;
  /** Unix ms when the source last set positionMs (0 = unknown) */
  updatedAtMs: number;
  rate: number;
  timelineOk: boolean;
  canSeek: boolean;
  /** set by the backend when artwork was omitted because it didn't change */
  artworkSame?: boolean;
}

export const trackKey = (np: Pick<NowPlaying, "sourceApp" | "title" | "artist">) =>
  `${np.sourceApp}|${np.artist}|${np.title}`;

const SNAP_MS = 300; // jumps larger than this are applied instantly (seek / resync)
const SLEW_TAU_MS = 250; // small drift is blended out with this time constant

export class PlaybackClock {
  private base = 0;
  private baseAt = 0;
  private rate = 1;
  private playing = false;
  private duration = 0;
  private correction = 0;
  private correctionAt = 0;
  /** true when the source has no timeline and position is inferred from track/pause events */
  estimated = false;
  key = "";

  private raw(now: number) {
    return this.base + (this.playing ? (now - this.baseAt) * this.rate : 0);
  }

  private corr(now: number) {
    return this.correction * Math.exp(-(now - this.correctionAt) / SLEW_TAU_MS);
  }

  update(np: NowPlaying, now = Date.now()): void {
    const key = trackKey(np);
    const trackChanged = key !== this.key;
    const shownBefore = this.raw(now) + this.corr(now);
    const playing = np.status === "playing";

    if (np.timelineOk) {
      // Trust the source's timestamp unless it is missing or in the future.
      const at = np.updatedAtMs > 0 && np.updatedAtMs <= now + 1000 ? np.updatedAtMs : now;
      this.base = np.positionMs;
      this.baseAt = at;
      this.estimated = false;
    } else {
      this.estimated = true;
      if (trackChanged) {
        this.base = 0;
        this.baseAt = now;
      } else if (playing !== this.playing) {
        this.base = this.raw(now); // freeze on pause / continue on resume
        this.baseAt = now;
      }
    }
    this.playing = playing;
    this.rate = np.rate > 0 ? np.rate : 1;
    this.duration = np.durationMs;
    this.key = key;

    const diff = shownBefore - this.raw(now);
    if (!trackChanged && playing && Math.abs(diff) < SNAP_MS) {
      this.correction = diff;
      this.correctionAt = now;
    } else {
      this.correction = 0;
    }
  }

  /** Smoothed position in ms. */
  position(now = Date.now()): number {
    const p = this.raw(now) + this.corr(now);
    return Math.max(0, this.duration > 0 ? Math.min(p, this.duration) : p);
  }

  /** Current smoothing offset (debug). */
  drift(now = Date.now()): number {
    return this.corr(now);
  }

  get isPlaying() {
    return this.playing;
  }
}
