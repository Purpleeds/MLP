import { describe, expect, it } from "vitest";
import { alignToVdb, artistMatches, findVocaDbSong, vdbPlainText, humanTranslation, pairTranslation, romajiKey, scoreSong, vdbLines, type FetchJson, type VdbSong } from "./vocadb";

// Shaped like VocaDB's real 千本桜 entry (id 8394): inline furigana, full-width spaces, trailing spaces.
const ORIGINAL =
  "大胆不敵にハイカラ革命 \n磊々落々（らいらいらくらく）反戦国家 \n日の丸印の二輪車転がし \n悪霊退散　ICBM \n\n" +
  "環状線を走り抜けて　東奔西走なんのその \n少年少女戦国無双　浮世の随（まにま）に \n\n" +
  "千本桜　夜ニ紛レ　君ノ声モ届カナイヨ \n此処は宴　鋼の檻　その断頭台で見下ろして ";
const ROMAJI =
  "daitanfuteki ni haikara kakumei\nrairairakuraku hansen kokka\nhinomarujirushi no nirinsha korogashi\nakuryoutaisan ICBM\n\n" +
  "kanjousen o hashirinukete toushonseisou nan no sono\nshounen shoujo sengoku musou ukiyo no manima ni\n\n" +
  "senbonzakura yoru ni magire kimi no koe mo todokanai yo\nkoko wa utage hagane no ori sono dantoudai de mioroshite";
const ENGLISH =
  "A bold, fearless, high-collar revolution \nAn easygoing anti-war nation \nRolling a two-wheeler marked with the rising sun \nBegone, evil spirits, ICBM \n\n" +
  "Running through the loop line, rushing east and west \nBoys and girls, peerless warriors, drifting with the floating world \n\n" +
  "A thousand cherry trees, hidden in the night, your voice can't reach me \nThis is a feast, a cage of steel, look down from that guillotine ";
const OTHER_EN = "Line one\nLine two\nLine three\n\nNotes from the translator\nmore notes\nand more\nand more\nand more\nand more";

const SONG: VdbSong = {
  id: 8394,
  name: "千本桜",
  artist: "黒うさP feat. 初音ミク",
  lyrics: [
    { type: "Original", langs: ["ja"], source: "KKBOX", url: "", text: ORIGINAL },
    { type: "Romanized", langs: ["ha"], source: "Vocaloid Lyrics Wiki", url: "", text: ROMAJI },
    { type: "Translation", langs: ["en"], source: "Other", url: "", text: OTHER_EN },
    { type: "Translation", langs: ["en"], source: "Anime Lyrics", url: "http://www.animelyrics.com/doujin/vocaloid/senbonzakura.htm", text: ENGLISH },
  ],
};

// How LRCLIB tends to show it: no furigana, half-width spaces, one VocaDB line split in two, a credit line.
const SHOWN = [
  "作詞：黒うさP",
  "大胆不敵にハイカラ革命",
  "磊々落々 反戦国家",
  "日の丸印の二輪車転がし",
  "悪霊退散 ICBM",
  "環状線を走り抜けて 東奔西走なんのその",
  "少年少女戦国無双 浮世の随に",
  "千本桜 夜ニ紛レ",
  "君ノ声モ届カナイヨ",
  "此処は宴 鋼の檻 その断頭台で見下ろして",
];

describe("vocadb lining up", () => {
  it("splits VocaDB text into trimmed lines with stanza breaks", () => {
    expect(vdbLines("a \nb\n\nc")).toEqual(["a", "b", "", "c"]);
  });

  it("pairs a translation line for line, or stanza by stanza", () => {
    expect(pairTranslation(["a", "b", "", "c"], ["A", "", "B", "C"])).toEqual(["A", "B", "C"]);
    expect(pairTranslation(["a", "b", "", "c"], ["A", "B", "", "C", "note"])).toEqual(["A", "B", null]);
  });

  it("aligns shown lines to VocaDB's (furigana ignored, split line shared)", () => {
    const vdb = vdbLines(ORIGINAL).filter(Boolean);
    const { idx: a, rest } = alignToVdb(SHOWN, vdb);
    expect(rest[8]).toBe(true);
    expect(a[0]).toEqual([]); // credit line: no match
    expect(a.slice(1, 8)).toEqual([[0], [1], [2], [3], [4], [5], [6]]);
    expect(a[8]).toEqual([]); // second half of the split line
    expect(a[9]).toEqual([7]);
  });

  it("puts the human translation under the matching lines", () => {
    const h = humanTranslation(SONG, SHOWN, "en")!;
    expect(h.source).toBe("Anime Lyrics"); // the translation whose lines pair up
    expect(h.lines[0]).toBeNull();
    expect(h.lines[1]).toBe("A bold, fearless, high-collar revolution");
    expect(h.lines[7]).toMatch(/^A thousand cherry trees/);
    expect(h.lines[8]).toBeNull();
    expect(h.lines[9]).toMatch(/guillotine$/);
    expect(h.coverage).toBeCloseTo(0.9); // all but the credit line
  });

  it("works when the shown lyrics are romanized", () => {
    const shown = vdbLines(ROMAJI).filter(Boolean).map((l) => l.replace(/ /g, "  "));
    const h = humanTranslation(SONG, shown, "en")!;
    expect(h.lines[0]).toBe("A bold, fearless, high-collar revolution");
  });

  it("joins two VocaDB lines shown as one", () => {
    const shown = ["大胆不敵にハイカラ革命 磊々落々反戦国家", "日の丸印の二輪車転がし", "悪霊退散 ICBM"];
    const h = humanTranslation(SONG, shown, "en")!;
    expect(h.lines[0]).toBe("A bold, fearless, high-collar revolution An easygoing anti-war nation");
  });

  it("gives nothing for other lyrics, other languages, or AI-ish text that doesn't fit", () => {
    expect(humanTranslation(SONG, ["夜に駆ける", "沈むように溶けてゆくように", "二人だけの空が広がる夜に"], "en")).toBeNull();
    expect(humanTranslation(SONG, SHOWN, "es")).toBeNull();
  });
});

