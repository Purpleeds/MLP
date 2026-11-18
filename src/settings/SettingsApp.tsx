// Settings window: section list on the left, schema-driven controls on the right. Changes apply live.
import { useT } from "./i18n";
import { useEffect, useState } from "react";
import { updateSettings, useSettings } from "../core/settings/store";
import { DEFAULT_SETTINGS } from "../core/settings/schema";
import { findSection, getPath, SECTIONS, visibleGroups } from "./fields";
import { FieldRow } from "./controls";
import { platform } from "../core/platform";
import "./settings.css";

const ADV_KEY = "mlp.settings.advanced";
const stored = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

export default function SettingsApp() {
  const [active, setActive] = useState(() => {
    const asked = new URLSearchParams(location.search).get("tab");
    return (findSection(asked) ?? findSection(stored("mlp.settings.tab")) ?? SECTIONS[0]).id;
  });
  const [advanced, setAdvanced] = useState(() => stored(ADV_KEY) === "1");
  useEffect(() => store("mlp.settings.tab", active), [active]);
  useEffect(() => store(ADV_KEY, advanced ? "1" : "0"), [advanced]);
  // The lyrics window can ask for a specific tab (e.g. "song" from its search button).
  useEffect(() => {
    const off = platform.on<string>("settings-tab", (t) => {
      const sec = findSection(t);
      if (sec) setActive(sec.id);
    });
    return () => void off.then((f) => f());
  }, []);
  const t = useT();
  const s = useSettings();
  const section = findSection(active) ?? SECTIONS[0];
  const { groups, hidden } = visibleGroups(section, s, advanced);

  const reset = () => {
    for (const p of section.resets) void updateSettings(p, structuredClone(getPath(DEFAULT_SETTINGS, p)));
  };

  return (
    <div className="settings">
      <nav className="nav" aria-label="Settings sections">
        <div className="nav-title">MLP</div>
        {SECTIONS.map((x) => (
          <button key={x.id} className={x.id === section.id ? "on" : ""} aria-current={x.id === section.id ? "page" : undefined} onClick={() => setActive(x.id)}>
            {t(x.title)}
          </button>
        ))}
        <div className="nav-foot">
          <label className="adv-toggle">
            <button role="switch" aria-checked={advanced} className={`switch small ${advanced ? "on" : ""}`} onClick={() => setAdvanced((v) => !v)}>
              <span />
            </button>
            {t("Advanced options")}
          </label>
          <p>{t("Changes apply right away.")}</p>
        </div>
      </nav>
      <main className="page">
        <header className="page-head">
          <h1>{t(section.title)}</h1>
          {section.resets.length > 0 && (
            <button className="btn quiet small" onClick={reset}>
              {t("Reset section")}
            </button>
          )}
        </header>
        {groups.map((g) => (
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
        {hidden > 0 && (
          <button className="btn quiet more" onClick={() => setAdvanced(true)}>
            {t("Show advanced options")} ({hidden})
          </button>
        )}
      </main>
    </div>
  );
}
