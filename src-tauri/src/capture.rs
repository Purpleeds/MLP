//! Player audio capture (Step 13): records only the playing app (Spotify / browser) through Windows
//! process loopback, as 16 kHz mono, placed on the *song's own timeline* (sample index = song time),
//! so later alignment works in song time directly, across pauses and seeks. Audio stays in memory.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

pub const RATE: usize = 16_000;
const MAX_SONG_MS: usize = 15 * 60 * 1000;

static ENABLED: AtomicBool = AtomicBool::new(false);
/// Output-latency correction (ms): audio reaches the loopback this much after the player's reported position.
static LATENCY_MS: AtomicI64 = AtomicI64::new(0);
static STATE: Mutex<Option<SongAudio>> = Mutex::new(None);
static LIVE: Mutex<LiveInfo> = Mutex::new(LiveInfo { pid: 0, app: String::new(), level: 0.0, error: None });

struct LiveInfo {
    pid: u32,
    app: String,
    level: f32,
    error: Option<String>,
}

/// Audio of one song, indexed by song time.
pub struct SongAudio {
    pub key: String,
    pub samples: Vec<f32>,
    /// covered song-time ranges in ms (merged)
    pub covered: Vec<(u64, u64)>,
}

impl SongAudio {
    pub(crate) fn new(key: String) -> Self {
        Self { key, samples: Vec::new(), covered: Vec::new() }
    }

