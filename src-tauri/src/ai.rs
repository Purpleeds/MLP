//! Local AI: on-demand downloads (whisper.cpp runtime + Whisper models) into the app data folder,
//! and a `whisper-server` sidecar kept running on 127.0.0.1 for transcription.
//! Nothing is bundled with the installer; audio never leaves the PC.

use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Windows process-creation flags (no console window, priority class); no-ops elsewhere.
trait CommandFlags {
    fn flags(&mut self, f: u32) -> &mut Self;
    fn no_window(&mut self) -> &mut Self {
        self.flags(CREATE_NO_WINDOW)
    }
}
impl CommandFlags for Command {
    #[cfg(windows)]
    fn flags(&mut self, f: u32) -> &mut Self {
        self.creation_flags(f)
    }
    #[cfg(not(windows))]
    fn flags(&mut self, _f: u32) -> &mut Self {
        self
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: &'static str,
    pub name: &'static str,
    /// runtime (zip, extracted) or model (single file)
    pub kind: &'static str,
    pub url: &'static str,
    pub size_mb: u32,
    /// SHA-256 of the downloaded file (checked before it is used; URLs are pinned to a revision)
    pub sha256: &'static str,
    pub note: &'static str,
}

/// Official whisper.cpp release binaries and ggml models (Hugging Face, ggerganov/whisper.cpp).
pub const CATALOG: &[Asset] = &[
    Asset {
        id: "whisper-cuda",
        name: "Whisper engine (NVIDIA GPU)",
        kind: "runtime",
        url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip",
        size_mb: 685,
        sha256: "afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a",
        note: "whisper.cpp b5454, CUDA 12.4",
    },
    Asset {
        id: "whisper-cpu",
        name: "Whisper engine (CPU)",
        kind: "runtime",
        url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip",
        size_mb: 22,
        sha256: "b1158bd10edf92c9799149a6fc5d3e58da3f495241d6fb3423088130e88ffbf3",
        note: "whisper.cpp b5454, OpenBLAS",
    },
    Asset {
        id: "large-v3-turbo-q5_0",
        name: "Whisper large-v3 turbo (q5)",
        kind: "model",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
        size_mb: 574,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        note: "best speed/quality balance",
    },
    Asset {
        id: "large-v3-turbo-q8_0",
        name: "Whisper large-v3 turbo (q8)",
        kind: "model",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q8_0.bin",
        size_mb: 874,
        sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
        note: "a little more accurate",
    },
    Asset {
        id: "base",
        name: "Whisper base",
        kind: "model",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin",
        size_mb: 148,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        note: "tiny, for testing",
    },
    Asset {
        id: "htdemucs-vocals",
        name: "Vocal isolation (HT-Demucs FT vocals, fp16)",
        kind: "model",
        url: "https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx/resolve/2ef0d757d3e226d0da85fb8c71514f464fcabdd0/htdemucs_ft_vocals_fp16weights.onnx",
        size_mb: 158,
        sha256: "0cbe651f535415c9d26a7bb614f7d322dd5a080fa0298f2e50f478030a994dce",
        note: "ONNX, MIT license; runs on the CPU in the background",
    },
    Asset {
        id: "ipadic",
        name: "Japanese dictionary (IPADIC for Lindera)",
        kind: "runtime",
        url: "https://github.com/lindera/lindera/releases/download/v6.2.0/lindera-ipadic-6.2.0.zip",
        size_mb: 11,
        sha256: "5ed4bba6b429030b0387df67d40d5751d35dedef0306f4bac6d957cad5f04b72",
        note: "for romaji; downloaded when the first Japanese song plays",
    },
    Asset {
        id: "mms-aligner",
        name: "Auto-sync (MMS-300m forced aligner, int8)",
        kind: "model",
        url: "https://huggingface.co/onnx-community/mms-300m-1130-forced-aligner-ONNX/resolve/2100fb247d8e43962eef24491597fbeb8b469531/onnx/model_quantized.onnx",
        size_mb: 317,
        sha256: "dc79e3bd48bffa9b4fb850d6195710d4eeb13e2fdf1f521eccbca512ab530254",
        note: "ONNX on the CPU; finds when each lyric word is sung",
    },
];

static DOWNLOADING: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static SERVER: Mutex<Option<(Child, u16, String)>> = Mutex::new(None);

pub fn ai_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("ai")
}

