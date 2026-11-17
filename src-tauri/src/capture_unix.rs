//! Player audio capture on macOS / Linux (Upgrade 21): not available yet — per-app loopback capture
//! is Windows-only (WASAPI process loopback). Same API as capture.rs so the rest of the app builds;
//! the song buffer helpers are shared logic (copied) so vocals / AI code compile unchanged.
#![allow(dead_code)]

use serde::Serialize;
use std::sync::Mutex;

pub const RATE: usize = 16_000;
const MAX_SONG_MS: usize = 15 * 60 * 1000;

static STATE: Mutex<Option<SongAudio>> = Mutex::new(None);
const UNSUPPORTED: &str = "Listening to the player is only available on Windows for now.";

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

#[derive(Serialize, Default)]
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
    CaptureStatus { error: Some(UNSUPPORTED.into()), ..Default::default() }
}

#[tauri::command]
pub fn set_capture(_enabled: bool) {}

#[tauri::command]
pub fn capture_dump(_path: String) -> Result<String, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn set_capture_latency(_ms: i64) {}

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
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn open_capture_test(_app: tauri::AppHandle) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

