// Opaque window background: fluid (WebGL), blurred art, solid, gradient, or dark (YT Music style).
import { useSettings } from "../core/settings/store";
import { fpsCaps, usePower } from "../core/power";
import { useEffect, useRef, useState } from "react";
import type { Settings } from "../core/settings/schema";
import { css, extractPalette, paletteFromSeed, tune, type RGB } from "./palette";
import { FluidRenderer } from "./fluid";

interface Props {
  bg: Settings["background"];
  artwork: string | null;
  seed: string;
  playing: boolean;
}

function usePalette(artwork: string | null, seed: string, saturation: number): RGB[] {
  const [pal, setPal] = useState<RGB[]>(() => paletteFromSeed(seed));
  useEffect(() => {
    let alive = true;
    (artwork ? extractPalette(artwork) : Promise.resolve(paletteFromSeed(seed))).then((p) => {
      if (alive) setPal(p.map((c) => tune(c, saturation)));
    });
    return () => {
      alive = false;
    };
  }, [artwork, seed, saturation]);
  return pal;
}

function Fluid({ palette, bg, playing }: { palette: RGB[]; bg: Settings["background"]; playing: boolean }) {
  // Upgrade 18: battery saver / covered window → lower frame rate.
  const caps = fpsCaps(usePower(), useSettings().app.batterySaver);
  const host = useRef<HTMLDivElement>(null);
  const r = useRef<FluidRenderer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // A fresh canvas per mount, so releasing its context on unmount can't break a remount.
    const canvas = document.createElement("canvas");
    canvas.className = "bg-layer bg-fluid";
    host.current!.appendChild(canvas);
    try {
      r.current = new FluidRenderer(canvas);
    } catch {
      setFailed(true);
    }
    const onVis = () => {
      if (document.hidden) r.current?.stop();
      else if (playing) r.current?.start();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      r.current?.destroy();
      r.current = null;
      canvas.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const f = r.current;
    if (!f) return;
    f.fps = caps.background ? Math.min(bg.fps, caps.background) : bg.fps;
    f.speed = bg.flowSpeed;
    f.dim = bg.dim;
    f.setPalette(palette);
    const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (playing && motion && !document.hidden) f.start();
    else f.stop();
  }, [palette, bg.fps, bg.flowSpeed, bg.dim, playing, caps.background]);

  if (failed) return <div className="bg-layer" style={{ background: css(palette[0]) }} />;
  return <div ref={host} className="bg-layer" />;
}

export function Background({ bg, artwork, seed, playing }: Props) {
  const palette = usePalette(artwork, seed, bg.saturation);
  const scrim = <div className="bg-layer" style={{ background: `rgba(0,0,0,${bg.dim})` }} />;

  switch (bg.type) {
    case "fluid":
      return <Fluid palette={palette} bg={bg} playing={playing} />;
    case "art":
      return (
        <>
          <div className="bg-layer" style={{ background: css(palette[0]) }} />
          {artwork && (
            <img key={artwork} className={`bg-layer bg-art ${playing ? "spin" : ""}`} src={artwork} alt="" style={{ filter: `blur(48px) saturate(${bg.saturation})` }} />
          )}
          {scrim}
        </>
      );
    case "gradient":
      return <div className="bg-layer" style={{ background: `linear-gradient(160deg, ${bg.color1}, ${bg.color2})` }} />;
    case "dark":
      return (
        <div
          className="bg-layer"
          style={{ background: `radial-gradient(120% 80% at 30% 0%, ${css(palette[0], 0.45)}, transparent 70%), #0d0d0d` }}
        />
      );
    default:
      return <div className="bg-layer" style={{ background: bg.color1 }} />;
  }
}
