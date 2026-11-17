// Upgrade 13: theme gallery — save the current look by name, apply / delete saved themes,
// copy a share code and import one from someone else.
import { useEffect, useState } from "react";
import { getSettings, replaceSettings, useSettings } from "../core/settings/store";
import { applyTheme, captureTheme, decodeTheme, deleteTheme, encodeTheme, listThemes, saveTheme, type Theme } from "../core/themes";

function Swatch({ t }: { t: Theme }) {
  const a = t.data.appearance;
  const b = t.data.background;
  const bg = b.type === "solid" || b.type === "dark" ? b.color1 : `linear-gradient(135deg, ${b.color1}, ${b.color2})`;
  return (
    <span className="preset-swatch" style={{ background: bg }}>
      <span style={{ color: a.activeColor, fontFamily: a.fontFamily, fontWeight: a.fontWeight }}>Aa</span>
    </span>
  );
}

export function ThemesPanel() {
  useSettings(); // re-render when the look changes
  const [themes, setThemes] = useState<Theme[]>([]);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const reload = () => void listThemes().then(setThemes);
  useEffect(reload, []);

  const save = async () => {
    const t = await saveTheme(name || "My theme", captureTheme(getSettings()));
    setName("");
    setMsg(`Saved “${t.name}”.`);
    reload();
  };
  const share = async (t: Theme) => {
    await navigator.clipboard.writeText(encodeTheme(t.name, t.data));
    setMsg(`Share code for “${t.name}” copied — paste it anywhere.`);
  };
  const importCode = async () => {
    const t = decodeTheme(code);
    if (!t) return setMsg("That isn't an MLP theme code (it starts with mlp-theme:).");
    await saveTheme(t.name, t.data);
    await replaceSettings(applyTheme(getSettings(), t.data));
    setCode("");
    setMsg(`Imported and applied “${t.name}”.`);
    reload();
  };

  return (
    <div className="themes">
      {themes.length > 0 && (
        <div className="presets">
          {themes.map((t) => (
            <div key={t.id} className="preset theme">
              <button className="theme-apply" onClick={() => void replaceSettings(applyTheme(getSettings(), t.data)).then(() => setMsg(`Applied “${t.name}”.`))}>
                <Swatch t={t} />
                <span className="preset-name">{t.name}</span>
              </button>
              <span className="theme-actions">
                <button className="btn small" onClick={() => void share(t)}>
                  Share
                </button>
                <button className="btn small quiet" onClick={() => void deleteTheme(t.id).then(reload)}>
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="inline">
        <input type="text" value={name} placeholder="Name for the current look" onChange={(e) => setName(e.target.value)} maxLength={40} />
        <button className="btn" onClick={() => void save()}>
          Save theme
        </button>
      </div>
      <div className="inline">
        <input type="text" value={code} placeholder="Paste a theme code (mlp-theme:…)" onChange={(e) => setCode(e.target.value)} spellCheck={false} />
        <button className="btn" disabled={!code.trim()} onClick={() => void importCode()}>
          Import
        </button>
      </div>
      {msg && <p className="help">{msg}</p>}
    </div>
  );
}
