import { describe, expect, it } from "vitest";
import { noLyricsHint } from "./instrumental";

const hint = (title: string, album = "") => noLyricsHint({ title, album });

describe("noLyricsHint", () => {
  it("spots instrumental versions from the title or album", () => {
    expect(hint("Blinding Lights (Instrumental)")).toBe("instrumental");
    expect(hint("夜に駆ける (Inst.)")).toBe("instrumental");
    expect(hint("Pretender - Off Vocal ver.")).toBe("instrumental");
    expect(hint("APT. (Karaoke Version)")).toBe("instrumental");
    expect(hint("Song", "Greatest Hits Instrumentals")).toBe("instrumental");
    expect(hint("夜に駆ける (オフボーカル)")).toBe("instrumental");
    expect(hint("晴天 (伴奏)")).toBe("instrumental");
  });

  it("spots soundtracks and scores", () => {
    expect(hint("Cornfield Chase", "Interstellar (Original Motion Picture Soundtrack)")).toBe("soundtrack");
    expect(hint("Time", "Inception (Music from the Motion Picture)")).toBe(null);
    expect(hint("Hedwig's Theme", "Harry Potter (Original Motion Picture Score)")).toBe("soundtrack");
    expect(hint("Megalovania [OST]")).toBe("soundtrack");
    expect(hint("Hans Zimmer - Interstellar Main Theme | Soundtrack")).toBe("soundtrack");
    expect(hint("戦闘曲", "ゲーム サウンドトラック")).toBe("soundtrack");
  });

  it("instrumental wins over soundtrack", () => {
    expect(hint("Let It Go (Instrumental)", "Frozen (Original Motion Picture Soundtrack)")).toBe("instrumental");
  });

  it("leaves ordinary songs alone", () => {
    expect(hint("Never Gonna Give You Up", "Whenever You Need Somebody")).toBe(null);
    expect(hint("Instant Crush", "Random Access Memories")).toBe(null);
    expect(hint("Ghost", "Postal Service")).toBe(null);
    expect(hint("The Score", "Boston")).toBe(null);
    expect(hint("Most Wanted")).toBe(null);
    expect(hint("Instagram")).toBe(null);
  });
});
