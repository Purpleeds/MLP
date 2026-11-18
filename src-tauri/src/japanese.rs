//! Japanese readings for romaji: morphological analysis with Lindera + IPADIC. The dictionary is
//! downloaded on demand (Upgrade 17, ~10 MB) instead of being embedded in the exe (~45 MB).
//! (Windows' JapanesePhoneticAnalyzer needs the Japanese language pack, so it isn't relied on.)

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Mutex;

use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JaWord {
    /// text as written
    pub display: String,
    /// reading in katakana (empty when unknown)
    pub yomi: String,
    /// part of speech (IPADIC), e.g. 名詞, 助詞
    pub pos: String,
    /// sub-category, e.g. 接続助詞, 接尾
    pub pos1: String,
}

static DICT_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static SEGMENTER: Mutex<Option<std::sync::Arc<Segmenter>>> = Mutex::new(None);

/// Where the IPADIC folder (with metadata.json) is, once downloaded.
pub fn set_dict_dir(dir: Option<PathBuf>) {
    *DICT_DIR.lock().unwrap() = dir;
    *SEGMENTER.lock().unwrap() = None;
}

pub fn dict_ready() -> bool {
    segmenter().is_some()
}

/// Does the dictionary in `dir` load? A half-unpacked or damaged copy still has metadata.json (so it
/// counts as downloaded) but never loads, and would leave romaji off for good.
pub fn dict_loads(dir: &std::path::Path) -> bool {
    load_dictionary(&dir.to_string_lossy()).is_ok()
}

fn segmenter() -> Option<std::sync::Arc<Segmenter>> {
    let mut g = SEGMENTER.lock().unwrap();
    if g.is_none() {
        let dir = DICT_DIR.lock().unwrap().clone()?;
        match load_dictionary(&dir.to_string_lossy()) {
            Ok(d) => *g = Some(std::sync::Arc::new(Segmenter::new(Mode::Normal, d, None))),
            Err(e) => eprintln!("[japanese] dictionary failed to load from {}: {e}", dir.display()),
        }
    }
    g.clone()
}

fn is_kana(c: char) -> bool {
    ('\u{3041}'..='\u{30FF}').contains(&c)
}
fn is_kanji(c: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&c) || ('\u{3400}'..='\u{4DBF}').contains(&c) || ('\u{F900}'..='\u{FAFF}').contains(&c)
}
const ITERATION: [char; 3] = ['々', '〻', '〃'];

/// Dictionary analysis without fallbacks.
fn analyze_raw(line: &str) -> Vec<JaWord> {
    let Some(seg) = segmenter() else { return vec![] };
    let seg = seg.as_ref();
    let Ok(mut tokens) = seg.segment(Cow::Borrowed(line)) else { return vec![] };
    tokens
        .iter_mut()
        .map(|t| {
            let display = t.surface.as_ref().to_string();
            let details = t.details();
            // IPADIC: pos, pos1, pos2, pos3, conj-type, conj-form, base, reading, pronunciation
            let yomi = details
                .get(7)
                .filter(|r| **r != "*" && r.chars().any(is_kana))
                .map(|r| r.to_string())
                .unwrap_or_default();
            let pos = details.first().map(|p| p.to_string()).unwrap_or_default();
            let pos1 = details.get(1).map(|p| p.to_string()).unwrap_or_default();
            JaWord { display, yomi, pos, pos1 }
        })
        .collect()
}

/// Reading for a kanji the dictionary only knows inside words (e.g. 鬱 alone): look up the doubled
/// form "X々" (鬱々 = ウツウツ) and take the first half, else the character on its own.
fn kanji_reading(c: char) -> Option<String> {
    let doubled = analyze_raw(&format!("{c}々"));
    if let [w] = doubled.as_slice() {
        let r: Vec<char> = w.yomi.chars().collect();
        if !r.is_empty() && r.len() % 2 == 0 {
            return Some(r[..r.len() / 2].iter().collect());
        }
    }
    match analyze_raw(&c.to_string()).as_slice() {
        [w] if !w.yomi.is_empty() => Some(w.yomi.clone()),
        _ => None,
    }
}

