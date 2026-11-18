// Settings controls rendered from field definitions.
import { useT } from "./i18n";
import { useEffect, useId, useState } from "react";
import { platform } from "../core/platform";
import { getSettings, replaceSettings, updateSettings, useSettings } from "../core/settings/store";
import { DEFAULT_SETTINGS, FONT_STACK } from "../core/settings/schema";
import { clearLyricsCache } from "../core/lyrics/service";
import { applyPreset, type PresetName } from "../render/presets";
import { getPath, type Field } from "./fields";
import { SongPanel } from "./SongPanel";
import { SyncEditor } from "./SyncEditor";
import { CapturePanel } from "./CapturePanel";
import { VocalsPanel } from "./VocalsPanel";
import { AutoSyncPanel } from "./AutoSyncPanel";
import { SpotifyPanel } from "./SpotifyPanel";
import { AiLyricsPanel } from "./AiLyricsPanel";
import { TrainingPanel } from "./TrainingPanel";
import { AiCorrectPanel } from "./AiCorrectPanel";
import { LearnedPanel } from "./LearnedPanel";
import { AiModelsPanel } from "./AiModelsPanel";
import { ThemesPanel } from "./ThemesPanel";
import { EvalPanel } from "./EvalPanel";
import { UpdatesPanel } from "./UpdatesPanel";
import { ObsPanel } from "./ObsPanel";
import { TranslationPanel } from "./TranslationPanel";
import { ErrorBoundary } from "./ErrorBoundary";

/** Write a setting; styling edits switch the preset label to "custom". */
export function setField(path: string, value: unknown, style?: boolean) {
  void updateSettings(path, value);
  if (style && getSettings().appearance.preset !== "custom") void updateSettings("appearance.preset", "custom");
}

