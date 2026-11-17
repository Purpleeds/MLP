// Upgrade 19: the stream overlay's address (copy into an OBS Browser Source) and URL options.
import { useState } from "react";
import { isTauri } from "../core/platform";
import { useSettings } from "../core/settings/store";

export function ObsPanel() {
  const s = useSettings();
  const [copied, setCopied] = useState(false);
  if (!isTauri()) return <p className="help">Available in the app.</p>;
  const url = `http://127.0.0.1:${s.app.obsPort}/`;
  return (
    <div className="capture">
      {s.app.obs ? (
        <>
          <div className="inline">
            <code>{url}</code>
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="help">
            In OBS: Sources → + → Browser, paste the address, size 1920×1080. Options: add <code>?size=64&amp;align=left&amp;title=1&amp;next=0</code>.
          </p>
        </>
      ) : (
        <p className="help">Turn it on to get the address.</p>
      )}
    </div>
  );
}
