import { describe, expect, it } from "vitest";
import { cleanAnswer, guessLanguage, splitNumbered, translateTexts, type TranslateDeps } from "./translate";
import { DEFAULT_SETTINGS } from "./settings/schema";

const O = DEFAULT_SETTINGS.translation; // MyMemory → English
const noSleep = async () => {};

/** Fake MyMemory: `answer(q)` returns the body; records every query. */
function mm(answer: (q: string) => object) {
  const qs: string[] = [];
  const deps: TranslateDeps = {
    sleep: noSleep,
    fetchJson: async (url) => {
      const q = decodeURIComponent(/q=([^&]*)/.exec(url)![1]);
      qs.push(q);
      const json = answer(q);
      return { ok: true, status: 200, json };
    },
  };
  return { deps, qs };
}
const ok = (text: string, extra: object = {}) => ({ responseData: { translatedText: text, ...extra }, responseStatus: 200, quotaFinished: false });
/** Numbered answer: translate each "N. text" line as "N. EN(text)". */
const numbered = (q: string) => q.split("\n").map((l) => l.replace(/^(\d+)\. (.*)$/, "$1. EN($2)")).join("\n");
const single = (q: string) => (/^\d+\. /.test(q) ? numbered(q) : `EN(${q})`);

describe("guessLanguage", () => {
  it("guesses common languages cheaply", () => {
    expect(guessLanguage(["I don't know what to do with you"])).toBe("en");
    expect(guessLanguage(["夜空に光る"])).toBe("ja");
    expect(guessLanguage(["Te quiero mucho, mi amor, no me dejes"])).toBe("es");
    expect(guessLanguage(["Je ne sais pas pourquoi tu es avec moi"])).toBe("fr");
    expect(guessLanguage(["Ich liebe dich und du bist nicht hier"])).toBe("de");
    expect(guessLanguage(["Я тебе люблю"])).toBe("ru");
    expect(guessLanguage(["Я тебе кохаю, моя рідна і єдина"])).toBe("uk");
    expect(guessLanguage(["Xyzzy plugh"])).toBeNull();
  });
});

describe("answer checks", () => {
  it("drops warnings, error-looking caps and copies of the source", () => {
    expect(cleanAnswer("MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY", "夜空")).toBeNull();
    expect(cleanAnswer("QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS", "夜空")).toBeNull();
    expect(cleanAnswer("SOMETHING WENT VERY WRONG HERE", "夜空")).toBeNull();
    expect(cleanAnswer("Hello", "hello ")).toBeNull();
    expect(cleanAnswer("I LOVE YOU SO", "TE QUIERO TANTO")).toBe("I LOVE YOU SO"); // shouting lyrics are fine
    expect(cleanAnswer(" Night sky ", "夜空")).toBe("Night sky");
  });
  it("splits numbered answers and distrusts merged or missing lines", () => {
    expect(splitNumbered("1. a\n2. b\n3. c", 3)).toEqual(["a", "b", "c"]);
    expect(splitNumbered("1. a\nmore\n2. b", 2)).toEqual(["a more", "b"]); // split line rejoined
    expect(splitNumbered("1. a 2. b\n3. c", 3)).toEqual([null, null, "c"]); // 2 merged into 1
    expect(splitNumbered("a\nb", 2)).toEqual([null, null]);
  });
});

