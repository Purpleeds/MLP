//! "Train on my songs": training clips + the on-PC Whisper fine-tune.
//!
//! Clips: while a song with synced lyrics plays, the UI hands over the labels (`training_arm`); when
//! the capture moves to another song (or the UI calls `training_flush`) the song's captured audio is
//! written as `<training dir>/songs/<title> - <artist> [id]/audio.wav` (16 kHz mono) + `song.json`.
//! A later play of the same capture fills in parts that weren't captured before.
//!
//! Training: a Python environment in `<training dir>/env` (made once with uv, PyTorch CUDA 12.8) runs
//! the embedded `training/mlp_train.py`, which prints JSON lines → `training-progress` events. The
//! tuned model is only used when it beat the original on held-out songs (`models/current.json`).

use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const TRAINER_PY: &str = include_str!("../../training/mlp_train.py");
const REQUIREMENTS: &str = include_str!("../../training/requirements.txt");
const TORCH_INDEX: &str = "https://download.pytorch.org/whl/cu128";
/// Less captured than this: not worth keeping.
const MIN_COVERED_MS: u64 = 45_000;
const FOLDER: &str = "MLP training";

struct Armed {
    key: String,
    dir: PathBuf,
    meta: Value,
}
static ARMED: Mutex<Vec<Armed>> = Mutex::new(Vec::new());

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub kind: String,
    pub running: bool,
    pub started_unix: u64,
    pub elapsed_s: u64,
    /// last JSON event from the trainer
    pub last: Option<Value>,
    pub stage: Option<Value>,
    pub log: Vec<String>,
    pub exit: Option<i32>,
    pub error: Option<String>,
}

struct Job {
    info: JobInfo,
    child: Option<Child>,
    started: Instant,
    stop: bool,
}
static JOB: Mutex<Option<Job>> = Mutex::new(None);

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------------------------------------------------------------- folders
/// The training folder: the setting, else an existing "MLP training" folder on a fixed drive, else
/// the roomiest fixed drive that isn't the system drive (≥ 30 GB free), else the app-data folder.
pub fn resolve_dir(app: &AppHandle, dir: &str) -> PathBuf {
    let d = dir.trim();
    if !d.is_empty() {
        return PathBuf::from(d);
    }
    default_dir().unwrap_or_else(|| crate::ai::ai_dir(app).join("training"))
}

#[cfg(windows)]
fn default_dir() -> Option<PathBuf> {
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives};
    use windows::core::HSTRING;
    const DRIVE_FIXED: u32 = 3;
    let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()).to_uppercase();
    let mask = unsafe { GetLogicalDrives() };
    let mut best: Option<(u64, PathBuf)> = None;
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let root = format!("{}:\\", (b'A' + i as u8) as char);
        if unsafe { GetDriveTypeW(&HSTRING::from(root.as_str())) } != DRIVE_FIXED {
            continue;
        }
        let folder = PathBuf::from(&root).join(FOLDER);
        if folder.is_dir() {
            return Some(folder); // already in use: never move it
        }
        if root.to_uppercase().starts_with(&system) {
            continue;
        }
        let mut free = 0u64;
        if unsafe { GetDiskFreeSpaceExW(&HSTRING::from(root.as_str()), Some(&mut free as *mut u64), None, None) }.is_ok()
            && free >= 30 << 30
            && best.as_ref().is_none_or(|(f, _)| free > *f)
        {
            best = Some((free, folder));
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(not(windows))]
fn default_dir() -> Option<PathBuf> {
    None
}

/// "<title> - <artist> [8 hex of the capture key]", safe as a folder name.
pub fn clip_folder(title: &str, artist: &str, key: &str) -> String {
    use sha2::{Digest, Sha256};
    let clean = |s: &str| -> String {
        let t: String = s.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c }).collect();
        let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
        t.trim_matches(|c| c == '.' || c == ' ').chars().take(60).collect()
    };
    let h = hex::encode(&Sha256::digest(key.as_bytes())[..4]);
    let (t, a) = (clean(title), clean(artist));
    let name = match (t.is_empty(), a.is_empty()) {
        (false, false) => format!("{t} - {a}"),
        (false, true) => t,
        (true, false) => a,
        _ => "song".into(),
    };
    format!("{name} [{h}]")
}

