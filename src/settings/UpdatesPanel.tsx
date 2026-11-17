// Upgrade 16: updates from GitHub Releases (signed with the app's updater key). The address of the
// release feed (latest.json) is set once the project is on GitHub.
import { useEffect, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { updateSettings, useSettings } from "../core/settings/store";

interface UpdateInfo {
  current: string;
  version: string | null;
  notes: string | null;
  date: string | null;
}

export function UpdatesPanel() {
  const s = useSettings();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const [msg, setMsg] = useState("");
  const [progress, setProgress] = useState<{ got: number; total: number } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const off = platform.on<{ got: number; total: number }>("update-progress", setProgress);
    return () => void off.then((f) => f());
  }, []);
  if (!isTauri()) return <p className="help">Available in the app.</p>;

  const check = async () => {
    setBusy("check");
    setMsg("");
    try {
      const r = await platform.invoke<UpdateInfo>("update_check", { url: s.app.updateUrl });
      if (r) setInfo(r);
      await updateSettings("app.lastUpdateCheck", Date.now());
      if (r && !r.version) setMsg(`You have the latest version (${r.current}).`);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };
  const install = async () => {
    setBusy("install");
    try {
      await platform.invoke("update_install", { url: s.app.updateUrl });
    } catch (e) {
      setMsg(String(e));
      setBusy(null);
    }
  };

  return (
    <div className="capture">
      {!s.app.updateUrl.trim() ? (
        <p className="help">Set the release feed address above (e.g. https://github.com/you/mlp/releases/latest/download/latest.json) to get updates.</p>
      ) : (
        <div className="inline">
          <button className="btn" disabled={!!busy} onClick={() => void check()}>
            {busy === "check" ? "Checking…" : "Check for updates"}
          </button>
          {info?.version && (
            <button className="btn" disabled={!!busy} onClick={() => void install()}>
              {busy === "install" ? (progress?.total ? `Downloading… ${Math.round((progress.got / progress.total) * 100)}%` : "Installing…") : `Install ${info.version} and restart`}
            </button>
          )}
        </div>
      )}
      {info?.version && info.notes && <p className="help">{info.notes}</p>}
      {msg && <p className="help">{msg}</p>}
    </div>
  );
}
