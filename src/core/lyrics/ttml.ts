// TTML (Apple Music / AMLL style) → normalized lyric lines with exact word timing,
// background vocals (ttm:role="x-bg") as their own lines and duet singers (ttm:agent).
import type { LyricLine, LyricWord } from "./model";

const TTM = "http://www.w3.org/ns/ttml#metadata";

/** "mm:ss.mmm", "hh:mm:ss.mmm", "ss.mmm", "12.5s" or "1500ms" → ms */
export function ttmlTime(v: string | null): number {
  if (!v) return NaN;
  const s = v.trim();
  if (s.endsWith("ms")) return parseFloat(s);
  if (s.endsWith("s") && !s.includes(":")) return parseFloat(s) * 1000;
  const parts = s.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0) * 1000);
}

const role = (el: Element) => el.getAttributeNS(TTM, "role") ?? el.getAttribute("ttm:role");
const agentOf = (el: Element) => el.getAttributeNS(TTM, "agent") ?? el.getAttribute("ttm:agent");

/** Singer number per agent id: people 1, 2, 3… in order of appearance, group agents ("together") 0. */
function voiceMap(doc: Document, ps: Element[]): Map<string, number> {
  const decl = [...Array.from(doc.getElementsByTagNameNS?.(TTM, "agent") ?? []), ...Array.from(doc.getElementsByTagName("ttm:agent"))];
  const groups = new Set(decl.filter((a) => a.getAttribute("type") === "group").map((a) => a.getAttribute("xml:id") ?? a.getAttribute("id") ?? ""));
  const out = new Map<string, number>();
  let n = 0;
  for (const p of ps) {
    const id = agentOf(p);
    if (id && !out.has(id)) out.set(id, groups.has(id) ? 0 : ++n);
  }
  // One singer only: nothing to colour.
  return new Set(out.values()).size > 1 ? out : new Map();
}

/** Timed spans of an element (direct children), with the whitespace that follows each one. */
function words(el: Element): LyricWord[] {
  const out: LyricWord[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      // Text between spans (usually a space) belongs to the previous word.
      if (out.length) out[out.length - 1].text += node.textContent ?? "";
      continue;
    }
    if (node.nodeType !== 1) continue;
    const e = node as Element;
    if (e.localName !== "span" || role(e)) continue;
    const start = ttmlTime(e.getAttribute("begin"));
    const end = ttmlTime(e.getAttribute("end"));
    if (!Number.isFinite(start)) continue;
    out.push({ text: e.textContent ?? "", start, end: Number.isFinite(end) ? end : NaN });
  }
  // Collapse runs of whitespace; drop empty words.
  return out.map((w) => ({ ...w, text: w.text.replace(/\s+/g, " ") })).filter((w) => w.text.trim());
}

const stripParens = (ws: LyricWord[]) => {
  if (!ws.length) return ws;
  const out = ws.map((w) => ({ ...w }));
  out[0].text = out[0].text.replace(/^\s*[(（]/, "");
  out[out.length - 1].text = out[out.length - 1].text.replace(/[)）]\s*$/, "");
  return out.filter((w) => w.text.trim());
};

function toLine(ws: LyricWord[], p: Element, extra: Partial<LyricLine>): LyricLine | null {
  if (!ws.length) return null;
  ws[ws.length - 1].text = ws[ws.length - 1].text.trimEnd();
  for (let i = 0; i < ws.length; i++) if (!Number.isFinite(ws[i].end)) ws[i].end = ws[i + 1]?.start ?? ws[i].start + 500;
  const start = Math.min(ws[0].start, ttmlTime(p.getAttribute("begin")) || Infinity);
  const end = Math.max(ws[ws.length - 1].end, ttmlTime(p.getAttribute("end")) || 0);
  return { start, end, text: ws.map((w) => w.text).join("").trim(), words: ws, exactEnds: true, ...extra };
}

export function parseTtml(xml: string): LyricLine[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Invalid TTML");
  // Namespace-agnostic: default-namespace <p> and prefixed <tt:p>.
  const byNs = Array.from(doc.getElementsByTagNameNS?.("*", "p") ?? []);
  const ps = byNs.length ? byNs : Array.from(doc.getElementsByTagName("p"));
  const firstAgent = ps.map(agentOf).find(Boolean) ?? null;
  const voices = voiceMap(doc, ps);
  const lines: LyricLine[] = [];
  for (const p of ps) {
    const agent = agentOf(p);
    const duet = !!agent && !!firstAgent && agent !== firstAgent;
    const voice = agent ? voices.get(agent) : undefined;
    const who = { ...(duet ? { duet: true } : {}), ...(voice !== undefined ? { voice } : {}) };
    let main = words(p);
    if (!main.length && p.textContent?.trim()) {
      // Line-timed TTML: a single "word" spanning the line.
      const s = ttmlTime(p.getAttribute("begin"));
      const e = ttmlTime(p.getAttribute("end"));
      if (Number.isFinite(s)) main = [{ text: p.textContent.trim(), start: s, end: Number.isFinite(e) ? e : s + 3000 }];
    }
    const tr = Array.from(p.children).find((c) => role(c) === "x-translation");
    const trans = tr?.textContent?.trim()
      ? { translation: tr.textContent.trim(), translationLang: tr.getAttribute("xml:lang") ?? tr.getAttribute("lang") ?? undefined }
      : {};
    const line = toLine(main, p, { ...who, ...trans });
    if (line) lines.push(line);
    for (const bgEl of Array.from(p.children).filter((c) => role(c) === "x-bg")) {
      const bg = toLine(stripParens(words(bgEl)), bgEl, { bg: true, ...who });
      if (bg) lines.push(bg);
    }
  }
  return lines.sort((a, b) => a.start - b.start || Number(!!a.bg) - Number(!!b.bg));
}