pub fn analyze(line: &str) -> Vec<JaWord> {
    let mut words = analyze_raw(line);
    for i in 0..words.len() {
        let chars: Vec<char> = words[i].display.chars().collect();
        // Iteration mark split off on its own: repeat a single-kanji predecessor (人+々), but drop it after
        // an already-doubled word (時時 + 々 → tokidoki), which is how the typo "時時々" reads.
        if !chars.is_empty() && chars.iter().all(|c| ITERATION.contains(c)) {
            let prev = if i > 0 { Some(words[i - 1].clone()) } else { None };
            words[i].yomi = match prev {
                Some(p) if p.display.chars().count() == 1 && !p.yomi.is_empty() => p.yomi,
                _ => String::new(),
            };
            words[i].pos = "記号".into();
            continue;
        }
        // Unknown word containing kanji: build a reading character by character where possible.
        if words[i].yomi.is_empty() && chars.iter().any(|c| is_kanji(*c)) {
            let mut r = String::new();
            for &c in &chars {
                if is_kanji(c) {
                    match kanji_reading(c) {
                        Some(k) => r.push_str(&k),
                        None => r.push(c),
                    }
                } else {
                    r.push(c);
                }
            }
            if r.chars().any(is_kana) {
                words[i].yomi = r;
            }
        }
    }
    words
}

#[tauri::command]
pub async fn jp_readings(lines: Vec<String>) -> Vec<Vec<JaWord>> {
    tauri::async_runtime::spawn_blocking(move || lines.iter().map(|l| analyze(l)).collect())
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests use the downloaded dictionary: MLP_IPADIC_DIR, or the app's copy. Without one they're skipped.
    pub(super) fn dict() -> bool {
        let dir = std::env::var("MLP_IPADIC_DIR").map(PathBuf::from).ok().or_else(|| {
            let base = PathBuf::from(std::env::var("APPDATA").ok()?).join("com.mlp.lyrics/ai/runtime/ipadic/lindera-ipadic");
            base.exists().then_some(base)
        });
        if DICT_DIR.lock().unwrap().is_none() {
            set_dict_dir(dir);
        }
        let ok = dict_ready();
        if !ok {
            eprintln!("no IPADIC dictionary — skipping");
        }
        ok
    }

    #[test]
    fn reads_kanji_and_marks_particles() {
        if !dict() {
            return;
        }
        let w = analyze("今日はいい天気です");
        let yomi: String = w.iter().map(|x| x.yomi.as_str()).collect();
        assert_eq!(yomi, "キョウハイイテンキデス");
        assert!(w.iter().any(|x| x.display == "は" && x.pos == "助詞"));
    }

    #[test]
    fn half_unpacked_dictionary_does_not_load() {
        // metadata.json alone makes the copy look downloaded; it must still be caught as broken.
        let dir = std::env::temp_dir().join(format!("mlp-ipadic-broken-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("metadata.json"), "{}").unwrap();
        assert!(!dict_loads(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        if dict() {
            assert!(dict_loads(DICT_DIR.lock().unwrap().as_ref().unwrap()));
        }
    }

    #[test]
    fn keeps_unknown_text() {
        if !dict() {
            return;
        }
        let w = analyze("夜に駆けるYOASOBI");
        let shown: String = w.iter().map(|x| x.display.as_str()).collect();
        assert_eq!(shown, "夜に駆けるYOASOBI");
    }
}

/// Lists words of a lyrics file the analyzer can't fully read (kanji left in the reading), and with
/// MLP_JA_JSON=out.jsonl also writes every line's words for the TS romaji tests:
///   MLP_JA_LINES=lyrics.txt cargo test --lib ja_unread -- --ignored --nocapture
#[cfg(test)]
mod ja_dump {
    use super::*;
    use std::io::Write;
    #[test]
    #[ignore]
    fn ja_unread() {
        if !super::tests::dict() {
            return;
        }
        let text = std::fs::read_to_string(std::env::var("MLP_JA_LINES").unwrap()).unwrap();
        let mut json = std::env::var("MLP_JA_JSON").ok().map(|p| std::fs::File::create(p).unwrap());
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let words = analyze(line);
            if let Some(f) = json.as_mut() {
                writeln!(f, "{}", serde_json::json!({ "line": line, "words": words })).unwrap();
            }
            let bad: Vec<String> = words
                .iter()
                .filter(|w| w.display.chars().any(is_kanji) && (w.yomi.is_empty() || w.yomi.chars().any(is_kanji)))
                .map(|w| format!("{}[{}|{}|{}]", w.display, w.yomi, w.pos, w.pos1))
                .collect();
            if !bad.is_empty() {
                println!("{line}  ->  {}", bad.join("  "));
            }
        }
    }
}

#[cfg(test)]
mod fallback_tests {
    use super::analyze;
    use super::tests::dict;

    #[test]
    fn reads_lone_kanji_and_iteration_marks() {
        if !dict() {
            return;
        }
        let r = |l: &str| analyze(l).iter().map(|w| w.yomi.clone()).collect::<String>();
        assert_eq!(r("鬱を連れて"), "ウツヲツレテ");
        assert_eq!(r("時時々"), "トキドキ"); // doubled typo: 々 adds nothing
        assert_eq!(r("人々"), "ヒトビト");
    }
}