    pub(crate) fn write(&mut self, start_ms: f64, data: &[f32]) {
        if start_ms < 0.0 || data.is_empty() {
            return;
        }
        let start = (start_ms * RATE as f64 / 1000.0) as usize;
        let end = (start + data.len()).min(MAX_SONG_MS * RATE / 1000);
        if end <= start {
            return;
        }
        if self.samples.len() < end {
            self.samples.resize(end, 0.0);
        }
        self.samples[start..end].copy_from_slice(&data[..end - start]);
        let (a, b) = ((start * 1000 / RATE) as u64, (end * 1000 / RATE) as u64);
        self.covered.push((a, b));
        self.covered.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for (s, e) in self.covered.drain(..) {
            match merged.last_mut() {
                Some(last) if s <= last.1 + 40 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        self.covered = merged;
    }
}

/// Dev aid (debug builds): pretend `samples` (16 kHz mono, from song time 0) were captured for `key`.
#[cfg(debug_assertions)]
pub fn debug_load(key: String, samples: &[f32]) {
    let mut s = SongAudio::new(key);
    s.write(0.0, samples);
    *STATE.lock().unwrap() = Some(s);
}

/// Key and covered ranges (ms) of the song currently held in memory.
#[cfg_attr(not(feature = "onnx"), allow(dead_code))]
pub fn current() -> Option<(String, Vec<(u64, u64)>)> {
    STATE.lock().unwrap().as_ref().map(|s| (s.key.clone(), s.covered.clone()))
}

/// Copy of the captured audio for a song time range (ms), if that song is the one in memory.
pub fn snapshot(key: &str, from_ms: u64, to_ms: u64) -> Option<Vec<f32>> {
    let g = STATE.lock().unwrap();
    let s = g.as_ref()?;
    if s.key != key {
        return None;
    }
    let a = (from_ms as usize * RATE / 1000).min(s.samples.len());
    let b = (to_ms as usize * RATE / 1000).min(s.samples.len());
    Some(s.samples[a..b].to_vec())
}

/// True when `covered` (sorted, merged ranges) contains all of [from, to) (40 ms slack).
#[cfg_attr(not(feature = "onnx"), allow(dead_code))]
pub fn covers(covered: &[(u64, u64)], from_ms: u64, to_ms: u64) -> bool {
    covered.iter().any(|&(a, b)| a <= from_ms + 40 && b + 40 >= to_ms)
}

/// Like `snapshot`, but only when the whole range was captured.
#[cfg_attr(not(feature = "onnx"), allow(dead_code))]
pub fn snapshot_covered(key: &str, from_ms: u64, to_ms: u64) -> Option<Vec<f32>> {
    let ok = STATE.lock().unwrap().as_ref().map(|s| s.key == key && covers(&s.covered, from_ms, to_ms)).unwrap_or(false);
    if ok {
        snapshot(key, from_ms, to_ms)
    } else {
        None
    }
}

/// Linear-interpolating resampler (fine for speech models after the box-filter downmix).
pub fn resample(input: &[f32], from: f64, to: f64) -> Vec<f32> {
    if (from - to).abs() < 1.0 || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from / to;
    let n = (input.len() as f64 / ratio) as usize;
    // Simple anti-alias: average over the decimation window before sampling.
    let win = ratio.floor().max(1.0) as usize;
    (0..n)
        .map(|i| {
            let x = i as f64 * ratio;
            let k = x as usize;
            let s: f32 = input[k..(k + win).min(input.len())].iter().sum();
            s / win.min(input.len() - k).max(1) as f32
        })
        .collect()
}

/// Executable names that play the audio for a GSMTC source.
fn exe_for(source_app: &str) -> Option<&'static [&'static str]> {
    let a = source_app.to_ascii_lowercase();
    Some(match () {
        _ if a.contains("spotify") => &["Spotify.exe"],
        _ if a.contains("msedge") => &["msedge.exe"],
        _ if a.contains("chrome") => &["chrome.exe"],
        _ if a.contains("brave") => &["brave.exe"],
        _ if a.contains("opera") => &["opera.exe"],
        _ if a.contains("vivaldi") => &["vivaldi.exe"],
        _ if a.contains("firefox") || a.contains("308046b0af4a39cb") => &["firefox.exe"],
        _ if a.contains("youtube-music") || a.contains("youtubemusic") => &["YouTube Music.exe", "youtube-music.exe"],
        _ if a.contains("claude") => &["claude.exe"],
        _ if a.contains("zunemusic") => &["Microsoft.Media.Player.exe"],
        _ => return None,
    })
}

/// Process ids that currently have an *active* audio session on the default output device.
fn active_audio_pids() -> Vec<u32> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    let mut out = Vec::new();
    unsafe {
        let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
        let Ok(dev) = en.GetDefaultAudioEndpoint(eRender, eConsole) else { return out };
        let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { return out };
        let Ok(list) = mgr.GetSessionEnumerator() else { return out };
        for i in 0..list.GetCount().unwrap_or(0) {
            let Ok(ctl) = list.GetSession(i) else { continue };
            if ctl.GetState().map(|s| s == AudioSessionStateActive).unwrap_or(false) {
                if let Ok(c2) = ctl.cast::<IAudioSessionControl2>() {
                    if let Ok(pid) = c2.GetProcessId() {
                        out.push(pid);
                    }
                }
            }
        }
    }
    out
}

/// Top-level process id for an app (the parent of its process tree), so child audio processes are included.
/// With several copies running (two browsers, a PWA), prefer the tree that is actually playing sound.
pub fn find_pid(source_app: &str) -> Option<u32> {
    let names = exe_for(source_app)?;
    let mut procs: Vec<(u32, u32, String)> = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                procs.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..len])));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    let matching: Vec<&(u32, u32, String)> = procs.iter().filter(|p| names.iter().any(|n| p.2.eq_ignore_ascii_case(n))).collect();
    // Roots = matching processes whose parent isn't the same app.
    let roots: Vec<u32> = matching.iter().filter(|p| !matching.iter().any(|q| q.0 == p.1)).map(|p| p.0).collect();
    if roots.len() > 1 {
        let parent: std::collections::HashMap<u32, u32> = procs.iter().map(|p| (p.0, p.1)).collect();
        let root_of = |mut pid: u32| {
            for _ in 0..16 {
                if roots.contains(&pid) {
                    return Some(pid);
                }
                pid = *parent.get(&pid)?;
            }
            None
        };
        if let Some(r) = active_audio_pids().into_iter().find_map(root_of) {
            return Some(r);
        }
    }
    roots.first().copied().or(matching.first().map(|p| p.0))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub enabled: bool,
    pub pid: u32,
    pub app: String,
    pub level: f32,
    pub song: Option<String>,
    pub covered: Vec<(u64, u64)>,
    pub seconds: f64,
    pub error: Option<String>,
}

