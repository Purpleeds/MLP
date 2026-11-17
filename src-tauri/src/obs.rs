//! Upgrade 19 — stream overlay: a tiny local web server (127.0.0.1 only) with an overlay page for
//! OBS' browser source (`/`) and the current line as JSON (`/state`, polled by the page).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::Duration;

const PAGE: &str = include_str!("../assets/obs.html");

static STATE: Mutex<String> = Mutex::new(String::new());
static RUNNING: AtomicBool = AtomicBool::new(false);
static PORT: AtomicU16 = AtomicU16::new(0);

/// "GET /state?x HTTP/1.1" → "/state"
pub fn route(request_line: &str) -> Option<&str> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    Some(parts.next()?.split('?').next().unwrap_or("/"))
}

fn respond(mut s: TcpStream) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0u8; 2048];
    let n = s.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let (status, ctype, body) = match req.lines().next().and_then(route) {
        Some("/") | Some("/index.html") => ("200 OK", "text/html; charset=utf-8", PAGE.to_string()),
        Some("/state") => {
            let st = STATE.lock().unwrap().clone();
            ("200 OK", "application/json", if st.is_empty() { "{}".into() } else { st })
        }
        _ => ("404 Not Found", "text/plain", "not found".into()),
    };
    let _ = s.write_all(
        format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes(),
    );
}

/// Start / stop the server; returns the overlay address while running.
#[tauri::command]
pub fn obs_set(enabled: bool, port: u16) -> Result<Option<String>, String> {
    if !enabled {
        RUNNING.store(false, Ordering::SeqCst);
        return Ok(None);
    }
    if RUNNING.load(Ordering::SeqCst) && PORT.load(Ordering::SeqCst) == port {
        return Ok(Some(format!("http://127.0.0.1:{port}/")));
    }
    RUNNING.store(false, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(250)); // let a previous server notice
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("Port {port} is in use ({e}). Pick another one."))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    RUNNING.store(true, Ordering::SeqCst);
    PORT.store(port, Ordering::SeqCst);
    std::thread::Builder::new()
        .name("obs".into())
        .spawn(move || {
            while RUNNING.load(Ordering::SeqCst) && PORT.load(Ordering::SeqCst) == port {
                match listener.accept() {
                    Ok((s, _)) => {
                        let _ = s.set_nonblocking(false);
                        std::thread::spawn(move || respond(s));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Some(format!("http://127.0.0.1:{port}/")))
}

/// The lyrics window pushes what it shows (JSON) a few times a second.
#[tauri::command]
pub fn obs_update(state: serde_json::Value) {
    if RUNNING.load(Ordering::Relaxed) {
        *STATE.lock().unwrap() = state.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_requests() {
        assert_eq!(route("GET /state?t=1 HTTP/1.1"), Some("/state"));
        assert_eq!(route("GET / HTTP/1.1"), Some("/"));
        assert_eq!(route("POST / HTTP/1.1"), None);
    }

    #[test]
    fn serves_page_and_state() {
        let url = obs_set(true, 47_272).unwrap().unwrap();
        assert!(url.ends_with(":47272/"));
        obs_update(serde_json::json!({ "line": "hello" }));
        let get = |path: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", 47_272)).unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        };
        assert!(get("/state").ends_with(r#"{"line":"hello"}"#));
        assert!(get("/").contains("MLP lyrics overlay"));
        obs_set(false, 0).unwrap();
    }
}
