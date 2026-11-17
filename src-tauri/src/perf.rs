#![cfg_attr(not(feature = "onnx"), allow(dead_code))]
//! Step 17 — performance limits for the AI work: CPU thread cap, low thread priority, and a
//! "something is running full-screen" check so games and presentations aren't slowed down.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// CPU threads for AI models (0 = automatic: a quarter of the cores, at least 2).
static THREADS: AtomicUsize = AtomicUsize::new(0);
static LOW_PRIORITY: AtomicBool = AtomicBool::new(true);
static PAUSE_FULLSCREEN: AtomicBool = AtomicBool::new(true);

pub fn threads() -> usize {
    match THREADS.load(Ordering::Relaxed) {
        0 => (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 4).clamp(2, 8),
        n => n,
    }
}

pub fn low_priority() -> bool {
    LOW_PRIORITY.load(Ordering::Relaxed)
}

/// Run the calling thread below normal priority (no-op when the setting is off).
pub fn lower_current_thread() {
    if !low_priority() {
        return;
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

/// Lowers the calling thread's priority until dropped (pool threads get their old priority back).
pub struct PriorityGuard(i32);

pub fn lower_scoped() -> PriorityGuard {
    #[cfg(windows)]
    let prev = unsafe { windows::Win32::System::Threading::GetThreadPriority(windows::Win32::System::Threading::GetCurrentThread()) };
    #[cfg(not(windows))]
    let prev = 0;
    lower_current_thread();
    PriorityGuard(prev)
}

impl Drop for PriorityGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY};
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY(self.0));
        }
    }
}

/// ONNX Runtime worker threads, started below normal priority.
#[cfg(feature = "onnx")]
pub struct LowPriorityThreads;

#[cfg(feature = "onnx")]
impl ort::environment::ThreadManager for LowPriorityThreads {
    type Thread = std::thread::JoinHandle<()>;
    fn create(&self, work: impl FnOnce() + Send + 'static) -> ort::Result<Self::Thread> {
        Ok(std::thread::spawn(move || {
            lower_current_thread();
            work();
        }))
    }
    fn join(thread: Self::Thread) -> ort::Result<()> {
        let _ = thread.join();
        Ok(())
    }
}

/// True while a full-screen game / video / presentation has the screen (Windows' "busy" states).
pub fn fullscreen_busy() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
        match unsafe { SHQueryUserNotificationState() } {
            Ok(s) => s == QUNS_BUSY || s == QUNS_RUNNING_D3D_FULL_SCREEN || s == QUNS_PRESENTATION_MODE,
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    false
}

/// Background AI work should wait (setting on and a full-screen app has the screen).
pub fn paused() -> bool {
    PAUSE_FULLSCREEN.load(Ordering::Relaxed) && fullscreen_busy()
}

#[tauri::command]
pub fn ai_set_limits(threads: usize, low_priority: bool, pause_fullscreen: Option<bool>) {
    THREADS.store(threads.min(64), Ordering::Relaxed);
    LOW_PRIORITY.store(low_priority, Ordering::Relaxed);
    if let Some(p) = pause_fullscreen {
        PAUSE_FULLSCREEN.store(p, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn ai_busy() -> bool {
    fullscreen_busy()
}

#[cfg(test)]
mod tests {
    #[test]
    fn auto_threads_are_bounded() {
        let n = super::threads();
        assert!((2..=8).contains(&n));
    }
}
