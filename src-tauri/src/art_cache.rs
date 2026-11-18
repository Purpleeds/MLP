//! Cover art per track. Players often change the title before the thumbnail (autoplay especially),
//! so the first read after a track change can still be the previous song's cover. Keep re-reading
//! for a short while after a change, and longer while the cover still equals the previous one.

/// Polls (250 ms each) after a track change during which the thumbnail is always re-read.
const ALWAYS_REREAD: u8 = 8;
/// Polls after which a missing or unchanged cover is accepted as final.
const MAX_TRIES: u8 = 40;

#[derive(Default)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct ArtCache {
    key: String,
    art: Option<String>,
    /// the previous track's cover, to spot a thumbnail the player hasn't swapped yet
    prev: Option<String>,
    tries: u8,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl ArtCache {
    /// Cover for the track `key`; `read` fetches the player's current thumbnail when needed.
    pub fn get(&mut self, key: &str, read: impl FnOnce() -> Option<String>) -> Option<String> {
        if key != self.key {
            let prev = self.art.take().or(self.prev.take());
            *self = ArtCache { key: key.to_string(), art: None, prev, tries: 0 };
        }
        let settled = self.art.is_some() && self.art != self.prev;
        if self.tries < MAX_TRIES && (self.tries < ALWAYS_REREAD || !settled) {
            self.tries += 1;
            if let Some(a) = read() {
                self.art = Some(a);
            }
        }
        self.art.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps_in_the_new_cover_when_it_arrives_late() {
        let mut c = ArtCache::default();
        assert_eq!(c.get("a", || Some("A".into())).as_deref(), Some("A"));
        for _ in 0..MAX_TRIES {
            c.get("a", || Some("A".into()));
        }
        // Autoplay: the title changed, the thumbnail is still song A's for a second.
        for _ in 0..4 {
            assert_eq!(c.get("b", || Some("A".into())).as_deref(), Some("A"));
        }
        assert_eq!(c.get("b", || Some("B".into())).as_deref(), Some("B"));
        // Once settled it stops reading.
        for _ in 0..ALWAYS_REREAD {
            c.get("b", || Some("B".into()));
        }
        assert_eq!(c.get("b", || panic!("read after settling")).as_deref(), Some("B"));
    }

    #[test]
    fn keeps_a_shared_album_cover_and_gives_up_on_missing_art() {
        let mut c = ArtCache::default();
        c.get("a", || Some("X".into()));
        let mut reads = 0;
        for _ in 0..100 {
            assert_eq!(c.get("b", || { reads += 1; Some("X".into()) }).as_deref(), Some("X"));
        }
        assert_eq!(reads, MAX_TRIES as usize);
        let mut reads = 0;
        for _ in 0..100 {
            assert_eq!(c.get("c", || { reads += 1; None }), None);
        }
        assert_eq!(reads, MAX_TRIES as usize);
    }
}