// ---------- color helpers ----------
export function parseColor(c: string): { hex: string; a: number } {
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return { hex: "#" + [...m[1]].map((x) => x + x).join("").toLowerCase(), a: 1 };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return { hex: "#" + m[1].toLowerCase(), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) {
    const hex = "#" + [m[1], m[2], m[3]].map((v) => Math.min(255, +v).toString(16).padStart(2, "0")).join("");
    const a = m[4] ? (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
    return { hex, a };
  }
  return { hex: "#ffffff", a: 1 };
}

export function formatColor(hex: string, a: number): string {
  if (a >= 0.999) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${+a.toFixed(2)})`;
}

const fmtNum = (f: Extract<Field, { kind: "slider" }>, v: number) =>
  f.pct ? `${Math.round(v * 100)}%` : `${+v.toFixed(3)}${f.unit ? ` ${f.unit}` : ""}`;

// ---------- field row ----------
export function FieldRow({ f }: { f: Field }) {
  const s = useSettings();
  const t = useT();
  const id = useId();
  const value = f.kind === "custom" ? undefined : getPath(s, f.path);
  const style = "style" in f ? f.style : false;

  let control: React.ReactNode = null;
  switch (f.kind) {
    case "toggle":
      control = (
        <button
          id={id}
          role="switch"
          aria-checked={!!value}
          className={`switch ${value ? "on" : ""}`}
          onClick={() => setField(f.path, !value, style)}
        >
          <span />
        </button>
      );
      break;
    case "slider": {
      const v = Number(value);
      control = (
        <div className="slider">
          <input id={id} type="range" min={f.min} max={f.max} step={f.step} value={v} onChange={(e) => setField(f.path, Number(e.target.value), style)} />
          <output>{fmtNum(f, v)}</output>
        </div>
      );
      break;
    }
    case "select":
      control =
        f.options.length <= 3 && f.options.every((o) => o.label.length <= 12) ? (
          <div className="segmented" role="radiogroup" id={id}>
            {f.options.map((o) => (
              <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? "on" : ""} onClick={() => setField(f.path, o.value, style)}>
                {t(o.label)}
              </button>
            ))}
          </div>
        ) : (
          <select
            id={id}
            value={String(value)}
            onChange={(e) => {
              const o = f.options.find((x) => String(x.value) === e.target.value);
              if (o) setField(f.path, o.value, style);
            }}
          >
            {f.options.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {t(o.label)}
              </option>
            ))}
          </select>
        );
      break;
    case "color": {
      const { hex, a } = parseColor(String(value));
      control = (
        <div className="color">
          <input id={id} type="color" value={hex} onChange={(e) => setField(f.path, formatColor(e.target.value, a), style)} />
          <input
            type="range"
            aria-label={`${f.label} opacity`}
            min={0}
            max={1}
            step={0.01}
            value={a}
            onChange={(e) => setField(f.path, formatColor(hex, Number(e.target.value)), style)}
            style={{ "--swatch": hex } as React.CSSProperties}
          />
          <output>{Math.round(a * 100)}%</output>
        </div>
      );
      break;
    }
    case "text":
      control = <TextInput id={id} value={String(value ?? "")} placeholder={f.placeholder} onCommit={(v) => setField(f.path, v)} />;
      break;
    case "list":
      control = (
        <TextInput
          id={id}
          value={Array.isArray(value) ? value.join(", ") : ""}
          placeholder={f.placeholder}
          onCommit={(v) => setField(f.path, v.split(",").map((x) => x.trim()).filter(Boolean))}
        />
      );
      break;
    case "font":
      control = <FontPicker id={id} value={String(value)} onChange={(v) => setField(f.path, v, style)} />;
      break;
    case "hotkey":
      control = <HotkeyInput id={id} value={String(value ?? "")} onChange={(v) => setField(f.path, v)} />;
      break;
    case "custom":
      control = (
        <ErrorBoundary where={`settings/panel:${f.id}`} variant="panel">
          <Custom id={f.id} />
        </ErrorBoundary>
      );
      break;
  }

  const wide = f.kind === "custom" && (f.id === "presets" || f.id === "backup" || f.id === "song" || f.id === "sync" || f.id === "capture" || f.id === "vocals" || f.id === "autosync" || f.id === "spotify" || f.id === "ailyrics" || f.id === "training" || f.id === "aicorrect" || f.id === "aimodels" || f.id === "themes" || f.id === "aieval");
  return (
    <div className={`row ${wide ? "wide" : ""}`}>
      <div className="row-label">
        <label htmlFor={id}>{t(f.label)}</label>
        {f.help && <p className="help">{t(f.help)}</p>}
      </div>
      <div className="row-control">{control}</div>
    </div>
  );
}

function TextInput({ id, value, placeholder, onCommit }: { id: string; value: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      id={id}
      type="text"
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

// ---------- hotkeys ----------
const KEY_NAMES: Record<string, string> = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space", Escape: "Escape",
};
const pretty = (accel: string) => accel.replace(/CommandOrControl/g, "Ctrl").split("+").join(" + ");

/** Accelerator string (Tauri format) from a key event, or null if only modifiers are held. */
export function accelFromEvent(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  let key = KEY_NAMES[e.key] ?? e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else if (/^(Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Backslash|Comma|Period|Slash)$/.test(e.code)) key = e.code;
  else if (key.length === 1) key = key.toUpperCase();
  const mods = [e.ctrlKey && "CommandOrControl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return null; // global hotkeys need a modifier
  return [...mods, key].join("+");
}

function HotkeyInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false);
  return (
    <button
      id={id}
      className={`hotkey ${rec ? "rec" : ""}`}
      onFocus={() => setRec(true)}
      onBlur={() => setRec(false)}
      onKeyDown={(e) => {
        if (e.key === "Tab") return;
        e.preventDefault();
        if (e.key === "Backspace" || e.key === "Delete") {
          onChange("");
          (e.target as HTMLElement).blur();
          return;
        }
        const a = accelFromEvent(e);
        if (a) {
          onChange(a);
          (e.target as HTMLElement).blur();
        }
      }}
    >
      {rec ? "Press keys\u2026" : value ? pretty(value) : "Not set"}
    </button>
  );
}

let fontCache: Promise<string[]> | null = null;
const loadFonts = () => (fontCache ??= platform.invoke<string[]>("list_fonts").then((f) => f ?? []));

function FontPicker({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    void loadFonts().then(setFonts);
  }, []);
  const first = /^\s*"?([^",]+)"?/.exec(value)?.[1] ?? "";
  const isDefault = value === FONT_STACK;
  return (
    <div className="font">
      <select
        id={id}
        value={isDefault ? "" : first}
        onChange={(e) => onChange(e.target.value ? `"${e.target.value}", ${FONT_STACK}` : FONT_STACK)}
      >
        <option value="">Default (SF Pro / Inter)</option>
        {!isDefault && !fonts.includes(first) && <option value={first}>{first}</option>}
        {fonts.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <span className="font-sample" style={{ fontFamily: value }}>
        Sing it louder
      </span>
    </div>
  );
}

// ---------- custom controls ----------
const PRESET_INFO: { id: PresetName; name: string; desc: string; swatch: string }[] = [
  { id: "apple", name: "Apple Music", desc: "Flowing album colors, blur, springy", swatch: "linear-gradient(135deg,#b3123c,#3b2a8f 60%,#0f6e8c)" },
  { id: "ytmusic", name: "YouTube Music", desc: "Dark, flat list, quick", swatch: "radial-gradient(120% 90% at 30% 0%,#5b0f17,#0d0d0d 70%)" },
  { id: "minimal", name: "Minimal", desc: "Solid, centered, calm", swatch: "#17171c" },
];

function Custom({ id }: { id: string }) {
  const s = useSettings();
  const [locked, setLocked] = useState(false);
  const [msg, setMsg] = useState("");
  const [paste, setPaste] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (id !== "lock") return;
    void platform.invoke<boolean>("is_click_through").then((v) => setLocked(!!v));
    const off = platform.on<boolean>("lock-changed", setLocked);
    return () => void off.then((f) => f());
  }, [id]);
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(""), 2500);
  };

  switch (id) {
    case "song":
      return <SongPanel />;
    case "sync":
      return <SyncEditor />;
    case "capture":
      return <CapturePanel />;
    case "vocals":
      return <VocalsPanel />;
    case "autosync":
      return <AutoSyncPanel />;
    case "spotify":
      return <SpotifyPanel />;
    case "ailyrics":
      return <AiLyricsPanel />;
    case "training":
      return <TrainingPanel />;
    case "aicorrect":
      return <AiCorrectPanel />;
    case "learned":
      return <LearnedPanel />;
    case "aimodels":
      return <AiModelsPanel />;
    case "themes":
      return <ThemesPanel />;
    case "aieval":
      return <EvalPanel />;
    case "updates":
      return <UpdatesPanel />;
    case "translations":
      return <TranslationPanel />;
    case "obs":
      return <ObsPanel />;
    case "autostart":
      return <Autostart />;
    case "presets":
      return (
        <div className="presets">
          {PRESET_INFO.map((p) => (
            <button key={p.id} className={`preset ${s.appearance.preset === p.id ? "on" : ""}`} onClick={() => void replaceSettings(applyPreset(getSettings(), p.id))}>
              <span className="preset-swatch" style={{ background: p.swatch }}>
                <span>Aa</span>
              </span>
              <span className="preset-name">{p.name}</span>
              <span className="preset-desc">{p.desc}</span>
            </button>
          ))}
          {s.appearance.preset === "custom" && <p className="help">Your own tweaks are active.</p>}
        </div>
      );
    case "corners":
      return (
        <div className="corners" role="group" aria-label="Move window to a corner">
          {(
            [
              ["tl", "Top left"],
              ["tr", "Top right"],
              ["bl", "Bottom left"],
              ["br", "Bottom right (near clock)"],
            ] as const
          ).map(([c, label]) => (
            <button key={c} className={`corner corner-${c}`} title={label} aria-label={label} onClick={() => void platform.emit("main-move", c)}>
              <span />
            </button>
          ))}
        </div>
      );
    case "lock":
      return (
        <button className="btn" onClick={() => void platform.invoke("set_click_through", { locked: !locked })}>
          {locked ? "Unlock window" : "Lock window"}
        </button>
      );
    case "clear-cache":
      return (
        <div className="inline">
          <button className="btn" onClick={() => void clearLyricsCache().then(() => flash("Saved lyrics cleared"))}>
            Clear saved lyrics
          </button>
          {msg && <span className="flash">{msg}</span>}
        </div>
      );
    case "backup":
      return (
        <div className="backup">
          <div className="inline">
            <button
              className="btn"
              onClick={() =>
                void navigator.clipboard.writeText(JSON.stringify(getSettings(), null, 2)).then(
                  () => flash("Settings copied"),
                  () => flash("Couldn't copy — clipboard unavailable"),
                )
              }
            >
              Copy settings
            </button>
            <button
              className={`btn ${confirmReset ? "danger" : ""}`}
              onClick={() => {
                if (!confirmReset) {
                  setConfirmReset(true);
                  setTimeout(() => setConfirmReset(false), 4000);
                  return;
                }
                setConfirmReset(false);
                void replaceSettings(DEFAULT_SETTINGS).then(() => flash("All settings reset"));
              }}
            >
              {confirmReset ? "Click again to reset everything" : "Reset all settings"}
            </button>
            {msg && <span className="flash">{msg}</span>}
          </div>
          <textarea value={paste} placeholder="Paste copied settings here" spellCheck={false} onChange={(e) => setPaste(e.target.value)} rows={4} />
          <button
            className="btn"
            disabled={!paste.trim()}
            onClick={() => {
              try {
                void replaceSettings(JSON.parse(paste));
                setPaste("");
                flash("Settings restored");
              } catch {
                flash("That isn't valid settings text");
              }
            }}
          >
            Restore pasted settings
          </button>
        </div>
      );
  }
  return null;
}


function Autostart() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void import("@tauri-apps/plugin-autostart")
      .then((a) => a.isEnabled())
      .then(setOn)
      .catch(() => setOn(null));
  }, []);
  if (on === null) return <span className="help">Available in the installed app.</span>;
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label="Start with Windows"
      className={`switch ${on ? "on" : ""}`}
      onClick={async () => {
        const a = await import("@tauri-apps/plugin-autostart");
        if (on) await a.disable();
        else await a.enable();
        const now = await a.isEnabled();
        setOn(now);
        void updateSettings("app.autostart", now);
      }}
    >
      <span />
    </button>
  );
}
