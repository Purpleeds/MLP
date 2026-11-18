// Settings → Translation: last problem, reset all saved translations, open their folder.
import { useEffect, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { getTranslationStatus, resetAllTranslations, type TranslationStatus } from "../core/translationFiles";

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

export function TranslationPanel() {
  const [status, setStatus] = useState<TranslationStatus | undefined>();
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    void getTranslationStatus().then(setStatus);
    const off = platform.on<TranslationStatus>("translation-status", setStatus);
    return () => void off.then((f) => f());
  }, []);
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(""), 2500);
  };

  return (
    <div className="backup">
      <p className="help" role="status">
        {status?.problem ? `Last problem: ${status.message} (${when(status.at)}${status.song ? `, ${status.song}` : ""}).` : status ? "Last translation worked." : "No translations yet."}
      </p>
      <div className="inline">
        <button
          className={`btn ${confirm ? "danger" : ""}`}
          onClick={() => {
            if (!confirm) {
              setConfirm(true);
              setTimeout(() => setConfirm(false), 4000);
              return;
            }
            setConfirm(false);
            void resetAllTranslations().then(
              (n) => flash(n ? `${n} saved translation${n === 1 ? "" : "s"} deleted` : "No saved translations"),
              (e) => flash(String(e)),
            );
          }}
        >
          {confirm ? "Click again to delete all" : "Reset all translations"}
        </button>
        {isTauri() && (
          <button className="btn quiet" onClick={() => void platform.invoke("tr_open_folder").catch((e) => flash(String(e)))}>
            Open folder
          </button>
        )}
        {msg && <span className="flash">{msg}</span>}
      </div>
    </div>
  );
}