describe("vocadb lookup", () => {
  const memStore = () => {
    const m = new Map<string, unknown>();
    return { m, store: { get: async (k: string) => m.get(k) as never, set: async (k: string, v: unknown) => void m.set(k, v), delete: async (k: string) => void m.delete(k) } };
  };

  it("prefers the matching song and follows a cover to the original's lyrics", async () => {
    const urls: string[] = [];
    const fetchJson: FetchJson = async (url) => {
      urls.push(url);
      if (url.includes("/songs?"))
        return {
          ok: true,
          status: 200,
          json: {
            items: [
              { id: 117452, name: "千本桜", artistString: "MASA WORKS DESIGN feat. GUMI", lengthSeconds: 242, songType: "Remix", originalVersionId: 8394, lyrics: [] },
              // A cover with its own (Vietnamese) lyrics: still leads to the original.
              { id: 745219, name: "Thiên Bản Anh Đào", artistString: "someone", lengthSeconds: 250, songType: "Cover", originalVersionId: 8394, names: [{ value: "千本桜" }], lyrics: [{ cultureCodes: ["vi"], translationType: "Original", value: "Lời bài hát" }] },
            ],
          },
        };
      return { ok: true, status: 200, json: { id: 8394, name: "千本桜", artistString: "黒うさP feat. 初音ミク", lyrics: [{ cultureCodes: ["ja"], translationType: "Original", value: ORIGINAL }, { cultureCodes: ["en"], translationType: "Translation", value: ENGLISH, source: "Anime Lyrics" }] } };
    };
    const { m, store } = memStore();
    const song = await findVocaDbSong("千本桜", "黒うさP", 245_000, { fetchJson, gapMs: 0, store });
    expect(song?.id).toBe(8394);
    expect(song?.lyrics.map((l) => l.type)).toEqual(["Original", "Translation"]);
    expect(urls[0]).toContain("sort=RatingScore");
    expect(urls[1]).toContain("/songs/8394?");
    // Cached: no new requests.
    await findVocaDbSong("千本桜", "黒うさP", 245_000, { fetchJson, gapMs: 0, store });
    expect(urls.length).toBe(2);
    expect(m.size).toBe(1);
  });

  it("remembers a miss, and backs off when VocaDB is busy", async () => {
    const { store } = memStore();
    let calls = 0;
    const miss: FetchJson = async () => (calls++, { ok: true, status: 200, json: { items: [] } });
    expect(await findVocaDbSong("Unknown Song", "", 0, { fetchJson: miss, gapMs: 0, store })).toBeNull();
    expect(await findVocaDbSong("Unknown Song", "", 0, { fetchJson: miss, gapMs: 0, store })).toBeNull();
    expect(calls).toBe(1);
    const busy: FetchJson = async () => ({ ok: false, status: 429, json: null, retryAfter: 60 });
    await expect(findVocaDbSong("Another", "", 0, { fetchJson: busy, gapMs: 0, store: memStore().store })).rejects.toThrow(/429/);
    await expect(findVocaDbSong("Third", "", 0, { fetchJson: miss, gapMs: 0, store: memStore().store })).rejects.toThrow(/slow down/);
  });

  it("scores title first, then artist and length", () => {
    const a = scoreSong({ id: 1, name: "千本桜", artistString: "黒うさP feat. 初音ミク", lengthSeconds: 246, songType: "Original" }, "千本桜", "黒うさP", 245_000);
    const b = scoreSong({ id: 2, name: "千本桜", artistString: "vivallise feat. SAKURA", lengthSeconds: 243, songType: "Cover" }, "千本桜", "黒うさP", 245_000);
    expect(a).toBeGreaterThan(b);
  });
});

