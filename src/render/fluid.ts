// Fluid album-art background: low-res WebGL shader blending 5 palette colors with drifting,
// domain-warped blobs (Apple Music style). Cheap: renders at ~1/4 resolution, FPS-capped.
import type { RGB } from "./palette";

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform vec2 res;
uniform float t;
uniform vec3 c[5];
uniform float dim;

vec2 hash(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return -1.0 + 2.0 * fract(sin(p) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(hash(i), f), dot(hash(i + vec2(1,0)), f - vec2(1,0)), u.x),
             mix(dot(hash(i + vec2(0,1)), f - vec2(0,1)), dot(hash(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
}

void main(){
  vec2 uv = gl_FragCoord.xy / res;
  vec2 q = uv * vec2(res.x / res.y, 1.0);
  // Domain warp gives the slow "liquid" motion.
  vec2 w = q + 0.55 * vec2(noise(q * 1.3 + t * 0.07), noise(q * 1.3 - t * 0.06 + 3.1));
  vec3 col = c[0];
  float wsum = 1.0;
  for (int i = 1; i < 5; i++) {
    float fi = float(i);
    vec2 center = vec2(0.5 * res.x / res.y, 0.5) + 0.55 * vec2(sin(t * (0.05 + 0.017 * fi) + fi * 1.7), cos(t * (0.043 + 0.013 * fi) + fi * 2.3));
    float d = length(w - center);
    float k = exp(-d * d * 3.2) * (1.15 - 0.12 * fi);
    col += c[i] * k * 2.2;
    wsum += k * 2.2;
  }
  col /= wsum;
  col *= 1.0 - dim;
  // Dither to avoid banding in smooth gradients.
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export class FluidRenderer {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private loc: { res: WebGLUniformLocation; t: WebGLUniformLocation; c: WebGLUniformLocation; dim: WebGLUniformLocation };
  private from: number[] = new Array(15).fill(0.15);
  private to: number[] = new Array(15).fill(0.15);
  private mixStart = 0;
  private raf = 0;
  private last = 0;
  private time = Math.random() * 100;
  fps = 30;
  speed = 1;
  dim = 0.25;
  running = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    this.loc = {
      res: gl.getUniformLocation(prog, "res")!,
      t: gl.getUniformLocation(prog, "t")!,
      c: gl.getUniformLocation(prog, "c")!,
      dim: gl.getUniformLocation(prog, "dim")!,
    };
  }

  /** Crossfade to a new palette over ~1.5 s. */
  setPalette(colors: RGB[]) {
    const flat = colors.slice(0, 5).flatMap((c) => c.map((v) => v / 255));
    while (flat.length < 15) flat.push(...flat.slice(0, 3));
    this.from = this.current(performance.now());
    this.to = flat;
    this.mixStart = performance.now();
    if (!this.running) this.draw(performance.now());
  }

  private current(now: number): number[] {
    const k = Math.min(1, (now - this.mixStart) / 1500);
    const e = k * k * (3 - 2 * k);
    return this.from.map((f, i) => f + (this.to[i] - f) * e);
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(16, Math.round(r.width / 4));
    const h = Math.max(16, Math.round(r.height / 4));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
  }

  private draw(now: number) {
    this.resize();
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniform2f(this.loc.res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.loc.t, this.time);
    gl.uniform3fv(this.loc.c, new Float32Array(this.current(now)));
    gl.uniform1f(this.loc.dim, this.dim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const minDt = 1000 / Math.max(5, this.fps);
    if (now - this.last < minDt - 1) return;
    const dt = Math.min(100, now - (this.last || now));
    this.last = now;
    this.time += (dt / 1000) * this.speed;
    this.draw(now);
  };

  start() {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.draw(performance.now());
  }

  /** Stop and release the GPU context (each renderer owns its canvas). */
  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
