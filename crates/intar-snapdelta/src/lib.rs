//! A VM memory file stored as a delta against a base snapshot's memory file.
//!
//! Delta file, little endian:
//!
//! - header (40 bytes): magic, page size (u32), pages per chunk (u32), pages
//!   (u64), mode (u32, always 0), chunks (u32), page map length (u64);
//! - per chunk, the length of its frame (u32);
//! - the page map, one zstd frame holding one byte per page: 0 = the base's
//!   page, 1 = zero, 2 = the page itself, 3 = the page XOR the base's page;
//! - per chunk, one independent zstd frame holding that chunk's data pages
//!   (kinds 2 and 3) in address order. A chunk without data pages has frame
//!   length 0.
//!
//! [`diff`] runs where the delta is built. [`apply`] runs on a host and
//! treats the delta as untrusted: every header field, table entry and page
//! kind is checked before it is used, and nothing is allocated beyond what
//! the base's size allows.

use std::fs::File;
use std::io::{BufWriter, Write as _};
use std::os::unix::fs::FileExt as _;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::Relaxed};

const PAGE: usize = 4096;
const MAGIC: &[u8; 8] = b"SNPDLT1\0";
const HEADER: usize = 40;
const SAME: u8 = 0;
const ZERO: u8 = 1;
const RAW: u8 = 2;
const XOR: u8 = 3;
/// A page is stored XORed when at most this many of its bytes differ from
/// the base's page; above that the page itself compresses better.
const XOR_MAX_DIFF: usize = 1024;
/// 4 MiB of pages per chunk.
const CHUNK_PAGES: usize = 1024;
/// The largest chunk [`apply`] accepts (256 MiB); it bounds the buffers.
const MAX_CHUNK_PAGES: usize = 65536;
static ZERO_PAGE: [u8; PAGE] = [0; PAGE];

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("snapdelta: {0}")]
    Invalid(&'static str),
}

/// Page counts by kind and the size of the delta written.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DiffStats {
    pub same: u64,
    pub zero: u64,
    pub raw: u64,
    pub xor: u64,
    pub delta_bytes: u64,
}

/// Runs `work(chunk_index, buffer_a, buffer_b)` for every chunk on
/// `threads` threads, each with two buffers of `buffer` bytes.
fn for_chunks<F>(chunks: usize, threads: usize, buffer: usize, work: F) -> Result<(), Error>
where
    F: Fn(usize, &mut [u8], &mut [u8]) -> Result<(), Error> + Sync,
{
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads.clamp(1, chunks.max(1)))
            .map(|_| {
                scope.spawn(|| {
                    let (mut a, mut b) = (vec![0; buffer], vec![0; buffer]);
                    loop {
                        let index = next.fetch_add(1, Relaxed);
                        if index >= chunks {
                            return Ok(());
                        }
                        work(index, &mut a, &mut b)?;
                    }
                })
            })
            .collect();
        workers.into_iter().try_for_each(|worker| {
            worker
                .join()
                .map_err(|_| Error::Invalid("a worker panicked"))?
        })
    })
}

fn len_of(file: &File) -> Result<usize, Error> {
    usize::try_from(file.metadata()?.len()).map_err(|_| Error::Invalid("file too large"))
}

/// Writes `fork` as a delta against `base` to `delta`. Both files must have
/// the same size, a multiple of 4096.
///
/// # Errors
///
/// When a file cannot be read or written, or the sizes do not fit.
pub fn diff(
    base: &Path,
    fork: &Path,
    delta: &Path,
    level: i32,
    threads: usize,
) -> Result<DiffStats, Error> {
    diff_chunked(base, fork, delta, level, threads, CHUNK_PAGES)
}

