// Korean: apply the main pronunciation rules before Revised Romanization, so lyrics read the way
// they're sung (않아 → ana, 좋아 → joa, 같이 → gachi, 국물 → gungmul, 신라 → silla).
import korean from "@romanize/korean";

const L = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const T = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const V_I = 20; // ㅣ

/** Double finals → [stays, moves] when followed by a vowel. */
const SPLIT: Record<string, [string, string]> = {
  ㄳ: ["ㄱ", "ㅆ"], ㄵ: ["ㄴ", "ㅈ"], ㄺ: ["ㄹ", "ㄱ"], ㄻ: ["ㄹ", "ㅁ"], ㄼ: ["ㄹ", "ㅂ"],
  ㄽ: ["ㄹ", "ㅆ"], ㄾ: ["ㄹ", "ㅌ"], ㄿ: ["ㄹ", "ㅍ"], ㅄ: ["ㅂ", "ㅆ"],
};
/** Representative sound of a final (for assimilation). */
const REP: Record<string, string> = {
  ㄱ: "ㄱ", ㄲ: "ㄱ", ㅋ: "ㄱ", ㄳ: "ㄱ", ㄺ: "ㄱ",
  ㄷ: "ㄷ", ㅅ: "ㄷ", ㅆ: "ㄷ", ㅈ: "ㄷ", ㅊ: "ㄷ", ㅌ: "ㄷ", ㅎ: "ㄷ",
  ㅂ: "ㅂ", ㅍ: "ㅂ", ㄼ: "ㅂ", ㄿ: "ㅂ", ㅄ: "ㅂ",
  ㄴ: "ㄴ", ㄵ: "ㄴ", ㄹ: "ㄹ", ㄽ: "ㄹ", ㄾ: "ㄹ", ㅀ: "ㄹ", ㅁ: "ㅁ", ㄻ: "ㅁ", ㅇ: "ㅇ",
};
const ASPIRATE: Record<string, string> = { ㄱ: "ㅋ", ㄷ: "ㅌ", ㅂ: "ㅍ", ㅈ: "ㅊ" };

interface Syl {
  l: string;
  v: number;
  t: string;
}

const isSyl = (c: string) => c >= "가" && c <= "힣";
const dec = (c: string): Syl => {
  const n = c.charCodeAt(0) - 0xac00;
  return { l: L[Math.floor(n / 588)], v: Math.floor((n % 588) / 28), t: T[n % 28] };
};
const com = (s: Syl) => String.fromCharCode(0xac00 + L.indexOf(s.l) * 588 + s.v * 28 + T.indexOf(s.t));

function fix(a: Syl, b: Syl) {
  // ㅎ finals: aspirate the next consonant, or disappear before a vowel.
  if (a.t === "ㅎ" || a.t === "ㄶ" || a.t === "ㅀ") {
    const rest = a.t === "ㅎ" ? "" : a.t === "ㄶ" ? "ㄴ" : "ㄹ";
    if (ASPIRATE[b.l]) {
      b.l = ASPIRATE[b.l];
      a.t = rest;
    } else if (b.l === "ㅇ") a.t = rest;
    else if (b.l === "ㅅ") {
      b.l = "ㅆ";
      a.t = rest;
    } else if (b.l === "ㄴ") a.t = rest || "ㄴ";
  }
  // Final + ㅎ → aspirated.
  if (b.l === "ㅎ" && a.t) {
    const [stay, last] = SPLIT[a.t] ?? ["", a.t];
    const asp = ASPIRATE[REP[last] === "ㄷ" ? "ㄷ" : last] ?? ASPIRATE[REP[last] ?? ""];
    if (asp) {
      b.l = asp;
      a.t = stay;
    }
  }
  // Liaison: a final moves onto a following vowel (palatalized before ㅣ).
  if (b.l === "ㅇ" && a.t && a.t !== "ㅇ") {
    const [stay, move] = SPLIT[a.t] ?? ["", a.t];
    let m = move;
    if (b.v === V_I && (m === "ㄷ" || m === "ㅌ")) m = m === "ㄷ" ? "ㅈ" : "ㅊ";
    if (L.includes(m)) {
      b.l = m;
      a.t = stay;
    }
    return;
  }
  const rep = REP[a.t] ?? "";
  // Nasalization.
  if (b.l === "ㄴ" || b.l === "ㅁ") {
    if (rep === "ㄱ") a.t = "ㅇ";
    else if (rep === "ㄷ") a.t = "ㄴ";
    else if (rep === "ㅂ") a.t = "ㅁ";
  }
  if (b.l === "ㄹ") {
    if (rep === "ㅁ" || rep === "ㅇ") b.l = "ㄴ";
    else if (rep === "ㄱ") (a.t = "ㅇ"), (b.l = "ㄴ");
    else if (rep === "ㅂ") (a.t = "ㅁ"), (b.l = "ㄴ");
    else if (rep === "ㄴ") a.t = "ㄹ"; // liquidization
  } else if (rep === "ㄹ" && b.l === "ㄴ") b.l = "ㄹ";
}

/** Hangul text as pronounced (rules applied inside words, not across spaces). */
export function pronounce(text: string): string {
  const chars = [...text];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (!isSyl(chars[i])) {
      out.push(chars[i++]);
      continue;
    }
    const run: Syl[] = [];
    while (i < chars.length && isSyl(chars[i])) run.push(dec(chars[i++]));
    for (let k = 0; k < run.length - 1; k++) fix(run[k], run[k + 1]);
    out.push(...run.map(com));
  }
  return out.join("");
}

// RR writes ㄹㄹ as "ll"; the library gives "lr".
export const koRoman = (text: string, rules: boolean) => korean.romanize(rules ? pronounce(text) : text).replace(/lr/g, "ll");
