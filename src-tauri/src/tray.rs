use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

pub const TRAY_ID: &str = "main-tray";

/// Holds the lock checkbox so its state can follow lock changes from any source.
pub struct LockItem(pub CheckMenuItem<Wry>);

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide lyrics", true, None::<&str>)?;
    let lock = CheckMenuItem::with_id(app, "lock", "Lock (click-through)", true, false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit MLP", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let modes = [
        ("full", "Full (art + info + lyrics)"),
        ("lyrics-title", "Lyrics + title"),
        ("lyrics", "Lyrics only"),
        ("card", "Now playing card"),
        ("title", "Title only"),
        ("mini", "Mini karaoke"),
        ("overlay", "Overlay (text over games / videos)"),
        ("bar", "Taskbar bar"),
        ("custom", "Custom"),
    ]
    .iter()
    .map(|(id, label)| MenuItem::with_id(app, format!("mode:{id}"), *label, true, None::<&str>))
    .collect::<tauri::Result<Vec<_>>>()?;
    let mode_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = modes.iter().map(|m| m as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    let mode_menu = Submenu::with_items(app, "Display mode", true, &mode_refs)?;
    let menu = Menu::with_items(app, &[&toggle, &lock, &mode_menu, &sep, &settings, &sep, &quit])?;
    app.manage(LockItem(lock));

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("MLP — Lyrics")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            id if id.starts_with("mode:") => {
                crate::show_main(app);
                let _ = app.emit("set-mode", &id[5..]);
            }
            "toggle" => crate::toggle_main(app),
            "lock" => {
                let locked = !crate::LOCKED.load(std::sync::atomic::Ordering::SeqCst);
                crate::set_locked(app, locked);
            }
            "settings" => crate::open_settings(app),
            "quit" => {
                let _ = app.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
                crate::ai::stop_server();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::toggle_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn sync_lock_item(app: &AppHandle, locked: bool) {
    if let Some(item) = app.try_state::<LockItem>() {
        let _ = item.0.set_checked(locked);
    }
}

pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}
