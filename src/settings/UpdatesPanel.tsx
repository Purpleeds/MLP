// Upgrade 16: updates from GitHub Releases (signed with the app's updater key). The official feed is
// built in (core/version.ts); Settings → General → Update feed can point somewhere else.
import { useEffect, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { updateSettings, useSettings } from "../core/settings/store";
import { APP_VERSION, updateFeed } from "../core/version";

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
      const r = await platform.invoke<UpdateInfo>("update_check", { url: updateFeed(s.app.updateUrl) });
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
      await platform.invoke("update_install", { url: updateFeed(s.app.updateUrl) });
    } catch (e) {
      setMsg(String(e));
      setBusy(null);
    }
  };

  return (
    <div className="capture">
      <p className="help">You have MLP {APP_VERSION}.</p>
      {(
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
