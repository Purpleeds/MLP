//! Now-playing on macOS and Linux (Upgrade 21), same events / commands as the Windows GSMTC module.
//! - Linux: MPRIS over D-Bus (Spotify, browsers, VLC, most players).
//! - macOS: AppleScript for Spotify and Music (the system-wide MediaRemote API is closed to apps).
//! Polled every 500 ms on a background thread; `now-playing` is emitted on change.

use serde::{Deserialize, Serialize};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const POLL: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub source_app: String,
    pub source_kind: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: f64,
    pub artwork: Option<String>,
    pub status: String,
    pub position_ms: f64,
    pub updated_at_ms: f64,
    pub rate: f64,
    pub timeline_ok: bool,
    pub can_seek: bool,
    pub artwork_same: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaConfig {
    pub allow_other: bool,
    pub ignore: Vec<String>,
    pub prefer: String,
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

pub fn classify(id: &str) -> &'static str {
    let a = id.to_ascii_lowercase();
    if a.contains("spotify") {
        "spotify"
    } else if a.contains("youtube-music") || a.contains("youtubemusic") || a.contains("pear") {
        "ytmusic-app"
    } else if ["chrom", "firefox", "brave", "edge", "opera", "vivaldi", "safari", "arc"].iter().any(|b| a.contains(b)) {
        "browser"
    } else {
        "other"
    }
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn allowed(kind: &str, id: &str, cfg: &MediaConfig) -> bool {
    let low = id.to_ascii_lowercase();
    if cfg.ignore.iter().any(|i| !i.trim().is_empty() && low.contains(&i.trim().to_ascii_lowercase())) {
        return false;
    }
    kind != "other" || cfg.allow_other
}

#[cfg(target_os = "linux")]
mod os {
    use super::*;
    use mpris::{PlaybackStatus, Player, PlayerFinder};

    pub struct Poller {
        finder: Option<PlayerFinder>,
    }

    impl Poller {
        pub fn new() -> Self {
            Self { finder: PlayerFinder::new().ok() }
        }

        fn pick(&self, cfg: &MediaConfig) -> Option<Player> {
            let players = self.finder.as_ref()?.find_all().ok()?;
            let mut best: Option<(i32, Player)> = None;
            for p in players {
                let id = p.identity().to_string();
                let kind = classify(&format!("{} {}", p.bus_name(), id));
                if !allowed(kind, &id, cfg) {
                    continue;
                }
                let playing = matches!(p.get_playback_status(), Ok(PlaybackStatus::Playing));
                let preferred = cfg.prefer == kind;
                let score = (playing as i32) * 2 + preferred as i32;
                if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                    best = Some((score, p));
                }
            }
            best.map(|(_, p)| p)
        }

        pub fn snapshot(&mut self, cfg: &MediaConfig) -> Option<NowPlaying> {
            if self.finder.is_none() {
                self.finder = PlayerFinder::new().ok();
            }
            let p = self.pick(cfg)?;
            let md = p.get_metadata().ok()?;
            let id = p.identity().to_string();
            let status = match p.get_playback_status() {
                Ok(PlaybackStatus::Playing) => "playing",
                Ok(PlaybackStatus::Paused) => "paused",
                _ => "stopped",
            };
            let duration_ms = md.length().map(|d| d.as_millis() as f64).unwrap_or(0.0);
            let position_ms = p.get_position().map(|d| d.as_millis() as f64).unwrap_or(0.0);
            Some(NowPlaying {
                source_kind: classify(&format!("{} {}", p.bus_name(), id)).into(),
                source_app: id,
                title: md.title().unwrap_or("").to_string(),
                artist: md.artists().map(|a| a.join(", ")).unwrap_or_default(),
                album: md.album_name().unwrap_or("").to_string(),
                duration_ms,
                artwork: md.art_url().map(String::from),
                status: status.into(),
                position_ms,
                updated_at_ms: now_ms(),
                rate: p.get_playback_rate().unwrap_or(1.0),
                timeline_ok: duration_ms > 0.0,
                can_seek: p.can_seek().unwrap_or(false),
                artwork_same: false,
            })
        }

        pub fn control(&mut self, cfg: &MediaConfig, c: Control) {
            let Some(p) = self.pick(cfg) else { return };
            let _ = match c {
                Control::Play => p.play(),
                Control::Pause => p.pause(),
                Control::Toggle => p.play_pause(),
                Control::Next => p.next(),
                Control::Prev => p.previous(),
                Control::Seek { ms } => match p.get_metadata().ok().and_then(|m| m.track_id()) {
                    Some(track) => p.set_position(track, &Duration::from_millis(ms.max(0.0) as u64)),
                    None => Ok(()),
                },
            };
        }
    }
}

#[cfg(target_os = "macos")]
mod os {
    use super::*;

