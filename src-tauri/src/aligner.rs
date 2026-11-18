#![cfg_attr(not(feature = "onnx"), allow(dead_code))]
//! Step 15 — line the lyrics up with the singing. The MMS-300m forced aligner (wav2vec2 CTC over
//! a–z, ONNX int8, CPU) turns a stretch of captured (ideally vocal-isolated) audio into per-frame
//! letter probabilities; CTC Viterbi with wildcard edges (`ctc::align_lines`) then finds where each
//! known, romanized lyric word is sung. Which lines, which window and the time map live in TS.

use serde::{Deserialize, Serialize};

pub const MODEL_ID: &str = "mms-aligner";
const BLANK: usize = 0;
/// Longest window accepted (attention cost grows with the square of the length).
pub const MAX_WINDOW_MS: u64 = 40_000;

/// MMS-300m-1130 forced-aligner vocabulary (vocab.json): the letters and the apostrophe.
const VOCAB: [(char, usize); 27] = [
    ('a', 4), ('b', 20), ('c', 23), ('d', 16), ('e', 6), ('f', 27), ('g', 17), ('h', 18), ('i', 5),
    ('j', 25), ('k', 14), ('l', 15), ('m', 13), ('n', 7), ('o', 8), ('p', 21), ('q', 29), ('r', 12),
    ('s', 11), ('t', 10), ('u', 9), ('v', 24), ('w', 22), ('x', 30), ('y', 19), ('z', 26), ('\'', 28),
];

/// Token ids of one (already romanized) word; anything outside a–z and ' is dropped.
pub fn token_ids(word: &str) -> Vec<usize> {
    word.chars()
        .flat_map(char::to_lowercase)
        .map(|c| if c == '’' { '\'' } else { c })
        .filter_map(|c| VOCAB.iter().find(|(k, _)| *k == c).map(|(_, id)| *id))
        .collect()
}

/// Default knobs (tuned on real songs, see PLAN.md Step 15).
#[derive(Clone, Copy)]
pub struct TuneDefault {
    pub star_logp: f32,
    pub blank_penalty: f32,
    pub prior_per_sec: f32,
    pub prior_tol_ms: f64,
}
/// blank_penalty −1.15: with free blanks a line's letters spread over the whole window and lines
/// landed ~2.5 s early on real songs; lines within 0.2 s with ±5 s windows went from 5/62 → 56/62
/// (晴天) and 2/42 → 32/42 (Super Shy). −0.75 and ≤ −2 both fail, so keep it near the star's −1.
/// The position prior is available but didn't add anything on top (off by default).
pub const TUNE_DEFAULT: TuneDefault = TuneDefault { star_logp: crate::ctc::STAR_LOGP, blank_penalty: -1.15, prior_per_sec: 0.0, prior_tol_ms: 500.0 };

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AlignRequest {
    /// capture song key ("{sourceApp}|{artist}|{title}")
    pub key: String,
    pub from_ms: u64,
    pub to_ms: u64,
    /// romanized words per line, in singing order
    pub lines: Vec<Vec<String>>,
    /// use the isolated vocals (Step 14) instead of the full mix
    pub vocals: bool,
    /// expected song time (ms) of each line's first word, for a soft position prior
    #[serde(default)]
    pub expect: Option<Vec<Option<f64>>>,
    /// tuning overrides (defaults in `Tune`)
    #[serde(default)]
    pub tune: Option<Tune>,
}

