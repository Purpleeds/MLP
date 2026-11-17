//! Upgrade 14 — save a share card (PNG made in the UI) to Pictures\MLP.

use base64::Engine;
use tauri::{AppHandle, Manager};

/// File-system-safe name: no reserved characters, no trailing dots/spaces, ≤ 80 chars.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c }).collect();
    let t: String = cleaned.trim().trim_end_matches(['.', ' ']).chars().take(80).collect();
    if t.is_empty() { "MLP".into() } else { t }
}

#[tauri::command]
pub fn save_image(app: AppHandle, name: String, png_base64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(png_base64.as_bytes()).map_err(|e| e.to_string())?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("not a PNG".into());
    }
    let dir = app.path().picture_dir().map_err(|e| e.to_string())?.join("MLP");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = safe_name(&name);
    let mut path = dir.join(format!("{base}.png"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} ({n}).png"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn cleans_file_names() {
        assert_eq!(super::safe_name("AC/DC: Back In Black?"), "AC_DC_ Back In Black_");
        assert_eq!(super::safe_name("  ...  "), "MLP");
    }
}
