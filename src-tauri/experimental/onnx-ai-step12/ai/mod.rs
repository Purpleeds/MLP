//! Phase 2 — local AI listening. The model manager is always built (plain HTTPS downloads);
//! inference (ONNX Runtime + DirectML) only with the `ai` Cargo feature.

pub mod align;
pub mod models;

#[cfg(feature = "ai")]
pub mod aligner;
#[cfg(feature = "ai")]
pub mod mel;
#[cfg(feature = "ai")]
pub mod runtime;
#[cfg(feature = "ai")]
pub mod whisper;

use tauri::{AppHandle, Emitter, Manager};

fn base(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("models")).map_err(|e| e.to_string())
}

/// Whether this build can run the models (built with `--features ai`).
#[tauri::command]
pub fn ai_available() -> bool {
    cfg!(feature = "ai")
}

#[tauri::command]
pub fn ai_models(app: AppHandle) -> Result<Vec<models::ModelStatus>, String> {
    Ok(models::status(&base(&app)?))
}

/// Download a model; progress arrives as `ai-download` events.
#[tauri::command]
pub async fn ai_download(app: AppHandle, id: String) -> Result<(), String> {
    let dir = base(&app)?;
    let a = app.clone();
    models::ensure(&dir, &id, move |p| {
        let _ = a.emit("ai-download", &p);
    })
    .await
    .map(|_| ())
}

#[tauri::command]
pub fn ai_cancel_download() {
    models::CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn ai_delete(app: AppHandle, id: String) -> Result<(), String> {
    models::delete(&base(&app)?, &id).map_err(|e| e.to_string())
}
