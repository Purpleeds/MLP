// Now-playing building blocks used by the display modes.
import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { clock, mediaControl, useTicker, type NowPlaying } from "../core/playback/nowPlaying";
import { fmtTime } from "../core/display";

export function Art({ src, className = "" }: { src: string | null; className?: string }) {
  return src ? (
    <img className={`art ${className}`} src={src} alt="" draggable={false} />
  ) : (
    <div className={`art empty ${className}`} aria-hidden />
  );
}

/** Single line that scrolls horizontally when it doesn't fit. */
export function Marquee({ children, className = "" }: { children: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const over = (inner.current?.scrollWidth ?? 0) - (box.current?.clientWidth ?? 0);
      setShift(over > 4 ? over + 24 : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [children]);
  return (
    <div ref={box} className={`marquee ${shift ? "moving" : ""} ${className}`}>
      <span
        ref={inner}
        style={shift ? ({ "--shift": `-${shift}px`, "--dur": `${Math.max(6, shift / 28)}s` } as React.CSSProperties) : undefined}
      >
        {children}
      </span>
    </div>
  );
}

export function Progress({ np, times }: { np: NowPlaying; times: boolean }) {
  useTicker(250);
  const dur = np.durationMs;
  const pos = clock.position();
  const k = dur > 0 ? Math.min(1, pos / dur) : 0;
  const seek = (e: MouseEvent<HTMLDivElement>) => {
    if (!np.canSeek || !dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    void mediaControl({ action: "seek", ms: ((e.clientX - r.left) / r.width) * dur });
  };
  return (
    <div className="progress" data-no-drag={np.canSeek ? "" : undefined}>
      <div className={`progress-track ${np.canSeek ? "seekable" : ""}`} onMouseDown={seek} title={np.canSeek ? "Click to seek" : undefined}>
        <div className="progress-fill" style={{ width: `${(k * 100).toFixed(2)}%` }} />
      </div>
      {times && (
        <div className="progress-times">
          <span>{fmtTime(pos)}</span>
          <span>{dur ? `-${fmtTime(dur - pos)}` : ""}</span>
        </div>
      )}
    </div>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
    <path d={d} fill="currentColor" />
  </svg>
);
const PREV = "M6 5h2v14H6zM9.5 12 19 5v14z";
const NEXT = "M16 5h2v14h-2zM14.5 12 5 19V5z";
const PLAY = "M7 4.5v15L19.5 12z";
const PAUSE = "M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z";

export function Controls({ np }: { np: NowPlaying }) {
  const playing = np.status === "playing";
  return (
    <div className="controls" data-no-drag>
      <button aria-label="Previous track" onClick={() => void mediaControl({ action: "prev" })}>
        <Icon d={PREV} />
      </button>
      <button className="main" aria-label={playing ? "Pause" : "Play"} onClick={() => void mediaControl({ action: "toggle" })}>
        <Icon d={playing ? PAUSE : PLAY} />
      </button>
      <button aria-label="Next track" onClick={() => void mediaControl({ action: "next" })}>
        <Icon d={NEXT} />
      </button>
    </div>
  );
}