fn asset(id: &str) -> Option<&'static Asset> {
    CATALOG.iter().find(|a| a.id == id)
}

fn asset_path(dir: &Path, a: &Asset) -> PathBuf {
    match a.kind {
        "runtime" => dir.join("runtime").join(a.id),
        _ => dir.join("models").join(format!("{}.bin", a.id)),
    }
}

fn installed(dir: &Path, a: &Asset) -> bool {
    let p = asset_path(dir, a);
    if a.kind == "runtime" {
        find_exe(&p, marker(a)).is_some()
    } else {
        p.metadata().map(|m| m.len() > 1_000_000).unwrap_or(false)
    }
}

/// File that proves a runtime archive was unpacked.
fn marker(a: &Asset) -> &'static str {
    if a.id == "ipadic" {
        "metadata.json"
    } else {
        "whisper-server.exe"
    }
}

/// The unpacked IPADIC folder (the one holding metadata.json), if downloaded.
pub fn ipadic_dir(app: &AppHandle) -> Option<PathBuf> {
    let a = asset("ipadic")?;
    find_exe(&asset_path(&ai_dir(app), a), marker(a)).and_then(|p| p.parent().map(Path::to_path_buf))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictStatus {
    pub ready: bool,
    pub installed: bool,
    pub downloading: bool,
}

/// Upgrade 17: is the Japanese dictionary there (and loaded)?
#[tauri::command]
pub fn jp_dict_status(app: AppHandle) -> DictStatus {
    let installed = ipadic_dir(&app).is_some();
    let downloading = DOWNLOADING.lock().unwrap().as_ref().map(|s| s.contains("ipadic")).unwrap_or(false);
    DictStatus { ready: installed && crate::japanese::dict_ready(), installed, downloading }
}

fn find_exe(dir: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_exe(&p, name) {
                return Some(f);
            }
        } else if p.file_name().map(|n| n.eq_ignore_ascii_case(name)).unwrap_or(false) {
            return Some(p);
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetStatus {
    #[serde(flatten)]
    pub asset: Asset,
    pub installed: bool,
    pub downloading: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub gpu: Option<String>,
    pub assets: Vec<AssetStatus>,
    pub server: Option<String>,
    pub dir: String,
}

/// NVIDIA GPU name + memory (None without an NVIDIA driver).
pub fn gpu_name() -> Option<String> {
    let out = Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader"])
        .no_window()
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[tauri::command]
pub async fn ai_status(app: AppHandle) -> AiStatus {
    let dir = ai_dir(&app);
    let busy = DOWNLOADING.lock().unwrap().clone().unwrap_or_default();
    let gpu = tauri::async_runtime::spawn_blocking(gpu_name).await.ok().flatten();
    AiStatus {
        gpu,
        assets: CATALOG
            .iter()
            .map(|a| AssetStatus { asset: *a, installed: installed(&dir, a), downloading: busy.contains(a.id) })
            .collect(),
        server: SERVER.lock().unwrap().as_ref().map(|(_, port, model)| format!("127.0.0.1:{port} · {model}")),
        dir: dir.display().to_string(),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    received: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

/// Download (resumable) and, for runtimes, extract. Emits `ai-download` progress events.
pub async fn download(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let a = asset(id).ok_or("unknown download")?;
    {
        let mut g = DOWNLOADING.lock().unwrap();
        let set = g.get_or_insert_with(HashSet::new);
        if !set.insert(id.to_string()) {
            return Err("already downloading".into());
        }
    }
    let result = download_inner(app, a).await;
    DOWNLOADING.lock().unwrap().as_mut().map(|s| s.remove(id));
    if id == "ipadic" && result.is_ok() {
        crate::japanese::set_dict_dir(ipadic_dir(app));
        let _ = app.emit("jp-dict-ready", ());
    }
    let _ = app.emit(
        "ai-download",
        Progress { id: id.into(), received: 0, total: 0, done: result.is_ok(), error: result.as_ref().err().cloned() },
    );
    result
}

async fn download_inner(app: &AppHandle, a: &Asset) -> Result<PathBuf, String> {
    let dir = ai_dir(app);
    let target = asset_path(&dir, a);
    if installed(&dir, a) {
        return Ok(target);
    }
    std::fs::create_dir_all(dir.join("downloads")).map_err(|e| e.to_string())?;
    let part = dir.join("downloads").join(format!("{}.part", a.id));
    let have = part.metadata().map(|m| m.len()).unwrap_or(0);

    let client = reqwest::Client::builder().user_agent(concat!("MLP/", env!("CARGO_PKG_VERSION"))).build().map_err(|e| e.to_string())?;
    let mut req = client.get(a.url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let res = req.send().await.map_err(|e| format!("download failed: {e}"))?;
    if res.status().as_u16() == 416 {
        // The leftover partial file is already complete or longer than the file: start over.
        let _ = std::fs::remove_file(&part);
        return Err("download failed: the partial file didn't match; try again".into());
    }
    if !res.status().is_success() {
        return Err(format!("download failed: HTTP {}", res.status()));
    }
    let resumed = res.status().as_u16() == 206;
    let total = res.content_length().unwrap_or(0) + if resumed { have } else { 0 };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(resumed)
        .write(true)
        .truncate(!resumed)
        .open(&part)
        .map_err(|e| e.to_string())?;
    let mut received = if resumed { have } else { 0 };
    let mut last = Instant::now();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            let _ = app.emit("ai-download", Progress { id: a.id.into(), received, total, done: false, error: None });
        }
    }
    drop(file);

    // Integrity: a cut-off or corrupted file would otherwise fail later inside whisper / ONNX Runtime.
    let (check, want) = (part.clone(), a.sha256);
    let ok = tauri::async_runtime::spawn_blocking(move || file_sha256(&check).map(|h| h == want))
        .await
        .map_err(|e| e.to_string())??;
    if !ok {
        let _ = std::fs::remove_file(&part);
        return Err("the download was damaged (checksum mismatch); try again".into());
    }

    if a.kind == "runtime" {
        let out = target.clone();
        let zip_path = part.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let f = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
            let mut z = zip::ZipArchive::new(f).map_err(|e| format!("bad archive: {e}"))?;
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            z.extract(&out).map_err(|e| format!("extract failed: {e}"))?;
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&part);
    } else {
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
    }
    Ok(target)
}

/// Lower-case hex SHA-256 of a file, read in 1 MB blocks.
pub fn file_sha256(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

#[tauri::command]
pub async fn ai_download(app: AppHandle, id: String) -> Result<(), String> {
    download(&app, &id).await.map(|_| ())
}

#[tauri::command]
pub async fn ai_delete(app: AppHandle, id: String) -> Result<(), String> {
    stop_server();
    if id == "ipadic" {
        crate::japanese::set_dict_dir(None);
    }
    let a = asset(&id).ok_or("unknown")?;
    let p = asset_path(&ai_dir(&app), a);
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

pub fn stop_server() {
    if let Some((mut child, _, _)) = SERVER.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(18_181)
}

/// Start (or reuse) whisper-server with the given runtime + model. Returns the port.
pub async fn ensure_server(app: &AppHandle, runtime: &str, model: &str) -> Result<u16, String> {
    // Thread / priority changes restart the server with the new limits.
    let id = format!("{runtime}/{model}/t{}/{}", crate::perf::threads(), crate::perf::low_priority());
    if let Some((child, port, m)) = SERVER.lock().unwrap().as_mut() {
        if *m == id && child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
            return Ok(*port);
        }
    }
    stop_server();
    let dir = ai_dir(app);
    let rt = asset(runtime).ok_or("unknown runtime")?;
    let md = asset(model).ok_or("unknown model")?;
    let exe = find_exe(&asset_path(&dir, rt), "whisper-server.exe").ok_or("Whisper engine isn't downloaded")?;
    let model_path = asset_path(&dir, md);
    if !model_path.exists() {
        return Err("Whisper model isn't downloaded".into());
    }
    let port = free_port();
    // Step 17 limits: CPU threads, below-normal priority; -sns drops "(music)"-style non-speech tokens.
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    let priority = if crate::perf::low_priority() { BELOW_NORMAL_PRIORITY_CLASS } else { 0 };
    let threads = crate::perf::threads().to_string();
    let child = Command::new(&exe)
        .current_dir(exe.parent().unwrap())
        .args(["-m", &model_path.to_string_lossy(), "--host", "127.0.0.1", "--port", &port.to_string(), "-l", "auto", "-t", &threads, "-sns"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .flags(CREATE_NO_WINDOW | priority)
        .spawn()
        .map_err(|e| format!("couldn't start Whisper: {e}"))?;
    *SERVER.lock().unwrap() = Some((child, port, id));
    // Loading the model takes a few seconds; wait until the HTTP port answers.
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(90) {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
        if let Some((c, _, _)) = SERVER.lock().unwrap().as_mut() {
            if let Ok(Some(st)) = c.try_wait() {
                return Err(format!("Whisper stopped while loading ({st})"));
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("Whisper took too long to start".into())
}

/// Transcribe 16 kHz mono f32 audio. Returns whisper-server's verbose JSON.
pub async fn transcribe(port: u16, samples: &[f32], language: Option<&str>, prompt: Option<&str>) -> Result<serde_json::Value, String> {
    let wav = wav_bytes(samples, 16_000);
    let part = reqwest::multipart::Part::bytes(wav).file_name("audio.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "verbose_json")
        .text("temperature", "0.0");
    if let Some(l) = language {
        form = form.text("language", l.to_string());
    }
    if let Some(p) = prompt.filter(|p| !p.trim().is_empty()) {
        form = form.text("prompt", p.to_string());
    }
    let res = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/inference"))
        .multipart(form)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("Whisper request failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Whisper HTTP {}", res.status()));
    }
    res.json().await.map_err(|e| format!("bad Whisper response: {e}"))
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    /// capture song key ("{sourceApp}|{artist}|{title}")
    pub key: String,
    pub from_ms: u64,
    pub to_ms: u64,
    /// use the isolated vocals (Step 14)
    pub vocals: bool,
    /// ISO code once the song's language is known (None = detect)
    pub language: Option<String>,
    /// last lines, for continuity
    pub prompt: Option<String>,
    /// Whisper model id from the catalog
    pub model: String,
    /// "auto" (NVIDIA GPU when available), "gpu" or "cpu"
    pub runtime: String,
}

/// Which Whisper engine to run: the GPU build when asked for / available and installed, else the CPU build.
fn pick_runtime(dir: &Path, pref: &str) -> Result<&'static str, String> {
    let gpu_ok = installed(dir, asset("whisper-cuda").unwrap());
    let cpu_ok = installed(dir, asset("whisper-cpu").unwrap());
    match pref {
        "gpu" if gpu_ok => Ok("whisper-cuda"),
        "cpu" if cpu_ok => Ok("whisper-cpu"),
        _ if gpu_ok && (pref == "gpu" || gpu_name().is_some()) => Ok("whisper-cuda"),
        _ if cpu_ok => Ok("whisper-cpu"),
        _ if gpu_ok => Ok("whisper-cuda"),
        _ => Err("Download a Whisper engine first (Settings → AI listening → AI lyrics).".into()),
    }
}

static GPU_FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Step 16: transcribe [from, to) of the captured song (vocals or mix) with whisper-server.
/// Returns Whisper's verbose JSON (times relative to `from`) plus `runtime`, `source`, `tookMs`.
#[tauri::command]
pub async fn ai_transcribe(app: AppHandle, req: TranscribeRequest) -> Result<serde_json::Value, String> {
    if req.to_ms <= req.from_ms || req.to_ms - req.from_ms > 30_000 {
        return Err("window must be 0–30 s".into());
    }
    #[cfg(feature = "onnx")]
    let vocals = if req.vocals { crate::vocals::snapshot(&req.key, req.from_ms, req.to_ms) } else { None };
    #[cfg(not(feature = "onnx"))]
    let vocals: Option<Vec<f32>> = None;
    let (audio, source) = match vocals {
        Some(v) => (v, "vocals"),
        None if req.vocals => return Err("those vocals aren't isolated yet".into()),
        None => (crate::capture::snapshot_covered(&req.key, req.from_ms, req.to_ms).ok_or("that part wasn't captured")?, "mix"),
    };
    let dir = ai_dir(&app);
    let pref = if GPU_FAILED.load(std::sync::atomic::Ordering::Relaxed) { "cpu" } else { req.runtime.as_str() };
    let mut runtime = pick_runtime(&dir, pref)?;
    let t0 = Instant::now();
    let port = match ensure_server(&app, runtime, &req.model).await {
        Ok(p) => p,
        Err(e) if runtime == "whisper-cuda" && installed(&dir, asset("whisper-cpu").unwrap()) => {
            // The CUDA build can fail on new GPUs / drivers: remember it and use the CPU build.
            eprintln!("[whisper] GPU engine failed ({e}); using the CPU engine");
            GPU_FAILED.store(true, std::sync::atomic::Ordering::Relaxed);
            runtime = "whisper-cpu";
            ensure_server(&app, runtime, &req.model).await?
        }
        Err(e) => return Err(e),
    };
    let mut json = transcribe(port, &audio, req.language.as_deref(), req.prompt.as_deref()).await?;
    json["runtime"] = runtime.into();
    json["source"] = source.into();
    json["tookMs"] = (t0.elapsed().as_millis() as u64).into();
    Ok(json)
}

pub fn wav_bytes(samples: &[f32], rate: u32) -> Vec<u8> {
    let mut v = Vec::with_capacity(44 + samples.len() * 2);
    let data_len = (samples.len() * 2) as u32;
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes()); // PCM
    v.extend_from_slice(&1u16.to_le_bytes()); // mono
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&(rate * 2).to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        v.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    v
}

/// Read a 16-bit PCM mono/stereo WAV and resample to 16 kHz mono (spike / tests).
pub fn read_wav_16k(path: &Path) -> Result<Vec<f32>, String> {
    let b = std::fs::read(path).map_err(|e| e.to_string())?;
    if b.len() < 44 || &b[0..4] != b"RIFF" {
        return Err("not a WAV file".into());
    }
    let ch = u16::from_le_bytes([b[22], b[23]]) as usize;
    let rate = u32::from_le_bytes([b[24], b[25], b[26], b[27]]) as f64;
    let mut i = 12;
    let (mut start, mut len) = (0, 0);
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let sz = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        if id == b"data" {
            start = i + 8;
            len = sz.min(b.len() - start);
            break;
        }
        i += 8 + sz;
    }
    let frames: Vec<f32> = b[start..start + len]
        .chunks_exact(2 * ch)
        .map(|f| f.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0).sum::<f32>() / ch as f32)
        .collect();
    Ok(crate::capture::resample(&frames, rate, 16_000.0))
}

/// Feasibility spike: transcribe a WAV with the given runtime/model; returns timing + text summary.
#[tauri::command]
pub async fn ai_spike(app: AppHandle, wav: String, runtime: String, model: String, language: Option<String>) -> Result<String, String> {
    let audio = read_wav_16k(Path::new(&wav))?;
    let t0 = Instant::now();
    let port = ensure_server(&app, &runtime, &model).await?;
    let load = t0.elapsed();
    let t1 = Instant::now();
    let json = transcribe(port, &audio, language.as_deref(), None).await?;
    let infer = t1.elapsed();
    let text = json.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
    Ok(format!(
        "audio {:.1}s · server start {:.1}s · transcribe {:.2}s ({:.0}× real time) · text: {}",
        audio.len() as f64 / 16_000.0,
        load.as_secs_f64(),
        infer.as_secs_f64(),
        (audio.len() as f64 / 16_000.0) / infer.as_secs_f64().max(0.001),
        text.chars().take(200).collect::<String>()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_pinned_and_hashed() {
        for a in CATALOG {
            assert_eq!(a.sha256.len(), 64, "{}", a.id);
            assert!(a.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{}", a.id);
            assert!(!a.url.contains("/resolve/main/"), "{} should be pinned to a revision", a.id);
        }
    }

    #[test]
    fn hashes_files() {
        let p = std::env::temp_dir().join("mlp-sha-test.txt");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(file_sha256(&p).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_file(&p);
    }
}
