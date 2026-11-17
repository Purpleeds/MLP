// Upgrade 14: share card — the current line + cover art as a 1080×1080 PNG (copied and saved).
import { accentFrom, css, extractPalette, tune, type RGB } from "../render/palette";

export interface CardInput {
  line: string;
  sub?: string;
  title: string;
  artist: string;
  art: string | null;
}

/** Break text into lines that fit `maxWidth` (words; CJK text breaks anywhere). */
export function wrapText(measure: (s: string) => number, text: string, maxWidth: number): string[] {
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) && !/\s/.test(text.trim());
  const units = cjk ? [...text] : text.split(/(\s+)/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    const next = cur + u;
    if (cur.trim() && measure(next.trimEnd()) > maxWidth) {
      out.push(cur.trim());
      cur = /^\s+$/.test(u) ? "" : u;
    } else cur = next;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const SIZE = 1080;

/** Draw the card; returns a PNG blob. Cover art that blocks reading (CORS) is replaced by its colours. */
export async function renderShareCard(c: CardInput, font: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const palette: RGB[] = c.art ? await extractPalette(c.art) : [[40, 30, 60], [90, 40, 80]];
  const [a, b] = [tune(palette[0] ?? [40, 30, 60]), tune(palette[1] ?? palette[0] ?? [90, 40, 80])];
  const g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  g.addColorStop(0, css(a));
  g.addColorStop(1, css(b));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // crossOrigin: art from a site without CORS fails to load → the card just uses its colours.
  const img = c.art ? await loadImage(c.art) : null;
  if (img) {
    // Blurred cover behind everything, then the sharp cover.
    ctx.save();
    ctx.filter = "blur(60px) saturate(1.3)";
    ctx.globalAlpha = 0.85;
    ctx.drawImage(img, -120, -120, SIZE + 240, SIZE + 240);
    ctx.restore();
  }
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  ctx.fillRect(0, 0, SIZE, SIZE);
  const pad = 96;
  if (img) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 40;
    const r = 28;
    const s = 220;
    ctx.beginPath();
    ctx.roundRect(pad, pad, s, s, r);
    ctx.clip();
    ctx.drawImage(img, pad, pad, s, s);
    ctx.restore();
  }

  // The lyric line, as big as fits.
  const accent = accentFrom(palette);
  const maxW = SIZE - pad * 2;
  let size = 92;
  let lines: string[] = [];
  for (; size >= 44; size -= 4) {
    ctx.font = `800 ${size}px ${font}`;
    lines = wrapText((s) => ctx.measureText(s).width, c.line, maxW);
    if (lines.length * size * 1.15 <= SIZE * 0.42) break;
  }
  ctx.textBaseline = "top";
  let y = 420;
  ctx.fillStyle = "#fff";
  for (const l of lines) {
    ctx.fillText(l, pad, y);
    y += size * 1.15;
  }
  if (c.sub) {
    ctx.font = `600 ${Math.round(size * 0.45)}px ${font}`;
    ctx.fillStyle = css(accent, 0.9);
    for (const l of wrapText((s) => ctx.measureText(s).width, c.sub, maxW).slice(0, 2)) {
      ctx.fillText(l, pad, y + 8);
      y += size * 0.55;
    }
  }
  // Song + artist at the bottom.
  ctx.font = `700 40px ${font}`;
  ctx.fillStyle = "#fff";
  ctx.fillText(c.title, pad, SIZE - pad - 96, maxW);
  ctx.font = `500 34px ${font}`;
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillText(c.artist, pad, SIZE - pad - 44, maxW);

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("couldn't make the image"))), "image/png"));
}
