//! Now-playing detection via Windows GSMTC (Global System Media Transport Controls).
//! A dedicated MTA thread polls the session manager (cheap, robust against missed events),
//! emits `now-playing` to the frontend on any change, and executes media-control requests.

use crate::art_cache::ArtCache;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;

const POLL: Duration = Duration::from_millis(250);
/// 100-ns ticks between 1601-01-01 (WinRT DateTime epoch) and 1970-01-01.
const EPOCH_DIFF_TICKS: i64 = 116_444_736_000_000_000;

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub source_app: String,
    /// spotify | browser | ytmusic-app | other
    pub source_kind: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: f64,
    /// data: URL of the thumbnail, if any
    pub artwork: Option<String>,
    /// playing | paused | stopped | changing | opened | closed
    pub status: String,
    pub position_ms: f64,
    /// Unix ms when the source last updated `position_ms`
    pub updated_at_ms: f64,
    pub rate: f64,
    /// false when the source does not publish a usable timeline (duration/position)
    pub timeline_ok: bool,
    pub can_seek: bool,
    /// true when `artwork` was left out because it is unchanged since the last event
    pub artwork_same: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaConfig {
    /// Follow apps other than Spotify / browsers / YT Music desktop.
    pub allow_other: bool,
    /// Substrings of app ids to ignore (case-insensitive).
    pub ignore: Vec<String>,
    /// auto | spotify | browser
    pub prefer: String,
}

impl Default for MediaConfig {
    fn default() -> Self {
        Self { allow_other: false, ignore: vec![], prefer: "auto".into() }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Control {
    Play,
    Pause,
    Toggle,
    Next,
    Prev,
    Seek { ms: f64 },
}

static CONFIG: Mutex<Option<MediaConfig>> = Mutex::new(None);
static LATEST: Mutex<Option<NowPlaying>> = Mutex::new(None);
static CONTROL_TX: OnceLock<Sender<Control>> = OnceLock::new();

pub fn classify(aumid: &str) -> &'static str {
    let a = aumid.to_ascii_lowercase();
    if a.contains("spotify") {
        "spotify"
    } else if a.contains("youtube-music") || a.contains("youtubemusic") || a.contains("pear") {
        "ytmusic-app"
    } else if ["chrome", "msedge", "brave", "opera", "vivaldi", "firefox", "308046b0af4a39cb", "arc"]
        .iter()
        .any(|b| a.contains(b))
    {
        "browser"
    } else {
        "other"
    }
}

fn status_str(s: Status) -> &'static str {
    match s {
        Status::Playing => "playing",
        Status::Paused => "paused",
        Status::Stopped => "stopped",
        Status::Changing => "changing",
        Status::Opened => "opened",
        _ => "closed",
    }
}

fn allowed(aumid: &str, kind: &str, cfg: &MediaConfig) -> bool {
    let a = aumid.to_ascii_lowercase();
    if cfg.ignore.iter().any(|i| !i.is_empty() && a.contains(&i.to_ascii_lowercase())) {
        return false;
    }
    kind != "other" || cfg.allow_other
}

/// Pick the best session: playing first, then preference, then the system "current" session.
fn pick_session(mgr: &Manager, cfg: &MediaConfig) -> windows::core::Result<Option<(Session, String)>> {
    let current = mgr
        .GetCurrentSession()
        .ok()
        .and_then(|s| s.SourceAppUserModelId().ok())
        .map(|h| h.to_string());
    let sessions = mgr.GetSessions()?;
    let mut best: Option<(i32, Session, String)> = None;
    for i in 0..sessions.Size()? {
        let s = sessions.GetAt(i)?;
        let aumid = s.SourceAppUserModelId()?.to_string();
        let kind = classify(&aumid);
        if !allowed(&aumid, kind, cfg) {
            continue;
        }
        let playing = s.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing;
        let mut score = if playing { 100 } else { 0 };
        if cfg.prefer == kind || (cfg.prefer == "browser" && kind == "ytmusic-app") {
            score += 20;
        }
        if current.as_deref() == Some(aumid.as_str()) {
            score += 5;
        }
        if best.as_ref().is_none_or(|(b, _, _)| score > *b) {
            best = Some((score, s, aumid));
        }
    }
    Ok(best.map(|(_, s, a)| (s, a)))
}

fn read_artwork(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    let thumb = props.Thumbnail().ok()?;
    let stream = thumb.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > 16 * 1024 * 1024 {
        return None;
    }
    let ctype = stream.ContentType().map(|h| h.to_string()).unwrap_or_default();
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size).ok()?.join().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    let mime = if ctype.starts_with("image/") { ctype } else { "image/png".into() };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
}

