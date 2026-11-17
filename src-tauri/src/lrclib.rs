//! LRCLIB publish proof-of-work: find a nonce so that SHA-256(prefix + nonce) <= target
//! (byte-wise, big-endian), same algorithm as LRCGET's challenge solver.

use sha2::{Digest, Sha256};

fn meets(hash: &[u8], target: &[u8]) -> bool {
    for (h, t) in hash.iter().zip(target) {
        if h != t {
            return h < t;
        }
    }
    true
}

pub fn solve(prefix: &str, target_hex: &str) -> Result<String, String> {
    let target = hex::decode(target_hex.trim()).map_err(|e| format!("bad target: {e}"))?;
    if target.len() != 32 {
        return Err("bad target length".into());
    }
    let mut nonce: u64 = 0;
    loop {
        let mut h = Sha256::new();
        h.update(prefix.as_bytes());
        h.update(nonce.to_string().as_bytes());
        if meets(&h.finalize(), &target) {
            return Ok(nonce.to_string());
        }
        nonce += 1;
        if nonce > 5_000_000_000 {
            return Err("challenge too hard".into());
        }
    }
}

#[tauri::command]
pub async fn lrclib_solve(prefix: String, target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || solve(&prefix, &target)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_valid_nonce() {
        let target = "0FFF".to_string() + &"F".repeat(60);
        let nonce = solve("abc", &target).unwrap();
        let mut h = Sha256::new();
        h.update(format!("abc{nonce}").as_bytes());
        let hash = h.finalize();
        assert!(hash[0] <= 0x0F);
        assert!(meets(&hash, &hex::decode(&target).unwrap()));
    }

    #[test]
    fn compares_bytewise() {
        assert!(meets(&[0, 5], &[0, 6]));
        assert!(meets(&[0, 6], &[0, 6]));
        assert!(!meets(&[1, 0], &[0, 255]));
    }
}

#[cfg(test)]
mod live {
    /// LRCLIB_PREFIX / LRCLIB_TARGET from a real `POST /api/request-challenge` (nothing is published).
    #[test]
    #[ignore]
    fn solves_real_challenge() {
        let p = std::env::var("LRCLIB_PREFIX").unwrap();
        let t = std::env::var("LRCLIB_TARGET").unwrap();
        let start = std::time::Instant::now();
        let n = super::solve(&p, &t).unwrap();
        println!("nonce {n} in {:?}", start.elapsed());
    }
}