fn diff_chunked(
    base: &Path,
    fork: &Path,
    delta: &Path,
    level: i32,
    threads: usize,
    chunk_pages: usize,
) -> Result<DiffStats, Error> {
    let (base, fork) = (File::open(base)?, File::open(fork)?);
    let size = len_of(&fork)?;
    if size != len_of(&base)? || !size.is_multiple_of(PAGE) {
        return Err(Error::Invalid(
            "base and fork must have the same size, a multiple of 4096",
        ));
    }
    let chunk_bytes = chunk_pages * PAGE;
    let chunks = size.div_ceil(chunk_bytes);
    let chunk_count = u32::try_from(chunks).map_err(|_| Error::Invalid("too many chunks"))?;
    let out = Mutex::new(vec![(Vec::new(), Vec::new()); chunks]);
    for_chunks(chunks, threads, chunk_bytes, |index, base_buf, fork_buf| {
        let offset = index * chunk_bytes;
        let len = chunk_bytes.min(size - offset);
        let (base_buf, fork_buf) = (&mut base_buf[..len], &mut fork_buf[..len]);
        base.read_exact_at(base_buf, offset as u64)?;
        fork.read_exact_at(fork_buf, offset as u64)?;
        let mut kinds = Vec::with_capacity(len / PAGE);
        let mut data = Vec::new();
        for (base_page, page) in base_buf
            .as_chunks::<PAGE>()
            .0
            .iter()
            .zip(fork_buf.as_chunks::<PAGE>().0)
        {
            // Zero is tested first, so a page that is zero in both files is
            // ZERO and `apply` never reads it from the base.
            if page == &ZERO_PAGE {
                kinds.push(ZERO);
            } else if page == base_page {
                kinds.push(SAME);
            } else if base_page != &ZERO_PAGE
                && page
                    .iter()
                    .zip(base_page.iter())
                    .filter(|(a, b)| a != b)
                    .count()
                    <= XOR_MAX_DIFF
            {
                kinds.push(XOR);
                data.extend(page.iter().zip(base_page.iter()).map(|(a, b)| a ^ b));
            } else {
                kinds.push(RAW);
                data.extend_from_slice(page);
            }
        }
        let frame = if data.is_empty() {
            Vec::new()
        } else {
            zstd::bulk::compress(&data, level)?
        };
        if u32::try_from(frame.len()).is_err() {
            return Err(Error::Invalid("chunk frame too large"));
        }
        out.lock().map_err(|_| Error::Invalid("lock poisoned"))?[index] = (kinds, frame);
        Ok(())
    })?;
    let out = out
        .into_inner()
        .map_err(|_| Error::Invalid("lock poisoned"))?;
    let map: Vec<u8> = out.iter().flat_map(|(kinds, _)| kinds).copied().collect();
    let map_frame = zstd::bulk::compress(&map, 19)?;

    let mut writer = BufWriter::new(File::create(delta)?);
    writer.write_all(MAGIC)?;
    writer.write_all(&(PAGE as u32).to_le_bytes())?;
    writer.write_all(&(chunk_pages as u32).to_le_bytes())?;
    writer.write_all(&((size / PAGE) as u64).to_le_bytes())?;
    writer.write_all(&0_u32.to_le_bytes())?;
    writer.write_all(&chunk_count.to_le_bytes())?;
    writer.write_all(&(map_frame.len() as u64).to_le_bytes())?;
    for (_, frame) in &out {
        writer.write_all(&(frame.len() as u32).to_le_bytes())?;
    }
    writer.write_all(&map_frame)?;
    for (_, frame) in &out {
        writer.write_all(frame)?;
    }
    writer.flush()?;

    let count = |kind: u8| map.iter().filter(|&&k| k == kind).count() as u64;
    let frames: usize = out.iter().map(|(_, frame)| frame.len()).sum();
    Ok(DiffStats {
        same: count(SAME),
        zero: count(ZERO),
        raw: count(RAW),
        xor: count(XOR),
        delta_bytes: (HEADER + 4 * chunks + map_frame.len() + frames) as u64,
    })
}

fn le32(bytes: &[u8], at: usize) -> usize {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize
}

fn le64(bytes: &[u8], at: usize) -> Result<usize, Error> {
    let mut value = [0; 8];
    value.copy_from_slice(&bytes[at..at + 8]);
    usize::try_from(u64::from_le_bytes(value)).map_err(|_| Error::Invalid("field too large"))
}

fn read_vec(file: &File, offset: usize, len: usize) -> Result<Vec<u8>, Error> {
    let mut bytes = vec![0; len];
    file.read_exact_at(&mut bytes, offset as u64)?;
    Ok(bytes)
}

