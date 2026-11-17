// Upgrade 7: connect / disconnect the optional Spotify account (the user's own developer app).
import { useEffect, useState } from "react";
import { isTauri, platform } from "../core/platform";
import { updateSettings, useSettings } from "../core/settings/store";

interface SpotifyStatus {
  connected: boolean;
  user: string;
  redirectUri: string;
}

export function SpotifyPanel() {
  const s = useSettings();
  const [st, setSt] = useState<SpotifyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isTauri()) void platform.invoke<SpotifyStatus>("spotify_status").then((x) => x && setSt(x));
  }, []);

  if (!isTauri()) return <p className="help">Available in the app.</p>;
  const redirect = st?.redirectUri ?? "http://127.0.0.1:43821/callback";

  const connect = async () => {
    setBusy(true);
    setMsg("Finish the login in your browser…");
    try {
      const next = await platform.invoke<SpotifyStatus>("spotify_login", { clientId: s.spotify.clientId });
      if (next) setSt(next);
      await updateSettings("spotify.enabled", true);
      setMsg("");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    await platform.invoke("spotify_logout");
    await updateSettings("spotify.enabled", false);
    setSt((x) => (x ? { ...x, connected: false, user: "" } : x));
  };

  return (
    <div className="capture">
      {st?.connected ? (
        <>
          <div className="capture-row">
            <span className="capture-label">Connected</span>
            <span>{st.user || "Spotify account"}</span>
            <button role="switch" aria-checked={s.spotify.enabled} aria-label="Use Spotify account" className={`switch ${s.spotify.enabled ? "on" : ""}`} onClick={() => void updateSettings("spotify.enabled", !s.spotify.enabled)}>
              <span />
            </button>
          </div>
          <div className="inline">
            <button className="btn" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <ol className="help steps">
            <li>Open developer.spotify.com/dashboard → Create app (Web API).</li>
            <li>
              Add the Redirect URI <code>{redirect}</code>{" "}
              <button
                className="btn small"
                onClick={() => void navigator.clipboard.writeText(redirect).then(() => setCopied(true))}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </li>
            <li>Paste the app's Client ID above, then connect. Spotify asks for your OK in the browser.</li>
          </ol>
          <div className="inline">
            <button className="btn" disabled={busy || s.spotify.clientId.trim().length < 16} onClick={() => void connect()}>
              {busy ? "Waiting for Spotify…" : "Connect Spotify"}
            </button>
          </div>
          <p className="help">Spotify only lets development apps work for accounts you add in the dashboard (and may require Premium for the app owner).</p>
        </>
      )}
      {msg && <p className="help">{msg}</p>}
    </div>
  );
}