// ---------------------------------------------------------------- clips
/// Union of sorted ranges (ms), merging ranges that touch (40 ms slack).
pub fn union(mut r: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    r.sort_unstable();
    let mut out: Vec<(u64, u64)> = Vec::new();
    for (a, b) in r {
        match out.last_mut() {
            Some(l) if a <= l.1 + 40 => l.1 = l.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

const RATE: usize = 16_000;

/// Copy the covered parts of `new` over `old` (both 16 kHz mono on song time).
pub fn merge_audio(mut old: Vec<f32>, new: &[f32], covered: &[(u64, u64)]) -> Vec<f32> {
    if old.len() < new.len() {
        old.resize(new.len(), 0.0);
    }
    for &(a, b) in covered {
        let (a, b) = ((a as usize * RATE / 1000).min(new.len()), (b as usize * RATE / 1000).min(new.len()));
        old[a..b].copy_from_slice(&new[a..b]);
    }
    old
}

fn write_clip(armed: &Armed, samples: &[f32], covered: &[(u64, u64)]) -> Result<PathBuf, String> {
    let s = |k: &str| armed.meta.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let dir = armed.dir.join("songs").join(clip_folder(&s("title"), &s("artist"), &armed.key));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let (wav, meta_p) = (dir.join("audio.wav"), dir.join("song.json"));
    // Same capture played before: keep what was there and add the newly captured parts.
    let old_cov: Vec<(u64, u64)> = std::fs::read_to_string(&meta_p)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|m| serde_json::from_value(m.get("covered")?.clone()).ok())
        .unwrap_or_default();
    let (audio, cov) = match crate::ai::read_wav_16k(&wav) {
        Ok(old) if !old_cov.is_empty() => (merge_audio(old, samples, covered), union([old_cov, covered.to_vec()].concat())),
        _ => (samples.to_vec(), covered.to_vec()),
    };
    let total: u64 = cov.iter().map(|(a, b)| b - a).sum();
    if total < MIN_COVERED_MS {
        return Err(format!("only {} s captured", total / 1000));
    }
    let mut meta = armed.meta.clone();
    meta["captureKey"] = armed.key.clone().into();
    meta["covered"] = serde_json::to_value(&cov).unwrap_or_default();
    meta["savedUnix"] = now_unix().into();
    let tmp = dir.join("audio.wav.tmp");
    std::fs::write(&tmp, crate::ai::wav_bytes(&audio, RATE as u32)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &wav).map_err(|e| e.to_string())?;
    std::fs::write(&meta_p, serde_json::to_string_pretty(&meta).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn take_armed(key: &str) -> Option<Armed> {
    let mut g = ARMED.lock().unwrap();
    let i = g.iter().position(|a| a.key == key)?;
    Some(g.remove(i))
}

fn save_in_background(armed: Armed, samples: Vec<f32>, covered: Vec<(u64, u64)>) {
    std::thread::Builder::new()
        .name("training-clip".into())
        .spawn(move || match write_clip(&armed, &samples, &covered) {
            Ok(d) => eprintln!("[training] saved {}", d.display()),
            Err(e) => eprintln!("[training] not saved ({}): {e}", armed.key),
        })
        .ok();
}

/// Capture thread: the song in memory is being replaced. Write it if the UI armed it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn on_song_replaced(key: &str, samples: Vec<f32>, covered: Vec<(u64, u64)>) {
    if let Some(a) = take_armed(key) {
        save_in_background(a, samples, covered);
    }
}

/// UI: this song (capture key) may be kept as a training clip; `meta` = lyrics labels (latest wins).
#[tauri::command]
pub fn training_arm(app: AppHandle, dir: String, key: String, meta: Value) {
    let dir = resolve_dir(&app, &dir);
    let mut g = ARMED.lock().unwrap();
    g.retain(|a| a.key != key);
    g.push(Armed { key, dir, meta });
    let n = g.len();
    if n > 4 {
        g.drain(..n - 4);
    }
}

/// UI: the song's view went away (song ended / changed): write it now if it's still in memory.
#[tauri::command]
pub fn training_flush(key: String) {
    let Some((cur, covered)) = crate::capture::current() else { return };
    if cur != key {
        return; // already replaced: the capture thread wrote it
    }
    let Some(samples) = crate::capture::snapshot(&key, 0, 86_400_000) else { return };
    if let Some(a) = take_armed(&key) {
        save_in_background(a, samples, covered);
    }
}

// ---------------------------------------------------------------- info
fn env_python(dir: &Path) -> PathBuf {
    if cfg!(windows) { dir.join("env").join("Scripts").join("python.exe") } else { dir.join("env").join("bin").join("python") }
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingInfo {
    dir: String,
    songs: u32,
    audio_hours: f64,
    trusted_lines: u32,
    held_out: u32,
    bytes: u64,
    env_ready: bool,
    uv: Option<String>,
    job: Option<JobInfo>,
    last_result: Option<Value>,
    model: Option<Value>,
}

#[tauri::command]
pub async fn training_info(app: AppHandle, dir: String) -> TrainingInfo {
    let d = resolve_dir(&app, &dir);
    let held: Vec<String> = read_json(&d.join("split.json"))
        .and_then(|v| serde_json::from_value(v.get("heldOut")?.clone()).ok())
        .unwrap_or_default();
    let (mut songs, mut ms, mut lines, mut held_n, mut bytes) = (0u32, 0u64, 0u32, 0u32, 0u64);
    for e in std::fs::read_dir(d.join("songs")).into_iter().flatten().flatten() {
        let Some(m) = read_json(&e.path().join("song.json")) else { continue };
        songs += 1;
        bytes += std::fs::metadata(e.path().join("audio.wav")).map(|m| m.len()).unwrap_or(0);
        ms += m["covered"].as_array().into_iter().flatten().filter_map(|r| Some(r[1].as_u64()? - r[0].as_u64()?)).sum::<u64>();
        lines += m["lines"].as_array().into_iter().flatten().filter(|l| l["trusted"].as_bool() == Some(true)).count() as u32;
        if m["songKey"].as_str().is_some_and(|k| held.iter().any(|h| h == k)) {
            held_n += 1;
        }
    }
    TrainingInfo {
        dir: d.display().to_string(),
        songs,
        audio_hours: ms as f64 / 3_600_000.0,
        trusted_lines: lines,
        held_out: held_n,
        bytes,
        env_ready: env_python(&d).is_file() && d.join("env").join(".mlp-ready").is_file(),
        uv: find_uv().map(|p| p.display().to_string()),
        job: training_status(),
        last_result: read_json(&d.join("last-result.json")),
        model: read_json(&d.join("models").join("current.json")),
    }
}

/// The adopted tuned model (beat the original on held-out songs), if its file is there.
#[tauri::command]
pub fn training_model(app: AppHandle, dir: String) -> Option<Value> {
    let cur = read_json(&resolve_dir(&app, &dir).join("models").join("current.json"))?;
    let path = cur["path"].as_str()?;
    (cur["adopted"].as_bool() == Some(true) && Path::new(path).is_file()).then_some(cur)
}

#[tauri::command]
pub fn training_open_folder(app: AppHandle, dir: String) -> Result<String, String> {
    let d = resolve_dir(&app, &dir);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    Command::new("explorer").arg(&d).spawn().map_err(|e| e.to_string())?;
    Ok(d.display().to_string())
}

// ---------------------------------------------------------------- jobs
fn find_uv() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "uv.exe" } else { "uv" };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .chain(std::env::var_os("USERPROFILE").or(std::env::var_os("HOME")).map(|h| PathBuf::from(h).join(".local").join("bin")))
        .map(|d| d.join(exe))
        .find(|p| p.is_file())
}

#[tauri::command]
pub fn training_status() -> Option<JobInfo> {
    let mut g = JOB.lock().unwrap();
    let j = g.as_mut()?;
    if j.info.running {
        j.info.elapsed_s = j.started.elapsed().as_secs();
    }
    Some(j.info.clone())
}

#[tauri::command]
pub fn training_stop() {
    if let Some(j) = JOB.lock().unwrap().as_mut() {
        j.stop = true;
        if let Some(c) = j.child.as_mut() {
            let _ = c.kill();
        }
    }
}

fn job_busy() -> bool {
    JOB.lock().unwrap().as_ref().is_some_and(|j| j.info.running)
}

fn begin(kind: &str) -> Result<(), String> {
    let mut g = JOB.lock().unwrap();
    if g.as_ref().is_some_and(|j| j.info.running) {
        return Err("training is already running".into());
    }
    *g = Some(Job {
        info: JobInfo { kind: kind.into(), running: true, started_unix: now_unix(), ..Default::default() },
        child: None,
        started: Instant::now(),
        stop: false,
    });
    Ok(())
}

fn push_log(app: &AppHandle, line: &str) {
    let mut g = JOB.lock().unwrap();
    let Some(j) = g.as_mut() else { return };
    if let Ok(v) = serde_json::from_str::<Value>(line) {
        if v.get("event").and_then(Value::as_str) == Some("log") {
            j.info.log.push(v["message"].as_str().unwrap_or("").to_string());
        } else {
            if v.get("event").and_then(Value::as_str) == Some("stage") {
                j.info.stage = Some(v.clone());
            }
            if v.get("event").and_then(Value::as_str) == Some("error") {
                j.info.error = v["message"].as_str().map(String::from);
            }
            j.info.last = Some(v);
        }
    } else if !line.trim().is_empty() {
        j.info.log.push(line.chars().take(400).collect());
    }
    let n = j.info.log.len();
    if n > 200 {
        j.info.log.drain(..n - 200);
    }
    j.info.elapsed_s = j.started.elapsed().as_secs();
    let _ = app.emit("training-progress", j.info.clone());
}

fn finish(app: &AppHandle, exit: Option<i32>, error: Option<String>) {
    let mut g = JOB.lock().unwrap();
    if let Some(j) = g.as_mut() {
        j.info.running = false;
        j.info.exit = exit;
        if error.is_some() {
            j.info.error = error;
        } else if j.stop {
            j.info.error = Some("stopped".into());
        }
        j.child = None;
        let _ = app.emit("training-progress", j.info.clone());
    }
}

/// Run one command as the job's current step; stdout + stderr lines go to the log. Ok(exit code).
fn run_step(app: &AppHandle, mut cmd: Command, hard_limit: Option<Duration>) -> Result<i32, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1").stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start {:?}: {e}", cmd.get_program()))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    {
        let mut g = JOB.lock().unwrap();
        let j = g.as_mut().ok_or("no job")?;
        if j.stop {
            let _ = child.kill();
            return Err("stopped".into());
        }
        j.child = Some(child);
    }
    let a2 = app.clone();
    let t_err = std::thread::spawn(move || {
        for l in BufReader::new(err.unwrap()).lines().map_while(Result::ok) {
            // PyTorch / transformers warnings: keep them in the log only
            push_log(&a2, &l);
        }
    });
    let started = Instant::now();
    let a3 = app.clone();
    let t_out = std::thread::spawn(move || {
        for l in BufReader::new(out.unwrap()).lines().map_while(Result::ok) {
            push_log(&a3, &l);
        }
    });
    // Wait, enforcing the hard time limit.
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let mut g = JOB.lock().unwrap();
        let Some(j) = g.as_mut() else { return Err("no job".into()) };
        let Some(c) = j.child.as_mut() else { return Err("stopped".into()) };
        if let Ok(Some(st)) = c.try_wait() {
            drop(g);
            let _ = t_out.join();
            let _ = t_err.join();
            return Ok(st.code().unwrap_or(-1));
        }
        if hard_limit.is_some_and(|l| started.elapsed() > l) {
            let _ = c.kill();
            j.stop = true;
            return Err("hit the time limit".into());
        }
    }
}