/// Rebuilds the file `delta` was made from, from `base` and `delta`, as a
/// sparse file at `out` (zero pages are not written). Returns the bytes
/// written. The base's pages that the delta replaces are never read.
///
/// The caller checks the result against the digest it expects: a delta
/// applied to another base of the same size gives a wrong file, not an
/// error.
///
/// # Errors
///
/// When a file cannot be read or written, or the delta is not a valid delta
/// for a base of this size.
pub fn apply(base: &Path, delta: &Path, out: &Path, threads: usize) -> Result<u64, Error> {
    let (base, delta) = (File::open(base)?, File::open(delta)?);
    let (size, delta_len) = (len_of(&base)?, len_of(&delta)?);
    if delta_len < HEADER {
        return Err(Error::Invalid("delta shorter than its header"));
    }
    let header = read_vec(&delta, 0, HEADER)?;
    if &header[..8] != MAGIC || le32(&header, 8) != PAGE {
        return Err(Error::Invalid("not a snapdelta file"));
    }
    let (chunk_pages, chunks) = (le32(&header, 12), le32(&header, 28));
    let (pages, map_len) = (le64(&header, 16)?, le64(&header, 32)?);
    if !(1..=MAX_CHUNK_PAGES).contains(&chunk_pages) {
        return Err(Error::Invalid("chunk size out of range"));
    }
    if !size.is_multiple_of(PAGE) || pages != size / PAGE {
        return Err(Error::Invalid("base size does not match the delta"));
    }
    if chunks != pages.div_ceil(chunk_pages) {
        return Err(Error::Invalid("chunk count does not match the size"));
    }
    // `chunks` is at most `pages`, so the table is at most the base's size.
    let table_end = HEADER + 4 * chunks;
    let frames_start = table_end
        .checked_add(map_len)
        .filter(|&end| end <= delta_len)
        .ok_or(Error::Invalid("delta shorter than its page map"))?;
    let table = read_vec(&delta, HEADER, 4 * chunks)?;
    let mut frames = Vec::with_capacity(chunks);
    let mut offset = frames_start;
    for index in 0..chunks {
        let len = le32(&table, 4 * index);
        frames.push((offset, len));
        offset = offset
            .checked_add(len)
            .ok_or(Error::Invalid("frame table overflows"))?;
    }
    if offset != delta_len {
        return Err(Error::Invalid(
            "delta length does not match its frame table",
        ));
    }
    let map = zstd::bulk::decompress(&read_vec(&delta, table_end, map_len)?, pages)
        .map_err(|_| Error::Invalid("page map does not decode"))?;
    if map.len() != pages || map.iter().any(|&kind| kind > XOR) {
        return Err(Error::Invalid("page map is not valid"));
    }

    let out = File::create(out)?;
    out.set_len(size as u64)?;
    let chunk_bytes = chunk_pages * PAGE;
    let written = AtomicU64::new(0);
    for_chunks(chunks, threads, chunk_bytes, |index, buf, _| {
        let start = index * chunk_bytes;
        let len = chunk_bytes.min(size - start);
        let buf = &mut buf[..len];
        let kinds = &map[start / PAGE..(start + len) / PAGE];

        // Read from the base only the runs of pages taken from it.
        let from_base = |kind: u8| kind == SAME || kind == XOR;
        let mut page = 0;
        while page < kinds.len() {
            if !from_base(kinds[page]) {
                page += 1;
                continue;
            }
            let run = page;
            while page < kinds.len() && from_base(kinds[page]) {
                page += 1;
            }
            base.read_exact_at(
                &mut buf[run * PAGE..page * PAGE],
                (start + run * PAGE) as u64,
            )?;
        }

        let data_pages = kinds.iter().filter(|&&kind| kind >= RAW).count();
        let (frame_at, frame_len) = frames[index];
        let data = if data_pages == 0 {
            if frame_len != 0 {
                return Err(Error::Invalid("frame for a chunk without data pages"));
            }
            Vec::new()
        } else {
            let frame = read_vec(&delta, frame_at, frame_len)?;
            zstd::bulk::decompress(&frame, data_pages * PAGE)
                .ok()
                .filter(|data| data.len() == data_pages * PAGE)
                .ok_or(Error::Invalid("chunk frame does not decode"))?
        };
        let mut data = data.as_chunks::<PAGE>().0.iter();
        for (page, &kind) in buf.as_chunks_mut::<PAGE>().0.iter_mut().zip(kinds) {
            match kind {
                SAME => {}
                ZERO => page.fill(0),
                _ => {
                    let stored = data.next().ok_or(Error::Invalid("data underrun"))?;
                    if kind == RAW {
                        page.copy_from_slice(stored);
                    } else {
                        page.iter_mut().zip(stored).for_each(|(a, b)| *a ^= b);
                    }
                }
            }
        }

        // Sparse output: write runs of non-zero pages only.
        let pages = len / PAGE;
        let mut run = None;
        for page in 0..=pages {
            let nonzero = page < pages && buf[page * PAGE..(page + 1) * PAGE] != ZERO_PAGE;
            match (run, nonzero) {
                (None, true) => run = Some(page),
                (Some(first), false) => {
                    out.write_all_at(
                        &buf[first * PAGE..page * PAGE],
                        (start + first * PAGE) as u64,
                    )?;
                    written.fetch_add(((page - first) * PAGE) as u64, Relaxed);
                    run = None;
                }
                _ => {}
            }
        }
        Ok(())
    })?;
    Ok(written.load(Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    /// 150 pages with 16 pages per chunk: the last chunk is short. The fork
    /// has identical, zeroed, new, slightly changed and fully changed pages.
    fn files() -> (Vec<u8>, Vec<u8>) {
        let mut state = 7_u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut base = vec![0_u8; 150 * PAGE];
        for page in base.as_chunks_mut::<PAGE>().0 {
            if next() % 10 < 6 {
                page.iter_mut().for_each(|byte| *byte = next() as u8);
            }
        }
        let mut fork = base.clone();
        for page in fork.as_chunks_mut::<PAGE>().0 {
            match next() % 10 {
                0 => page.fill(0),
                1 => page.iter_mut().for_each(|byte| *byte = next() as u8),
                2 | 3 => page[next() as usize % PAGE] ^= 0x5a,
                _ => {}
            }
        }
        (base, fork)
    }

    #[test]
    fn apply_rebuilds_the_fork() -> TestResult {
        let dir = tempfile::tempdir()?;
        let path = |name: &str| dir.path().join(name);
        let (base, fork) = files();
        fs::write(path("base"), &base)?;
        fs::write(path("fork"), &fork)?;

        let stats = diff_chunked(&path("base"), &path("fork"), &path("delta"), 3, 4, 16)?;
        assert_eq!(stats.same + stats.zero + stats.raw + stats.xor, 150);
        assert!(stats.same > 0 && stats.zero > 0 && stats.raw > 0 && stats.xor > 0);
        assert_eq!(stats.delta_bytes, fs::metadata(path("delta"))?.len());
        for threads in [1, 8] {
            let written = apply(&path("base"), &path("delta"), &path("out"), threads)?;
            assert_eq!(fs::read(path("out"))?, fork);
            assert!(written < fork.len() as u64);
        }

        // The default chunk size, and a fork equal to its base.
        diff(&path("base"), &path("base"), &path("delta"), 3, 2)?;
        apply(&path("base"), &path("delta"), &path("out"), 2)?;
        assert_eq!(fs::read(path("out"))?, base);
        Ok(())
    }

    #[test]
    fn apply_refuses_a_delta_that_does_not_fit() -> TestResult {
        let dir = tempfile::tempdir()?;
        let path = |name: &str| dir.path().join(name);
        let (base, fork) = files();
        fs::write(path("base"), &base)?;
        fs::write(path("fork"), &fork)?;
        diff_chunked(&path("base"), &path("fork"), &path("delta"), 3, 1, 16)?;
        let delta = fs::read(path("delta"))?;

        let refused = |bytes: &[u8]| -> Result<bool, std::io::Error> {
            fs::write(path("bad"), bytes)?;
            Ok(matches!(
                apply(&path("base"), &path("bad"), &path("out"), 2),
                Err(Error::Invalid(_))
            ))
        };
        let with = |at: usize, value: &[u8]| {
            let mut bytes = delta.clone();
            bytes[at..at + value.len()].copy_from_slice(value);
            bytes
        };
        assert!(refused(&delta[..20])?, "short header");
        assert!(refused(&delta[..delta.len() - 1])?, "truncated");
        assert!(refused(&[&delta[..], &[0]].concat())?, "trailing byte");
        assert!(refused(&with(0, b"X"))?, "magic");
        assert!(refused(&with(12, &0_u32.to_le_bytes()))?, "chunk size 0");
        assert!(refused(&with(12, &u32::MAX.to_le_bytes()))?, "chunk size");
        assert!(refused(&with(16, &u64::MAX.to_le_bytes()))?, "pages");
        assert!(refused(&with(28, &1_u32.to_le_bytes()))?, "chunk count");
        assert!(refused(&with(32, &u64::MAX.to_le_bytes()))?, "map length");
        assert!(refused(&with(HEADER, &u32::MAX.to_le_bytes()))?, "frame");
        assert!(refused(&with(delta.len() - 8, &[0xff; 8]))?, "frame data");

        fs::write(path("base"), &base[..PAGE])?;
        assert!(refused(&delta)?, "another base size");
        Ok(())
    }
}
