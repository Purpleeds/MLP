//! MMS-300m forced aligner (wav2vec2 CTC, a–z alphabet): audio + known (romanized) words → word times.

use super::align::{align, log_softmax_rows, normalize_words, WordSpan};
use super::runtime::{float_tensor, input_type, read_float, session, Device};
use ort::session::Session;
use std::collections::HashMap;
use std::path::Path;

pub struct Aligner {
    session: Session,
    pub device: Device,
    vocab: HashMap<char, usize>,
    blank: usize,
}

#[derive(Debug, Clone)]
pub struct WordTime {
    pub word: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub score: f32,
}

impl Aligner {
    pub fn load(dir: &Path, gpu: bool) -> Result<Self, String> {
        let (session, device) = session(&dir.join("onnx/model_fp16.onnx"), gpu)?;
        let raw: HashMap<String, usize> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("vocab.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let blank = *raw.get("<blank>").unwrap_or(&0);
        let vocab = raw.iter().filter_map(|(k, &v)| (k.chars().count() == 1).then(|| (k.chars().next().unwrap(), v))).collect();
        Ok(Self { session, device, vocab, blank })
    }

    /// Per-frame log-probabilities for 16 kHz mono audio. Returns (frames, vocab size, ms per frame).
    pub fn emissions(&mut self, audio: &[f32]) -> Result<(Vec<f32>, usize, usize, f64), String> {
        // wav2vec2 feature extractor: zero mean, unit variance.
        let n = audio.len().max(1) as f32;
        let mean = audio.iter().sum::<f32>() / n;
        let var = audio.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / n;
        let norm: Vec<f32> = audio.iter().map(|x| (x - mean) / (var + 1e-7).sqrt()).collect();
        let ty = input_type(&self.session, 0);
        let input = float_tensor(vec![1, norm.len() as i64], norm, ty)?;
        let outputs = self.session.run(ort::inputs![input]).map_err(|e| e.to_string())?;
        let (shape, mut logits) = read_float(&outputs[0])?;
        let (t, v) = (shape[1] as usize, shape[2] as usize);
        log_softmax_rows(&mut logits, v);
        let ms_per_frame = audio.len() as f64 / 16.0 / t as f64;
        Ok((logits, t, v, ms_per_frame))
    }

    /// Align `text` (already romanized, words separated by spaces) to the audio.
    pub fn align_text(&mut self, audio: &[f32], text: &str) -> Result<Vec<WordTime>, String> {
        let words = normalize_words(text);
        let ids: Vec<Vec<usize>> = words.iter().map(|w| w.chars().filter_map(|c| self.vocab.get(&c).copied()).collect()).collect();
        let (lp, t, v, ms) = self.emissions(audio)?;
        let spans: Vec<WordSpan> = align(&lp, t, v, self.blank, &ids).ok_or("text is too long for this audio")?;
        Ok(spans
            .into_iter()
            .map(|s| WordTime {
                word: words[s.word].clone(),
                start_ms: s.start_frame as f64 * ms,
                end_ms: s.end_frame as f64 * ms,
                score: s.score,
            })
            .collect())
    }
}
