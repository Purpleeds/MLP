// Upgrade 20: the settings window in more languages. Strings are looked up by their English text,
// so anything not translated yet simply stays English.
import { useSettings } from "../core/settings/store";
import { es } from "./i18n/es";
import { ja } from "./i18n/ja";

const DICTS: Record<string, Record<string, string>> = { ja, es };
export const UI_LANGS = ["en", "ja", "es"] as const;
export type UiLang = (typeof UI_LANGS)[number];

/** "auto" follows the Windows / browser language when we have it. */
export function resolveLang(setting: string, nav = typeof navigator !== "undefined" ? navigator.language : "en"): UiLang {
  if ((UI_LANGS as readonly string[]).includes(setting)) return setting as UiLang;
  const n = nav.slice(0, 2).toLowerCase();
  return (UI_LANGS as readonly string[]).includes(n) ? (n as UiLang) : "en";
}

export const translate = (lang: UiLang, s: string): string => (lang === "en" ? s : (DICTS[lang]?.[s] ?? s));

/** React: `t(text)` in the chosen interface language. */
export function useT() {
  const lang = resolveLang(useSettings().app.uiLanguage);
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  return <T extends string | undefined>(s: T): T => (s ? (translate(lang, s) as T) : s);
}
