import { describe, expect, it } from "vitest";
import { SECTIONS } from "./fields";
import { es } from "./i18n/es";
import { ja } from "./i18n/ja";
import { resolveLang, translate } from "./i18n";

describe("settings translations", () => {
  it("picks the language", () => {
    expect(resolveLang("auto", "ja-JP")).toBe("ja");
    expect(resolveLang("auto", "fr-FR")).toBe("en");
    expect(resolveLang("es", "ja-JP")).toBe("es");
    expect(translate("ja", "Lyrics")).toBe("歌詞");
    expect(translate("ja", "no such text")).toBe("no such text");
  });
  it("covers every section, group and field label", () => {
    const missing: Record<string, string[]> = { ja: [], es: [] };
    // Same in every language: numbers, URLs, examples, language names in their own language, product names.
    const keep = (s: string) => /^\d+$|^https?:|^kyo|^kyō|^xxxx|^Spotify$|^CPU$|^\d+ fps$|^日本語$|^Español$|^NVIDIA GPU \(CUDA\)$/.test(s);
    for (const sec of SECTIONS) {
      const strings = [sec.title, ...sec.groups.flatMap((g) => [g.title, g.note, ...g.fields.flatMap((f) => ["label" in f ? f.label : "", "help" in f ? f.help : "", ...("options" in f ? f.options.map((o) => o.label) : [])])])];
      for (const s of strings) {
        if (!s || keep(s)) continue;
        if (!(s in ja)) missing.ja.push(s);
        if (!(s in es)) missing.es.push(s);
      }
    }
    expect(missing).toEqual({ ja: [], es: [] });
  });
});
