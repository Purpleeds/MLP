//! Thai → RTGS romanization with word segmentation (kham-core: dictionary + rule engine).

use std::sync::OnceLock;

use kham_core::romanizer::RomanizationMap;
use kham_core::segmenter::Tokenizer;
use kham_core::token::TokenKind;

static MAP: OnceLock<RomanizationMap> = OnceLock::new();

pub fn romanize(text: &str) -> String {
    let map = MAP.get_or_init(RomanizationMap::builtin);
    let tokenizer = Tokenizer::builder().keep_whitespace(true).build();
    let mut out = String::new();
    let mut prev_thai = false;
    for t in tokenizer.segment(text) {
        match t.kind {
            TokenKind::Thai | TokenKind::Named(_) => {
                // Thai has no spaces between words: separate romanized words.
                if prev_thai {
                    out.push(' ');
                }
                out.push_str(&map.romanize_or_rule(t.text));
                prev_thai = true;
            }
            _ => {
                out.push_str(t.text);
                prev_thai = false;
            }
        }
    }
    out
}

#[tauri::command]
pub async fn th_romanize(lines: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || lines.iter().map(|l| romanize(l)).collect())
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn rtgs() {
        let r = super::romanize("สวัสดีครับ กินข้าว");
        println!("{r}");
        assert!(!r.chars().any(|c| ('\u{0E00}'..='\u{0E7F}').contains(&c)));
        assert!(r.contains("khrap"), "{r}");
    }
}
