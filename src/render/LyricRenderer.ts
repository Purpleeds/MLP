// Apple-Music-style lyric renderer (vanilla DOM, own rAF loop; React only mounts it).
// Lines are absolutely positioned and moved with springs; only the active line updates per frame.
import type { Timeline, TimedLine, TimedWord } from "../core/timing/timeline";
import { wordProgress } from "../core/timing/timeline";
import { lineDir, wordDir } from "../core/bidi";
import { planWordFx, type FxChoice, type FxStyle, type WordFx } from "./wordFx";

export interface RendererOptions {
  anchor: number;
  lineGap: number; // em
  blur: boolean;
  blurStep: number;
  blurMax: number;
  inactiveScale: number;
  spring: boolean;
  springStiffness: number;
  springDamping: number;
  stagger: number;
  lift: number;
  emphasis: boolean;
  /** which effect held / key words get ("auto" = matched to the song) */
  effectStyle?: FxChoice;
  /** song title: its words get an effect too */
  songTitle?: string;
  glowColor: string;
  interludeDots: boolean;
  edgeFade: boolean;
  align: "left" | "center" | "right";
  reducedMotion: boolean;
  /** frame-rate cap for lyric animation */
  fps: number;
  /** show only the active line and this many following lines (mini mode); null = all */
  window?: number | null;
  /** one-line strips: shrink lines that don't fit the width (down to 60 %) */
  fitWidth?: boolean;
  /** click a line → called with its start time (song time); the line gets a pointer cursor */
  onLineClick?: ((start: number) => void) | null;
}

interface WordEl {
  el: HTMLElement;
  w: TimedWord;
  letters: HTMLElement[] | null;
  fx: WordFx | null;
  p: number;
  glow: number;
}

interface Item {
  kind: "line" | "dots";
  start: number;
  end: number;
  bg: boolean;
  line: TimedLine | null;
  el: HTMLElement;
  h: number;
  y: number;
  vy: number;
  target: number;
  shownTarget: number;
  delayUntil: number;
  scale: number;
  hl: number;
  live: boolean;
  cur: boolean;
  blur: number;
  opacity: number;
  words: WordEl[];
  dots: HTMLElement[];
  /** last written transform / --hl (avoid redundant style writes) */
  tf: string;
  hlStr: string;
}

const HL_FADE_MS = 650;
const DOTS_IN_MS = 450;
const DOTS_OUT_MS = 550;
const USER_SCROLL_HOLD_MS = 2500;
// Letter-by-letter emphasis only where splitting a word can't break shaping (Arabic joining, Indic
// clusters, CJK, combining marks, emoji sequences); other held words glow as a whole.
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}~]+$/u;

// Emoji (incl. ZWJ / skin-tone / flag sequences). The fill clips a gradient to the text, which would
// turn a colour emoji into a flat silhouette, so emoji runs get their own span drawn in their colours.
const EMOJI_RUN = /((?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣)+)/u;