fn snapshot(mgr: &Manager, cfg: &MediaConfig, art: &mut ArtCache) -> windows::core::Result<Option<(NowPlaying, Session)>> {
    let Some((s, aumid)) = pick_session(mgr, cfg)? else { return Ok(None) };
    let props = s.TryGetMediaPropertiesAsync()?.join()?;
    let title = props.Title()?.to_string();
    if title.trim().is_empty() {
        return Ok(None);
    }
    let artist = props.Artist()?.to_string();
    let album = props.AlbumTitle()?.to_string();

    // Thumbnails can lag behind the title (see art_cache): re-read for a while after a change.
    let artwork = art.get(&format!("{aumid}|{title}|{artist}|{album}"), || read_artwork(&props));

    let info = s.GetPlaybackInfo()?;
    let status = status_str(info.PlaybackStatus()?).to_string();
    let rate = info.PlaybackRate().and_then(|r| r.Value()).unwrap_or(1.0);
    let can_seek = info.Controls().and_then(|c| c.IsPlaybackPositionEnabled()).unwrap_or(false);

    let tl = s.GetTimelineProperties()?;
    let start = tl.StartTime()?.Duration;
    let end = tl.EndTime()?.Duration;
    let pos = tl.Position()?.Duration;
    let updated = tl.LastUpdatedTime()?.UniversalTime;
    let timeline_ok = end > start;
    let updated_at_ms = if updated > EPOCH_DIFF_TICKS { (updated - EPOCH_DIFF_TICKS) as f64 / 1e4 } else { 0.0 };

    let np = NowPlaying {
        source_kind: classify(&aumid).into(),
        source_app: aumid,
        title,
        artist,
        album,
        duration_ms: if timeline_ok { (end - start) as f64 / 1e4 } else { 0.0 },
        artwork,
        status,
        position_ms: ((pos - start).max(0)) as f64 / 1e4,
        updated_at_ms,
        rate: if rate > 0.0 { rate } else { 1.0 },
        timeline_ok,
        can_seek,
        artwork_same: false,
    };
    Ok(Some((np, s)))
}

fn run_control(s: &Session, c: Control) -> windows::core::Result<()> {
    let ok = match c {
        Control::Play => s.TryPlayAsync()?.join()?,
        Control::Pause => s.TryPauseAsync()?.join()?,
        Control::Toggle => s.TryTogglePlayPauseAsync()?.join()?,
        Control::Next => s.TrySkipNextAsync()?.join()?,
        Control::Prev => s.TrySkipPreviousAsync()?.join()?,
        Control::Seek { ms } => {
            let start = s.GetTimelineProperties()?.StartTime()?.Duration;
            s.TryChangePlaybackPositionAsync(start + (ms * 1e4) as i64)?.join()?
        }
    };
    if !ok {
        eprintln!("[media] control rejected by source");
    }
    Ok(())
}

pub fn start(app: AppHandle) {
    let (tx, rx) = channel::<Control>();
    let _ = CONTROL_TX.set(tx);
    std::thread::Builder::new()
        .name("gsmtc".into())
        .spawn(move || {
            unsafe {
                let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
            }
            let mgr = loop {
                match Manager::RequestAsync().and_then(|op| op.join()) {
                    Ok(m) => break m,
                    Err(e) => {
                        eprintln!("[media] session manager unavailable: {e}");
                        std::thread::sleep(Duration::from_secs(3));
                    }
                }
            };
            let mut art = ArtCache::default();
            let mut last: Option<NowPlaying> = None;
            let mut session: Option<Session> = None;
            let mut next_poll = Instant::now();
            loop {
                match rx.recv_timeout(next_poll.saturating_duration_since(Instant::now())) {
                    Ok(c) => {
                        if let Some(s) = &session {
                            if let Err(e) = run_control(s, c) {
                                eprintln!("[media] control failed: {e}");
                            }
                        }
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                next_poll = Instant::now() + POLL;
                let cfg = CONFIG.lock().unwrap().clone().unwrap_or_default();
                let snap = match snapshot(&mgr, &cfg, &mut art) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[media] poll error: {e}");
                        None
                    }
                };
                let (np, s) = match snap {
                    Some((np, s)) => (Some(np), Some(s)),
                    None => (None, None),
                };
                session = s;
                if np != last {
                    let track_changed = np.as_ref().map(|n| (&n.title, &n.artist, &n.source_app))
                        != last.as_ref().map(|n| (&n.title, &n.artist, &n.source_app));
                    if track_changed {
                        match &np {
                            Some(n) => {
                                println!(
                                    "[media] {} ({}): {} — {} | dur {:.0} ms | timeline {} | art {}",
                                    n.source_kind, n.source_app, n.artist, n.title, n.duration_ms, n.timeline_ok, n.artwork.is_some()
                                );
                                crate::tray::set_tooltip(&app, &format!("MLP — {} · {}", n.title, n.artist));
                            }
                            None => {
                                println!("[media] nothing playing");
                                crate::tray::set_tooltip(&app, "MLP — Lyrics");
                            }
                        }
                    }
                    *LATEST.lock().unwrap() = np.clone();
                    // Don't resend the (large) artwork data URL when only playback state changed.
                    let same_art = matches!((&np, &last), (Some(a), Some(b)) if a.artwork.is_some() && a.artwork == b.artwork);
                    let payload = np.clone().map(|mut n| {
                        if same_art {
                            n.artwork = None;
                            n.artwork_same = true;
                        }
                        n
                    });
                    let _ = app.emit("now-playing", &payload);
                    last = np;
                }
            }
        })
        .expect("spawn gsmtc thread");
}

/// Latest now-playing snapshot (for other Rust modules).
pub fn latest() -> Option<NowPlaying> {
    LATEST.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_now_playing() -> Option<NowPlaying> {
    LATEST.lock().unwrap().clone()
}

#[tauri::command]
pub fn media_control(control: Control) {
    if let Some(tx) = CONTROL_TX.get() {
        let _ = tx.send(control);
    }
}

#[tauri::command]
pub fn set_media_config(config: MediaConfig) {
    *CONFIG.lock().unwrap() = Some(config);
}

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn classifies_sources() {
        assert_eq!(classify("Spotify.exe"), "spotify");
        assert_eq!(classify("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "spotify");
        assert_eq!(classify("Chrome"), "browser");
        assert_eq!(classify("MSEdge"), "browser");
        assert_eq!(classify("308046B0AF4A39CB"), "browser");
        assert_eq!(classify("com.github.th-ch.youtube-music"), "ytmusic-app");
        assert_eq!(classify("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "other");
    }
}
