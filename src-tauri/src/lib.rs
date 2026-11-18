mod ai;
mod art_cache;
mod obs;
mod share;
mod timing_files;
mod translations;
mod update;
#[cfg(windows)]
mod dock;
#[cfg(not(windows))]
#[path = "dock_unix.rs"]
mod dock;
mod spotify;
mod aligner;
mod ctc;
mod perf;
#[cfg(windows)]
mod capture;
#[cfg(not(windows))]
#[path = "capture_unix.rs"]
mod capture;
mod vocals;
mod japanese;
mod lrclib;
mod thai;
#[cfg(windows)]
mod media;
#[cfg(not(windows))]
#[path = "media_unix.rs"]
mod media;
mod tray;

use tauri::{WebviewUrl, WebviewWindowBuilder};

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Whether the main window currently ignores mouse input (click-through "lock").
pub static LOCKED: AtomicBool = AtomicBool::new(false);

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Show the lyrics window (tray / second instance). The frontend hears `main-shown` so auto-hide
/// doesn't immediately hide a window the user just asked for. Always-on-top follows the user's setting.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = app.emit("main-shown", ());
    }
}

pub fn toggle_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

pub fn set_locked(app: &AppHandle, locked: bool) {
    LOCKED.store(locked, Ordering::SeqCst);
    if let Some(w) = main_window(app) {
        let _ = w.set_ignore_cursor_events(locked);
    }
    tray::sync_lock_item(app, locked);
    let _ = app.emit("lock-changed", locked);
}

/// Open (or focus) the settings window. Window creation runs off the calling thread:
/// building a webview from a menu / single-instance callback on Windows can deadlock.
pub fn open_settings(app: &AppHandle) {
    open_settings_tab(app, None);
}

pub fn open_settings_tab(app: &AppHandle, tab: Option<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { open_settings_now(&app, tab) });
}

fn open_settings_now(app: &AppHandle, tab: Option<String>) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(t) = tab {
            let _ = w.emit("settings-tab", t);
        }
        return;
    }
    let url = match &tab {
        Some(t) if t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => format!("index.html?window=settings&tab={t}"),
        _ => "index.html?window=settings".to_string(),
    };
    let built = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(url.into()))
        .title("MLP Settings")
        .theme(Some(tauri::Theme::Dark))
        .inner_size(860.0, 660.0)
        .min_inner_size(640.0, 460.0)
        .center()
        .build();
    if let Err(e) = built {
        eprintln!("[settings] failed to open: {e}");
    }
}

#[tauri::command]
fn open_settings_window(app: AppHandle, tab: Option<String>) {
    open_settings_tab(&app, tab);
}

/// True when started by autostart (`--hidden`): stay in the tray until music plays or the user opens it.
#[tauri::command]
fn launched_hidden() -> bool {
    std::env::args().any(|a| a == "--hidden")
}

/// Installed font family names (for the font picker).
#[tauri::command]
async fn list_fonts() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut names: Vec<String> = db
        .faces()
        .filter_map(|f| f.families.first().map(|(n, _)| n.clone()))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

/// Dev aid: `MLP_MOCK=1` makes the UI use the built-in mock song (for profiling without a player).
#[tauri::command]
/// `MLP_MOCK=ai` plays the mock song as a real track (no built-in lyrics → AI lyrics path).
fn dev_mock() -> Option<String> {
    std::env::var("MLP_MOCK").ok().filter(|v| v == "1" || v == "ai")
}

/// Frontend diagnostics end up in the dev console / stdout.
#[tauri::command]
fn log_message(msg: String) {
    println!("[ui] {msg}");
}

#[tauri::command]
fn set_click_through(app: AppHandle, locked: bool) {
    set_locked(&app, locked);
}

#[tauri::command]
fn is_click_through() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

/// First launch (no saved window state): place the window bottom-right, just above the taskbar near the clock.
fn place_near_clock(w: &WebviewWindow) {
    let Ok(Some(monitor)) = w.primary_monitor() else { return };
    let Ok(size) = w.outer_size() else { return };
    let area = monitor.work_area();
    let margin = (16.0 * monitor.scale_factor()) as i32;
    let x = area.position.x + area.size.width as i32 - size.width as i32 - margin;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Dev aid (debug builds only): load WAVs (16 kHz mono) as the captured and isolated audio of a song
/// (`key` = "{sourceApp}|{artist}|{title}"), to re-run auto-sync / measurements on recorded songs.
#[tauri::command]
fn debug_load_audio(key: String, mix: String, vocals: Option<String>) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        let m = ai::read_wav_16k(std::path::Path::new(&mix))?;
        capture::debug_load(key.clone(), &m);
        #[cfg(feature = "onnx")]
        if let Some(v) = &vocals {
            vocals::debug_load(key.clone(), &ai::read_wav_16k(std::path::Path::new(v))?);
        }
        Ok(format!("{:.1} s loaded as {key}", m.len() as f64 / 16_000.0))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (key, mix, vocals);
        Err("debug builds only".into())
    }
}