    /// One player through AppleScript: "playing|title|artist|album|duration s|position s".
    fn query(app: &str) -> Option<Vec<String>> {
        let dur = if app == "Spotify" { "(duration of current track) / 1000" } else { "duration of current track" };
        let script = format!(
            "if application \"{app}\" is running then tell application \"{app}\" to if player state is not stopped then return (player state as text) & \"|\" & name of current track & \"|\" & artist of current track & \"|\" & album of current track & \"|\" & ({dur}) & \"|\" & player position"
        );
        let out = std::process::Command::new("osascript").args(["-e", &script]).output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let parts: Vec<String> = s.split('|').map(String::from).collect();
        (parts.len() >= 6).then_some(parts)
    }

    fn num(s: &str) -> f64 {
        s.trim().replace(',', ".").parse().unwrap_or(0.0)
    }

    pub struct Poller;

    impl Poller {
        pub fn new() -> Self {
            Self
        }

        pub fn snapshot(&mut self, cfg: &MediaConfig) -> Option<NowPlaying> {
            let mut found = Vec::new();
            for app in ["Spotify", "Music"] {
                let kind = if app == "Spotify" { "spotify" } else { "other" };
                if !allowed(kind, app, cfg) {
                    continue;
                }
                if let Some(p) = query(app) {
                    found.push((app, kind, p));
                }
            }
            found.sort_by_key(|(_, _, p)| (p[0] != "playing") as u8);
            let (app, kind, p) = found.into_iter().next()?;
            let duration_ms = num(&p[4]) * 1000.0;
            Some(NowPlaying {
                source_app: app.into(),
                source_kind: kind.into(),
                title: p[1].clone(),
                artist: p[2].clone(),
                album: p[3].clone(),
                duration_ms,
                artwork: None,
                status: if p[0] == "playing" { "playing".into() } else { "paused".into() },
                position_ms: num(&p[5]) * 1000.0,
                updated_at_ms: now_ms(),
                rate: 1.0,
                timeline_ok: duration_ms > 0.0,
                can_seek: true,
                artwork_same: false,
            })
        }

        pub fn control(&mut self, _cfg: &MediaConfig, c: Control) {
            let Some(app) = LATEST.lock().unwrap().as_ref().map(|n| n.source_app.clone()) else { return };
            let cmd = match c {
                Control::Play => "play".to_string(),
                Control::Pause => "pause".to_string(),
                Control::Toggle => "playpause".to_string(),
                Control::Next => "next track".to_string(),
                Control::Prev => "previous track".to_string(),
                Control::Seek { ms } => format!("set player position to {}", ms.max(0.0) / 1000.0),
            };
            let _ = std::process::Command::new("osascript").args(["-e", &format!("tell application \"{app}\" to {cmd}")]).output();
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod os {
    use super::*;
    pub struct Poller;
    impl Poller {
        pub fn new() -> Self {
            Self
        }
        pub fn snapshot(&mut self, _cfg: &MediaConfig) -> Option<NowPlaying> {
            None
        }
        pub fn control(&mut self, _cfg: &MediaConfig, _c: Control) {}
    }
}

pub fn start(app: AppHandle) {
    let (tx, rx) = channel::<Control>();
    let _ = CONTROL_TX.set(tx);
    std::thread::Builder::new()
        .name("media".into())
        .spawn(move || {
            let mut poller = os::Poller::new();
            let mut last: Option<NowPlaying> = None;
            let mut next = Instant::now();
            loop {
                match rx.recv_timeout(next.saturating_duration_since(Instant::now())) {
                    Ok(c) => {
                        let cfg = CONFIG.lock().unwrap().clone().unwrap_or_default();
                        poller.control(&cfg, c);
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                next = Instant::now() + POLL;
                let cfg = CONFIG.lock().unwrap().clone().unwrap_or_default();
                let np = poller.snapshot(&cfg);
                // Position moves every poll; only emit when something else changed or it jumped.
                let changed = match (&np, &last) {
                    (Some(a), Some(b)) => {
                        let expected = b.position_ms + if b.status == "playing" { a.updated_at_ms - b.updated_at_ms } else { 0.0 };
                        a.title != b.title || a.artist != b.artist || a.status != b.status || a.duration_ms != b.duration_ms || (a.position_ms - expected).abs() > 1500.0
                    }
                    (None, None) => false,
                    _ => true,
                };
                if changed {
                    if let Some(n) = &np {
                        crate::tray::set_tooltip(&app, &format!("MLP — {} · {}", n.title, n.artist));
                    }
                    *LATEST.lock().unwrap() = np.clone();
                    let _ = app.emit("now-playing", &np);
                    last = np;
                }
            }
        })
        .expect("spawn media thread");
}

pub fn latest() -> Option<NowPlaying> {
    LATEST.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_now_playing() -> Option<NowPlaying> {
    latest()
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
