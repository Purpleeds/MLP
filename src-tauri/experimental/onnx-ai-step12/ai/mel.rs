//! Whisper log-mel spectrogram (16 kHz, n_fft 400, hop 160, Slaney mel filters), matching
//! `whisper.audio.log_mel_spectrogram`: 30 s window → n_mels × 3000 frames.

use rustfft::{num_complex::Complex32, FftPlanner};

pub const SAMPLE_RATE: usize = 16_000;
pub const N_FFT: usize = 400;
pub const HOP: usize = 160;
pub const CHUNK_SAMPLES: usize = 30 * SAMPLE_RATE;
pub const FRAMES: usize = CHUNK_SAMPLES / HOP; // 3000

fn hz_to_mel(f: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = (6.4f64).ln() / 27.0;
    if f >= min_log_hz {
        min_log_mel + (f / min_log_hz).ln() / logstep
    } else {
        f / f_sp
    }
}

fn mel_to_hz(m: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = (6.4f64).ln() / 27.0;
    if m >= min_log_mel {
        min_log_hz * (logstep * (m - min_log_mel)).exp()
    } else {
        f_sp * m
    }
}

/// librosa.filters.mel(sr=16000, n_fft=400, n_mels, norm="slaney") → [n_mels][201]
pub fn mel_filters(n_mels: usize) -> Vec<Vec<f32>> {
    let n_bins = N_FFT / 2 + 1;
    let fft_freqs: Vec<f64> = (0..n_bins).map(|i| i as f64 * SAMPLE_RATE as f64 / N_FFT as f64).collect();
    let (lo, hi) = (hz_to_mel(0.0), hz_to_mel(SAMPLE_RATE as f64 / 2.0));
    let mel_f: Vec<f64> = (0..n_mels + 2).map(|i| mel_to_hz(lo + (hi - lo) * i as f64 / (n_mels + 1) as f64)).collect();
    (0..n_mels)
        .map(|i| {
            let enorm = 2.0 / (mel_f[i + 2] - mel_f[i]);
            fft_freqs
                .iter()
                .map(|&f| {
                    let lower = (f - mel_f[i]) / (mel_f[i + 1] - mel_f[i]);
                    let upper = (mel_f[i + 2] - f) / (mel_f[i + 2] - mel_f[i + 1]);
                    (lower.min(upper).max(0.0) * enorm) as f32
                })
                .collect()
        })
        .collect()
}

/// Log-mel features for up to 30 s of 16 kHz mono audio (zero-padded), row-major [n_mels × 3000].
pub fn log_mel(samples: &[f32], n_mels: usize) -> Vec<f32> {
    let mut audio = samples[..samples.len().min(CHUNK_SAMPLES)].to_vec();
    audio.resize(CHUNK_SAMPLES, 0.0);
    // center=True: reflect-pad n_fft/2 on both sides
    let pad = N_FFT / 2;
    let mut padded = Vec::with_capacity(audio.len() + 2 * pad);
    padded.extend((1..=pad).rev().map(|i| audio[i]));
    padded.extend_from_slice(&audio);
    padded.extend((1..=pad).map(|i| audio[audio.len() - 1 - i]));

    let window: Vec<f32> = (0..N_FFT).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / N_FFT as f32).cos()).collect();
    let filters = mel_filters(n_mels);
    let fft = FftPlanner::<f32>::new().plan_fft_forward(N_FFT);
    let n_bins = N_FFT / 2 + 1;
    let mut out = vec![0f32; n_mels * FRAMES];
    let mut buf = vec![Complex32::new(0.0, 0.0); N_FFT];
    let mut power = vec![0f32; n_bins];
    for t in 0..FRAMES {
        let start = t * HOP;
        for i in 0..N_FFT {
            buf[i] = Complex32::new(padded[start + i] * window[i], 0.0);
        }
        fft.process(&mut buf);
        for (k, p) in power.iter_mut().enumerate() {
            *p = buf[k].norm_sqr();
        }
        for (m, filt) in filters.iter().enumerate() {
            let e: f32 = filt.iter().zip(&power).map(|(a, b)| a * b).sum();
            out[m * FRAMES + t] = e.max(1e-10).log10();
        }
    }
    let max = out.iter().cloned().fold(f32::MIN, f32::max);
    for v in &mut out {
        *v = (v.max(max - 8.0) + 4.0) / 4.0;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filterbank_shape_and_coverage() {
        let f = mel_filters(128);
        assert_eq!(f.len(), 128);
        assert_eq!(f[0].len(), 201);
        assert!(f.iter().all(|row| row.iter().any(|&w| w > 0.0)));
    }

    #[test]
    fn tone_lands_in_the_right_band() {
        let sine: Vec<f32> = (0..SAMPLE_RATE).map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / SAMPLE_RATE as f32).sin()).collect();
        let m = log_mel(&sine, 128);
        let frame = 50;
        let peak = (0..128).max_by(|&a, &b| m[a * FRAMES + frame].total_cmp(&m[b * FRAMES + frame])).unwrap();
        let hz = mel_to_hz(hz_to_mel(0.0) + (hz_to_mel(8000.0) - hz_to_mel(0.0)) * (peak + 1) as f64 / 129.0);
        assert!((hz - 1000.0).abs() < 120.0, "peak at {hz} Hz");
    }
}