/// Make the Python environment (once): uv venv (Python 3.12) + PyTorch CUDA 12.8 + the trainer's packages.
#[tauri::command]
pub fn training_setup(app: AppHandle, dir: String) -> Result<(), String> {
    let d = resolve_dir(&app, &dir);
    let uv = find_uv().ok_or("uv isn't installed. Install it once with: winget install astral-sh.uv (then try again).")?;
    begin("setup")?;
    std::thread::spawn(move || {
        let res = (|| -> Result<(), String> {
            std::fs::create_dir_all(d.join("trainer")).map_err(|e| e.to_string())?;
            let req = d.join("trainer").join("requirements.txt");
            std::fs::write(&req, REQUIREMENTS).map_err(|e| e.to_string())?;
            let env = d.join("env");
            let py = env_python(&d);
            let step = |args: Vec<String>| -> Result<(), String> {
                push_log(&app, &format!("> uv {}", args.join(" ")));
                let mut c = Command::new(&uv);
                c.args(&args).current_dir(&d).env("UV_CACHE_DIR", d.join("uv-cache"));
                match run_step(&app, c, None)? {
                    0 => Ok(()),
                    n => Err(format!("uv {} failed ({n})", args.first().map(String::as_str).unwrap_or(""))),
                }
            };
            if !py.is_file() {
                step(vec!["venv".into(), "--python".into(), "3.12".into(), env.display().to_string()])?;
            }
            let p = py.display().to_string();
            step(vec!["pip".into(), "install".into(), "--python".into(), p.clone(), "torch".into(), "--index-url".into(), TORCH_INDEX.into()])?;
            step(vec!["pip".into(), "install".into(), "--python".into(), p, "-r".into(), req.display().to_string()])?;
            std::fs::write(env.join(".mlp-ready"), now_unix().to_string()).map_err(|e| e.to_string())
        })();
        match res {
            Ok(()) => finish(&app, Some(0), None),
            Err(e) => finish(&app, None, Some(e)),
        }
    });
    Ok(())
}

