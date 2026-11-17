//! Upgrade 16 — updates from GitHub Releases (latest.json + signed installer). The feed address is
//! a setting (the project's GitHub repo); the public key is compiled in (updater.pub).

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

const PUBKEY: &str = include_str!("../updater.pub");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    /// newer version, None = up to date
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

fn updater(app: &AppHandle, url: &str) -> Result<tauri_plugin_updater::Updater, String> {
    let url = url.trim();
    if !url.starts_with("https://") {
        return Err("The update feed must be an https:// address.".into());
    }
    app.updater_builder()
        .pubkey(PUBKEY.trim())
        .endpoints(vec![url.parse().map_err(|e| format!("bad feed address: {e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_check(app: AppHandle, url: String) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    match updater(&app, &url)?.check().await.map_err(|e| format!("Couldn't check for updates: {e}"))? {
        Some(u) => Ok(UpdateInfo { current, version: Some(u.version.clone()), notes: u.body.clone(), date: u.date.map(|d| d.to_string()) }),
        None => Ok(UpdateInfo { current, version: None, notes: None, date: None }),
    }
}

/// Download (signature-checked), run the installer and restart.
#[tauri::command]
pub async fn update_install(app: AppHandle, url: String) -> Result<(), String> {
    let Some(u) = updater(&app, &url)?.check().await.map_err(|e| e.to_string())? else {
        return Err("No update available.".into());
    };
    let a = app.clone();
    let mut got = 0u64;
    u.download_and_install(
        move |chunk, total| {
            got += chunk as u64;
            let _ = a.emit("update-progress", serde_json::json!({ "got": got, "total": total.unwrap_or(0) }));
        },
        || {},
    )
    .await
    .map_err(|e| format!("Update failed: {e}"))?;
    app.restart();
}