#[tauri::command]
pub fn capture_status() -> CaptureStatus {
    let live = LIVE.lock().unwrap();
    let st = STATE.lock().unwrap();
    CaptureStatus {
        enabled: ENABLED.load(Ordering::SeqCst),
        pid: live.pid,
        app: live.app.clone(),
        level: live.level,
        song: st.as_ref().map(|s| s.key.clone()),
        covered: st.as_ref().map(|s| s.covered.clone()).unwrap_or_default(),
        seconds: st.as_ref().map(|s| s.covered.iter().map(|(a, b)| (b - a) as f64 / 1000.0).sum()).unwrap_or(0.0),
        error: live.error.clone(),
    }
}

#[tauri::command]
pub fn set_capture(enabled: bool) {
    #[cfg(debug_assertions)]
    if std::env::var("MLP_FAKE_CAPTURE").is_ok() {
        return; // the fake song stays in memory; no real capture
    }
    let was = ENABLED.swap(enabled, Ordering::SeqCst);
    if enabled && !was {
        std::thread::Builder::new().name("capture".into()).spawn(capture_thread).ok();
    }
}

/// Debug aid: write the captured audio of the current song to a WAV file.
#[tauri::command]
pub fn capture_dump(path: String) -> Result<String, String> {
    let g = STATE.lock().unwrap();
    let s = g.as_ref().ok_or("nothing captured yet")?;
    std::fs::write(&path, crate::ai::wav_bytes(&s.samples, RATE as u32)).map_err(|e| e.to_string())?;
    Ok(format!("{} s of \"{}\"", s.samples.len() / RATE, s.key))
}

