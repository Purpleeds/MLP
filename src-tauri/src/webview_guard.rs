//! Reload a window's page when WebView2's renderer process dies. Without this, a crashed renderer
//! leaves the window showing WebView2's error page (dark in our dark-themed windows) until MLP is
//! restarted. A few reloads per minute at most, so a page that crashes on load can't loop forever.

use tauri::WebviewWindow;

#[cfg(windows)]
pub fn reload_on_renderer_crash(w: &WebviewWindow) {
    use std::time::{Duration, Instant};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    use webview2_com::ProcessFailedEventHandler;

    let label = w.label().to_string();
    let res = w.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let mut recent: Vec<Instant> = Vec::new();
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED && kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                return Ok(()); // GPU / utility processes restart by themselves
            }
            recent.retain(|t| t.elapsed() < Duration::from_secs(60));
            if recent.len() >= 3 {
                eprintln!("[webview] {label}: renderer failed again ({kind:?}); not reloading (3 in the last minute)");
                return Ok(());
            }
            recent.push(Instant::now());
            eprintln!("[webview] {label}: renderer failed ({kind:?}); reloading the page");
            if let Some(s) = sender {
                s.Reload()?;
            }
            Ok(())
        }));
        let mut token = Default::default();
        if let Err(e) = core.add_ProcessFailed(&handler, &mut token) {
            eprintln!("[webview] couldn't watch the renderer: {e}");
        }
    });
    if let Err(e) = res {
        eprintln!("[webview] couldn't reach the webview: {e}");
    }
}

#[cfg(not(windows))]
pub fn reload_on_renderer_crash(_w: &WebviewWindow) {}
