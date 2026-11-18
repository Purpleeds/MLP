import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings/schema";
import type { Lyrics } from "./lyrics/model";
import type { TranslateDeps } from "./translate";
import {
  formatTranslation, getTranslations, lyricsHash, parseTranslation, resetAllTranslations, resetTranslation,
  translationFileName, type TranslationFiles,
} from "./translationFiles";

const O = { ...DEFAULT_SETTINGS.translation, vocadb: false }; // VocaDB has its own tests below
const lyr = (texts: string[], extra: Partial<Lyrics["lines"][number]>[] = []): Lyrics => ({
  kind: "line", source: "lrclib", id: 1, trackName: "夜に駆ける", artistName: "YOASOBI", durationMs: 1,
  lines: texts.map((text, i) => ({ start: i * 1000, end: i * 1000 + 900, text, words: null, ...extra[i] })),
});
const SONG = { title: "夜に駆ける", artist: "YOASOBI" };

function memFiles() {
  const m = new Map<string, string>();
  const files: TranslationFiles = {
    read: async (n) => m.get(n) ?? null,
    write: async (n, t) => void m.set(n, t),
    remove: async (n) => void m.delete(n),
    clear: async () => {
      const n = m.size;
      m.clear();
      return n;
    },
  };
  return { m, files };
}
/** Fake MyMemory translating numbered lines; `quotaAfter` requests then the daily limit. */
function mm(quotaAfter = Infinity) {
  const qs: string[] = [];
  const deps: TranslateDeps = {
    sleep: async () => {},
    fetchJson: async (url) => {
      const q = decodeURIComponent(/q=([^&]*)/.exec(url)![1]);
      qs.push(q);
      if (qs.length > quotaAfter) return { ok: true, status: 200, json: { quotaFinished: true, responseStatus: 429, responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY" } } };
      const t = q.split("\n").map((l) => (/^\d+\. /.test(l) ? l.replace(/^(\d+)\. (.*)$/, "$1. EN($2)") : `EN(${l})`)).join("\n");
      return { ok: true, status: 200, json: { responseData: { translatedText: t }, responseStatus: 200 } };
    },
  };
  return { deps, qs };
}

describe("file names", () => {
  it("are Windows-safe", () => {
    expect(translationFileName("夜に駆ける", "YOASOBI")).toBe("夜に駆ける - YOASOBI.txt");
    expect(translationFileName("AC/DC: Back?", "")).toBe("AC_DC_ Back_.txt");
    expect(translationFileName('a<b>"c|d*\u0007', "x\\y")).toBe("a_b__c_d_ - x_y.txt");
    expect(translationFileName("Song...  ")).toBe("Song.txt");
    expect(translationFileName("CON")).toBe("_CON.txt");
    expect(translationFileName("nul.txt")).toBe("_nul.txt.txt");
    expect(translationFileName("   ")).toBe("Untitled.txt");
    expect([...translationFileName("x".repeat(500), "y")].length).toBeLessThanOrEqual(124);
  });
});

describe("file format", () => {
  it("round-trips", () => {
    const f = {
      song: "夜に駆ける", artist: "YOASOBI", target: "en", provider: "mymemory", hash: lyricsHash(["a", "", "c"]), complete: false,
      lines: [{ text: "a", tr: "EN a" }, { text: "", tr: null }, { text: "c", tr: undefined }],
    };
    const text = formatTranslation(f);
    expect(text).toContain("a\r\n→ EN a\r\n");
    expect(parseTranslation(text)).toEqual(f);
    expect(parseTranslation("{\"json\":1}")).toBeNull();
  });
});

describe("getTranslations", () => {
  it("translates once, saves a file and reuses it", async () => {
    const { m, files } = memFiles();
    const a = mm();
    const l = lyr(["夜空", "星", "夜空", "OK"]);
    expect((await getTranslations(l, SONG, O, { ...a.deps, files })).lines).toEqual(["EN(夜空)", "EN(星)", "EN(夜空)", "EN(OK)"]);
    expect(a.qs).toHaveLength(1);
    const saved = parseTranslation(m.get("夜に駆ける - YOASOBI.txt")!)!;
    expect(saved.complete).toBe(true);
    const b = mm();
    expect((await getTranslations(l, SONG, O, { ...b.deps, files })).lines[1]).toBe("EN(星)");
    expect(b.qs).toHaveLength(0);
  });
  it("keeps TTML translations working without files", async () => {
    const { m, files } = memFiles();
    const l = lyr(["你好"], [{ translation: "Hello", translationLang: "en" }]);
    expect((await getTranslations(l, SONG, O, { fetchJson: async () => ({ ok: false, status: 500, json: null }), files })).lines).toEqual(["Hello"]);
    expect(m.size).toBe(0);
  });
  it("re-translates only changed lines when the lyrics change", async () => {
    const { m, files } = memFiles();
    await getTranslations(lyr(["夜空", "星"]), SONG, O, { ...mm().deps, files });
    const b = mm();
    const r = await getTranslations(lyr(["夜空", "月"]), SONG, O, { ...b.deps, files });
    expect(r.lines).toEqual(["EN(夜空)", "EN(月)"]);
    expect(b.qs).toEqual(["月"]);
    expect(parseTranslation(m.get("夜に駆ける - YOASOBI.txt")!)!.hash).toBe(lyricsHash(["夜空", "月"]));
  });
  it("ignores a file for another target language", async () => {
    const { files } = memFiles();
    await getTranslations(lyr(["夜空"]), SONG, O, { ...mm().deps, files });
    const b = mm();
    await getTranslations(lyr(["夜空"]), SONG, { ...O, target: "es" }, { ...b.deps, files });
    expect(b.qs).toHaveLength(1);
  });
  it("saves nothing when the limit is reached before anything is translated", async () => {
    const { m, files } = memFiles();
    const r = await getTranslations(lyr(["夜空"]), SONG, O, { ...mm(0).deps, files });
    expect(r).toEqual({ lines: [null], problem: "quota", kind: "machine" });
    expect(m.size).toBe(0);
  });
  it("keeps finished lines on a mid-way limit, never saves warning text, finishes later", async () => {
    const { m, files } = memFiles();
    const long = Array.from({ length: 40 }, (_, i) => `夜空の星が光るよ${i}番`); // > 1 request
    const r = await getTranslations(lyr(long), SONG, O, { ...mm(1).deps, files });
    expect(r.problem).toBe("quota");
    expect(r.lines[0]).toBe(`EN(${long[0]})`);
    expect(r.lines.at(-1)).toBeNull();
    const text = m.get("夜に駆ける - YOASOBI.txt")!;
    expect(text).not.toMatch(/WARNING/);
    expect(parseTranslation(text)!.complete).toBe(false);
    const b = mm();
    const done = await getTranslations(lyr(long), SONG, O, { ...b.deps, files });
    expect(done.lines.every(Boolean)).toBe(true);
    expect(b.qs.join("\n")).not.toContain(long[0]);
    expect(parseTranslation(m.get("夜に駆ける - YOASOBI.txt")!)!.complete).toBe(true);
  });
  it("resets delete the files", async () => {
    const { m, files } = memFiles();
    await getTranslations(lyr(["夜空"]), SONG, O, { ...mm().deps, files });
    await getTranslations(lyr(["星"]), { title: "Other" }, O, { ...mm().deps, files });
    expect([...m.keys()].sort()).toEqual(["Other.txt", "夜に駆ける - YOASOBI.txt"]);
    await resetTranslation(SONG, files);
    expect([...m.keys()]).toEqual(["Other.txt"]);
    const b = mm();
    await getTranslations(lyr(["夜空"]), SONG, O, { ...b.deps, files });
    expect(b.qs).toHaveLength(1); // translated again
    expect(await resetAllTranslations(files)).toBe(2);
    expect(m.size).toBe(0);
  });
});

describe("human translations (VocaDB)", () => {
  const HO = { ...O, vocadb: true };
  const ja = ["夜空を見上げて", "星が流れてく", "君の名前を呼ぶ"];
  const en = ["Looking up at the night sky", "The stars flow by", "I call your name"];
  const vdbStore = () => {
    const m = new Map<string, unknown>();
    return { get: async (k: string) => m.get(k) as never, set: async (k: string, v: unknown) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
  };
  const vocadb = (found: boolean) => ({
    gapMs: 0,
    store: vdbStore(),
    fetchJson: async () => ({
      ok: true, status: 200,
      json: { items: found ? [{ id: 5, name: "夜に駆ける", artistString: "YOASOBI", lyrics: [
        { cultureCodes: ["ja"], translationType: "Original", value: ja.join("\n") },
        { cultureCodes: ["en"], translationType: "Translation", value: en.join("\n"), source: "Wiki", url: "https://example.org/tl" },
      ] }] : [] },
    }),
  });

  it("uses VocaDB before the machine, saves it, and reuses the file", async () => {
    const { m, files } = memFiles();
    const b = mm();
    const r = await getTranslations(lyr(ja), SONG, HO, { ...b.deps, files, vocadb: vocadb(true) });
    expect(r).toMatchObject({ kind: "human", lines: en, source: "https://example.org/tl" });
    expect(b.qs).toHaveLength(0);
    const f = parseTranslation(m.get("夜に駆ける - YOASOBI.txt")!)!;
    expect(f).toMatchObject({ provider: "vocadb", source: "https://example.org/tl", complete: true });
    const again = await getTranslations(lyr(ja), SONG, HO, { ...b.deps, files, vocadb: vocadb(false) });
    expect(again.kind).toBe("human");
    expect(again.lines).toEqual(en);
  });

  it("falls back to the machine, which never overwrites a saved human translation", async () => {
    const { m, files } = memFiles();
    await getTranslations(lyr(ja), SONG, HO, { ...mm().deps, files, vocadb: vocadb(true) });
    const before = m.get("夜に駆ける - YOASOBI.txt");
    const changed = [...ja, "新しい行"];
    const r = await getTranslations(lyr(changed), SONG, HO, { ...mm().deps, files, vocadb: vocadb(false) });
    expect(r.kind).toBe("machine");
    expect(m.get("夜に駆ける - YOASOBI.txt")).toBe(before);
    const none = await getTranslations(lyr(["夜空"]), { title: "Other" }, HO, { ...mm().deps, files, vocadb: vocadb(false) });
    expect(none).toMatchObject({ kind: "machine", lines: ["EN(夜空)"] });
  });

  it("works with 'only the lyrics file' too, without any machine translation", async () => {
    const { files } = memFiles();
    const b = mm();
    const r = await getTranslations(lyr(ja), SONG, { ...HO, provider: "file" }, { ...b.deps, files, vocadb: vocadb(true) });
    expect(r.kind).toBe("human");
    const none = await getTranslations(lyr(ja), { title: "Other" }, { ...HO, provider: "file" }, { ...b.deps, files, vocadb: vocadb(false) });
    expect(none.lines).toEqual([null, null, null]);
    expect(b.qs).toHaveLength(0);
  });
});
