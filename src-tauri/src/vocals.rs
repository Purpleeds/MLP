#![cfg_attr(not(feature = "onnx"), allow(dead_code))]
//! Step 14 — vocal isolation. HT-Demucs FT (vocals specialist, ONNX, MIT) separates the singing from
//! the captured player audio (CPU by default — see `gpu_session` for the GPU story). It runs in the background on whatever
//! part of the song has been captured, in blocks with overlap, and keeps the result on the same
//! song timeline as the capture (16 kHz mono). Only built with the `onnx` Cargo feature.

use serde::Serialize;

/// Model I/O (see the model card): stereo 44.1 kHz, 7.8 s segments, stems [drums, bass, other, vocals].
pub const MODEL_RATE: usize = 44_100;
pub const SEGMENT: usize = 343_980;
pub const VOCALS_STEM: usize = 3;

/// Overlap-add weights for one segment: linear fade over the first and last quarter.
pub fn transition_window(len: usize) -> Vec<f32> {
    let t = len / 4;
    (0..len)
        .map(|i| {
            if i < t {
                i as f32 / (t - 1).max(1) as f32
            } else if i >= len - t {
                (len - 1 - i) as f32 / (t - 1).max(1) as f32
            } else {
                1.0
            }
        })
        .collect()
}

/// Chunk boundaries (start, end) for overlap-add over `total` samples (stride = 3/4 segment).
pub fn chunks(total: usize, seg: usize) -> Vec<(usize, usize)> {
    let stride = seg - seg / 4;
    let n = total.div_ceil(stride).max(1);
    (0..n).map(|i| (i * stride, (i * stride + seg).min(total))).filter(|(a, b)| a < b).collect()
}

