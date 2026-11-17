//! Upgrade 12 — taskbar bar: a thin one-line lyrics strip docked right above the taskbar (by the
//! clock), or experimentally *on* the taskbar just left of the tray icons (re-asserted on top).

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::Shell::{SHAppBarMessage, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_GETTASKBARPOS, APPBARDATA};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, GetWindow, GetWindowRect, IsIconic, IsWindowVisible, SetWindowPos, GW_HWNDPREV, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
};
use windows::core::w;

static ON_TASKBAR: AtomicBool = AtomicBool::new(false);
static KEEPER: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Where the bar goes (physical px). `taskbar` = taskbar rect and edge, `tray` = notification area
/// rect (when found), `bar` = bar size, `gap` = spacing.
pub fn place(taskbar: RECT, edge: u32, tray: Option<RECT>, bar: (i32, i32), gap: i32, on_taskbar: bool) -> Rect {
    let (w, h) = bar;
    let tb_h = taskbar.bottom - taskbar.top;
    if on_taskbar && (edge == ABE_BOTTOM || edge == ABE_TOP) {
        let right = tray.map(|t| t.left).unwrap_or(taskbar.right - 320);
        return Rect { x: right - w - gap, y: taskbar.top + (tb_h - h).max(0) / 2, w, h: h.min(tb_h) };
    }
    match edge {
        e if e == ABE_TOP => Rect { x: taskbar.right - w - gap, y: taskbar.bottom + gap, w, h },
        e if e == ABE_LEFT => Rect { x: taskbar.right + gap, y: taskbar.bottom - h - gap, w, h },
        e if e == ABE_RIGHT => Rect { x: taskbar.left - w - gap, y: taskbar.bottom - h - gap, w, h },
        _ => Rect { x: taskbar.right - w - gap, y: taskbar.top - h - gap, w, h },
    }
}

fn taskbar() -> Option<(RECT, u32, Option<RECT>)> {
    let mut abd = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, ..Default::default() };
    if unsafe { SHAppBarMessage(ABM_GETTASKBARPOS, &mut abd) } == 0 {
        return None;
    }
    let tray = unsafe {
        FindWindowW(w!("Shell_TrayWnd"), None).ok().and_then(|tb| FindWindowExW(Some(tb), None, w!("TrayNotifyWnd"), None).ok()).and_then(|n| {
            let mut r = RECT::default();
            GetWindowRect(n, &mut r).ok().map(|_| r)
        })
    };
    Some((abd.rc, abd.uEdge, tray.filter(|r| r.right > r.left)))
}

/// Keep the bar above the taskbar's own z-order while it sits on it (the taskbar is topmost too).
fn keep_on_top(app: AppHandle) {
    if KEEPER.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        while ON_TASKBAR.load(Ordering::SeqCst) {
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(h) = w.hwnd() {
                    let hwnd = HWND(h.0 as _);
                    unsafe {
                        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
        KEEPER.store(false, Ordering::SeqCst);
    });
}

/// Dock the main window as the bar. `width`/`height` in logical px; `placement` "above" | "taskbar".
#[tauri::command]
pub fn dock_bar(app: AppHandle, placement: String, width: f64, height: f64) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("no main window")?;
    let scale = w.scale_factor().unwrap_or(1.0);
    let (rc, edge, tray) = taskbar().ok_or("couldn't find the taskbar")?;
    let on = placement == "taskbar";
    let r = place(rc, edge, tray, ((width * scale) as i32, (height * scale) as i32), (6.0 * scale) as i32, on);
    w.set_size(PhysicalSize::new(r.w as u32, r.h as u32)).map_err(|e| e.to_string())?;
    w.set_position(PhysicalPosition::new(r.x, r.y)).map_err(|e| e.to_string())?;
    ON_TASKBAR.store(on, Ordering::SeqCst);
    if on {
        keep_on_top(app.clone());
    }
    Ok(())
}

/// Leaving bar mode stops the on-taskbar keeper.
#[tauri::command]
pub fn undock_bar() {
    ON_TASKBAR.store(false, Ordering::SeqCst);
}

/// `outer` fully contains `inner`.
pub fn contains(outer: RECT, inner: RECT) -> bool {
    outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom
}

/// Upgrade 18: is the main window completely hidden behind one visible window above it?
/// (Single-window check: covers the common case of a maximized app over it.)
#[tauri::command]
pub fn window_covered(app: AppHandle) -> bool {
    let Some(w) = app.get_webview_window("main") else { return false };
    let Ok(h) = w.hwnd() else { return false };
    let me = HWND(h.0 as _);
    unsafe {
        if !IsWindowVisible(me).as_bool() || IsIconic(me).as_bool() {
            return false;
        }
        let mut mine = RECT::default();
        if GetWindowRect(me, &mut mine).is_err() {
            return false;
        }
        let mut cur = GetWindow(me, GW_HWNDPREV).ok();
        let mut guard = 0;
        while let Some(o) = cur {
            guard += 1;
            if guard > 500 {
                break;
            }
            if IsWindowVisible(o).as_bool() && !IsIconic(o).as_bool() {
                let mut cloaked = 0u32;
                let _ = DwmGetWindowAttribute(o, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4);
                let mut r = RECT::default();
                if cloaked == 0 && GetWindowRect(o, &mut r).is_ok() && contains(r, mine) {
                    return true;
                }
            }
            cur = GetWindow(o, GW_HWNDPREV).ok();
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const TB: RECT = RECT { left: 0, top: 1392, right: 2560, bottom: 1440 };

    #[test]
    fn docks_above_a_bottom_taskbar_by_the_clock() {
        let r = place(TB, ABE_BOTTOM, None, (520, 40), 6, false);
        assert_eq!(r, Rect { x: 2560 - 520 - 6, y: 1392 - 40 - 6, w: 520, h: 40 });
    }

    #[test]
    fn sits_left_of_the_tray_on_the_taskbar() {
        let tray = RECT { left: 2200, top: 1392, right: 2560, bottom: 1440 };
        let r = place(TB, ABE_BOTTOM, Some(tray), (520, 40), 6, true);
        assert_eq!(r, Rect { x: 2200 - 520 - 6, y: 1392 + 4, w: 520, h: 40 });
        // taller than the taskbar: clipped to it
        assert_eq!(place(TB, ABE_BOTTOM, Some(tray), (520, 60), 6, true).h, 48);
    }

    #[test]
    fn detects_full_cover() {
        let me = RECT { left: 100, top: 100, right: 500, bottom: 600 };
        assert!(contains(RECT { left: 0, top: 0, right: 2560, bottom: 1392 }, me));
        assert!(!contains(RECT { left: 200, top: 0, right: 2560, bottom: 1392 }, me));
    }

    #[test]
    fn handles_side_and_top_taskbars() {
        let top = RECT { left: 0, top: 0, right: 2560, bottom: 48 };
        assert_eq!(place(top, ABE_TOP, None, (500, 40), 6, false).y, 54);
        let right = RECT { left: 2500, top: 0, right: 2560, bottom: 1440 };
        assert_eq!(place(right, ABE_RIGHT, None, (500, 40), 6, false).x, 2500 - 506);
    }
}
