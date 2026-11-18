// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlaying } from "../playback/clock";
import type { VdbSong } from "./vocadb";

const lrclibHit = vi.fn();
const vdbSong = vi.fn();
vi.mock("./lrclib", () => ({ lrclib: { get: () => lrclibHit(), search: async () => [], getById: async () => null } }));
vi.mock("./amll", () => ({ findAmll: async () => null, amllToLyrics: () => ({ lines: [] }) }));
vi.mock("./vocadb", async (orig) => ({ ...(await orig<typeof import("./vocadb")>()), findVocaDbSong: () => vdbSong() }));

const { loadLyrics } = await import("./service");

const NP = { title: "ワールドイズマイン", artist: "ryo (supercell)", album: "", durationMs: 254_000, sourceKind: "spotify" } as NowPlaying;
const SONG: VdbSong = {
  id: 1,
  name: "ワールドイズマイン",
  artist: "ryo (supercell) feat. 初音ミク",
  lyrics: [{ type: "Original", langs: ["ja"], source: "", url: "", text: "世界で一番おひめさま\nそういう扱い心得てよね\n\nその一 いつもと違う髪形に気が付くこと" }],
};

describe("lyrics service: VocaDB untimed lyrics", () => {
  beforeEach(() => {
    localStorage.clear();
    lrclibHit.mockReset();
    vdbSong.mockReset();
  });

  it("uses VocaDB's original lyrics as plain lyrics when LRCLIB has nothing", async () => {
    lrclibHit.mockResolvedValue(null);
    vdbSong.mockResolvedValue(SONG);
    const l = await loadLyrics(NP, true);
    expect(l).toMatchObject({ kind: "plain", source: "vocadb", id: 1 });
    expect(l?.plain?.split("\n")[0]).toBe("世界で一番おひめさま");
  });

  it("not for another artist's song with the same title, nor when VocaDB can't be reached", async () => {
    lrclibHit.mockResolvedValue(null);
    vdbSong.mockResolvedValue({ ...SONG, artist: "Some Band" });
    expect(await loadLyrics(NP, true)).toBeNull();
    vdbSong.mockRejectedValue(new Error("offline"));
    expect(await loadLyrics(NP, true)).toBeNull();
  });

  it("LRCLIB's lyrics win: VocaDB isn't asked", async () => {
    lrclibHit.mockResolvedValue({ id: 9, trackName: NP.title, artistName: NP.artist, albumName: null, duration: 254, instrumental: false, plainLyrics: "a\nb", syncedLyrics: "[00:01.00]a\n[00:03.00]b" });
    const l = await loadLyrics(NP, true);
    expect(l?.source).toBe("lrclib");
    expect(vdbSong).not.toHaveBeenCalled();
  });
});
