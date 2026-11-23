//! Waveform peaks (M1-013): a min/max envelope of PCM at 256-frame resolution, with a power-of-two pyramid above it.
//!
//! * [`PeaksBuilder`] consumes interleaved i16 PCM in chunks of any size (a decoder streams it), so a partial result can be
//!   shown while decoding goes on ([`PeaksBuilder::snapshot`]) and an interrupted job can continue ([`PeaksBuilder::resume`]).
//! * The envelope is across all channels: per bin, the lowest and highest sample of any channel.
//! * [`Peaks::columns`] answers "min/max for each of N pixels starting at frame F" from the best pyramid level, so drawing
//!   a clip never touches PCM and costs O(pixels), not O(samples).
//! * The file format (below) stores level 0 only; upper levels are derived on load in one pass (they are 1/2, 1/4, ... of level 0).
//!
//! ## Binary format (version 1, little endian), cached per media fingerprint
//! ```text
//! 0   "OCPK"           magic
//! 4   u8 version = 1
//! 5   u8 flags         bit 0: complete (all audio decoded)
//! 6   u8 base_log2     8 (256 frames per bin); readers refuse other values
//! 7   u8 reserved      0
//! 8   u32 sample_rate
//! 12  u64 frames       frames covered (the last bin may be partial)
//! 20  u32 bins         = ceil(frames / 256)
//! 24  bins x (i16 min, i16 max)
//! ```

/// Frames per level-0 bin (`1 << BASE_LOG2`).
pub const BASE_LOG2: u32 = 8;
pub const BASE_FRAMES: u64 = 1 << BASE_LOG2;
pub const FORMAT_VERSION: u8 = 1;
const MAGIC: &[u8; 4] = b"OCPK";
const HEADER: usize = 24;
/// Marker for "no data here (yet)" in [`Peaks::columns`] output: `min > max`.
pub const NO_DATA: [i16; 2] = [i16::MAX, i16::MIN];
/// Pyramid depth cap (level 20 = 268 M frames per bin).
const MAX_LEVELS: usize = 21;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeaksError {
    /// Not a peaks file, or truncated / inconsistent.
    Invalid(&'static str),
    /// Written by a newer version.
    Unsupported(u8),
}

impl std::fmt::Display for PeaksError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PeaksError::Invalid(s) => write!(f, "invalid peaks file: {s}"),
            PeaksError::Unsupported(v) => {
                write!(f, "peaks file version {v} is newer than this build")
            }
        }
    }
}
impl std::error::Error for PeaksError {}

/// Streaming extractor. Feed PCM with [`push`](Self::push); read results with [`snapshot`](Self::snapshot) / [`finish`](Self::finish).
#[derive(Clone, Debug)]
pub struct PeaksBuilder {
    sample_rate: u32,
    channels: usize,
    /// Level 0, `[min, max]` per full bin.
    bins: Vec<[i16; 2]>,
    /// The bin being filled and how many frames it holds.
    cur: [i16; 2],
    cur_frames: u64,
    frames: u64,
}

