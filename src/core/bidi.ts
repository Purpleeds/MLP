// Text direction for lyrics: Arabic / Hebrew lines are laid out and filled right to left.

const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;
const LETTER = /\p{L}/u;

/** Direction of the first letter ("rtl" for Arabic, Hebrew…), or null when there are no letters (numbers, emoji). */
export function wordDir(s: string): "rtl" | "ltr" | null {
  for (const c of s) if (LETTER.test(c)) return RTL.test(c) ? "rtl" : "ltr";
  return null;
}

/** A line is right-to-left when most of its letters are (an English word inside an Arabic line keeps it RTL). */
export function lineDir(s: string): "rtl" | "ltr" {
  let rtl = 0;
  let ltr = 0;
  for (const c of s) if (LETTER.test(c)) RTL.test(c) ? rtl++ : ltr++;
  return rtl > ltr || (rtl === ltr && rtl > 0 && wordDir(s) === "rtl") ? "rtl" : "ltr";
}
