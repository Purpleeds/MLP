// Settings window: section list on the left, schema-driven controls on the right. Changes apply live.
import { useT } from "./i18n";
import { useEffect, useState } from "react";
import { updateSettings } from "../core/settings/store";
import { DEFAULT_SETTINGS } from "../core/settings/schema";
import { getPath, SECTIONS } from "./fields";
import { FieldRow } from "./controls";
import { platform } from "../core/platform";
import "./settings.css";

export default function SettingsApp() {
  const [active, setActive] = useState(() => {
    try {
      return new URLSearchParams(location.search).get("tab") ?? localStorage.getItem("mlp.settings.tab") ?? "general";
    } catch {
      return "general";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("mlp.settings.tab", active);
    } catch {
      /* ignore */
    }
  }, [active]);
  // The lyrics window can ask for a specific tab (e.g. "song" from its search button).
  useEffect(() => {
    const off = platform.on<string>("settings-tab", (t) => SECTIONS.some((x) => x.id === t) && setActive(t));
    return () => void off.then((f) => f());
  }, []);
  const t = useT();
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  const reset = () => {
    for (const p of section.resets) void updateSettings(p, structuredClone(getPath(DEFAULT_SETTINGS, p)));
  };

  return (
    <div className="settings">
      <nav className="nav" aria-label="Settings sections">
        <div className="nav-title">MLP</div>
        {SECTIONS.map((s) => (
          <button key={s.id} className={s.id === section.id ? "on" : ""} aria-current={s.id === section.id ? "page" : undefined} onClick={() => setActive(s.id)}>
            {t(s.title)}
          </button>
        ))}
        <p className="nav-foot">Changes apply right away.</p>
      </nav>
      <main className="page">
        <header className="page-head">
          <h1>{t(section.title)}</h1>
          {section.resets.length > 0 && (
            <button className="btn quiet" onClick={reset}>
              Reset section
            </button>
          )}
        </header>
        {section.groups.map((g) => (
          <section className="group" key={g.title}>
            <h2>{t(g.title)}</h2>
            {g.note && <p className="group-note">{t(g.note)}</p>}
            <div className="group-body">
              {g.fields.map((f) => (
                <FieldRow key={f.kind === "custom" ? f.id : f.path} f={f} />
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
