//! Saved AI timing (auto-sync): readable `.json` files in `<app data>\ai\timing\` (one per song).
//! The UI builds the file names and the content; these commands only accept plain `.json` names
//! inside that folder.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Same "ai" folder as the models (ai.rs) — one folder, also on case-sensitive file systems.
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai").join("timing"))
}

/// A bare file name ending in .json: no folders, no reserved characters, no `..`.
fn checked(name: &str) -> Result<&str, String> {
    let ok = name.ends_with(".json")
        && name.len() <= 220
        && !name.starts_with('.')
        && !name.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c));
    if ok { Ok(name) } else { Err(format!("bad file name: {name}")) }
}

fn path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(dir(app)?.join(checked(name)?))
}

fn json_files(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(entries) = dir(app).and_then(|d| std::fs::read_dir(d).map_err(|e| e.to_string())) else { return vec![] };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
        .collect()
}

#[tauri::command]
pub fn timing_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path(&app, &name)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn timing_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let p = path(&app, &name)?;
    std::fs::create_dir_all(dir(&app)?).map_err(|e| e.to_string())?;
    // Temp file then rename: a crash never leaves half a file.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn timing_delete(app: AppHandle, name: String) -> Result<bool, String> {
    match std::fs::remove_file(path(&app, &name)?) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// How many timing files there are.
#[tauri::command]
pub fn timing_count(app: AppHandle) -> u32 {
    json_files(&app).len() as u32
}

/// Delete every timing file (only `.json` files in the folder). Returns how many.
#[tauri::command]
pub fn timing_clear(app: AppHandle) -> u32 {
    json_files(&app).iter().filter(|p| std::fs::remove_file(p).is_ok()).count() as u32
}

/// Open the folder in the file manager (created first so there's something to open).
#[tauri::command]
pub fn timing_open_folder(app: AppHandle) -> Result<String, String> {
    let d = dir(&app)?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let cmd = "explorer";
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd).arg(&d).spawn().map_err(|e| e.to_string())?;
    Ok(d.display().to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_plain_json_names() {
        assert!(super::checked("晴天 - 周杰倫.json").is_ok());
        assert!(super::checked("Song - Artist (2).json").is_ok());
        assert!(super::checked("../x.json").is_err());
        assert!(super::checked("a\\b.json").is_err());
        assert!(super::checked("a/b.json").is_err());
        assert!(super::checked("song.txt").is_err());
        assert!(super::checked(".json").is_err());
    }
}