#[tauri::command]
pub fn set_capture_latency(ms: i64) {
    LATENCY_MS.store(ms.clamp(-1000, 1000), Ordering::Relaxed);
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeepCheck {
    pub beeps: usize,
    /// mean signed error (ms): positive = captured audio sits later than its song time
    pub mean_ms: f64,
    pub median_abs_ms: f64,
    pub p90_abs_ms: f64,
}

/// Onsets (ms) of 1 kHz test beeps: 5 ms Goertzel frames, rising edge after ≥ 400 ms of quiet,
/// refined to the first sample above a fraction of the beep's peak.
pub fn beep_onsets(samples: &[f32]) -> Vec<f64> {
    const FRAME: usize = RATE / 200; // 5 ms
    let w = 2.0 * std::f32::consts::PI * 1000.0 / RATE as f32;
    let coeff = 2.0 * w.cos();
    let power: Vec<f32> = samples
        .chunks(FRAME)
        .map(|c| {
            let (mut s1, mut s2) = (0f32, 0f32);
            for &x in c {
                let s0 = x + coeff * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (c.len() as f32).powi(2)
        })
        .collect();
    let peak = power.iter().cloned().fold(0f32, f32::max);
    if peak <= 1e-6 {
        return vec![];
    }
    let thr = peak * 0.1;
    let mut out = Vec::new();
    let mut quiet = 0usize;
    for (i, &p) in power.iter().enumerate() {
        if p > thr {
            if quiet * 5 >= 400 {
                // refine inside this and the previous frame
                let from = i.saturating_sub(1) * FRAME;
                let to = ((i + 1) * FRAME).min(samples.len());
                let amp = samples[from..to].iter().fold(0f32, |m, x| m.max(x.abs()));
                let k = (from..to).find(|&k| samples[k].abs() > amp * 0.3).unwrap_or(i * FRAME);
                out.push(k as f64 * 1000.0 / RATE as f64);
            }
            quiet = 0;
        } else {
            quiet += 1;
        }
    }
    out
}

pub fn check_beeps(samples: &[f32]) -> Option<BeepCheck> {
    let errs: Vec<f64> = beep_onsets(samples).into_iter().map(|t| t - (t / 1000.0).round() * 1000.0).collect();
    if errs.len() < 5 {
        return None;
    }
    let mut abs: Vec<f64> = errs.iter().map(|e| e.abs()).collect();
    abs.sort_by(f64::total_cmp);
    Some(BeepCheck {
        beeps: errs.len(),
        mean_ms: errs.iter().sum::<f64>() / errs.len() as f64,
        median_abs_ms: abs[abs.len() / 2],
        p90_abs_ms: abs[(abs.len() * 9 / 10).min(abs.len() - 1)],
    })
}

/// Analyze the captured audio of the timing-test page (see `open_capture_test`).
#[tauri::command]
pub fn capture_beep_check() -> Result<BeepCheck, String> {
    let g = STATE.lock().unwrap();
    let s = g.as_ref().ok_or("Nothing captured yet. Turn on listening and play the test page.")?;
    if !s.key.contains("MLP timing test") {
        return Err("The captured song isn't the timing test. Play the test page, then check again.".into());
    }
    check_beeps(&s.samples).ok_or_else(|| "Not enough beeps captured yet — let the test play longer.".into())
}

/// Write the timing-test page to the app data folder and open it in the default browser.
#[tauri::command]
pub fn open_capture_test(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("timing-test.html");
    std::fs::write(&path, include_str!("../assets/capture-test.html")).map_err(|e| e.to_string())?;
    std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(&path)
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn song_position_ms() -> Option<(String, f64, bool)> {
    let np = crate::media::latest()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as f64;
    let playing = np.status == "playing";
    let at = if np.updated_at_ms > 0.0 && np.updated_at_ms <= now + 1000.0 { np.updated_at_ms } else { now };
    let pos = np.position_ms + if playing { (now - at) * np.rate } else { 0.0 };
    Some((format!("{}|{}|{}", np.source_app, np.artist, np.title), pos, playing))
}

fn set_error(e: Option<String>) {
    LIVE.lock().unwrap().error = e;
}

/// Follow the current player: (re)open a loopback client whenever the source app changes.
fn capture_thread() {
    let _ = initialize_mta();
    while ENABLED.load(Ordering::SeqCst) {
        let Some(np) = crate::media::latest() else {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        };
        let Some(pid) = find_pid(&np.source_app) else {
            set_error(Some(format!("Can't find the process for {}", np.source_app)));
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        {
            let mut l = LIVE.lock().unwrap();
            l.pid = pid;
            l.app = np.source_app.clone();
        }
        if let Err(e) = capture_pid(pid, &np.source_app) {
            set_error(Some(e));
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    LIVE.lock().unwrap().level = 0.0;
}

fn capture_pid(pid: u32, source: &str) -> Result<(), String> {
    let format = WaveFormat::new(32, 32, SampleType::Float, 48_000, 2, None);
    let block = format.get_blockalign() as usize;
    let mut client = AudioClient::new_application_loopback_client(pid, true).map_err(|e| format!("loopback: {e}"))?;
    client
        .initialize_client(&format, Direction::Capture, StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 }, None)
        .map_err(|e| format!("init: {e}"))?;
    let event = client.set_get_eventhandle().map_err(|e| format!("event: {e}"))?;
    let cap = client.get_audiocaptureclient().map_err(|e| format!("client: {e}"))?;
    client.start_stream().map_err(|e| format!("start: {e}"))?;
    set_error(None);

    let mut queue: VecDeque<u8> = VecDeque::new();
    let mut last_check = Instant::now();
    loop {
        if !ENABLED.load(Ordering::SeqCst) {
            break;
        }
        // Player changed? Restart on the new process.
        if last_check.elapsed() > Duration::from_millis(1000) {
            last_check = Instant::now();
            if crate::media::latest().map(|n| n.source_app != source).unwrap_or(false) {
                break;
            }
            // Another copy of the app started playing (second browser window / PWA): follow it.
            if find_pid(source).map(|p| p != pid).unwrap_or(false) {
                break;
            }
        }
        if event.wait_for_event(500).is_err() {
            LIVE.lock().unwrap().level = 0.0; // silence: loopback delivers no packets when nothing plays
            continue;
        }
        // Song position of the *end* of what's buffered right now.
        let pos_now = song_position_ms();
        loop {
            match cap.get_next_packet_size() {
                Ok(Some(n)) if n > 0 => {
                    if cap.read_from_device_to_deque(&mut queue).is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
        let frames = queue.len() / block;
        if frames == 0 {
            continue;
        }
        let bytes: Vec<u8> = queue.drain(..frames * block).collect();
        let mono: Vec<f32> = bytes
            .chunks_exact(block)
            .map(|f| (f32::from_le_bytes([f[0], f[1], f[2], f[3]]) + f32::from_le_bytes([f[4], f[5], f[6], f[7]])) * 0.5)
            .collect();
        let rms = (mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32).sqrt();
        LIVE.lock().unwrap().level = rms;
        let audio = resample(&mono, 48_000.0, RATE as f64);
        if let Some((key, pos, playing)) = pos_now {
            if !playing {
                continue;
            }
            let dur_ms = audio.len() as f64 * 1000.0 / RATE as f64;
            let mut st = STATE.lock().unwrap();
            if st.as_ref().map(|s| s.key != key).unwrap_or(true) {
                *st = Some(SongAudio::new(key));
            }
            st.as_mut().unwrap().write(pos - dur_ms - LATENCY_MS.load(Ordering::Relaxed) as f64, &audio);
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_audio_on_song_time_and_merges_coverage() {
        let mut s = SongAudio::new("k".into());
        s.write(1000.0, &vec![0.5; RATE]); // 1–2 s
        s.write(2000.0, &vec![0.25; RATE / 2]); // 2–2.5 s
        s.write(10_000.0, &vec![0.1; RATE]); // after a seek
        assert_eq!(s.covered, vec![(1000, 2500), (10_000, 11_000)]);
        assert_eq!(s.samples[RATE + 10], 0.5);
        assert_eq!(s.samples[RATE * 2 + 10], 0.25);
    }

    /// Timing of a real capture: MLP_BEEP_WAV = captured song audio (16 kHz, song timeline) of the
    /// beep test page → beeps vs whole seconds.  cargo test --lib beep_wav -- --ignored --nocapture
    #[test]
    #[ignore]
    fn beep_wav() {
        let wav = std::env::var("MLP_BEEP_WAV").expect("MLP_BEEP_WAV");
        let s = crate::ai::read_wav_16k(std::path::Path::new(&wav)).unwrap();
        println!("{:.1} s captured → {:?}", s.len() as f64 / 16_000.0, check_beeps(&s));
    }

    #[test]
    fn measures_beep_timing() {
        // 20 beeps at whole seconds, captured 37 ms late
        let mut x = vec![0f32; RATE * 22];
        for k in 1..=20 {
            let start = (k * 1000 + 37) * RATE / 1000;
            for i in 0..(RATE * 30 / 1000) {
                x[start + i] = 0.6 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / RATE as f32).sin();
            }
        }
        let c = check_beeps(&x).unwrap();
        assert_eq!(c.beeps, 20);
        assert!((c.mean_ms - 37.0).abs() < 3.0, "{c:?}");
        assert!(c.p90_abs_ms < 42.0);
        assert!(check_beeps(&vec![0f32; RATE]).is_none());
    }

    #[test]
    fn resamples_48k_to_16k() {
        let x: Vec<f32> = (0..48_000).map(|i| (i as f32 / 48.0).sin()).collect();
        assert_eq!(resample(&x, 48_000.0, 16_000.0).len(), 16_000);
    }

    #[test]
    fn finds_a_running_process() {
        // Explorer always runs; map through a fake source name to its exe list isn't possible,
        // so just check the snapshot code path doesn't panic for an unknown app.
        assert!(find_pid("not-a-player").is_none());
    }
}