/// Train (or with `smoke`: a few steps to check the pipeline, never used). `max_hours` is capped at 5.
#[tauri::command]
pub fn training_start(app: AppHandle, dir: String, max_hours: f64, smoke: bool) -> Result<(), String> {
    let d = resolve_dir(&app, &dir);
    let py = env_python(&d);
    if !py.is_file() {
        return Err("Set up the trainer first.".into());
    }
    if job_busy() {
        return Err("training is already running".into());
    }
    let hours = max_hours.clamp(0.25, 5.0);
    let script = d.join("trainer").join("mlp_train.py");
    std::fs::create_dir_all(script.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&script, TRAINER_PY).map_err(|e| e.to_string())?;
    let quantize = crate::ai::whisper_tool(&app, "whisper-quantize.exe");
    begin(if smoke { "smoke" } else { "train" })?;
    std::thread::spawn(move || {
        let mut c = Command::new(&py);
        c.arg("-u").arg(&script).arg("run").arg("--data").arg(&d).arg("--max-hours").arg(hours.to_string());
        if smoke {
            c.arg("--smoke");
        }
        if let Some(q) = quantize {
            c.arg("--quantize").arg(q);
        }
        c.current_dir(&d).env("HF_HOME", d.join("hf-cache")).env("HF_HUB_DISABLE_TELEMETRY", "1");
        // The trainer stops itself in time; this is only the backstop.
        match run_step(&app, c, Some(Duration::from_secs_f64(hours * 3600.0 + 1800.0))) {
            Ok(code) => finish(&app, Some(code), None),
            Err(e) => finish(&app, None, Some(e)),
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_are_safe_and_stable() {
        let a = clip_folder("What? / Why: \"now\"", "AC/DC", "Spotify.exe|AC/DC|What?");
        assert!(!a.chars().any(|c| r#"<>:"/\|?*"#.contains(c)), "{a}");
        assert_eq!(a, clip_folder("What? / Why: \"now\"", "AC/DC", "Spotify.exe|AC/DC|What?"));
        assert_ne!(a, clip_folder("What? / Why: \"now\"", "AC/DC", "msedge.exe|AC/DC|What?"));
        assert!(clip_folder("", "", "k").starts_with("song ["));
    }

    #[test]
    fn later_plays_fill_in_missing_parts() {
        let old = vec![1.0f32; 16_000]; // 1 s, all captured before
        let new = vec![0.5f32; 32_000]; // 2 s, only the second second captured now
        let merged = merge_audio(old, &new, &[(1000, 2000)]);
        assert_eq!(merged.len(), 32_000);
        assert_eq!(merged[100], 1.0);
        assert_eq!(merged[20_000], 0.5);
        assert_eq!(union(vec![(1000, 2000), (0, 1000), (5000, 6000)]), vec![(0, 2000), (5000, 6000)]);
    }

    #[test]
    fn short_captures_are_not_kept() {
        let tmp = std::env::temp_dir().join(format!("mlp-train-test-{}", now_unix()));
        let a = Armed { key: "k".into(), dir: tmp.clone(), meta: serde_json::json!({ "title": "T", "artist": "A" }) };
        assert!(write_clip(&a, &vec![0.1; 16_000 * 10], &[(0, 10_000)]).is_err());
        let d = write_clip(&a, &vec![0.1; 16_000 * 50], &[(0, 50_000)]).unwrap();
        let m: Value = serde_json::from_str(&std::fs::read_to_string(d.join("song.json")).unwrap()).unwrap();
        assert_eq!(m["covered"], serde_json::json!([[0, 50_000]]));
        // played again, further: coverage grows
        write_clip(&a, &vec![0.2; 16_000 * 60], &[(40_000, 60_000)]).unwrap();
        let m: Value = serde_json::from_str(&std::fs::read_to_string(d.join("song.json")).unwrap()).unwrap();
        assert_eq!(m["covered"], serde_json::json!([[0, 60_000]]));
        let _ = std::fs::remove_dir_all(tmp);
    }
}
