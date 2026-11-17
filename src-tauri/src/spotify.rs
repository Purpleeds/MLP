//! Upgrade 7 — optional Spotify login (official Web API, Authorization Code + PKCE).
//! The user registers their own Spotify app (Client ID, redirect `http://127.0.0.1:43821/callback`);
//! MLP then reads the currently playing track (exact metadata, ISRC, 640 px cover art).
//! Tokens are stored in `<app data>/spotify.json`, never in settings (backups / copy-paste stay clean).

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const REDIRECT_PORT: u16 = 43_821;
pub const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";
const SCOPES: &str = "user-read-currently-playing user-read-playback-state";

#[derive(Serialize, Deserialize, Clone, Default)]
struct Tokens {
    client_id: String,
    access_token: String,
    refresh_token: String,
    /// unix seconds
    expires_at: u64,
    user: String,
}

static TOKENS: Mutex<Option<Tokens>> = Mutex::new(None);

fn file(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("spotify.json")
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load(app: &AppHandle) -> Option<Tokens> {
    let mut g = TOKENS.lock().unwrap();
    if g.is_none() {
        *g = std::fs::read_to_string(file(app)).ok().and_then(|s| serde_json::from_str(&s).ok());
    }
    g.clone()
}

fn save(app: &AppHandle, t: Option<Tokens>) -> Result<(), String> {
    let p = file(app);
    match &t {
        Some(t) => {
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, serde_json::to_string(t).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
        None => {
            let _ = std::fs::remove_file(&p);
        }
    }
    *TOKENS.lock().unwrap() = t;
    Ok(())
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// PKCE verifier (43–128 chars of [A-Za-z0-9-._~]) and its S256 challenge.
pub fn pkce() -> Result<(String, String), String> {
    let mut raw = [0u8; 48];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    let verifier = b64url(&raw);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

fn random_state() -> Result<String, String> {
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    Ok(b64url(&raw))
}

/// `?code=…&state=…` from the redirect's request line ("GET /callback?code=… HTTP/1.1").
pub fn parse_callback(request_line: &str) -> Option<Vec<(String, String)>> {
    let path = request_line.split_whitespace().nth(1)?;
    let (route, query) = path.split_once('?')?;
    if route != "/callback" {
        return None;
    }
    Some(
        query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (k.to_string(), urlencoding_decode(v)))
            .collect(),
    )
}

fn urlencoding_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|c| match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect()
}

/// Wait for the browser to come back to the loopback redirect; answers it with a small page.
fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(180) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let Some(params) = req.lines().next().and_then(parse_callback) else {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    continue;
                };
                let get = |k: &str| params.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
                let ok = get("state").as_deref() == Some(state) && get("code").is_some();
                let body = if ok {
                    "<!doctype html><meta charset=utf-8><title>MLP</title><body style=\"font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:90vh\"><p>Spotify is connected to MLP. You can close this tab.</p>"
                } else {
                    "<!doctype html><meta charset=utf-8><title>MLP</title><body style=\"font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:90vh\"><p>Spotify didn't connect. Try again from MLP's settings.</p>"
                };
                let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
                if let Some(err) = get("error") {
                    return Err(format!("Spotify said: {err}"));
                }
                if get("state").as_deref() != Some(state) {
                    return Err("login answer didn't match (state)".into());
                }
                return get("code").ok_or_else(|| "no code in the answer".into());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Timed out waiting for the Spotify login.".into())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}

async fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let res = reqwest::Client::new()
        .post("https://accounts.spotify.com/api/token")
        .form(form)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Spotify login failed: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Spotify login failed: HTTP {status} {}", text.chars().take(200).collect::<String>()));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// A valid access token (refreshed when it's about to expire).
async fn access_token(app: &AppHandle) -> Result<String, String> {
    let t = load(app).ok_or("Spotify isn't connected")?;
    if t.expires_at > now() + 60 {
        return Ok(t.access_token);
    }
    let r = token_request(&[("grant_type", "refresh_token"), ("refresh_token", &t.refresh_token), ("client_id", &t.client_id)]).await?;
    let next = Tokens { access_token: r.access_token.clone(), refresh_token: r.refresh_token.unwrap_or(t.refresh_token), expires_at: now() + r.expires_in, ..t };
    save(app, Some(next))?;
    Ok(r.access_token)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStatus {
    pub connected: bool,
    pub user: String,
    pub redirect_uri: &'static str,
}

#[tauri::command]
pub fn spotify_status(app: AppHandle) -> SpotifyStatus {
    let t = load(&app);
    SpotifyStatus { connected: t.is_some(), user: t.map(|t| t.user).unwrap_or_default(), redirect_uri: REDIRECT_URI }
}

/// Default browser, per OS.
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]).creation_flags(0x0800_0000).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens Spotify's login page in the default browser and waits for the loopback redirect.
#[tauri::command]
pub async fn spotify_login(app: AppHandle, client_id: String) -> Result<SpotifyStatus, String> {
    let client_id = client_id.trim().to_string();
    if client_id.len() < 16 || !client_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("That doesn't look like a Spotify Client ID.".into());
    }
    let (verifier, challenge) = pkce()?;
    let state = random_state()?;
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).map_err(|e| format!("Port {REDIRECT_PORT} is busy ({e}); close other logins and try again."))?;
    let url = format!(
        "https://accounts.spotify.com/authorize?client_id={}&response_type=code&redirect_uri={}&code_challenge_method=S256&code_challenge={}&scope={}&state={}",
        enc(&client_id),
        enc(REDIRECT_URI),
        challenge,
        enc(SCOPES),
        enc(&state)
    );
    open_url(&url)?;
    let st = state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &st)).await.map_err(|e| e.to_string())??;
    let r = token_request(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", &client_id),
        ("code_verifier", &verifier),
    ])
    .await?;
    let mut t = Tokens {
        client_id,
        access_token: r.access_token,
        refresh_token: r.refresh_token.unwrap_or_default(),
        expires_at: now() + r.expires_in,
        user: String::new(),
    };
    // Display name (best effort).
    if let Ok(res) = reqwest::Client::new().get("https://api.spotify.com/v1/me").bearer_auth(&t.access_token).timeout(Duration::from_secs(10)).send().await {
        if let Ok(me) = res.json::<serde_json::Value>().await {
            t.user = me["display_name"].as_str().or(me["id"].as_str()).unwrap_or("").to_string();
        }
    }
    save(&app, Some(t))?;
    Ok(spotify_status(app))
}