/// Aligner knobs (camelCase from TS); unset = default.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tune {
    pub star_logp: Option<f32>,
    pub blank_penalty: Option<f32>,
    /// prior strength: log-prob per second of distance beyond the tolerance
    pub prior_per_sec: Option<f32>,
    pub prior_tol_ms: Option<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WordTime {
    /// song time (ms)
    pub start: f64,
    pub end: f64,
    /// mean log-probability of the word's letters (≈0 = sure, below −3 = probably wrong)
    pub score: f32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AlignResult {
    pub lines: Vec<Vec<Option<WordTime>>>,
    pub source: &'static str,
    pub took_ms: u64,
    pub threads: usize,
}

/// Frame spans → song times.
pub fn to_times(spans: Vec<Vec<Option<crate::ctc::WordSpan>>>, from_ms: u64, ms_per_frame: f64) -> Vec<Vec<Option<WordTime>>> {
    spans
        .into_iter()
        .map(|line| {
            line.into_iter()
                .map(|s| {
                    s.map(|s| WordTime {
                        start: from_ms as f64 + s.start_frame as f64 * ms_per_frame,
                        end: from_ms as f64 + s.end_frame as f64 * ms_per_frame,
                        score: s.score,
                    })
                })
                .collect()
        })
        .collect()
}

#[cfg(feature = "onnx")]
mod imp {
    use super::*;
    use ort::{session::Session, value::Tensor};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::Instant;

    pub struct Aligner {
        session: Session,
        threads: usize,
        path: PathBuf,
    }

    static ALIGNER: Mutex<Option<Aligner>> = Mutex::new(None);

    impl Aligner {
        pub fn load(path: &Path) -> Result<Self, String> {
            Ok(Self { session: crate::vocals::cpu_session(path)?, threads: crate::perf::threads(), path: path.to_path_buf() })
        }

        /// Per-frame log-probabilities for 16 kHz mono audio: (T×V row-major, T, V, ms per frame).
        pub fn emissions(&mut self, audio: &[f32]) -> Result<(Vec<f32>, usize, usize, f64), String> {
            if audio.len() < 16_000 / 2 {
                return Err("too little audio".into());
            }
            // wav2vec2 feature extractor (do_normalize): zero mean, unit variance.
            let n = audio.len() as f32;
            let mean = audio.iter().sum::<f32>() / n;
            let var = audio.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / n;
            let norm: Vec<f32> = audio.iter().map(|x| (x - mean) / (var + 1e-7).sqrt()).collect();
            let input = Tensor::from_array((vec![1i64, norm.len() as i64], norm)).map_err(|e| e.to_string())?;
            let out = self.session.run(ort::inputs![input]).map_err(|e| e.to_string())?;
            let (shape, data) = out[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let (t, v) = (shape[1] as usize, shape[2] as usize);
            let mut lp = data.to_vec();
            crate::ctc::log_softmax_rows(&mut lp, v);
            Ok((lp, t, v, audio.len() as f64 / 16.0 / t as f64))
        }

        /// Align the lines somewhere inside `audio` (which starts at song time `from_ms`).
        #[cfg_attr(not(test), allow(dead_code))] // used by the benches and tests
        pub fn align(&mut self, audio: &[f32], from_ms: u64, lines: &[Vec<String>]) -> Result<Vec<Vec<Option<WordTime>>>, String> {
            self.align_tuned(audio, from_ms, lines, None, &Tune::default())
        }

        pub fn align_tuned(&mut self, audio: &[f32], from_ms: u64, lines: &[Vec<String>], expect: Option<&[Option<f64>]>, tune: &Tune) -> Result<Vec<Vec<Option<WordTime>>>, String> {
            let (lp, t, v, ms) = self.emissions(audio)?;
            let ids: Vec<Vec<Vec<usize>>> = lines.iter().map(|l| l.iter().map(|w| token_ids(w)).collect()).collect();
            let d = TUNE_DEFAULT;
            let per_sec = tune.prior_per_sec.unwrap_or(d.prior_per_sec);
            let tol_ms = tune.prior_tol_ms.unwrap_or(d.prior_tol_ms);
            let line_entry = match expect {
                Some(e) if per_sec > 0.0 => e
                    .iter()
                    .map(|x| x.map(|at| (((at - from_ms as f64) / ms) as f32, per_sec * (ms / 1000.0) as f32, (tol_ms / ms) as f32)))
                    .collect(),
                _ => Vec::new(),
            };
            let tuning = crate::ctc::Tuning {
                star_logp: tune.star_logp.unwrap_or(d.star_logp),
                blank_penalty: tune.blank_penalty.unwrap_or(d.blank_penalty),
                line_entry,
            };
            let spans = crate::ctc::align_lines_with(&lp, t, v, BLANK, &ids, &tuning).ok_or("the words don't fit this stretch of audio")?;
            Ok(to_times(spans, from_ms, ms))
        }
    }

    pub fn align(model: &Path, req: AlignRequest) -> Result<AlignResult, String> {
        if !model.exists() {
            return Err("Download the auto-sync model first (Settings → AI listening).".into());
        }
        if req.to_ms <= req.from_ms || req.to_ms - req.from_ms > MAX_WINDOW_MS {
            return Err(format!("window must be 0–{} s", MAX_WINDOW_MS / 1000));
        }
        let (audio, source) = if req.vocals {
            (crate::vocals::snapshot(&req.key, req.from_ms, req.to_ms).ok_or("those vocals aren't isolated yet")?, "vocals")
        } else {
            (crate::capture::snapshot_covered(&req.key, req.from_ms, req.to_ms).ok_or("that part wasn't captured")?, "mix")
        };
        let _low = crate::perf::lower_scoped();
        let mut g = ALIGNER.lock().unwrap();
        if g.as_ref().map(|a| a.threads != crate::perf::threads() || a.path != model).unwrap_or(true) {
            *g = None; // free the old session first
            *g = Some(Aligner::load(model)?);
        }
        let a = g.as_mut().unwrap();
        let t0 = Instant::now();
        let lines = a.align_tuned(&audio, req.from_ms, &req.lines, req.expect.as_deref(), &req.tune.clone().unwrap_or_default())?;
        Ok(AlignResult { lines, source, took_ms: t0.elapsed().as_millis() as u64, threads: a.threads })
    }

    /// Free the model's memory (≈ 0.5 GB) when auto-sync is switched off.
    pub fn unload() {
        *ALIGNER.lock().unwrap() = None;
    }

    /// Accuracy check on real speech: align the known text of MLP_SPEECH_WAV (with silence and an
    /// unrelated sentence around it) and compare with Whisper's word times (MLP_SPEECH_JSON).
    ///   cargo test --release --features onnx aligner_bench -- --ignored --nocapture
    #[cfg(test)]
    mod bench {
        use super::*;

        #[test]
        #[ignore]
        fn aligner_bench() {
            let wav = std::env::var("MLP_SPEECH_WAV").expect("MLP_SPEECH_WAV");
            let speech = crate::ai::read_wav_16k(Path::new(&wav)).unwrap();
            let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("MLP_SPEECH_JSON").unwrap()).unwrap()).unwrap();
            let model = std::env::var("MLP_ALIGNER_MODEL").map(PathBuf::from).unwrap_or_else(|_| {
                PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.mlp.lyrics/ai/models/mms-aligner.bin")
            });
            let t = Instant::now();
            let mut a = Aligner::load(&model).unwrap();
            println!("load {:.2}s, {} threads", t.elapsed().as_secs_f64(), a.threads);
            // Reference: Whisper segments (lines) and words.
            let segs = json["segments"].as_array().unwrap();
            let ref_words: Vec<(String, f64)> = segs
                .iter()
                .flat_map(|s| s["words"].as_array().unwrap().iter())
                .map(|w| (w["word"].as_str().unwrap().trim().to_string(), w["start"].as_f64().unwrap() * 1000.0))
                .filter(|(w, _)| !token_ids(w).is_empty())
                .collect();
            // Lines 2–4 only, inside the whole clip (other lines = unrelated singing for the wildcard).
            let lines: Vec<Vec<String>> = segs[1..4]
                .iter()
                .map(|s| s["text"].as_str().unwrap().split_whitespace().map(String::from).collect())
                .collect();
            let t = Instant::now();
            let out = a.align(&speech, 0, &lines).unwrap();
            println!("align {:.1}s audio in {:.2}s", speech.len() as f64 / 16_000.0, t.elapsed().as_secs_f64());
            let mut errs = Vec::new();
            for (li, line) in out.iter().enumerate() {
                for (wi, w) in line.iter().enumerate() {
                    let Some(w) = w else { continue };
                    let word = &lines[li][wi];
                    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
                    if let Some((_, r)) = ref_words.iter().filter(|(rw, _)| norm(rw) == norm(word)).min_by(|a, b| (a.1 - w.start).abs().total_cmp(&(b.1 - w.start).abs())) {
                        errs.push((w.start - r).abs());
                        println!("{word:>12}: {:>7.0} ms (whisper {:>7.0}) score {:.2}", w.start, r, w.score);
                    }
                }
            }
            errs.sort_by(f64::total_cmp);
            println!("median |Δ| vs whisper: {:.0} ms, max {:.0} ms ({} words)", errs[errs.len() / 2], errs.last().unwrap(), errs.len());
            // Wrong text must score badly.
            let wrong = a.align(&speech, 0, &[vec!["completely".into(), "different".into(), "banana".into(), "words".into()]]).unwrap();
            let s: Vec<f32> = wrong[0].iter().flatten().map(|w| w.score).collect();
            println!("wrong text scores: {s:?}");
        }

        /// Known line positions (MLP_ALIGN_CASE = folder with case.json + case_vocals.wav / case_mix.wav):
        /// align lines 2–4 inside the clip; lines 1 and 5 act as unrelated singing.
        #[test]
        #[ignore]
        fn aligner_truth() {
            let dir = PathBuf::from(std::env::var("MLP_ALIGN_CASE").expect("MLP_ALIGN_CASE"));
            let case: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("case.json")).unwrap()).unwrap();
            let texts: Vec<&str> = case["texts"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
            let starts: Vec<f64> = case["starts"].as_array().unwrap().iter().map(|t| t.as_f64().unwrap()).collect();
            let ends: Vec<f64> = case["ends"].as_array().unwrap().iter().map(|t| t.as_f64().unwrap()).collect();
            let model = PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.mlp.lyrics/ai/models/mms-aligner.bin");
            let mut a = Aligner::load(&model).unwrap();
            for file in ["case_vocals.wav", "case_mix.wav"] {
                let audio = crate::ai::read_wav_16k(&dir.join(file)).unwrap();
                let lines: Vec<Vec<String>> = texts[1..4].iter().map(|t| t.split_whitespace().map(String::from).collect()).collect();
                // Window = the whole clip, i.e. ±2–6 s of margin around the lines.
                let out = a.align(&audio, 0, &lines).unwrap();
                for (k, line) in out.iter().enumerate() {
                    let ws: Vec<&WordTime> = line.iter().flatten().collect();
                    let mean = ws.iter().map(|w| w.score).sum::<f32>() / ws.len() as f32;
                    println!(
                        "{file:>16} line {}: start {:>6.0} (truth {:>6.0}, Δ {:>+4.0}) · last word end {:>6.0} (truth {:>6.0}) · score {mean:.2}",
                        k + 2,
                        ws[0].start,
                        starts[k + 1],
                        ws[0].start - starts[k + 1],
                        ws.last().unwrap().end,
                        ends[k + 1]
                    );
                }
                // A shifted window that only half-contains line 4 must not report a confident line 4.
                let cut = (starts[3] + 800.0) as usize * 16;
                let out = a.align(&audio[..cut], 0, &lines).unwrap();
                let s4: Vec<f32> = out[2].iter().flatten().map(|w| w.score).collect();
                println!("{file:>16} line 4 cut short: scores {s4:.2?}");
            }
        }
    }
}