describe("vocadb pairing shapes", () => {
  it("pairs two short lines with one translated line, and the reverse", () => {
    expect(pairTranslation(["a", "b", "c", "d", "", "e", "f", "g"], ["AB", "CD", "", "E", "F", "G"])).toEqual(["AB", "", "CD", "", "E", "F", "G"]);
    expect(pairTranslation(["a", "b", "", "c"], ["A1", "A2", "B1", "B2", "", "C"])).toEqual(["A1 A2", "B1 B2", "C"]);
  });
  it("gives up on stanzas it can't pair safely", () => {
    expect(pairTranslation(["a", "b", "c", "", "d"], ["A", "B", "", "D"])).toEqual([null, null, null, "D"]);
  });
});

describe("vocadb romaji bridge", () => {
  // Shaped like シャルル: the original joins two sung lines, the romanized text and the translation don't.
  const song: VdbSong = {
    id: 135628,
    name: "シャルル",
    artist: "バルーン feat. v flower",
    lyrics: [
      { type: "Original", langs: ["ja"], source: "", url: "", text: "さよならはあなたから言った　それなのに頬を濡らしてしまうの\nそうやって昨日の事も消してしまうなら　もういいよ\n\n花束を抱えて歩いた　意味もなく" },
      { type: "Romanized", langs: ["und"], source: "", url: "", text: "sayonara wa anata kara itta\nsore nano ni hoo o nurashite shimau no\nsou yatte kinou no koto mo keshite shimau nara\nmou ii yo\n\nhanataba o kakaete aruita\nimi mo naku" },
      { type: "Translation", langs: ["en"], source: "Wiki", url: "", text: "It was you who said goodbye\nStill, tears run down on your cheeks\nIf you are going to erase memories of yesterday like this,\nthat's enough\n\nI walked holding a bouquet\nwithout any meaning" },
    ],
  };
  const shown = ["さよならはあなたから言った", "それなのに頬を濡らしてしまうの", "そうやって昨日の事も消してしまうなら", "もういいよ", "花束を抱えて歩いた", "意味もなく"];

  it("spells romaji one way", () => {
    expect(romajiKey("Tōkyō e")).toBe(romajiKey("toukyou he".replace("he", "e")));
    expect(romajiKey("kimi wo")).toBe(romajiKey("kimi o"));
    expect(romajiKey("とうきょう")).toBe(romajiKey("tokyo"));
  });

  it("matches the shown lines through VocaDB's romanized text", () => {
    const roman = ["sayonara wa anata kara itta", "sore na no ni hoo wo nurashite shimau no", "sō yatte kinō no koto mo keshite shimau nara", "mō ii yo", "hanataba wo kakaete aruita", "imi mo naku"];
    const h = humanTranslation(song, shown, "en", () => true, roman)!;
    expect(h.lines).toEqual(["It was you who said goodbye", "Still, tears run down on your cheeks", "If you are going to erase memories of yesterday like this,", "that's enough", "I walked holding a bouquet", "without any meaning"]);
  });

  it("still finds most lines from the kana alone (no romanizer)", () => {
    const h = humanTranslation(song, shown, "en")!;
    expect(h.coverage).toBeGreaterThanOrEqual(0.6);
    expect(h.lines[0]).toBe("It was you who said goodbye");
  });
});

describe("VocaDB untimed lyrics", () => {
  it("gives the original lyrics without furigana when the artist matches", () => {
    const text = vdbPlainText(SONG, "黒うさP")!;
    expect(text.split("\n")[1]).toBe("磊々落々反戦国家");
    expect(text).toContain("浮世の随に");
    expect(text).not.toMatch(/（/);
    expect(text).toContain("\n\n"); // stanza breaks kept
    expect(text.startsWith("大胆不敵にハイカラ革命")).toBe(true);
  });

  it("matches the singer or producer, not another artist with a song of the same name", () => {
    expect(artistMatches(SONG, "初音ミク")).toBe(true);
    expect(artistMatches(SONG, "Kurousa-P feat. Hatsune Miku")).toBe(false); // romanized names aren't guessed
    expect(vdbPlainText(SONG, "Some Rock Band")).toBeNull();
    expect(vdbPlainText(SONG, "")).toBeNull();
  });

  it("drops furigana after kanji but keeps kana lines in parentheses (backing vocals)", () => {
    const song: VdbSong = { ...SONG, lyrics: [{ type: "Original", langs: ["ja"], source: "", url: "", text: "君の声（ねえ）\n(ららら)" }] };
    expect(vdbPlainText(song, "初音ミク")).toBe("君の声\n(ららら)");
  });

  it("no original lyrics → nothing", () => {
    const song: VdbSong = { ...SONG, lyrics: SONG.lyrics.filter((l) => l.type !== "Original") };
    expect(vdbPlainText(song, "初音ミク")).toBeNull();
  });
});