describe("MyMemory", () => {
  it("translates a batch in one numbered request", async () => {
    const { deps, qs } = mm((q) => ok(numbered(q)));
    const r = await translateTexts(["夜空", "星"], O, deps);
    expect(r).toEqual({ lines: ["EN(夜空)", "EN(星)"] });
    expect(qs).toEqual(["1. 夜空\n2. 星"]);
  });
  it("ignores answers whose status isn't 200", async () => {
    const { deps } = mm(() => ({ responseData: { translatedText: "garbage" }, responseStatus: "500" }));
    const r = await translateTexts(["夜空"], O, deps);
    expect(r.lines).toEqual([undefined]);
    expect(r.problem).toBe("service");
  });
  it("treats warning text in a 200 answer as no translation", async () => {
    const { deps } = mm(() => ok("MYMEMORY WARNING: SOMETHING ODD HAPPENED TODAY"));
    expect((await translateTexts(["夜空"], O, deps)).lines).toEqual([null]);
  });
  it("shows nothing when the text is already in the target language", async () => {
    const a = mm(() => ({ responseData: { translatedText: "PLEASE SELECT TWO DISTINCT LANGUAGES" }, responseStatus: "403", responseDetails: "PLEASE SELECT TWO DISTINCT LANGUAGES" }));
    expect(await translateTexts(["Hello there", "Bye now"], O, a.deps)).toEqual({ lines: [null, null] });
    const b = mm((q) => ok(numbered(q), { detectedLanguage: "en" }));
    expect((await translateTexts(["Hi", "Yo"], O, b.deps)).lines).toEqual([null, null]);
    const c = mm((q) => ok(q));
    expect((await translateTexts(["夜空"], O, c.deps)).lines).toEqual([null]); // echoed back
  });
  it("re-sends merged lines one by one", async () => {
    const { deps, qs } = mm((q) => (q.includes("\n") ? ok("1. EN(a) EN(b)\n3. EN(c)") : ok(single(q))));
    const r = await translateTexts(["a", "b", "c"], O, deps);
    expect(r.lines).toEqual(["EN(a)", "EN(b)", "EN(c)"]);
    expect(qs.slice(1).sort()).toEqual(["a", "b"]);
  });
  it("stops at the daily limit, also during retries, keeping what's done", async () => {
    let n = 0;
    const { deps, qs } = mm((q) => {
      if (q.includes("\n")) return ok("1. EN(a)\n2. EN(b) EN(c)"); // c merged → retry b and c
      return ++n === 1 ? { quotaFinished: true, responseStatus: 429, responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS" } } : ok(single(q));
    });
    const r = await translateTexts(["a", "b", "c"], O, deps);
    expect(r.problem).toBe("quota");
    expect(r.lines[0]).toBe("EN(a)");
    expect(r.lines.every((l) => l === undefined || (l && !/WARNING/.test(l)))).toBe(true);
    expect(qs.length).toBeLessThanOrEqual(3);
  });
  it("limits retries to 5 at a time", async () => {
    let live = 0;
    let peak = 0;
    const deps: TranslateDeps = {
      sleep: noSleep,
      fetchJson: async (url) => {
        const q = decodeURIComponent(/q=([^&]*)/.exec(url)![1]);
        if (q.includes("\n")) return { ok: true, status: 200, json: ok("nothing numbered") };
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 2));
        live--;
        return { ok: true, status: 200, json: ok(`EN(${q})`) };
      },
    };
    const texts = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const r = await translateTexts(texts, O, deps);
    expect(r.lines).toEqual(texts.map((t) => `EN(${t})`));
    expect(peak).toBeLessThanOrEqual(5);
  });
  it("reports being offline", async () => {
    const deps: TranslateDeps = { fetchJson: async () => Promise.reject(new TypeError("Failed to fetch")) };
    expect((await translateTexts(["夜空"], O, deps)).problem).toBe("offline");
  });
});

describe("DeepL", () => {
  it("sends at most 50 lines per request", async () => {
    const sizes: number[] = [];
    const deps: TranslateDeps = {
      fetchJson: async (_u, init) => {
        const text = JSON.parse(String(init!.body)).text as string[];
        sizes.push(text.length);
        return { ok: true, status: 200, json: { translations: text.map((t) => ({ text: `EN(${t})` })) } };
      },
    };
    const texts = Array.from({ length: 120 }, (_, i) => `l${i}`);
    const r = await translateTexts(texts, { ...O, provider: "deepl", deeplKey: "k:fx" }, deps);
    expect(sizes).toEqual([50, 50, 20]);
    expect(r.lines[119]).toBe("EN(l119)");
  });
});