fn model_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    crate::ai::model_file(app, MODEL_ID)
}

#[tauri::command]
pub async fn ai_align(app: tauri::AppHandle, req: AlignRequest) -> Result<AlignResult, String> {
    #[cfg(feature = "onnx")]
    {
        let model = model_path(&app);
        tauri::async_runtime::spawn_blocking(move || imp::align(&model, req)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "onnx"))]
    {
        let _ = (app, req);
        Err("This build doesn't include auto-sync (build with --features onnx).".into())
    }
}

/// Free AI models' memory (aligner + Whisper server) when the AI features are switched off.
#[tauri::command]
pub fn ai_unload() {
    #[cfg(feature = "onnx")]
    imp::unload();
    crate::ai::stop_server();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_words_to_the_aligner_alphabet() {
        assert_eq!(token_ids("Don’t"), vec![16, 8, 7, 28, 10]);
        assert!(token_ids("123!").is_empty());
    }

    #[test]
    fn converts_frames_to_song_time() {
        let span = crate::ctc::WordSpan { word: 0, start_frame: 10, end_frame: 15, score: -0.5 };
        let t = to_times(vec![vec![Some(span), None]], 30_000, 20.0);
        assert_eq!(t[0][0], Some(WordTime { start: 30_200.0, end: 30_300.0, score: -0.5 }));
        assert_eq!(t[0][1], None);
    }
}