pub fn run() {
    // Restore position/size only; the frontend shows the window after its first paint.
    let state_flags = StateFlags::POSITION | StateFlags::SIZE;

    // Dev aid (debug builds): MLP_DEV_MULTI=1 runs beside an installed copy instead of handing over to it.
    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let multi = std::env::var("MLP_DEV_MULTI").is_ok();
    #[cfg(not(debug_assertions))]
    let multi = false;
    let builder = if multi { builder } else { builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // `mlp.exe --settings` (e.g. from a shortcut) opens the settings window.
            if let Some(tab) = args.iter().find_map(|a| a.strip_prefix("--settings=")) {
                open_settings_tab(app, Some(tab.to_string()));
            } else if args.iter().any(|a| a == "--settings") {
                open_settings(app);
            } else {
                show_main(app);
            }
        })) };
    builder
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(state_flags)
                .with_denylist(&["settings"])
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().args(["--hidden"]).build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            debug_load_audio,
            set_click_through,
            is_click_through,
            open_settings_window,
            launched_hidden,
            log_message,
            dev_mock,
            list_fonts,
            japanese::jp_readings,
            lrclib::lrclib_solve,
            thai::th_romanize,
            ai::ai_status,
            ai::ai_download,
            ai::ai_delete,
            ai::ai_spike,
            capture::capture_status,
            capture::set_capture,
            capture::capture_dump,
            capture::set_capture_latency,
            capture::capture_beep_check,
            capture::open_capture_test,
            vocals::vocals_set,
            vocals::vocals_status,
            vocals::vocals_dump,
            perf::ai_set_limits,
            perf::ai_busy,
            dock::dock_bar,
            dock::undock_bar,
            dock::window_covered,
            obs::obs_set,
            obs::obs_update,
            share::save_image,
            translations::tr_read,
            translations::tr_write,
            translations::tr_delete,
            translations::tr_clear,
            translations::tr_open_folder,
            timing_files::timing_read,
            timing_files::timing_write,
            timing_files::timing_delete,
            timing_files::timing_count,
            timing_files::timing_clear,
            timing_files::timing_open_folder,
            update::update_check,
            update::update_install,
            ai::jp_dict_status,
            ai::jp_dict_ensure,
            spotify::spotify_status,
            spotify::spotify_login,
            spotify::spotify_logout,
            spotify::spotify_now,
            ai::ai_transcribe,
            aligner::ai_align,
            aligner::ai_unload,
            media::get_now_playing,
            media::media_control,
            media::set_media_config
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let has_saved_state = app
                .path()
                .app_config_dir()
                .map(|d| d.join(tauri_plugin_window_state::DEFAULT_FILENAME).exists())
                .unwrap_or(false);
            if let Some(w) = main_window(&handle) {
                if !has_saved_state {
                    place_near_clock(&w);
                }
            }
            tray::create(&handle)?;
            translations::drop_old_store(&handle);
            // Upgrade 17: Japanese dictionary from the download folder (if it's there yet).
            japanese::set_dict_dir(ai::ipadic_dir(&handle));
            media::start(handle.clone());
            // Dev aid (debug builds only): MLP_CAPTURE_DUMP=path.wav → capture the player and save the
            // current song's audio there every 3 s, for checking alignment against a known signal.
            // Dev aid (debug builds only): MLP_FAKE_CAPTURE="file.wav|sourceApp|artist|title" → that WAV
            // counts as already captured for that song (end-to-end check of auto-sync without a player).
            #[cfg(debug_assertions)]
            if let Ok(spec) = std::env::var("MLP_FAKE_CAPTURE") {
                if let Some((wav, key)) = spec.split_once('|') {
                    match ai::read_wav_16k(std::path::Path::new(wav)) {
                        Ok(s) => {
                            println!("[capture] fake: {:.1} s as {key}", s.len() as f64 / 16_000.0);
                            capture::debug_load(key.to_string(), &s);
                        }
                        Err(e) => println!("[capture] fake failed: {e}"),
                    }
                }
            }
            #[cfg(debug_assertions)]
            if let Ok(path) = std::env::var("MLP_CAPTURE_DUMP") {
                capture::set_capture(true);
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let st = capture::capture_status();
                    println!("[capture] app={} pid={} level={:.3} covered={:?} err={:?}", st.app, st.pid, st.level, st.covered, st.error);
                    if let Ok(msg) = capture::capture_dump(path.clone()) {
                        println!("[capture] saved {msg}");
                    }
                });
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Closing hides to tray; Quit lives in the tray menu.
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.app_handle().save_window_state(state_flags);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
