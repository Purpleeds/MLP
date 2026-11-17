#![cfg_attr(not(feature = "onnx"), allow(dead_code))]
//! CTC forced alignment (Viterbi over the blank-interleaved target sequence), like torchaudio's
//! `forced_align`: given per-frame log-probabilities and the known text, find when each letter is sung.

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
    align_with(logp, t_len, v, blank, words, &[])
}

/// Soft position prior for entering a token: (expected frame, log-prob per frame of distance beyond
/// the tolerance, tolerance in frames). Used for the first letter of each line.
pub type Entry = Option<(f32, f32, f32)>;

/// `align` with an optional entry prior per word (`entries[w]` applies to word `w`'s first token).
pub fn align_with(logp: &[f32], t_len: usize, v: usize, blank: usize, words: &[Vec<usize>], entries: &[Entry]) -> Option<Vec<WordSpan>> {
    let tokens: Vec<usize> = words.iter().flatten().copied().collect();
    // entry prior per token index
    let mut tok_entry: Vec<Entry> = vec![None; tokens.len()];
    {
        let mut j = 0;
        for (w, ids) in words.iter().enumerate() {
            if !ids.is_empty() {
                tok_entry[j] = entries.get(w).copied().flatten();
            }
            j += ids.len();
        }
    }
    let entry_cost = |j: usize, t: usize| -> f32 {
        match tok_entry[j] {
            Some((e, per, tol)) => -per * ((t as f32 - e).abs() - tol).max(0.0),
            None => 0.0,
        }
    };
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
    prev[1] = logp[tokens[0]] + entry_cost(0, 0);
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
            // entering a token (from the blank before it, or straight from the previous letter)
            let enter = if s % 2 == 1 { entry_cost(s / 2, t) } else { 0.0 };
            if s >= 1 && prev[s - 1] + enter > best {
                best = prev[s - 1] + enter;
                from = 1;
            }
            if s >= 2 && s % 2 == 1 && tokens[s / 2] != tokens[s / 2 - 1] && prev[s - 2] + enter > best {
                best = prev[s - 2] + enter;
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

/// Log-probability of the wildcard ("star") token: like ctc-forced-aligner's `<star>`, it can stand
/// for any sound, so audio before, between and after the lines (other singing, ad-libs) is absorbed
/// instead of being forced onto the lyrics. Slightly below a confident letter (−1 vs ≈0) so it doesn't
/// eat the edges of real words. Letters still win where they really are sung, because
/// the frames between a line's first and last letter must be letters or blanks.
pub const STAR_LOGP: f32 = -1.0;

/// Align several lines that sit somewhere inside a longer stretch of audio. `lines[l][w]` = token
/// ids of word `w` of line `l` (empty = skipped word). Returns spans per line and word (None for
/// skipped words), or None if the text can't fit.
pub fn align_lines(logp: &[f32], t_len: usize, v: usize, blank: usize, lines: &[Vec<Vec<usize>>]) -> Option<Vec<Vec<Option<WordSpan>>>> {
    align_lines_with(logp, t_len, v, blank, lines, &Tuning::default())
}

/// Knobs for `align_lines_with` (defaults = `align_lines`).
#[derive(Clone, Debug)]
pub struct Tuning {
    pub star_logp: f32,
    /// added to the blank's log-prob in every frame (≤ 0): letters of a line stay together instead of
    /// spreading over a long stretch of music
    pub blank_penalty: f32,
    /// per line: soft prior on where its first letter starts (see `Entry`)
    pub line_entry: Vec<Entry>,
}
impl Default for Tuning {
    fn default() -> Self {
        Self { star_logp: STAR_LOGP, blank_penalty: 0.0, line_entry: Vec::new() }
    }
}

pub fn align_lines_with(logp: &[f32], t_len: usize, v: usize, blank: usize, lines: &[Vec<Vec<usize>>], tune: &Tuning) -> Option<Vec<Vec<Option<WordSpan>>>> {
    let star = v;
    let v2 = v + 1;
    let mut lp = Vec::with_capacity(t_len * v2);
    for row in logp.chunks(v).take(t_len) {
        let at = lp.len();
        lp.extend_from_slice(row);
        lp[at + blank] += tune.blank_penalty;
        lp.push(tune.star_logp);
    }
    let mut words: Vec<Vec<usize>> = vec![vec![star]];
    let mut index: Vec<Option<(usize, usize)>> = vec![None];
    let mut entries: Vec<Entry> = vec![None];
    for (li, line) in lines.iter().enumerate() {
        if line.iter().all(|w| w.is_empty()) {
            continue;
        }
        let first = line.iter().position(|w| !w.is_empty());
        for (wi, w) in line.iter().enumerate() {
            words.push(w.clone());
            index.push(Some((li, wi)));
            entries.push(if Some(wi) == first { tune.line_entry.get(li).copied().flatten() } else { None });
        }
        words.push(vec![star]);
        index.push(None);
        entries.push(None);
    }
    if words.len() <= 1 {
        return None;
    }
    let spans = align_with(&lp, t_len, v2, blank, &words, &entries)?;
    let mut out: Vec<Vec<Option<WordSpan>>> = lines.iter().map(|l| vec![None; l.len()]).collect();
    for s in spans {
        if let Some((li, wi)) = index[s.word] {
            out[li][wi] = Some(WordSpan { word: wi, ..s });
        }
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
    fn position_prior_picks_the_nearer_repeat() {
        // "a b" sung twice (frames 2–4 and 10–12); the prior expects the line around frame 10.
        let seq = [0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0];
        let lp = emissions(&seq, 3);
        let line = vec![vec![vec![1], vec![2]]];
        let plain = align_lines(&lp, seq.len(), 3, 0, &line).unwrap();
        assert!(matches!(plain[0][0].as_ref().unwrap().start_frame, 2 | 10));
        for (expect, want) in [(10.0, 10), (2.0, 2)] {
            let tune = Tuning { line_entry: vec![Some((expect, 1.0, 1.0))], ..Tuning::default() };
            let near = align_lines_with(&lp, seq.len(), 3, 0, &line, &tune).unwrap();
            assert_eq!(near[0][0].as_ref().unwrap().start_frame, want);
        }
    }

    #[test]
    fn finds_lines_inside_longer_audio() {
        // blank=0, a=1, b=2, c=3. Unrelated "c c" singing before and after; the line "a b" in the middle.
        let seq = [3, 0, 3, 0, 0, 1, 1, 0, 2, 0, 0, 3, 3, 0];
        let lp = emissions(&seq, 4);
        let out = align_lines(&lp, seq.len(), 4, 0, &[vec![vec![1], vec![2]]]).unwrap();
        let w: Vec<(usize, usize)> = out[0].iter().map(|s| s.as_ref().map(|s| (s.start_frame, s.end_frame)).unwrap()).collect();
        assert_eq!(w, vec![(5, 7), (8, 9)]);
        // empty words / lines are skipped but keep their places
        let out = align_lines(&lp, seq.len(), 4, 0, &[vec![], vec![vec![1], vec![], vec![2]]]).unwrap();
        assert!(out[0].is_empty() && out[1][1].is_none());
        assert_eq!(out[1][2].as_ref().unwrap().start_frame, 8);
    }
}