impl PeaksBuilder {
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        PeaksBuilder {
            sample_rate,
            channels: channels.max(1) as usize,
            bins: Vec::new(),
            cur: [i16::MAX, i16::MIN],
            cur_frames: 0,
            frames: 0,
        }
    }

    /// Continues a cached, possibly partial file: keeps its full bins and drops a trailing partial one. The caller then
    /// decodes from [`next_frame`](Self::next_frame) (always a multiple of 256).
    pub fn resume(bytes: &[u8], channels: u16) -> Result<Self, PeaksError> {
        let p = Peaks::from_bytes(bytes)?;
        let full = (p.frames / BASE_FRAMES) as usize;
        let mut b = PeaksBuilder::new(p.sample_rate, channels);
        b.bins = p.levels[0][..full].to_vec();
        b.frames = full as u64 * BASE_FRAMES;
        Ok(b)
    }

    /// The first frame the next `push` must start at.
    pub fn next_frame(&self) -> u64 {
        self.frames
    }

    /// Adds interleaved PCM. A trailing partial frame (fewer than `channels` samples) is ignored.
    pub fn push(&mut self, interleaved: &[i16]) {
        let ch = self.channels;
        let mut rest = interleaved;
        while rest.len() >= ch {
            let room = (BASE_FRAMES - self.cur_frames) as usize;
            let n = room.min(rest.len() / ch);
            let (chunk, tail) = rest.split_at(n * ch);
            let (mut lo, mut hi) = (self.cur[0], self.cur[1]);
            for &s in chunk {
                lo = lo.min(s);
                hi = hi.max(s);
            }
            self.cur = [lo, hi];
            self.cur_frames += n as u64;
            self.frames += n as u64;
            rest = tail;
            if self.cur_frames == BASE_FRAMES {
                self.bins.push(self.cur);
                self.cur = [i16::MAX, i16::MIN];
                self.cur_frames = 0;
            }
        }
    }

    /// Everything so far as a [`Peaks`] (the partial bin included, flagged incomplete).
    pub fn snapshot(&self) -> Peaks {
        self.build(false)
    }

    /// The final result: same data, flagged complete.
    pub fn finish(self) -> Peaks {
        self.build(true)
    }

    fn build(&self, complete: bool) -> Peaks {
        let mut base = Vec::with_capacity(self.bins.len() + 1);
        base.extend_from_slice(&self.bins);
        if self.cur_frames > 0 {
            base.push(self.cur);
        }
        Peaks::from_base(self.sample_rate, self.frames, complete, base)
    }
}

/// A peaks pyramid. `levels[k]` has one `[min, max]` per `256 << k` frames.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Peaks {
    pub sample_rate: u32,
    /// Frames covered so far.
    pub frames: u64,
    /// False while extraction is still running (or was interrupted).
    pub complete: bool,
    pub levels: Vec<Vec<[i16; 2]>>,
}

fn merge(a: [i16; 2], b: [i16; 2]) -> [i16; 2] {
    [a[0].min(b[0]), a[1].max(b[1])]
}

impl Peaks {
    fn from_base(sample_rate: u32, frames: u64, complete: bool, base: Vec<[i16; 2]>) -> Self {
        let mut levels = vec![base];
        while levels.len() < MAX_LEVELS && levels.last().is_some_and(|l| l.len() > 1) {
            let prev = levels.last().unwrap();
            let next: Vec<[i16; 2]> = prev
                .chunks(2)
                .map(|c| {
                    if c.len() == 2 {
                        merge(c[0], c[1])
                    } else {
                        c[0]
                    }
                })
                .collect();
            levels.push(next);
        }
        Peaks {
            sample_rate,
            frames,
            complete,
            levels,
        }
    }

    /// Frames per bin at `level`.
    pub fn bin_frames(level: usize) -> u64 {
        BASE_FRAMES << level
    }

    /// Seconds of audio covered so far.
    pub fn seconds(&self) -> f64 {
        self.frames as f64 / self.sample_rate.max(1) as f64
    }

    /// Highest level whose bins are not wider than `frames_per_px` (level 0 when zoomed in further than that).
    pub fn level_for(&self, frames_per_px: f64) -> usize {
        let mut l = 0;
        while l + 1 < self.levels.len() && (Self::bin_frames(l + 1) as f64) <= frames_per_px {
            l += 1;
        }
        l
    }

