//! Whisper large-v3-turbo through ONNX Runtime: log-mel → encoder → greedy decoder (4-layer turbo
//! decoder re-run per token; no KV cache needed at this size) → byte-level BPE detokenizer.

use super::mel::{log_mel, CHUNK_SAMPLES, FRAMES};
use super::runtime::{float_tensor, input_type, read_float, session, Device};
use ort::session::Session;
use ort::value::{DynValue, Tensor};
use std::collections::HashMap;
use std::path::Path;

pub struct Whisper {
    encoder: Session,
    decoder: Session,
    pub device: Device,
    n_mels: usize,
    id_to_token: HashMap<u32, String>,
    special: HashMap<String, u32>,
    byte_decoder: HashMap<char, u8>,
}

/// GPT-2 bytes↔unicode table, inverted.
fn byte_decoder() -> HashMap<char, u8> {
    let mut bs: Vec<u32> = (b'!' as u32..=b'~' as u32).chain(0xA1..=0xAC).chain(0xAE..=0xFF).collect();
    let mut cs = bs.clone();
    let mut n = 0;
    for b in 0..256u32 {
        if !bs.contains(&b) {
            bs.push(b);
            cs.push(256 + n);
            n += 1;
        }
    }
    bs.into_iter().zip(cs).map(|(b, c)| (char::from_u32(c).unwrap(), b as u8)).collect()
}

impl Whisper {
    pub fn load(dir: &Path, gpu: bool) -> Result<Self, String> {
        let (encoder, device) = session(&dir.join("onnx/encoder_model_fp16.onnx"), gpu)?;
        let (decoder, _) = session(&dir.join("onnx/decoder_model_fp16.onnx"), gpu)?;
        let read = |f: &str| std::fs::read_to_string(dir.join(f)).map_err(|e| format!("{f}: {e}"));
        let vocab: HashMap<String, u32> = serde_json::from_str(&read("vocab.json")?).map_err(|e| e.to_string())?;
        let special: HashMap<String, u32> = serde_json::from_str(&read("added_tokens.json")?).map_err(|e| e.to_string())?;
        let pre: serde_json::Value = serde_json::from_str(&read("preprocessor_config.json")?).map_err(|e| e.to_string())?;
        let n_mels = pre["feature_size"].as_u64().unwrap_or(128) as usize;
        let mut id_to_token: HashMap<u32, String> = vocab.into_iter().map(|(k, v)| (v, k)).collect();
        for (k, &v) in &special {
            id_to_token.insert(v, k.clone());
        }
        Ok(Self { encoder, decoder, device, n_mels, id_to_token, special, byte_decoder: byte_decoder() })
    }

    fn tok(&self, s: &str) -> Result<u32, String> {
        self.special.get(s).copied().ok_or_else(|| format!("missing token {s}"))
    }

    fn decode(&self, ids: &[u32]) -> String {
        let bytes: Vec<u8> = ids
            .iter()
            .filter_map(|i| self.id_to_token.get(i))
            .filter(|t| !(t.starts_with("<|") && t.ends_with("|>")))
            .flat_map(|t| t.chars().filter_map(|c| self.byte_decoder.get(&c).copied()).collect::<Vec<_>>())
            .collect();
        String::from_utf8_lossy(&bytes).trim().to_string()
    }

    /// Transcribe up to 30 s of 16 kHz mono audio. `lang`: ISO code like "en", "ja" (None = auto).
    pub fn transcribe(&mut self, audio: &[f32], lang: Option<&str>) -> Result<String, String> {
        let feats = log_mel(&audio[..audio.len().min(CHUNK_SAMPLES)], self.n_mels);
        let ty = input_type(&self.encoder, 0);
        let input = float_tensor(vec![1, self.n_mels as i64, FRAMES as i64], feats, ty)?;
        let enc_out = self.encoder.run(ort::inputs![input]).map_err(|e| e.to_string())?;
        let (hshape, hidden) = read_float(&enc_out[0])?;
        drop(enc_out);
        let hty = input_type(&self.decoder, 1);

        let eot = self.tok("<|endoftext|>")?;
        let mut tokens: Vec<u32> = vec![self.tok("<|startoftranscript|>")?];
        if let Some(l) = lang {
            tokens.push(self.tok(&format!("<|{l}|>"))?);
        }
        tokens.push(self.tok("<|transcribe|>")?);
        tokens.push(self.tok("<|notimestamps|>")?);
        let prompt_len = tokens.len();
        let first_special = *self.special.values().min().unwrap_or(&eot);

        for _ in 0..224 {
            let ids: Vec<i64> = tokens.iter().map(|&t| t as i64).collect();
            let ids_t: DynValue = Tensor::from_array((vec![1i64, ids.len() as i64], ids)).map_err(|e| e.to_string())?.into_dyn();
            let h = float_tensor(hshape.clone(), hidden.clone(), hty)?;
            let out = self.decoder.run(ort::inputs![ids_t, h]).map_err(|e| e.to_string())?;
            let (shape, logits) = read_float(&out[0])?;
            let v = shape[2] as usize;
            let last = &logits[(tokens.len() - 1) * v..tokens.len() * v];
            // Greedy, but never pick special tokens other than end-of-text.
            let next = last
                .iter()
                .enumerate()
                .filter(|(i, _)| (*i as u32) < first_special || *i as u32 == eot)
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(i, _)| i as u32)
                .unwrap_or(eot);
            if next == eot {
                break;
            }
            tokens.push(next);
            // Stop runaway repetition (a common Whisper failure on music).
            let n = tokens.len();
            if n - prompt_len > 24 && tokens[n - 8..] == tokens[n - 16..n - 8] {
                tokens.truncate(n - 8);
                break;
            }
        }
        Ok(self.decode(&tokens[prompt_len..]))
    }
}
