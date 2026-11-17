//! Taskbar bar / covered-window check on macOS and Linux (Upgrade 21): the bar is placed in the
//! bottom-right corner of the work area (no taskbar API); the covered check isn't available.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

#[tauri::command]
pub fn dock_bar(app: AppHandle, placement: String, width: f64, height: f64) -> Result<(), String> {
    let _ = placement;
    let w = app.get_webview_window("main").ok_or("no main window")?;
    let mon = w.current_monitor().map_err(|e| e.to_string())?.ok_or("no monitor")?;
    let scale = mon.scale_factor();
    let area = mon.work_area();
    let (bw, bh) = ((width * scale) as i32, (height * scale) as i32);
    let gap = (6.0 * scale) as i32;
    w.set_size(PhysicalSize::new(bw as u32, bh as u32)).map_err(|e| e.to_string())?;
    w.set_position(PhysicalPosition::new(
        area.position.x + area.size.width as i32 - bw - gap,
        area.position.y + area.size.height as i32 - bh - gap,
    ))
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn undock_bar() {}

#[tauri::command]
pub fn window_covered(_app: AppHandle) -> bool {
    false
}
