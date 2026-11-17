//! Model manager: AI models are downloaded on demand from Hugging Face into `<app data>/models/<id>/`,
//! resumed with HTTP Range after interruptions, verified against the Hub's SHA-256 (LFS oid), and can be
//! deleted again. Nothing is bundled in the installer.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_http::reqwest;

pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub purpose: &'static str,
    pub license: &'static str,
    pub repo: &'static str,
    /// files inside the repo (kept with their folder structure)
    pub files: &'static [&'static str],
}

/// Models used by Phase 2 (sizes come from the Hub at download time).
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "whisper-turbo",
        name: "Whisper large-v3-turbo (fp16)",
        purpose: "Writes down lyrics for songs no database has",
        license: "MIT",
        repo: "onnx-community/whisper-large-v3-turbo",
        files: &[
            "onnx/encoder_model_fp16.onnx",
            "onnx/decoder_model_fp16.onnx",
            "vocab.json",
            "added_tokens.json",
            "preprocessor_config.json",
        ],
    },
    ModelSpec {
        id: "mms-aligner",
        name: "MMS-300m forced aligner (fp16)",
        purpose: "Lines up known lyrics with the singing, word by word",
        license: "CC-BY-NC-4.0 (non-commercial)",
        repo: "onnx-community/mms-300m-1130-forced-aligner-ONNX",
        files: &["onnx/model_fp16.onnx", "vocab.json", "preprocessor_config.json"],
    },
];

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn model_dir(base: &Path, id: &str) -> PathBuf {
    base.join(id)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub license: String,
    pub installed: bool,
    pub bytes_on_disk: u64,
}

/// A file counts as installed once its `.ok` marker (written after verification) exists.
fn verified(path: &Path) -> bool {
    path.exists() && marker(path).exists()
}
fn marker(path: &Path) -> PathBuf {
    let mut m = path.as_os_str().to_owned();
    m.push(".ok");
    PathBuf::from(m)
}
fn part(path: &Path) -> PathBuf {
    let mut m = path.as_os_str().to_owned();
    m.push(".part");
    PathBuf::from(m)
}