function appendWithEmoji(span: HTMLElement, text: string) {
  if (!EMOJI_RUN.test(text)) {
    span.textContent = text;
    return;
  }
  for (const part of text.split(EMOJI_RUN)) {
    if (!part) continue;
    if (EMOJI_RUN.test(part) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(part)) {
      const e = document.createElement("span");
      e.className = "lr-emoji";
      e.textContent = part;
      span.appendChild(e);
    } else span.append(part);
  }
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export class LyricRenderer {
  private list: HTMLDivElement;
  private items: Item[] = [];
  private opts: RendererOptions;
  private raf = 0;
  private idleTimer = 0;
  private lastFrame = 0;
  private lastT = NaN;
  private focus = -1;
  private fontPx = 28;
  private height = 0;
  private userOffset = 0;
  private userAt = 0;
  private ro: ResizeObserver;
  private destroyed = false;
  /** something is animating (springs, fades, glow) → run at the full frame rate */
  private moving = true;
  /**
   * Lines are in their final layout. False after a (re)build or a re-measure: the next frame puts every
   * line straight at its target (no springs, no stagger, no blur/opacity transitions) instead of flying
   * them in from the top, and the list stays hidden until that frame has run.
   */
  private placed = false;

  constructor(
    private root: HTMLElement,
    private getTime: () => number,
    opts: RendererOptions,
  ) {
    this.opts = opts;
    this.list = document.createElement("div");
    this.list.className = "lr-list";
    root.appendChild(this.list);
    root.dataset.align = opts.align;
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(root);
    root.addEventListener("wheel", this.onWheel, { passive: true });
    root.addEventListener("click", this.onClick);
    root.classList.toggle("seekable", !!opts.onLineClick);
    void document.fonts?.ready.then(() => this.measure());
  }

  setOptions(o: RendererOptions) {
    const relayout =
      o.lineGap !== this.opts.lineGap || o.emphasis !== this.opts.emphasis || o.effectStyle !== this.opts.effectStyle || o.songTitle !== this.opts.songTitle;
    this.opts = o;
    this.root.dataset.align = o.align;
    this.root.classList.toggle("seekable", !!o.onLineClick);
    for (const it of this.items) it.blur = -1; // force re-apply
    if (relayout) this.build(this.timeline);
    else this.measure();
    this.kick();
  }

  private timeline: Timeline | null = null;

  setTimeline(tl: Timeline | null) {
    this.timeline = tl;
    this.build(tl);
    this.kick();
  }

  // ---------- build ----------

  private build(tl: Timeline | null) {
    this.list.textContent = "";
    this.items = [];
    this.focus = -1;
    this.lastT = NaN;
    this.unplace();
    // Mostly right-to-left song: interlude dots move to the mirrored side too.
    const rtlLines = tl ? tl.lines.filter((l) => lineDir(l.text) === "rtl").length : 0;
    this.root.classList.toggle("rtl-song", !!tl && rtlLines > tl.lines.length / 2);
    if (!tl) return;
    const dotsAt = new Map<number, { start: number; end: number }>();
    if (this.opts.interludeDots) for (const g of tl.interludes) dotsAt.set(g.end, g);

    const add = (it: Omit<Item, "h" | "y" | "vy" | "target" | "shownTarget" | "delayUntil" | "scale" | "hl" | "live" | "cur" | "blur" | "opacity" | "tf" | "hlStr">) => {
      this.list.appendChild(it.el);
      this.items.push({ ...it, h: 0, y: 0, vy: 0, target: 0, shownTarget: 0, delayUntil: 0, scale: 1, hl: 0, live: false, cur: false, blur: -1, opacity: 1, tf: "", hlStr: "" });
    };

    const fx = this.opts.emphasis ? planWordFx(tl, { choice: this.opts.effectStyle ?? "auto", title: this.opts.songTitle }) : null;
    this.energy = fx?.energy ?? 0.5;
    tl.lines.forEach((line, i) => {
      const g = dotsAt.get(line.start);
      if (g) add(this.makeDots(g));
      add(this.makeLine(line, fx?.words[i] ?? null));
    });
    this.measure();
  }

  private makeDots(g: { start: number; end: number }) {
    const el = document.createElement("div");
    el.className = "lr-item lr-dots";
    const dots: HTMLElement[] = [];
    for (let i = 0; i < 3; i++) {
      const d = document.createElement("span");
      d.className = "lr-dot";
      el.appendChild(d);
      dots.push(d);
    }
    return { kind: "dots" as const, start: g.start, end: g.end, bg: false, line: null, el, words: [], dots };
  }

  private makeLine(line: TimedLine, fxRow: (WordFx | null)[] | null) {
    const el = document.createElement("div");
    el.className = `lr-item lr-line${line.bg ? " bg" : ""}${line.duet ? " duet" : ""}${line.voice !== undefined ? ` voice-${line.voice}` : ""}${line.fill === "none" ? " nofill" : ""}`;
    const main = document.createElement("p");
    main.className = "lr-main";
    // Arabic / Hebrew: right-to-left line, fill runs right to left; runs of Latin words inside stay in
    // reading order (each word is an inline-block, which bidi would otherwise reverse) via an isolate.
    const rtl = lineDir(line.text) === "rtl";
    if (rtl) {
      main.dir = "rtl";
      el.classList.add("rtl");
    }
    let ltrRun: HTMLElement | null = null;
    const parentFor = (core: string) => {
      if (!rtl) return main;
      const d = wordDir(core);
      if (d === "rtl") ltrRun = null;
      else if (d === "ltr" && !ltrRun) {
        ltrRun = document.createElement("span");
        ltrRun.className = "lr-iso";
        ltrRun.dir = "ltr";
        main.appendChild(ltrRun);
      }
      return ltrRun ?? main;
    };
    const words: WordEl[] = [];
    for (const [wi, w] of line.words.entries()) {
      const core = w.text.trimEnd();
      const tail = w.text.slice(core.length);
      const span = document.createElement("span");
      span.className = "lr-w";
      const letters = [...core];
      // Held words, the title and vivid keywords get an effect (see wordFx.ts).
      const fx = fxRow?.[wi] ?? null;
      const emph = !!fx;
      if (fx) span.classList.add(`fx-${fx.style}`);
      let letterEls: HTMLElement[] | null = null;
      if (w.ruby) {
        // Furigana: <ruby>漢字<rt>かんじ</rt></ruby> segments inside the word span.
        const segs = w.ruby.map((sg, k) => (k === w.ruby!.length - 1 ? { ...sg, base: sg.base.trimEnd() } : sg));
        for (const sg of segs) {
          if (sg.rt) {
            const r = document.createElement("ruby");
            r.append(sg.base);
            const rt = document.createElement("rt");
            rt.textContent = sg.rt;
            r.appendChild(rt);
            span.appendChild(r);
          } else span.append(sg.base);
        }
        if (emph) span.classList.add("emph1");
      } else if (emph && SPLITTABLE.test(core) && letters.length > 1) {
        span.classList.add("emph");
        letterEls = letters.map((ch) => {
          const l = document.createElement("span");
          l.className = "lr-l";
          l.textContent = ch;
          span.appendChild(l);
          return l;
        });
      } else {
        if (emph) span.classList.add("emph1");
        appendWithEmoji(span, core);
      }
      if (w.bg && !line.bg) span.classList.add("bgw");
      const parent = parentFor(core);
      parent.appendChild(span);
      if (tail) parent.appendChild(document.createTextNode(tail));
      words.push({ el: span, w, letters: letterEls, fx, p: -1, glow: 0 });
    }
    el.appendChild(main);
    if (line.sub) {
      const sub = document.createElement("p");
      sub.className = "lr-sub";
      sub.dir = "auto";
      sub.textContent = line.sub;
      el.appendChild(sub);
    }
    if (line.trans) {
      const tr = document.createElement("p");
      tr.className = "lr-trans";
      tr.dir = "auto";
      tr.textContent = line.trans;
      el.appendChild(tr);
    }
    return { kind: "line" as const, start: line.start, end: line.end, bg: line.bg, line, el, words, dots: [] };
  }

  /** Hide the lines until the next frame lays them out in place. */
  private unplace() {
    this.placed = false;
    this.list.classList.add("unplaced");
  }

  private measure() {
    if (this.destroyed) return;
    const oldHeight = this.height;
    this.height = this.root.clientHeight;
    this.fontPx = parseFloat(getComputedStyle(this.root).fontSize) || 28;
    if (this.opts.fitWidth) {
      const room = this.root.clientWidth - 4;
      for (const it of this.items) {
        if (it.kind !== "line") continue;
        it.el.style.fontSize = "";
        const need = it.el.scrollWidth;
        if (need > room && room > 0) it.el.style.fontSize = `${Math.max(0.6, room / need).toFixed(3)}em`;
      }
    }
    let changed = this.height !== oldHeight;
    for (const it of this.items) {
      const h = it.el.offsetHeight;
      if (h !== it.h) changed = true;
      it.h = h;
    }
    // New sizes (window resize, fonts loaded, line wrap changed): jump to the new layout rather than
    // springing every line from where the old layout had it.
    if (changed && this.placed) this.placed = false;
    this.kick();
  }

  // ---------- input ----------

  /** Click a line → jump the song there (Apple-style); the view snaps back to the playing line. */
  private onClick = (e: MouseEvent) => {
    if (!this.opts.onLineClick) return;
    const el = (e.target as HTMLElement).closest(".lr-line");
    const it = el && this.items.find((x) => x.el === el);
    if (!it || it.kind !== "line") return;
    this.userOffset = 0;
    this.userAt = 0;
    this.opts.onLineClick(it.start);
    this.kick();
  };

  private onWheel = (e: WheelEvent) => {
    this.userOffset += e.deltaY;
    this.userAt = performance.now();
    this.kick();
  };

  // ---------- loop ----------

  /** Ensure the loop is running (after option/timeline changes or input). */
  kick() {
    if (this.destroyed || this.raf) return;
    clearTimeout(this.idleTimer);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.idleTimer);
    this.ro.disconnect();
    this.root.removeEventListener("wheel", this.onWheel);
    this.root.removeEventListener("click", this.onClick);
    this.list.remove();
  }

  /** Active (non-background) item index at time t: last item that has started. */
  private focusAt(t: number): number {
    let ans = -1;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.start > t) break;
      if (!it.bg) ans = i;
    }
    return ans;
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.destroyed) return;
    // FPS cap: skip frames that come too early.
    // Adaptive frame rate: full rate while lines move; the slow word fill alone looks smooth at 30 fps.
    const fps = this.moving ? this.opts.fps : Math.min(this.opts.fps, 30);
    // Placing never waits for the cap: until it runs the lines are hidden.
    if (this.placed && fps < 60 && now - this.lastFrame < 1000 / fps - 2) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    const dt = clamp((now - this.lastFrame) / 1000, 0, 1 / 20);
    this.lastFrame = now;
    const t = this.getTime();
    const o = this.opts;
    const motion = !o.reducedMotion;
    const jumped = Number.isFinite(this.lastT) && (t < this.lastT - 250 || t > this.lastT + 2000);
    const timeMoved = t !== this.lastT;
    this.lastT = t;
    // First layout of these lines (needs a laid-out root): everything goes straight to its place.
    const place = !this.placed && this.height > 0;

    // Active item & cascade delays.
    const active = this.focusAt(t);
    const focus = Math.max(0, active);
    if (focus !== this.focus) {
      const forward = focus === this.focus + 1 && !jumped && !place;
      for (let i = 0; i < this.items.length; i++) {
        const k = i - (focus - 1);
        this.items[i].delayUntil = forward && motion && o.spring ? now + clamp(k, 0, 10) * o.stagger : 0;
      }
      this.focus = focus;
    }

    // User scroll decays back after a pause.
    if (this.userOffset !== 0 && now - this.userAt > USER_SCROLL_HOLD_MS) {
      this.userOffset *= Math.pow(0.002, dt);
      if (Math.abs(this.userOffset) < 0.5) this.userOffset = 0;
    }
    const browsing = this.userOffset !== 0;

    // Targets: active item at the anchor, others stacked around it.
    const gap = o.lineGap * this.fontPx;
    const vh = (it: Item, i: number) => (it.kind === "dots" ? (i === active ? it.h : 0) : it.h);
    const vgap = (it: Item, i: number) => (it.kind === "dots" && i !== active ? 0 : gap);
    // Scroll boundary: wheel browsing stops once the first line (scrolling up) or the last line
    // (scrolling down) reaches the anchor, instead of scrolling on into empty space.
    if (this.userOffset !== 0 && this.items.length) {
      let above = 0;
      for (let i = 0; i < focus; i++) above += vh(this.items[i], i) + vgap(this.items[i], i);
      let below = 0;
      for (let i = focus; i < this.items.length - 1; i++) below += vh(this.items[i], i) + vgap(this.items[i], i);
      this.userOffset = clamp(this.userOffset, -above, below);
    }
    const anchorY = this.height * o.anchor - this.userOffset;
    if (this.items.length) {
      let y = anchorY;
      for (let i = focus; i < this.items.length; i++) {
        this.items[i].target = y;
        y += vh(this.items[i], i) + vgap(this.items[i], i);
      }
      y = anchorY;
      for (let i = focus - 1; i >= 0; i--) {
        y -= vh(this.items[i], i) + vgap(this.items[i], i);
        this.items[i].target = y;
      }
    }

    let moving = browsing;
    const k = o.springStiffness;
    const c = o.springDamping;
    const fadeZone = this.height * 0.16;

    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (now >= it.delayUntil) it.shownTarget = it.target;
      // Position
      if (place || !motion || !o.spring || jumped || Math.abs(it.shownTarget - it.y) > this.height * 2) {
        it.y = it.shownTarget;
        it.vy = 0;
      } else {
        const a = k * (it.shownTarget - it.y) - c * it.vy;
        it.vy += a * dt;
        it.y += it.vy * dt;
        if (Math.abs(it.vy) < 0.05 && Math.abs(it.shownTarget - it.y) < 0.1) {
          it.y = it.shownTarget;
          it.vy = 0;
        } else moving = true;
      }
      if (now < it.delayUntil) moving = true;

      const visible = it.y + it.h > -this.height * 0.3 && it.y < this.height * 1.3;
      const isCur = i === active;
      const sTarget = isCur || it.kind === "dots" ? 1 : o.inactiveScale;
      const ds = sTarget - it.scale;
      it.scale = place || Math.abs(ds) < 0.0005 || !motion ? sTarget : it.scale + ds * clamp(dt * 9);
      if (it.scale !== sTarget) moving = true;

      if (!visible) {
        if (it.el.style.visibility !== "hidden") it.el.style.visibility = "hidden";
        continue;
      }
      if (it.el.style.visibility) it.el.style.visibility = "";

      // Dots size/opacity animate with time.
      let extraScale = 1;
      if (it.kind === "dots") {
        if (isCur) {
          const tin = clamp((t - it.start) / DOTS_IN_MS);
          const tout = clamp((it.end - t) / DOTS_OUT_MS);
          const breathe = motion ? 1 + 0.07 * Math.sin((t / 1000) * Math.PI * 1.25) : 1;
          extraScale = tin * tout * breathe;
          const q = clamp((t - it.start) / Math.max(1, it.end - it.start - DOTS_OUT_MS));
          it.dots.forEach((d, n) => {
            const f = clamp(q * 3 - n).toFixed(2);
            if (d.style.getPropertyValue("--f") !== f) d.style.setProperty("--f", f);
          });
        } else extraScale = 0;
      }

      const tf = `translate3d(0,${it.y.toFixed(1)}px,0) scale(${(it.scale * extraScale).toFixed(4)})`;
      if (tf !== it.tf) {
        it.tf = tf;
        it.el.style.transform = tf;
      }

      // Edge fade + blur (blur via CSS transition; only written on change).
      let opacity = 1;
      if (o.window != null && (i < focus || i > focus + o.window)) opacity = 0;
      else if (o.edgeFade && !isCur) {
        const top = (it.y + it.h * 0.5) / fadeZone;
        const bottom = (this.height - (it.y + it.h * 0.5)) / fadeZone;
        opacity = clamp(Math.min(top, bottom));
      }
      if (Math.abs(opacity - it.opacity) > 0.01) {
        it.opacity = opacity;
        it.el.style.opacity = opacity.toFixed(2);
      }
      const dist = Math.abs(i - focus);
      const blur = o.blur && !browsing && !isCur ? Math.min(o.blurMax, dist * o.blurStep) : 0;
      if (blur !== it.blur) {
        it.blur = blur;
        it.el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(1)}px)` : "";
      }

      if (it.kind === "line") moving = this.updateLine(it, isCur, t, dt) || moving;
      if (it.kind === "dots" && isCur) moving = true;
    }

    if (place) {
      // Styles were written with transitions off (`.unplaced`); resolve them before showing the list,
      // so blur and opacity don't animate in from their defaults.
      void this.list.offsetHeight;
      this.list.classList.remove("unplaced");
      this.placed = true;
    }
    this.moving = moving;
    if (moving || timeMoved) this.raf = requestAnimationFrame(this.frame);
    else this.idleTimer = window.setTimeout(() => this.kick(), 200); // paused: poll cheaply
  };

  /** Highlight + word fill for one line. Returns true while it is animating. */
  private updateLine(it: Item, isCur: boolean, t: number, dt: number): boolean {
    const line = it.line!;
    const bgLive = it.bg && t >= line.start && t <= line.end + 200;
    const live = isCur || bgLive;
    let animating = false;

    if (live) {
      const target = 1;
      it.hl = line.fill === "none" && !this.opts.reducedMotion ? Math.min(target, it.hl + dt / 0.25) : target;
    } else if (it.hl > 0) {
      it.hl = Math.max(0, it.hl - (dt * 1000) / HL_FADE_MS);
    }
    if (it.hl > 0 && it.hl < 1) animating = true;

    const isLive = it.hl > 0;
    if (isLive !== it.live) {
      it.live = isLive;
      it.el.classList.toggle("live", isLive);
      if (isLive) for (const w of it.words) w.p = -1; // force refresh
    }
    if (live !== it.cur) {
      it.cur = live;
      it.el.classList.toggle("cur", live);
      if (!live)
        for (const w of it.words) {
          w.el.style.transform = "";
          w.letters?.forEach((l) => (l.style.transform = ""));
        }
    }
    const hlStr = it.hl.toFixed(3);
    if (hlStr !== it.hlStr) {
      it.hlStr = hlStr;
      it.el.style.setProperty("--hl", hlStr);
    }
    if (!live) {
      // Settle the effects of emphasized words after the line ends.
      for (const w of it.words) if (w.glow > 0) this.clearFx(w);
      return animating;
    }

    const lift = this.opts.reducedMotion ? 0 : this.opts.lift;
    for (const w of it.words) {
      const p = line.fill === "none" ? 1 : wordProgress(w.w, t);
      const moved = Math.abs(p - w.p) > 0.0005;
      if (moved) {
        w.p = p;
        w.el.style.setProperty("--p", p.toFixed(4));
        w.letters?.forEach((l, i) => l.style.setProperty("--p", clamp(p * w.letters!.length - i).toFixed(3)));
      }
      if (w.fx) {
        // Effect strength: rises while sung, holds, fades out 700 ms after the word ends.
        const g = p <= 0 ? 0 : p < 1 ? Math.min(1, p * 1.8) : clamp(1 - (t - w.w.end) / 700);
        const still = this.opts.reducedMotion || (w.fx.style !== "shimmer" && w.fx.style !== "wave" && w.fx.style !== "shake" && w.fx.style !== "glitch");
        if (moved || (!still && g > 0) || Math.abs(g - w.glow) > 0.01) this.drawFx(w, p, g, t, lift);
        if (g > 0 && (g < 1 || !still)) animating = true;
      } else if (moved && lift) w.el.style.transform = `translateY(${(-lift * easeOut(p)).toFixed(4)}em)`;
    }
    return animating;
  }

  /** Draw one word's effect: g = effect strength now (0 … 1), p = fill progress. */
  private drawFx(w: WordEl, p: number, g: number, t: number, lift: number) {
    const fx = w.fx!;
    w.glow = g;
    const reduced = this.opts.reducedMotion;
    // Reduced motion: no movement, only the glows.
    const style: FxStyle = reduced && fx.style !== "bloom" ? "glow" : fx.style;
    const k = fx.strength;
    const px = this.fontPx;
    const since = t - w.w.start;
    const n = w.letters?.length ?? 1;
    const q = Math.floor(t / 45); // jitter step (≈ 22 changes per second)
    const burst = style === "glitch" && g > 0.3 && hash(Math.floor(t / 70)) < 0.2 + 0.2 * this.energy;
    let wx = 0;
    let wy = -lift * easeOut(p);
    let wr = 0;
    let ws = 1;
    let wo = 1;
    for (let i = 0; i < n; i++) {
      const x = p * n - i;
      let tx = 0;
      let ty = 0;
      let rot = 0;
      let sc = 1;
      let op = 1;
      if (!reduced) {
        if (w.letters && style !== "wave") {
          // Letters bounce up as they are sung, then settle a little higher.
          const bump = x > 0 && x < 2 ? Math.sin((Math.PI * x) / 2) : 0;
          const settle = x >= 2 ? 1 : x > 0 ? Math.min(1, x / 2) : 0;
          ty = -0.07 * bump - 0.02 * settle;
          sc = 1 + 0.08 * bump;
        }
        if (style === "wave") ty = Math.sin((since / 1000) * 2 * Math.PI * 1.25 - i * 0.75) * 0.1 * g * k - 0.02 * g;
        else if (style === "shimmer") {
          // A bright band sweeps across the letters again and again; the rest dims a little.
          const band = ((since / 750) % 1) * (n + 3) - 1.5;
          const lit = Math.max(0, 1 - Math.abs(i - band) / 1.4);
          op = 1 - 0.4 * g * (1 - lit);
          ty -= 0.035 * lit * g;
          sc += 0.05 * lit * g;
        } else if (style === "shake") {
          const a = 0.032 * g * k;
          tx += a * (hash(q * 7 + i * 13) * 2 - 1);
          ty += a * (hash(q * 11 + i * 17) * 2 - 1);
          rot = 4 * g * k * (hash(q * 5 + i * 3) - 0.5);
        } else if (burst && hash(q * 3 + i * 7) < 0.3) {
          tx += (hash(q + i * 29) - 0.5) * 0.16 * k; // glitch: a letter or two jumps sideways
          rot = 0;
        }
      }
      if (w.letters) {
        const l = w.letters[i];
        l.style.transform = `translate(${tx.toFixed(4)}em,${ty.toFixed(4)}em) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(4)})`;
        l.style.opacity = op < 0.999 ? op.toFixed(3) : "";
      } else {
        wx += tx;
        wy += ty;
        wr = rot;
        ws *= sc;
        wo = op;
      }
    }
    const glow = (r: number) => `drop-shadow(0 0 ${(g * r * k * px).toFixed(1)}px ${this.opts.glowColor})`;
    let filter = "";
    if (g > 0.01) {
      if (style === "bloom") {
        filter = `${glow(0.2)} ${glow(0.55)}`;
        if (!reduced) ws *= 1 + 0.05 * g * k;
      } else if (burst) {
        const d = ((1.5 + 2.5 * hash(Math.floor(t / 70) + 9)) * k * g * px) / 28;
        filter = `drop-shadow(${(-d).toFixed(1)}px 0 0 rgba(255,40,120,0.7)) drop-shadow(${d.toFixed(1)}px 0 0 rgba(40,220,255,0.7))`;
      } else filter = glow(style === "glow" ? 0.24 : style === "glitch" ? 0.14 : style === "shake" ? 0.2 : 0.17);
    }
    w.el.style.filter = filter;
    w.el.style.opacity = wo < 0.999 ? wo.toFixed(3) : "";
    w.el.style.transform =
      wx || wr || ws !== 1 ? `translate(${wx.toFixed(4)}em,${wy.toFixed(4)}em) rotate(${wr.toFixed(2)}deg) scale(${ws.toFixed(4)})` : wy ? `translateY(${wy.toFixed(4)}em)` : "";
  }

  private clearFx(w: WordEl) {
    w.glow = 0;
    w.el.style.filter = "";
    w.el.style.opacity = "";
    w.letters?.forEach((l) => (l.style.opacity = ""));
  }

  private energy = 0.5;
}

/** Cheap deterministic noise in [0, 1). */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
