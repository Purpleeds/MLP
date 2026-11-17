// Album-art palette extraction (tiny canvas + k-means) for backgrounds.

export type RGB = [number, number, number];

const cache = new Map<string, Promise<RGB[]>>();

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Make colors usable as a background: limit lightness, boost saturation. */
export function tune(c: RGB, saturation = 1.3): RGB {
  const [h, s, l] = rgbToHsl(c);
  return hslToRgb(h, Math.min(1, s * saturation), Math.min(0.55, Math.max(0.12, l)));
}

/** Deterministic palette from a string (used when there is no artwork). */
export function paletteFromSeed(seed: string): RGB[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const base = ((h >>> 0) % 360) / 360;
  return [0, 0.08, 0.55, 0.62, 0.15].map((o, i) => hslToRgb((base + o) % 1, 0.55, [0.32, 0.45, 0.3, 0.4, 0.22][i]));
}

function kmeans(px: RGB[], k: number): { c: RGB; n: number }[] {
  let cents = Array.from({ length: k }, (_, i) => px[Math.floor(((i + 0.5) / k) * px.length)]);
  let groups: RGB[][] = [];
  for (let it = 0; it < 8; it++) {
    groups = cents.map(() => []);
    for (const p of px) {
      let bi = 0;
      let bd = Infinity;
      cents.forEach((c, i) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      groups[bi].push(p);
    }
    cents = groups.map((g, i) =>
      g.length ? (g.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / g.length) as RGB) : cents[i],
    );
  }
  return cents.map((c, i) => ({ c, n: groups[i].length }));
}

/** 5 representative colors of an image, most common first. */
export function extractPalette(src: string): Promise<RGB[]> {
  let p = cache.get(src);
  if (!p) {
    p = new Promise<RGB[]>((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 32;
          const ctx = c.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0, 32, 32);
          const d = ctx.getImageData(0, 0, 32, 32).data;
          const px: RGB[] = [];
          for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
          const clusters = kmeans(px, 5).sort((a, b) => b.n - a.n);
          resolve(clusters.map((x) => x.c.map(Math.round) as RGB));
        } catch {
          resolve(paletteFromSeed(src.slice(-64)));
        }
      };
      img.onerror = () => resolve(paletteFromSeed(src.slice(-64)));
      img.src = src;
    });
    cache.set(src, p);
    if (cache.size > 30) cache.delete(cache.keys().next().value!);
  }
  return p;
}

export const css = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Upgrade 13: a readable accent from the cover — the most colourful palette entry, made light enough for sung text on a dark card. */
export function accentFrom(palette: RGB[]): RGB {
  let best: RGB = [255, 255, 255];
  let score = -1;
  palette.forEach((c, i) => {
    const [, s, l] = rgbToHsl(c);
    const sc = s * (1 - Math.abs(l - 0.5)) * (1 - i * 0.08); // colourful, not black/white, common first
    if (sc > score) [best, score] = [c, sc];
  });
  const [h, s] = rgbToHsl(best);
  if (s < 0.12) return [255, 255, 255]; // grey cover → plain white
  return hslToRgb(h, Math.min(0.9, Math.max(0.55, s)), 0.76);
}

export const hex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