/// Linear-interpolation resampler (used for 16 kHz ↔ 44.1 kHz around the separator).
pub fn resample_linear(x: &[f32], from: usize, to: usize) -> Vec<f32> {
    if x.is_empty() || from == to {
        return x.to_vec();
    }
    let n = (x.len() as u64 * to as u64 / from as u64) as usize;
    let step = from as f64 / to as f64;
    (0..n)
        .map(|i| {
            let p = i as f64 * step;
            let k = p as usize;
            let f = (p - k as f64) as f32;
            let a = x[k.min(x.len() - 1)];
            let b = x[(k + 1).min(x.len() - 1)];
            a + (b - a) * f
        })
        .collect()
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct VocalsStatus {
    pub available: bool,
    pub enabled: bool,
    pub device: String,
    pub song: Option<String>,
    pub isolated: Vec<(u64, u64)>,
    /// processing time ÷ audio time (lower is faster; < 1 = faster than real time)
    pub rtf: f64,
    pub busy: bool,
    pub error: Option<String>,
}

#[cfg(feature = "onnx")]
mod imp {
    use super::*;
    use crate::capture::{self, SongAudio};
    use half::f16;
    #[cfg(windows)]
    use ort::ep;
    use ort::{session::Session, value::Tensor};
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// Device for vocal isolation unless `MLP_VOCALS_GPU` says otherwise ("cpu" or "dml"; see `gpu_session`).
    const DEFAULT_GPU: &str = "cpu";

    static ENABLED: AtomicBool = AtomicBool::new(false);
    static STATUS: Mutex<Option<VocalsStatus>> = Mutex::new(None);
    static VOCALS: Mutex<Option<SongAudio>> = Mutex::new(None);

    /// One ONNX Runtime environment for the whole process (sessions borrow it).
    pub(crate) fn ort_env() -> Result<&'static ort::environment::Environment, String> {
        static ENV: std::sync::OnceLock<ort::environment::Environment> = std::sync::OnceLock::new();
        if let Some(e) = ENV.get() {
            return Ok(e);
        }
        let e = ort::init().with_name("mlp").build().map_err(|e| e.to_string())?;
        Ok(ENV.get_or_init(|| e))
    }

    /// CPU session within the AI thread budget (Step 17), worker threads below normal priority.
    pub(crate) fn cpu_session(path: &Path) -> Result<Session, String> {
        let b = Session::builder(ort_env()?).map_err(|e| e.to_string())?;
        let b = b.with_intra_threads(crate::perf::threads()).map_err(|e| e.to_string())?;
        let b = b.with_inter_threads(1).map_err(|e| e.to_string())?;
        let b = b.with_intra_op_spinning(false).map_err(|e| e.to_string())?;
        let b = b.with_inter_op_spinning(false).map_err(|e| e.to_string())?;
        let mut b = b.with_thread_manager(crate::perf::LowPriorityThreads).map_err(|e| e.to_string())?;
        b.commit_from_file(path).map_err(|e| e.to_string())
    }

    pub struct Separator {
        session: Session,
        pub device: String,
        f16_input: bool,
        path: std::path::PathBuf,
    }

    /// GPU session through DirectML (Windows only). Opt-in (`MLP_VOCALS_GPU=dml`): on HT-Demucs with
    /// an RTX 5060 Ti, DML's graph fusion fails at run time (`DmlFusedNode_0_1` E_OUTOFMEMORY, clean
    /// CPU fallback) and with fusion off (`MLP_DML_FUSION=0`) the GPU hangs (DXGI_ERROR_DEVICE_HUNG)
    /// after returning wrong segments. pyke's WebGPU ORT build needs the MSVC 14.50 (VS 2026) STL to link.
    #[cfg(windows)]
    fn gpu_session(env: &ort::environment::Environment, level: ort::session::builder::GraphOptimizationLevel, path: &Path, which: &str) -> Result<(Session, String), String> {
        if which != "dml" {
            return Err(format!("unknown GPU option `{which}`"));
        }
        let fuse = std::env::var("MLP_DML_FUSION").as_deref() != Ok("0");
        let mut b = Session::builder(env)
            .map_err(|e| e.to_string())?
            .with_optimization_level(level)
            .map_err(|e| e.to_string())?
            .with_execution_providers([ep::DirectML::default()
                // Pick the fast discrete GPU, not a virtual / integrated adapter.
                .with_performance_preference(ep::directml::PerformancePreference::HighPerformance)
                .with_device_filter(ep::directml::DeviceFilter::Gpu)
                .build()
                .error_on_failure()])
            .and_then(|b| b.with_memory_pattern(false))
            .and_then(|b| b.with_parallel_execution(false))
            .and_then(|b| b.with_config_entry("ep.dml.disable_graph_fusion", if fuse { "0" } else { "1" }))
            .map_err(|e| e.to_string())?;
        Ok((b.commit_from_file(path).map_err(|e| e.to_string())?, "GPU (DirectML)".to_string()))
    }
    #[cfg(not(windows))]
    fn gpu_session(_env: &ort::environment::Environment, _level: ort::session::builder::GraphOptimizationLevel, _path: &Path, _which: &str) -> Result<(Session, String), String> {
        Err("no GPU path on this OS".into())
    }

    impl Separator {
        pub fn load(path: &Path) -> Result<Self, String> {
            let env = ort_env()?;
            use ort::session::builder::GraphOptimizationLevel as L;
            // GPU session only: basic optimizations (DML's own fusion is the problem, see `gpu_session`).
            let level = match std::env::var("MLP_ORT_OPT").as_deref() {
                Ok("0") => L::Disable,
                Ok("2") => L::Level2,
                Ok("3") => L::Level3,
                _ => L::Level1,
            };
            let which = std::env::var("MLP_VOCALS_GPU").unwrap_or_else(|_| DEFAULT_GPU.into());
            let gpu = if std::env::var("MLP_ORT_CPU").is_ok() || which == "cpu" { None } else { Some(gpu_session(env, level, path, &which)) };
            let (session, device) = match gpu {
                Some(Ok(s)) => s,
                Some(Err(e)) => {
                    eprintln!("[vocals] GPU unavailable ({e}); using the CPU");
                    (cpu_session(path)?, "CPU".to_string())
                }
                None => (cpu_session(path)?, "CPU".to_string()),
            };
            let f16_input = session.inputs().first().and_then(|o| o.dtype().tensor_type()) == Some(ort::value::TensorElementType::Float16);
            Ok(Self { session, device, f16_input, path: path.to_path_buf() })
        }

        /// A GPU EP can fail at *run* time on this model (see `gpu_session`). Rebuild on the CPU —
        /// already faster than real time — and remember it.
        fn fall_back_to_cpu(&mut self, why: &str) -> Result<(), String> {
            eprintln!("[vocals] GPU run failed ({why}); switching to the CPU");
            self.session = cpu_session(&self.path)?;
            self.device = "CPU (GPU failed on this model)".into();
            self.f16_input = self.session.inputs().first().and_then(|o| o.dtype().tensor_type()) == Some(ort::value::TensorElementType::Float16);
            Ok(())
        }

        /// One 7.8 s stereo segment (planar L then R, each SEGMENT long) → vocals stereo (planar).
        fn run_segment(&mut self, planar: Vec<f32>) -> Result<Vec<f32>, String> {
            let shape = vec![1i64, 2, SEGMENT as i64];
            let input = if self.f16_input {
                Tensor::from_array((shape, planar.into_iter().map(f16::from_f32).collect::<Vec<_>>())).map(|t| t.into_dyn())
            } else {
                Tensor::from_array((shape, planar)).map(|t| t.into_dyn())
            }
            .map_err(|e| e.to_string())?;
            let out = self.session.run(ort::inputs![input]).map_err(|e| e.to_string())?;
            let v = &out[0];
            let data: Vec<f32> = match v.try_extract_tensor::<f32>() {
                Ok((_, d)) => d.to_vec(),
                Err(_) => v.try_extract_tensor::<f16>().map_err(|e| e.to_string())?.1.iter().map(|x| x.to_f32()).collect(),
            };
            let base = VOCALS_STEM * 2 * SEGMENT; // [1, 4, 2, SEGMENT]
            Ok(data[base..base + 2 * SEGMENT].to_vec())
        }

        /// Isolate vocals from 16 kHz mono audio; returns 16 kHz mono vocals of the same length.
        pub fn isolate_16k(&mut self, mono16: &[f32]) -> Result<Vec<f32>, String> {
            let mix = resample_linear(mono16, 16_000, MODEL_RATE);
            let total = mix.len();
            let window = transition_window(SEGMENT);
            let mut out = vec![0f32; total];
            let mut weight = vec![0f32; total];
            for (a, b) in chunks(total, SEGMENT) {
                let mut planar = vec![0f32; 2 * SEGMENT];
                planar[..b - a].copy_from_slice(&mix[a..b]);
                planar[SEGMENT..SEGMENT + b - a].copy_from_slice(&mix[a..b]);
                let v = match self.run_segment(planar) {
                    Ok(v) => v,
                    // A failing GPU may already have returned wrong segments: redo the whole block.
                    Err(e) if !self.device.starts_with("CPU") => {
                        self.fall_back_to_cpu(&e)?;
                        return self.isolate_16k(mono16);
                    }
                    Err(e) => return Err(e),
                };
                for i in 0..b - a {
                    let w = window[i];
                    out[a + i] += 0.5 * (v[i] + v[SEGMENT + i]) * w;
                    weight[a + i] += w;
                }
            }
            for (o, w) in out.iter_mut().zip(&weight) {
                *o /= w.max(1e-8);
            }
            // Low-pass by averaging before decimating back to 16 kHz.
            let smoothed: Vec<f32> = (0..out.len()).map(|i| (out[i] + out[(i + 1).min(out.len() - 1)] + out[(i + 2).min(out.len() - 1)]) / 3.0).collect();
            let mut v16 = resample_linear(&smoothed, MODEL_RATE, 16_000);
            v16.resize(mono16.len(), 0.0);
            Ok(v16)
        }
    }

    fn set_status(f: impl FnOnce(&mut VocalsStatus)) {
        let mut g = STATUS.lock().unwrap();
        let s = g.get_or_insert_with(|| VocalsStatus { available: true, ..Default::default() });
        f(s);
    }

    /// Ranges of `covered` not yet in `done`, cut into blocks ≥ `min_ms` (shorter tail only if `flush`).
    pub fn pending(covered: &[(u64, u64)], done: &[(u64, u64)], min_ms: u64, max_ms: u64, flush: bool) -> Vec<(u64, u64)> {
        let mut out = Vec::new();
        for &(a, b) in covered {
            let mut s = a;
            for &(da, db) in done {
                if da <= s && db > s {
                    s = db;
                }
            }
            while s < b {
                let e = (s + max_ms).min(b);
                if e - s >= min_ms || flush {
                    out.push((s, e));
                }
                if e - s < min_ms {
                    break;
                }
                s = e;
            }
        }
        out
    }

    /// Background worker: isolate newly captured audio while enabled.
    fn worker(model: std::path::PathBuf) {
        crate::perf::lower_current_thread();
        let mut sep = match Separator::load(&model) {
            Ok(s) => s,
            Err(e) => {
                set_status(|s| s.error = Some(format!("Couldn't load the vocal model: {e}")));
                ENABLED.store(false, Ordering::SeqCst);
                return;
            }
        };
        set_status(|s| {
            s.device = sep.device.clone();
            s.error = None;
        });
        const CONTEXT_MS: u64 = 1_000; // audio on each side so block edges get full context
        let mut idle_since = Instant::now();
        while ENABLED.load(Ordering::SeqCst) {
            if crate::perf::paused() {
                set_status(|s| s.busy = false);
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            let Some((key, covered)) = capture::current() else {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            };
            let done = {
                let mut g = VOCALS.lock().unwrap();
                if g.as_ref().map(|v| v.key != key).unwrap_or(true) {
                    *g = Some(SongAudio::new(key.clone()));
                }
                g.as_ref().unwrap().covered.clone()
            };
            // Wait for ~8 s blocks while audio keeps arriving; flush shorter tails after 3 s of no growth.
            let flush = idle_since.elapsed() > Duration::from_secs(3);
            let todo = pending(&covered, &done, 8_000, 30_000, flush);
            if todo.is_empty() {
                std::thread::sleep(Duration::from_millis(700));
                continue;
            }
            idle_since = Instant::now();
            for (a, b) in todo {
                let from = a.saturating_sub(CONTEXT_MS);
                let Some(audio) = capture::snapshot(&key, from, b + CONTEXT_MS) else { break };
                set_status(|s| s.busy = true);
                let t = Instant::now();
                let result = sep.isolate_16k(&audio);
                let secs = audio.len() as f64 / 16_000.0;
                match result {
                    Ok(v) => {
                        let off = ((a - from) as usize * 16).min(v.len());
                        let len = (((b - a) as usize) * 16).min(v.len() - off);
                        let mut g = VOCALS.lock().unwrap();
                        if let Some(buf) = g.as_mut().filter(|x| x.key == key) {
                            buf.write(a as f64, &v[off..off + len]);
                        }
                        let rtf = t.elapsed().as_secs_f64() / secs.max(0.001);
                        set_status(|s| {
                            s.rtf = if s.rtf == 0.0 { rtf } else { s.rtf * 0.7 + rtf * 0.3 };
                            s.error = None;
                        });
                    }
                    Err(e) => set_status(|s| s.error = Some(e)),
                }
                set_status(|s| s.busy = false);
            }
        }
    }

    pub fn set(model: std::path::PathBuf, enabled: bool) -> Result<(), String> {
        if enabled && !model.exists() {
            return Err("Download the vocal isolation model first (Settings → AI listening).".into());
        }
        let was = ENABLED.swap(enabled, Ordering::SeqCst);
        set_status(|s| s.enabled = enabled);
        if enabled && !was {
            std::thread::Builder::new().name("vocals".into()).spawn(move || worker(model)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn status() -> VocalsStatus {
        let mut s = STATUS.lock().unwrap().clone().unwrap_or(VocalsStatus { available: true, ..Default::default() });
        s.enabled = ENABLED.load(Ordering::SeqCst);
        if let Some(v) = VOCALS.lock().unwrap().as_ref() {
            s.song = Some(v.key.clone());
            s.isolated = v.covered.clone();
        }
        s
    }

    /// Isolated vocals for [from, to) of the song `key`, only when that whole range is isolated.
    pub fn snapshot(key: &str, from_ms: u64, to_ms: u64) -> Option<Vec<f32>> {
        let g = VOCALS.lock().unwrap();
        let v = g.as_ref().filter(|v| v.key == key)?;
        if !crate::capture::covers(&v.covered, from_ms, to_ms) {
            return None;
        }
        let a = (from_ms as usize * 16).min(v.samples.len());
        let b = (to_ms as usize * 16).min(v.samples.len());
        Some(v.samples[a..b].to_vec())
    }

    /// Dev aid (debug builds): `samples` (16 kHz mono from song time 0) count as isolated vocals of `key`.
    #[cfg(debug_assertions)]
    pub fn debug_load(key: String, samples: &[f32]) {
        let mut v = SongAudio::new(key);
        v.write(0.0, samples);
        *VOCALS.lock().unwrap() = Some(v);
    }

    pub fn dump(path: &str) -> Result<String, String> {
        let g = VOCALS.lock().unwrap();
        let v = g.as_ref().ok_or("nothing isolated yet")?;
        std::fs::write(path, crate::ai::wav_bytes(&v.samples, 16_000)).map_err(|e| e.to_string())?;
        Ok(format!("{} s of vocals", v.samples.len() / 16_000))
    }

    /// Speed + quality check on a known mix (speech + synthetic band). Needs MLP_SPEECH_WAV and the model.
    ///   cargo test --release --features onnx vocals_bench -- --ignored --nocapture
    #[cfg(test)]
    mod bench {
        use super::Separator;

        fn si_sdr(est: &[f32], reference: &[f32]) -> f64 {
            let n = est.len().min(reference.len());
            let (e, r) = (&est[..n], &reference[..n]);
            let dot: f64 = e.iter().zip(r).map(|(a, b)| *a as f64 * *b as f64).sum();
            let rr: f64 = r.iter().map(|x| (*x as f64).powi(2)).sum();
            let a = dot / rr.max(1e-12);
            let target: f64 = r.iter().map(|x| (a * *x as f64).powi(2)).sum();
            let noise: f64 = e.iter().zip(r).map(|(x, y)| (*x as f64 - a * *y as f64).powi(2)).sum();
            10.0 * (target / noise.max(1e-12)).log10()
        }

        #[test]
        #[ignore]
        fn vocals_bench() {
            let speech = crate::ai::read_wav_16k(std::path::Path::new(&std::env::var("MLP_SPEECH_WAV").unwrap())).unwrap();
            let n = speech.len();
            // Synthetic band: chords (harmonic stacks), bass, kick and hi-hat noise.
            let mut seed = 12345u32;
            let mut rnd = || {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                (seed as f32 / u32::MAX as f32) * 2.0 - 1.0
            };
            let chords = [[220.0f32, 277.2, 329.6], [196.0, 246.9, 293.7], [174.6, 220.0, 261.6], [196.0, 246.9, 329.6]];
            let music: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f32 / 16_000.0;
                    let ch = chords[(t / 2.0) as usize % 4];
                    let mut x = 0.0;
                    for f in ch {
                        for h in 1..5 {
                            x += (2.0 * std::f32::consts::PI * f * h as f32 * t).sin() / h as f32;
                        }
                    }
                    x *= 0.08;
                    x += 0.25 * (2.0 * std::f32::consts::PI * ch[0] / 2.0 * t).sin();
                    let beat = t % 0.5;
                    x += 0.6 * (-beat * 30.0).exp() * (2.0 * std::f32::consts::PI * 60.0 * beat).sin();
                    let off = (t + 0.25) % 0.5;
                    x += 0.15 * (-off * 80.0).exp() * rnd();
                    x
                })
                .collect();
            let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
            let gain = rms(&speech) / rms(&music); // 0 dB speech-to-music
            let mix: Vec<f32> = speech.iter().zip(&music).map(|(s, m)| 0.7 * (s + m * gain)).collect();

            let model = std::env::var("MLP_VOCALS_MODEL").map(std::path::PathBuf::from).unwrap_or_else(|_| {
                std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.mlp.lyrics/ai/models/htdemucs-vocals.bin")
            });
            let t = std::time::Instant::now();
            let mut sep = Separator::load(&model).unwrap();
            println!("load: {:.2}s on {}", t.elapsed().as_secs_f64(), sep.device);
            for run in 0..2 {
                let t = std::time::Instant::now();
                let v = sep.isolate_16k(&mix).unwrap();
                let secs = n as f64 / 16_000.0;
                let el = t.elapsed().as_secs_f64();
                println!(
                    "run {run}: {el:.2}s for {secs:.1}s audio (RTF {:.3}, {:.0}x real time); SI-SDR mix {:.1} dB -> vocals {:.1} dB",
                    el / secs,
                    secs / el,
                    si_sdr(&mix, &speech),
                    si_sdr(&v, &speech)
                );
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::pending;

        #[test]
        fn plans_blocks_from_coverage() {
            // 0–20 s captured, nothing done: two blocks (≤ 30 s each, ≥ 8 s), no flush needed
            assert_eq!(pending(&[(0, 20_000)], &[], 8_000, 30_000, false), vec![(0, 20_000)]);
            // 0–20 s done, 20–25 s new: too short unless flushing
            assert!(pending(&[(0, 25_000)], &[(0, 20_000)], 8_000, 30_000, false).is_empty());
            assert_eq!(pending(&[(0, 25_000)], &[(0, 20_000)], 8_000, 30_000, true), vec![(20_000, 25_000)]);
            // long range split into 30 s blocks
            assert_eq!(pending(&[(0, 70_000)], &[], 8_000, 30_000, false), vec![(0, 30_000), (30_000, 60_000), (60_000, 70_000)]);
        }
    }
}

fn model_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    crate::ai::ai_dir(app).join("models").join("htdemucs-vocals.bin")
}

#[tauri::command]
pub fn vocals_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(feature = "onnx")]
    {
        imp::set(model_path(&app), enabled)
    }
    #[cfg(not(feature = "onnx"))]
    {
        let _ = (app, enabled);
        Err("This build doesn't include vocal isolation (build with --features onnx).".into())
    }
}

#[tauri::command]
pub fn vocals_status(app: tauri::AppHandle) -> VocalsStatus {
    let _ = model_path(&app);
    #[cfg(feature = "onnx")]
    {
        imp::status()
    }
    #[cfg(not(feature = "onnx"))]
    {
        VocalsStatus::default()
    }
}

#[tauri::command]
pub fn vocals_dump(path: String) -> Result<String, String> {
    #[cfg(feature = "onnx")]
    {
        imp::dump(&path)
    }
    #[cfg(not(feature = "onnx"))]
    {
        let _ = path;
        Err("This build doesn't include vocal isolation.".into())
    }
}

#[cfg(feature = "onnx")]
pub use imp::snapshot;
#[cfg(all(feature = "onnx", debug_assertions))]
pub use imp::debug_load;
#[cfg(feature = "onnx")]
pub(crate) use imp::cpu_session;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_add_weights_cover_everything() {
        let w = transition_window(SEGMENT);
        let total = SEGMENT * 3;
        let mut sum = vec![0f32; total];
        for (a, b) in chunks(total, SEGMENT) {
            for i in a..b {
                sum[i] += w[i - a];
            }
        }
        // Every sample except the very first / last gets positive weight.
        assert!(sum[1..total - 1].iter().all(|&x| x > 0.0));
    }

    #[test]
    fn resampling_keeps_duration() {
        let x = vec![0.5f32; 16_000];
        assert_eq!(resample_linear(&x, 16_000, 44_100).len(), 44_100);
        assert_eq!(resample_linear(&resample_linear(&x, 16_000, 44_100), 44_100, 16_000).len(), 16_000);
    }
}