    /// Min/max for `count` pixel columns, column `i` covering frames `[start + i*fpp, start + (i+1)*fpp)`.
    /// Appends `count` pairs to `out`; columns with no extracted data (yet) are [`NO_DATA`]. Allocation-free if `out` has room.
    pub fn columns(
        &self,
        start_frame: f64,
        frames_per_px: f64,
        count: usize,
        out: &mut Vec<[i16; 2]>,
    ) {
        let fpp = frames_per_px.max(1e-6);
        let level = self.level_for(fpp);
        let bins = &self.levels[level];
        let bf = Self::bin_frames(level) as f64;
        for i in 0..count {
            let a = start_frame + i as f64 * fpp;
            let b = a + fpp;
            if b <= 0.0 || a >= self.frames as f64 {
                out.push(NO_DATA);
                continue;
            }
            let first = (a.max(0.0) / bf).floor() as usize;
            let last = ((b / bf).ceil() as usize).max(first + 1).min(bins.len());
            let mut m = NO_DATA;
            for bin in bins.get(first..last).unwrap_or(&[]) {
                m = merge(m, *bin);
            }
            out.push(m);
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let base = &self.levels[0];
        let mut v = Vec::with_capacity(HEADER + base.len() * 4);
        v.extend_from_slice(MAGIC);
        v.push(FORMAT_VERSION);
        v.push(self.complete as u8);
        v.push(BASE_LOG2 as u8);
        v.push(0);
        v.extend_from_slice(&self.sample_rate.to_le_bytes());
        v.extend_from_slice(&self.frames.to_le_bytes());
        v.extend_from_slice(&(base.len() as u32).to_le_bytes());
        for b in base {
            v.extend_from_slice(&b[0].to_le_bytes());
            v.extend_from_slice(&b[1].to_le_bytes());
        }
        v
    }

    /// Parses a file. Never panics; every length is checked against the bytes present.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, PeaksError> {
        if bytes.len() < HEADER || &bytes[..4] != MAGIC {
            return Err(PeaksError::Invalid("bad header"));
        }
        if bytes[4] != FORMAT_VERSION {
            return Err(if bytes[4] > FORMAT_VERSION {
                PeaksError::Unsupported(bytes[4])
            } else {
                PeaksError::Invalid("unknown version")
            });
        }
        if bytes[6] as u32 != BASE_LOG2 {
            return Err(PeaksError::Invalid("unsupported base resolution"));
        }
        let sample_rate = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let frames = u64::from_le_bytes(bytes[12..20].try_into().unwrap());
        let n = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
        if sample_rate == 0
            || n as u64 != frames.div_ceil(BASE_FRAMES)
            || bytes.len() != HEADER + n * 4
        {
            return Err(PeaksError::Invalid("length mismatch"));
        }
        let base = bytes[HEADER..]
            .chunks_exact(4)
            .map(|c| {
                [
                    i16::from_le_bytes([c[0], c[1]]),
                    i16::from_le_bytes([c[2], c[3]]),
                ]
            })
            .collect();
        Ok(Peaks::from_base(
            sample_rate,
            frames,
            bytes[5] & 1 == 1,
            base,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic noise-like signal, no float and no RNG crate.
    fn signal(n: usize, ch: usize) -> Vec<i16> {
        let mut x: u32 = 0x1234_5678;
        (0..n * ch)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x >> 16) as i16
            })
            .collect()
    }

    fn brute(pcm: &[i16], ch: usize, from: usize, to: usize) -> [i16; 2] {
        let s = &pcm[from * ch..(to * ch).min(pcm.len())];
        [*s.iter().min().unwrap(), *s.iter().max().unwrap()]
    }

    #[test]
    fn level_zero_matches_brute_force_whatever_the_chunking() {
        let pcm = signal(10_000, 2);
        let mut a = PeaksBuilder::new(48_000, 2);
        a.push(&pcm);
        let mut b = PeaksBuilder::new(48_000, 2);
        for c in pcm.chunks(2 * 37) {
            b.push(c);
        }
        let (pa, pb) = (a.finish(), b.finish());
        assert_eq!(pa, pb);
        assert_eq!(pa.frames, 10_000);
        assert_eq!(pa.levels[0].len(), 10_000usize.div_ceil(256));
        for (i, bin) in pa.levels[0].iter().enumerate() {
            assert_eq!(*bin, brute(&pcm, 2, i * 256, ((i + 1) * 256).min(10_000)));
        }
    }

    #[test]
    fn pyramid_levels_are_exact_merges() {
        let pcm = signal(256 * 37 + 5, 1);
        let mut b = PeaksBuilder::new(44_100, 1);
        b.push(&pcm);
        let p = b.finish();
        assert_eq!(p.levels.last().unwrap().len(), 1);
        for (k, level) in p.levels.iter().enumerate() {
            let w = (256usize) << k;
            for (i, bin) in level.iter().enumerate() {
                assert_eq!(
                    *bin,
                    brute(&pcm, 1, i * w, ((i + 1) * w).min(pcm.len())),
                    "level {k} bin {i}"
                );
            }
        }
    }

