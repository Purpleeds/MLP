//! Step 12 feasibility spike: download models, align known text and transcribe a test clip on the GPU.
//!   cargo run --release --features ai --example ai_spike -- <clip.wav> <truth.json> [lang]
//! truth.json: { "text": "...", "words": [{ "word": "...", "ms": 1234 }, ...] } (e.g. from a TTS script).

use mlp_lib::ai::{aligner::Aligner, models, whisper::Whisper};
use std::path::PathBuf;
use std::time::Instant;

fn gpu_mem_mb() -> Option<u64> {
    let out = std::process::Command::new("nvidia-smi").args(["--query-gpu=memory.used", "--format=csv,noheader,nounits"]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().lines().next()?.trim().parse().ok()
}

fn read_wav(path: &str) -> Vec<f32> {
    let mut r = hound::WavReader::open(path).expect("wav");
    let spec = r.spec();
    assert_eq!(spec.sample_rate, 16_000, "need 16 kHz");
    let ch = spec.channels as usize;
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => r.samples::<i32>().map(|s| s.unwrap() as f32 / (1 << (spec.bits_per_sample - 1)) as f32).collect(),
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap()).collect(),
    };
    raw.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect()
}

fn wer(reference: &str, hyp: &str) -> f64 {
    let norm = |s: &str| s.to_lowercase().split_whitespace().map(|w| w.chars().filter(|c| c.is_alphanumeric() || *c == '\'').collect::<String>()).filter(|w| !w.is_empty()).collect::<Vec<_>>();
    let (r, h) = (norm(reference), norm(hyp));
    let mut d: Vec<Vec<usize>> = (0..=r.len()).map(|i| vec![i; h.len() + 1]).collect();
    for j in 0..=h.len() {
        d[0][j] = j;
    }
    for i in 1..=r.len() {
        for j in 1..=h.len() {
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + usize::from(r[i - 1] != h[j - 1]));
        }
    }
    d[r.len()][h.len()] as f64 / r.len().max(1) as f64
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (wav, truth_path) = (&args[1], &args[2]);
    let lang = args.get(3).map(|s| s.as_str()).unwrap_or("en");
    let base = PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.mlp.lyrics").join("models");

    for id in ["mms-aligner", "whisper-turbo"] {
        let t = Instant::now();
        let mut last = 0u64;
        tauri::async_runtime::block_on(models::ensure(&base, id, |p| {
            if p.done - last > 200 << 20 || p.done == p.total {
                last = p.done;
                println!("  {} {}: {} / {} MB", p.id, p.file, p.done >> 20, p.total >> 20);
            }
        }))
        .expect("download");
        println!("model {id} ready in {:.1}s", t.elapsed().as_secs_f64());
    }

    let audio = read_wav(wav);
    let truth: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(truth_path).unwrap()).unwrap();
    let text = truth["text"].as_str().unwrap().to_string();
    let secs = audio.len() as f64 / 16_000.0;
    println!("clip: {secs:.1}s, {} words", text.split_whitespace().count());
    let mem0 = gpu_mem_mb();

    // --- forced alignment ---
    let t = Instant::now();
    let mut al = Aligner::load(&base.join("mms-aligner"), true).expect("aligner");
    println!("aligner on {:?}, load {:.2}s", al.device, t.elapsed().as_secs_f64());
    for run in 0..2 {
        let t = Instant::now();
        let words = al.align_text(&audio, &text).expect("align");
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if run == 1 {
            let truth_words = truth["words"].as_array().unwrap();
            let mut errs: Vec<f64> = words
                .iter()
                .zip(truth_words)
                .map(|(w, tw)| (w.start_ms - tw["ms"].as_f64().unwrap()).abs())
                .collect();
            errs.sort_by(f64::total_cmp);
            let med = errs[errs.len() / 2];
            let p90 = errs[errs.len() * 9 / 10];
            println!("align (warm): {ms:.0} ms for {secs:.0}s audio = {:.0}x real time; word-start error median {med:.0} ms, p90 {p90:.0} ms over {} words", secs * 1000.0 / ms, errs.len());
        } else {
            println!("align (cold): {ms:.0} ms");
        }
    }
    let mem1 = gpu_mem_mb();

    // --- transcription (first 30 s) ---
    let t = Instant::now();
    let mut wh = Whisper::load(&base.join("whisper-turbo"), true).expect("whisper");
    println!("whisper on {:?}, load {:.2}s", wh.device, t.elapsed().as_secs_f64());
    let clip = &audio[..audio.len().min(30 * 16_000)];
    for run in 0..2 {
        let t = Instant::now();
        let out = wh.transcribe(clip, Some(lang)).expect("transcribe");
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if run == 1 {
            let ref_words: Vec<&str> = text.split_whitespace().collect();
            let truth_words = truth["words"].as_array().unwrap();
            let n_in_clip = truth_words.iter().filter(|w| w["ms"].as_f64().unwrap() < 29_000.0).count().min(ref_words.len());
            println!("transcribe (warm): {ms:.0} ms for {:.0}s = {:.0}x real time; WER {:.0}%", clip.len() as f64 / 16_000.0, clip.len() as f64 / 16.0 / ms, wer(&ref_words[..n_in_clip].join(" "), &out) * 100.0);
            println!("  → {out}");
        } else {
            println!("transcribe (cold): {ms:.0} ms");
        }
    }
    let mem2 = gpu_mem_mb();
    println!("GPU memory used (whole card): before {mem0:?} MB, +aligner {mem1:?} MB, +whisper {mem2:?} MB");
}
