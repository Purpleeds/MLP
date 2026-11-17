//! CTC forced alignment (Viterbi over the blank-interleaved target sequence), like torchaudio's
//! `forced_align`: given per-frame log-probabilities and the known text, find when each letter is sung.

/// Lower-case a–z and apostrophes only (the MMS aligner's alphabet). Words keep their indexes.
pub fn normalize_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || *c == '\'').collect::<String>())
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct WordSpan {
    pub word: usize,
    pub start_frame: usize,
    pub end_frame: usize,
    /// mean log-probability of the word's letters (higher = more confident)
    pub score: f32,
}

/// `logp`: T × V log-probabilities (row-major), `blank`: blank id, `words`: token ids per word.
/// Returns one span per non-empty word, or None if the text cannot fit the audio.
pub fn align(logp: &[f32], t_len: usize, v: usize, blank: usize, words: &[Vec<usize>]) -> Option<Vec<WordSpan>> {
    let tokens: Vec<usize> = words.iter().flatten().copied().collect();
    let l = tokens.len();
    if l == 0 || t_len == 0 {
        return None;
    }
    let s_len = 2 * l + 1;
    let state_tok = |s: usize| if s % 2 == 0 { blank } else { tokens[s / 2] };
    // Repeated letters need a blank between them, so the minimum length is l + repeats.
    let repeats = tokens.windows(2).filter(|w| w[0] == w[1]).count();
    if l + repeats > t_len {
        return None;
    }

    const NEG: f32 = f32::NEG_INFINITY;
    let mut prev = vec![NEG; s_len];
    let mut cur = vec![NEG; s_len];
    let mut back = vec![0u8; t_len * s_len];
    prev[0] = logp[blank];
    prev[1] = logp[tokens[0]];
    for t in 1..t_len {
        let row = &logp[t * v..(t + 1) * v];
        // State s can't be reached before frame (s-1)/2.
        let s_max = (2 * t + 2).min(s_len);
        for s in 0..s_len {
            if s >= s_max {
                cur[s] = NEG;
                continue;
            }
            let mut best = prev[s];
            let mut from = 0u8;
            if s >= 1 && prev[s - 1] > best {
                best = prev[s - 1];
                from = 1;
            }
            if s >= 2 && s % 2 == 1 && tokens[s / 2] != tokens[s / 2 - 1] && prev[s - 2] > best {
                best = prev[s - 2];
                from = 2;
            }
            cur[s] = if best == NEG { NEG } else { best + row[state_tok(s)] };
            back[t * s_len + s] = from;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let mut s = if prev[s_len - 1] >= prev[s_len - 2] { s_len - 1 } else { s_len - 2 };
    if prev[s] == NEG {
        return None;
    }
    // Backtrack: state per frame.
    let mut path = vec![0usize; t_len];
    for t in (0..t_len).rev() {
        path[t] = s;
        if t > 0 {
            s -= back[t * s_len + s] as usize;
        }
    }
    // Frames per token index.
    let mut tok_start = vec![usize::MAX; l];
    let mut tok_end = vec![0usize; l];
    let mut tok_score = vec![0f32; l];
    let mut tok_n = vec![0u32; l];
    for (t, &st) in path.iter().enumerate() {
        if st % 2 == 1 {
            let j = st / 2;
            tok_start[j] = tok_start[j].min(t);
            tok_end[j] = t + 1;
            tok_score[j] += logp[t * v + tokens[j]];
            tok_n[j] += 1;
        }
    }
    let mut out = Vec::new();
    let mut j = 0;
    for (w, ids) in words.iter().enumerate() {
        if ids.is_empty() {
            continue;
        }
        let (a, b) = (j, j + ids.len());
        j = b;
        let n: u32 = tok_n[a..b].iter().sum();
        out.push(WordSpan {
            word: w,
            start_frame: tok_start[a],
            end_frame: tok_end[b - 1],
            score: tok_score[a..b].iter().sum::<f32>() / n.max(1) as f32,
        });
    }
    Some(out)
}

/// In-place log-softmax of each row.
pub fn log_softmax_rows(x: &mut [f32], v: usize) {
    for row in x.chunks_mut(v) {
        let m = row.iter().cloned().fold(f32::MIN, f32::max);
        let lse = m + row.iter().map(|&a| (a - m).exp()).sum::<f32>().ln();
        for a in row.iter_mut() {
            *a -= lse;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build log-probs where token `seq[t]` is very likely at frame t.
    fn emissions(seq: &[usize], v: usize) -> Vec<f32> {
        let mut x = vec![-10f32; seq.len() * v];
        for (t, &k) in seq.iter().enumerate() {
            x[t * v + k] = 0.0;
        }
        log_softmax_rows(&mut x, v);
        x
    }

    #[test]
    fn finds_word_positions() {
        // blank=0, a=1, b=2: frames: _ a a _ _ b b _
        let seq = [0, 1, 1, 0, 0, 2, 2, 0];
        let lp = emissions(&seq, 3);
        let spans = align(&lp, seq.len(), 3, 0, &[vec![1], vec![2]]).unwrap();
        assert_eq!((spans[0].start_frame, spans[0].end_frame), (1, 3));
        assert_eq!((spans[1].start_frame, spans[1].end_frame), (5, 7));
    }

    #[test]
    fn handles_repeated_letters_and_too_short_audio() {
        // "aa" needs a blank between the two a's
        let seq = [1, 0, 1];
        let lp = emissions(&seq, 3);
        let spans = align(&lp, 3, 3, 0, &[vec![1, 1]]).unwrap();
        assert_eq!((spans[0].start_frame, spans[0].end_frame), (0, 3));
        assert!(align(&lp, 1, 3, 0, &[vec![1, 1]]).is_none());
    }

    #[test]
    fn normalizes_text() {
        assert_eq!(normalize_words("Don't STOP, 123 me!"), vec!["don't", "stop", "", "me"]);
    }
}