    #[test]
    fn columns_cover_the_requested_range_and_flag_missing_data() {
        let pcm = signal(4096, 1);
        let mut b = PeaksBuilder::new(48_000, 1);
        b.push(&pcm);
        let p = b.finish();
        let mut out = Vec::new();
        p.columns(0.0, 1024.0, 6, &mut out);
        assert_eq!(out[0], brute(&pcm, 1, 0, 1024));
        assert_eq!(out[3], brute(&pcm, 1, 3072, 4096));
        assert_eq!(out[4], NO_DATA);
        assert_eq!(out[5], NO_DATA);
        out.clear();
        p.columns(-2048.0, 1024.0, 3, &mut out); // before the start
        assert_eq!(out[0], NO_DATA);
        assert_eq!(out[2], brute(&pcm, 1, 0, 1024));
        out.clear();
        p.columns(0.0, 1.0, 4, &mut out); // far zoomed in: bins are coarser than pixels
        assert_eq!(out[0], brute(&pcm, 1, 0, 256));
    }

    #[test]
    fn snapshot_is_partial_then_resume_reaches_the_same_result() {
        let pcm = signal(256 * 20 + 100, 2);
        let mut b = PeaksBuilder::new(48_000, 2);
        b.push(&pcm[..2 * (256 * 7 + 30)]);
        let snap = b.snapshot();
        assert!(!snap.complete);
        assert_eq!(snap.frames, 256 * 7 + 30);
        // Interrupted job: the cache holds the snapshot; a new job resumes from the last full bin.
        let mut r = PeaksBuilder::resume(&snap.to_bytes(), 2).unwrap();
        assert_eq!(r.next_frame(), 256 * 7);
        r.push(&pcm[2 * 256 * 7..]);
        let mut whole = PeaksBuilder::new(48_000, 2);
        whole.push(&pcm);
        assert_eq!(r.finish(), whole.finish());
    }

    #[test]
    fn bytes_round_trip_and_hostile_input_is_refused() {
        let pcm = signal(5000, 1);
        let mut b = PeaksBuilder::new(48_000, 1);
        b.push(&pcm);
        let p = b.finish();
        let bytes = p.to_bytes();
        assert_eq!(bytes.len(), 24 + 4 * 20);
        assert_eq!(Peaks::from_bytes(&bytes).unwrap(), p);
        for cut in 0..bytes.len() {
            assert!(Peaks::from_bytes(&bytes[..cut]).is_err());
        }
        let mut newer = bytes.clone();
        newer[4] = 9;
        assert_eq!(Peaks::from_bytes(&newer), Err(PeaksError::Unsupported(9)));
        let mut forged = bytes.clone();
        forged[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(Peaks::from_bytes(&forged).is_err());
        let mut x = 7u32;
        for i in 0..bytes.len() * 8 {
            let mut m = bytes.clone();
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            m[(x >> 8) as usize % bytes.len()] ^= 1 << (i % 8);
            let _ = Peaks::from_bytes(&m); // must not panic
        }
    }

    #[test]
    fn empty_and_tiny_inputs() {
        let p = PeaksBuilder::new(48_000, 2).finish();
        assert_eq!(p.frames, 0);
        let mut out = Vec::new();
        p.columns(0.0, 100.0, 2, &mut out);
        assert_eq!(out, vec![NO_DATA; 2]);
        let mut b = PeaksBuilder::new(8000, 2);
        b.push(&[5, -7, 9]); // one full frame + a stray sample
        let p = b.finish();
        assert_eq!(p.frames, 1);
        assert_eq!(p.levels[0], vec![[-7, 5]]);
        assert_eq!(Peaks::from_bytes(&p.to_bytes()).unwrap(), p);
    }

    /// Extraction speed: run `cargo test --release -p app-audio throughput -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn throughput() {
        let sr = 48_000usize;
        let pcm = signal(sr * 60, 2); // 60 s stereo
        let t = std::time::Instant::now();
        let mut b = PeaksBuilder::new(sr as u32, 2);
        for c in pcm.chunks(2 * 4096) {
            b.push(c);
        }
        let p = b.finish();
        let s = t.elapsed().as_secs_f64();
        println!(
            "peaks: 60 s stereo in {:.2} ms = {:.0}x realtime ({} bins)",
            s * 1e3,
            60.0 / s,
            p.levels[0].len()
        );
    }
}
