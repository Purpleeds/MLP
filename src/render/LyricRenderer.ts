// Apple-Music-style lyric renderer (vanilla DOM, own rAF loop; React only mounts it).
// Lines are absolutely positioned and moved with springs; only the active line updates per frame.
import type { Timeline, TimedLine, TimedWord } from "../core/timing/timeline";
import { wordProgress } from "../core/timing/timeline";
import { lineDir, wordDir } from "../core/bidi";

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
  emph: boolean;
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

const LETTERS_MAX = 9;
const EMPH_MIN_MS = 1000;
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
    const relayout = o.lineGap !== this.opts.lineGap || o.emphasis !== this.opts.emphasis;
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

    for (const line of tl.lines) {
      const g = dotsAt.get(line.start);
      if (g) add(this.makeDots(g));
      add(this.makeLine(line));
    }
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

  private makeLine(line: TimedLine) {
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
    for (const w of line.words) {
      const core = w.text.trimEnd();
      const tail = w.text.slice(core.length);
      const span = document.createElement("span");
      span.className = "lr-w";
      const letters = [...core];
      // Held words glow. With estimated timing only visibly stretched words qualify ("noooo", "yeahhh").
      const emph =
        this.opts.emphasis &&
        line.fill === "words" &&
        w.end - w.start >= EMPH_MIN_MS &&
        letters.length <= LETTERS_MAX &&
        letters.length > 0 &&
        (line.exact || /(\p{L})\1{2,}/u.test(core));
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
      words.push({ el: span, w, letters: letterEls, emph, p: -1, glow: 0 });
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

  private measure() {
    if (this.destroyed) return;
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
    for (const it of this.items) it.h = it.el.offsetHeight;
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
    if (fps < 60 && now - this.lastFrame < 1000 / fps - 2) {
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

    // Active item & cascade delays.
    const active = this.focusAt(t);
    const focus = Math.max(0, active);
    if (focus !== this.focus) {
      const forward = focus === this.focus + 1 && !jumped;
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
      if (!motion || !o.spring || jumped || Math.abs(it.shownTarget - it.y) > this.height * 2) {
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
      it.scale = Math.abs(ds) < 0.0005 || !motion ? sTarget : it.scale + ds * clamp(dt * 9);
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
      // Settle glow of emphasized words after the line ends.
      for (const w of it.words) if (w.glow > 0) this.applyGlow(w, 0);
      return animating;
    }

    const lift = this.opts.reducedMotion ? 0 : this.opts.lift;
    for (const w of it.words) {
      const p = line.fill === "none" ? 1 : wordProgress(w.w, t);
      if (Math.abs(p - w.p) > 0.0005) {
        w.p = p;
        w.el.style.setProperty("--p", p.toFixed(4));
        if (lift) w.el.style.transform = `translateY(${(-lift * easeOut(p)).toFixed(4)}em)`;
        if (w.letters) {
          const n = w.letters.length;
          w.letters.forEach((l, i) => {
            const x = p * n - i;
            l.style.setProperty("--p", clamp(x).toFixed(3));
            if (!this.opts.reducedMotion) {
              const bump = x > 0 && x < 2 ? Math.sin((Math.PI * x) / 2) : 0;
              const settle = x >= 2 ? 1 : x > 0 ? Math.min(1, x / 2) : 0;
              l.style.transform = `translateY(${(-0.07 * bump - 0.02 * settle).toFixed(4)}em) scale(${(1 + 0.08 * bump).toFixed(4)})`;
            }
          });
        }
      }
      if (w.emph) {
        const g = p <= 0 ? 0 : p < 1 ? Math.min(1, p * 1.8) : clamp(1 - (t - w.w.end) / 700);
        if (Math.abs(g - w.glow) > 0.01) this.applyGlow(w, g);
        if (g > 0 && g < 1) animating = true;
      }
    }
    return animating;
  }

  private applyGlow(w: WordEl, g: number) {
    w.glow = g;
    w.el.style.filter = g > 0.01 ? `drop-shadow(0 0 ${(g * this.fontPx * 0.24).toFixed(1)}px ${this.opts.glowColor})` : "";
  }
}

const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
