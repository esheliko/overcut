//! Windowed random-access reader over a [`Source`]: small header reads hit a 64 KiB window instead of the host.

use crate::{MediaError, Source};

const WINDOW: usize = 64 * 1024;

pub(crate) fn invalid(msg: &str) -> MediaError {
    MediaError::Invalid(msg.to_string())
}

pub(crate) struct Reader<'a, S: Source> {
    src: &'a S,
    len: u64,
    win_off: u64,
    win: Vec<u8>,
}

impl<'a, S: Source> Reader<'a, S> {
    pub(crate) fn new(src: &'a S) -> Self {
        Reader {
            src,
            len: src.len(),
            win_off: 0,
            win: Vec::new(),
        }
    }

    pub(crate) fn len(&self) -> u64 {
        self.len
    }

    async fn fill(&self, offset: u64, buf: &mut [u8]) -> Result<(), MediaError> {
        let mut done = 0;
        while done < buf.len() {
            let n = self
                .src
                .read_at(offset + done as u64, &mut buf[done..])
                .await?;
            if n == 0 || n > buf.len() - done {
                return Err(invalid("truncated file"));
            }
            done += n;
        }
        Ok(())
    }

    /// Exactly `n` bytes at `offset`; errors (never panics) when the range is past the end of the source.
    pub(crate) async fn bytes(&mut self, offset: u64, n: usize) -> Result<Vec<u8>, MediaError> {
        let end = offset
            .checked_add(n as u64)
            .filter(|e| *e <= self.len)
            .ok_or_else(|| invalid("truncated file"))?;
        if n >= WINDOW {
            let mut v = vec![0u8; n];
            self.fill(offset, &mut v).await?;
            return Ok(v);
        }
        let win_end = self.win_off + self.win.len() as u64;
        if offset < self.win_off || end > win_end {
            let want = (self.len - offset).min(WINDOW as u64) as usize;
            let mut w = vec![0u8; want];
            self.fill(offset, &mut w).await?;
            self.win_off = offset;
            self.win = w;
        }
        let start = (offset - self.win_off) as usize;
        Ok(self.win[start..start + n].to_vec())
    }

    /// Up to `n` bytes (fewer at end of source).
    pub(crate) async fn bytes_upto(
        &mut self,
        offset: u64,
        n: usize,
    ) -> Result<Vec<u8>, MediaError> {
        let avail = self.len.saturating_sub(offset).min(n as u64) as usize;
        self.bytes(offset, avail).await
    }
}

/// Bounds-checked big-endian cursor over an in-memory buffer. Every read returns an error instead of panicking.
pub(crate) struct Cur<'a> {
    d: &'a [u8],
    pub(crate) pos: usize,
}

impl<'a> Cur<'a> {
    pub(crate) fn new(d: &'a [u8]) -> Self {
        Cur { d, pos: 0 }
    }
    pub(crate) fn remaining(&self) -> usize {
        self.d.len() - self.pos
    }
    pub(crate) fn take(&mut self, n: usize) -> Result<&'a [u8], MediaError> {
        if n > self.remaining() {
            return Err(invalid("box shorter than its contents"));
        }
        let s = &self.d[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    pub(crate) fn skip(&mut self, n: usize) -> Result<(), MediaError> {
        self.take(n).map(|_| ())
    }
    pub(crate) fn rest(&mut self) -> &'a [u8] {
        let s = &self.d[self.pos..];
        self.pos = self.d.len();
        s
    }
    pub(crate) fn u8(&mut self) -> Result<u8, MediaError> {
        Ok(self.take(1)?[0])
    }
    pub(crate) fn u16(&mut self) -> Result<u16, MediaError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    pub(crate) fn u32(&mut self) -> Result<u32, MediaError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    pub(crate) fn i32(&mut self) -> Result<i32, MediaError> {
        Ok(self.u32()? as i32)
    }
    pub(crate) fn u64(&mut self) -> Result<u64, MediaError> {
        let b = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Ok(u64::from_be_bytes(a))
    }
}