fn dir_size(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| {
            rd.flatten()
                .map(|e| match e.metadata() {
                    Ok(m) if m.is_dir() => dir_size(&e.path()),
                    Ok(m) => m.len(),
                    Err(_) => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}

pub fn status(base: &Path) -> Vec<ModelStatus> {
    MODELS
        .iter()
        .map(|m| {
            let dir = model_dir(base, m.id);
            ModelStatus {
                id: m.id.into(),
                name: m.name.into(),
                purpose: m.purpose.into(),
                license: m.license.into(),
                installed: m.files.iter().all(|f| verified(&dir.join(f))),
                bytes_on_disk: dir_size(&dir),
            }
        })
        .collect()
}

pub fn delete(base: &Path, id: &str) -> std::io::Result<()> {
    let dir = model_dir(base, id);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub file: String,
    pub done: u64,
    pub total: u64,
}

/// Set to cancel all running downloads (they keep their `.part` files for resuming).
pub static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(serde::Deserialize)]
struct TreeEntry {
    path: String,
    size: u64,
    lfs: Option<Lfs>,
}
#[derive(serde::Deserialize)]
struct Lfs {
    oid: String,
}

/// Expected size + SHA-256 (LFS files only) for each file, from the Hub tree API.
async fn hub_meta(client: &reqwest::Client, repo: &str, files: &[&str]) -> Result<Vec<(u64, Option<String>)>, String> {
    let mut dirs: Vec<&str> = files.iter().map(|f| f.rsplit_once('/').map(|(d, _)| d).unwrap_or("")).collect();
    dirs.sort();
    dirs.dedup();
    let mut entries: Vec<TreeEntry> = Vec::new();
    for d in dirs {
        let url = format!("https://huggingface.co/api/models/{repo}/tree/main/{d}");
        let res = client.get(&url).send().await.map_err(|e| format!("model list: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("model list: HTTP {}", res.status()));
        }
        entries.extend(res.json::<Vec<TreeEntry>>().await.map_err(|e| format!("model list: {e}"))?);
    }
    files
        .iter()
        .map(|f| {
            entries
                .iter()
                .find(|e| e.path == *f)
                .map(|e| (e.size, e.lfs.as_ref().map(|l| l.oid.clone())))
                .ok_or_else(|| format!("{f} is missing on the Hub"))
        })
        .collect()
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Download (or resume / skip) every file of a model, then verify it.
pub async fn ensure(base: &Path, id: &str, mut on_progress: impl FnMut(Progress)) -> Result<PathBuf, String> {
    let m = spec(id).ok_or_else(|| format!("unknown model {id}"))?;
    let dir = model_dir(base, id);
    if m.files.iter().all(|f| verified(&dir.join(f))) {
        return Ok(dir);
    }
    CANCEL.store(false, Ordering::SeqCst);
    let client = reqwest::Client::builder()
        .user_agent("MLP/0.1.0 (floating lyrics for Windows)")
        .build()
        .map_err(|e| e.to_string())?;
    let meta = hub_meta(&client, m.repo, m.files).await?;

    for (file, (size, sha)) in m.files.iter().zip(meta) {
        let dest = dir.join(file);
        if verified(&dest) {
            continue;
        }
        std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        let tmp = part(&dest);
        let mut have = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        if have > size {
            let _ = std::fs::remove_file(&tmp);
            have = 0;
        }
        if have < size {
            let url = format!("https://huggingface.co/{}/resolve/main/{}", m.repo, file);
            let mut req = client.get(&url);
            if have > 0 {
                req = req.header("Range", format!("bytes={have}-"));
            }
            let mut res = req.send().await.map_err(|e| format!("{file}: {e}"))?;
            let resumed = res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
            if !res.status().is_success() {
                return Err(format!("{file}: HTTP {}", res.status()));
            }
            if have > 0 && !resumed {
                have = 0; // server ignored Range: start over
            }
            let mut out = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(resumed)
                .truncate(!resumed)
                .open(&tmp)
                .map_err(|e| e.to_string())?;
            let mut last_report = 0u64;
            while let Some(chunk) = res.chunk().await.map_err(|e| format!("{file}: {e}"))? {
                if CANCEL.load(Ordering::SeqCst) {
                    return Err("cancelled".into());
                }
                out.write_all(&chunk).map_err(|e| e.to_string())?;
                have += chunk.len() as u64;
                if have - last_report > 4 << 20 || have == size {
                    last_report = have;
                    on_progress(Progress { id: id.into(), file: (*file).into(), done: have, total: size });
                }
            }
            out.flush().map_err(|e| e.to_string())?;
        }
        if let Some(expected) = sha {
            let got = sha256_file(&tmp).map_err(|e| e.to_string())?;
            if got != expected {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("{file}: checksum mismatch (download corrupted, try again)"));
            }
        } else if std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0) != size {
            return Err(format!("{file}: incomplete download"));
        }
        std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        std::fs::write(marker(&dest), b"verified").map_err(|e| e.to_string())?;
        on_progress(Progress { id: id.into(), file: (*file).into(), done: size, total: size });
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reports_missing_models() {
        let base = std::env::temp_dir().join("mlp-models-test-empty");
        let s = status(&base);
        assert_eq!(s.len(), MODELS.len());
        assert!(s.iter().all(|m| !m.installed && m.bytes_on_disk == 0));
    }

    #[test]
    fn marker_and_part_paths() {
        let p = Path::new("C:/x/onnx/model.onnx");
        assert!(marker(p).to_string_lossy().ends_with("model.onnx.ok"));
        assert!(part(p).to_string_lossy().ends_with("model.onnx.part"));
    }
}
