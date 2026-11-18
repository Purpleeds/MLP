//! Saved translations: readable `.txt` files in `<app data>\saved translation\` (one per song).
//! The UI builds the file names; these commands only accept plain `.txt` names inside that folder.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("saved translation"))
}

/// A bare file name ending in .txt: no folders, no reserved characters, no `..`.
fn checked(name: &str) -> Result<&str, String> {
    let ok = name.ends_with(".txt")
        && name.len() <= 200
        && !name.starts_with('.')
        && !name.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c));
    if ok { Ok(name) } else { Err(format!("bad file name: {name}")) }
}

fn path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(dir(app)?.join(checked(name)?))
}

#[tauri::command]
pub fn tr_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path(&app, &name)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn tr_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let p = path(&app, &name)?;
    std::fs::create_dir_all(dir(&app)?).map_err(|e| e.to_string())?;
    // Write a temp file then rename, so a crash never leaves half a file.
    let tmp = p.with_extension("txt.tmp");
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tr_delete(app: AppHandle, name: String) -> Result<bool, String> {
    match std::fs::remove_file(path(&app, &name)?) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete every saved translation (only `.txt` files in the folder). Returns how many.
#[tauri::command]
pub fn tr_clear(app: AppHandle) -> Result<u32, String> {
    let Ok(entries) = std::fs::read_dir(dir(&app)?) else { return Ok(0) };
    let mut n = 0;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() && p.extension().is_some_and(|x| x == "txt") && std::fs::remove_file(&p).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/// Open the folder in the file manager (created first so there's something to open).
#[tauri::command]
pub fn tr_open_folder(app: AppHandle) -> Result<String, String> {
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

/// The old translations.json store could hold cached warning text: remove it once.
pub fn drop_old_store(app: &AppHandle) {
    if let Ok(d) = app.path().app_data_dir() {
        drop_old_store_in(&d);
    }
}

fn drop_old_store_in(dir: &std::path::Path) -> bool {
    match std::fs::remove_file(dir.join("translations.json")) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            println!("[translation] couldn't remove the old translations.json: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_plain_txt_names() {
        assert!(super::checked("夜空 - YOASOBI.txt").is_ok());
        assert!(super::checked("../x.txt").is_err());
        assert!(super::checked("a\\b.txt").is_err());
        assert!(super::checked("song.json").is_err());
        assert!(super::checked(".txt").is_err());
    }

    #[test]
    fn removes_the_old_store_once() {
        let d = std::env::temp_dir().join(format!("mlp-tr-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("translations.json"), "{}").unwrap();
        assert!(super::drop_old_store_in(&d));
        assert!(!d.join("translations.json").exists());
        assert!(!super::drop_old_store_in(&d)); // already gone: nothing to do
        std::fs::remove_dir_all(&d).unwrap();
    }
}
