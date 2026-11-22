//! LRU frame cache with a hard byte budget and look-ahead. Bounded memory is the point: 3-4 GB phones.

use crate::traits::{Decoder, MediaError, VideoFrame};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

/// Cache of decoded frames for ONE source, keyed by frame index. `bytes() <= budget()` always holds.
pub struct FrameCache {
    budget: usize,
    bytes: usize,
    tick: u64,
    map: HashMap<i64, (VideoFrame, u64)>,
    order: BTreeMap<u64, i64>, // last-use tick -> index; first entry is least recently used
    stats: CacheStats,
}

impl FrameCache {
    pub fn new(budget_bytes: usize) -> Self {
        FrameCache {
            budget: budget_bytes,
            bytes: 0,
            tick: 0,
            map: HashMap::new(),
            order: BTreeMap::new(),
            stats: CacheStats::default(),
        }
    }

    pub fn budget(&self) -> usize {
        self.budget
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
    pub fn stats(&self) -> CacheStats {
        self.stats
    }
    pub fn contains(&self, index: i64) -> bool {
        self.map.contains_key(&index)
    }

    /// Lower or raise the budget (e.g. on a memory-pressure signal); evicts immediately if needed.
    pub fn set_budget(&mut self, budget_bytes: usize) {
        self.budget = budget_bytes;
        self.evict_to(budget_bytes);
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.bytes = 0;
    }

    /// Cached frame, marking it most recently used.
    pub fn get(&mut self, index: i64) -> Option<VideoFrame> {
        self.tick += 1;
        let tick = self.tick;
        match self.map.get_mut(&index) {
            Some((frame, last)) => {
                self.order.remove(last);
                *last = tick;
                self.order.insert(tick, index);
                self.stats.hits += 1;
                Some(frame.clone())
            }
            None => {
                self.stats.misses += 1;
                None
            }
        }
    }

    /// Insert a frame, evicting least-recently-used frames to stay within budget.
    /// A frame larger than the whole budget is not stored (returns false).
    pub fn insert(&mut self, frame: VideoFrame) -> bool {
        let size = frame.byte_size();
        if size > self.budget {
            return false;
        }
        if let Some((old, last)) = self.map.remove(&frame.index) {
            self.order.remove(&last);
            self.bytes -= old.byte_size();
        }
        self.evict_to(self.budget - size);
        self.tick += 1;
        self.order.insert(self.tick, frame.index);
        self.bytes += size;
        self.map.insert(frame.index, (frame, self.tick));
        true
    }

    fn evict_to(&mut self, target: usize) {
        while self.bytes > target {
            let Some((&tick, &index)) = self.order.iter().next() else {
                break;
            };
            self.order.remove(&tick);
            if let Some((f, _)) = self.map.remove(&index) {
                self.bytes -= f.byte_size();
                self.stats.evictions += 1;
            }
        }
    }

    /// Frame `index` from cache, or decode it. After a miss, also decodes up to `lookahead` following frames
    /// (clamped so they cannot push out the requested frame and stopping at the end of the stream).
    pub async fn get_or_decode<D: Decoder>(
        &mut self,
        decoder: &mut D,
        index: i64,
        lookahead: usize,
    ) -> Result<VideoFrame, MediaError> {
        if let Some(f) = self.get(index) {
            return Ok(f);
        }
        let frame = decoder.video_frame(index).await?;
        let size = frame.byte_size().max(1);
        self.insert(frame.clone());
        let fit = (self.budget / size).saturating_sub(1);
        let frame_count = decoder.info().video.as_ref().map_or(0, |v| v.frame_count);
        for i in 1..=lookahead.min(fit) as i64 {
            let next = index + i;
            if next >= frame_count {
                break;
            }
            if !self.map.contains_key(&next) {
                let f = decoder.video_frame(next).await?;
                self.insert(f);
            }
        }
        // Prefetching must never cost us the frame the caller asked for.
        if self.get(index).is_none() {
            self.stats.misses -= 1;
            self.insert(frame.clone());
        } else {
            self.stats.hits -= 1;
        }
        Ok(frame)
    }
}