#[tauri::command]
pub fn spotify_logout(app: AppHandle) -> Result<(), String> {
    save(&app, None)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyTrack {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: u64,
    pub progress_ms: u64,
    pub is_playing: bool,
    pub isrc: Option<String>,
    /// largest cover image
    pub art: Option<String>,
}

/// Currently playing item from the Web API JSON (tracks only; episodes/ads → None).
pub fn parse_track(v: &serde_json::Value) -> Option<SpotifyTrack> {
    let item = v.get("item")?;
    if item.get("type")?.as_str()? != "track" {
        return None;
    }
    let art = item["album"]["images"]
        .as_array()
        .and_then(|imgs| imgs.iter().max_by_key(|i| i["width"].as_u64().unwrap_or(0)))
        .and_then(|i| i["url"].as_str())
        .map(String::from);
    Some(SpotifyTrack {
        id: item["id"].as_str().unwrap_or("").to_string(),
        title: item["name"].as_str()?.to_string(),
        artists: item["artists"].as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str().map(String::from)).collect()).unwrap_or_default(),
        album: item["album"]["name"].as_str().unwrap_or("").to_string(),
        duration_ms: item["duration_ms"].as_u64().unwrap_or(0),
        progress_ms: v["progress_ms"].as_u64().unwrap_or(0),
        is_playing: v["is_playing"].as_bool().unwrap_or(false),
        isrc: item["external_ids"]["isrc"].as_str().map(String::from),
        art,
    })
}

/// What Spotify says is playing now (None: nothing, an ad or a podcast).
#[tauri::command]
pub async fn spotify_now(app: AppHandle) -> Result<Option<SpotifyTrack>, String> {
    let token = access_token(&app).await?;
    let res = reqwest::Client::new()
        .get("https://api.spotify.com/v1/me/player/currently-playing")
        .bearer_auth(token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    match res.status().as_u16() {
        204 => Ok(None),
        200 => Ok(parse_track(&res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?)),
        401 => {
            // Token revoked: forget it so the UI offers to reconnect.
            save(&app, None)?;
            Err("Spotify disconnected (access was removed). Connect again in Settings.".into())
        }
        429 => Err("Spotify is rate-limiting; trying again later.".into()),
        s => Err(format!("Spotify HTTP {s}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pair_is_valid() {
        let (v, c) = pkce().unwrap();
        assert!((43..=128).contains(&v.len()));
        assert_eq!(c, b64url(&Sha256::digest(v.as_bytes())));
        assert!(!c.contains('=') && !c.contains('+') && !c.contains('/'));
    }

    #[test]
    fn reads_the_redirect() {
        let p = parse_callback("GET /callback?code=AQB%2Fx-y&state=abc HTTP/1.1").unwrap();
        assert_eq!(p, vec![("code".into(), "AQB/x-y".into()), ("state".into(), "abc".into())]);
        assert!(parse_callback("GET /favicon.ico HTTP/1.1").is_none());
        assert_eq!(enc("user-read-currently-playing user"), "user-read-currently-playing%20user");
    }

    #[test]
    fn parses_currently_playing() {
        let v = serde_json::json!({
            "is_playing": true, "progress_ms": 42000,
            "item": { "type": "track", "id": "4uLU6hMCjMI75M1A2tKUQC", "name": "Never Gonna Give You Up", "duration_ms": 213573,
                "artists": [{ "name": "Rick Astley" }], "external_ids": { "isrc": "GBARL9300135" },
                "album": { "name": "Whenever You Need Somebody", "images": [{ "url": "s", "width": 64 }, { "url": "big", "width": 640 }] } }
        });
        let t = parse_track(&v).unwrap();
        assert_eq!((t.title.as_str(), t.artists[0].as_str(), t.duration_ms, t.art.as_deref(), t.isrc.as_deref()), ("Never Gonna Give You Up", "Rick Astley", 213573, Some("big"), Some("GBARL9300135")));
        assert!(parse_track(&serde_json::json!({ "item": { "type": "episode", "name": "x" } })).is_none());
    }
}
