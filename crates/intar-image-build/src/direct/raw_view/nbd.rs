//! A blocking client for the part of the NBD protocol the raw view uses: a
//! fixed-newstyle handshake over a Unix socket, structured replies, the
//! `base:allocation` metadata context, block status, reads, and disconnect.
//! See <https://github.com/NetworkBlockDevice/nbd/blob/master/doc/proto.md>.

use std::io::{Read, Write};
use std::ops::Range;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Instant;

use anyhow::{Context as _, Result, bail, ensure};

const NBDMAGIC: u64 = 0x4e42_444d_4147_4943;
const IHAVEOPT: u64 = 0x4948_4156_454f_5054;
const OPTION_REPLY_MAGIC: u64 = 0x0003_e889_0455_65a9;
const REQUEST_MAGIC: u32 = 0x2560_9513;
const SIMPLE_REPLY_MAGIC: u32 = 0x6744_6698;
const STRUCTURED_REPLY_MAGIC: u32 = 0x668e_33ef;

const FLAG_FIXED_NEWSTYLE: u16 = 1 << 0;
const FLAG_NO_ZEROES: u16 = 1 << 1;
const TRANSMISSION_FLAG_READ_ONLY: u16 = 1 << 1;

const OPT_GO: u32 = 7;
const OPT_STRUCTURED_REPLY: u32 = 8;
const OPT_SET_META_CONTEXT: u32 = 10;
const REP_ACK: u32 = 1;
const REP_INFO: u32 = 3;
const REP_META_CONTEXT: u32 = 4;
const REP_ERROR_BIT: u32 = 1 << 31;
const INFO_EXPORT: u16 = 0;

const CMD_READ: u16 = 0;
const CMD_DISC: u16 = 2;
const CMD_BLOCK_STATUS: u16 = 7;
const REPLY_FLAG_DONE: u16 = 1 << 0;
const REPLY_TYPE_NONE: u16 = 0;
const REPLY_TYPE_OFFSET_DATA: u16 = 1;
const REPLY_TYPE_OFFSET_HOLE: u16 = 2;
const REPLY_TYPE_BLOCK_STATUS: u16 = 5;
const REPLY_TYPE_ERROR_BIT: u16 = 1 << 15;

const CONTEXT_BASE_ALLOCATION: &str = "base:allocation";
/// `base:allocation` reads as zeroes in this extent.
const STATE_ZERO: u32 = 1 << 1;
/// No option reply this client asks for is anywhere near this large.
const MAX_OPTION_REPLY_BYTES: u32 = 64 * 1024;
/// A server's error message, which this client only reports.
const MAX_ERROR_MESSAGE_BYTES: usize = 4096;

pub(super) struct NbdClient {
    stream: UnixStream,
    size: u64,
    read_only: bool,
    /// The server's id for `base:allocation`, when it agreed to report it.
    allocation_context: Option<u32>,
}

impl NbdClient {
    /// Connects to the default export and negotiates structured replies and
    /// `base:allocation`. A server without either still serves reads.
    pub(super) fn connect(socket: &Path, deadline: Instant) -> Result<Self> {
        let stream = UnixStream::connect(socket).context("failed to connect to NBD export")?;
        let mut client = Self {
            stream,
            size: 0,
            read_only: false,
            allocation_context: None,
        };
        client.set_deadline(deadline)?;
        client.handshake()?;
        Ok(client)
    }

    pub(super) fn size(&self) -> u64 {
        self.size
    }

    pub(super) fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub(super) fn has_allocation_metadata(&self) -> bool {
        self.allocation_context.is_some()
    }

    /// Bounds every later socket read and write by `deadline`.
    pub(super) fn set_deadline(&mut self, deadline: Instant) -> Result<()> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .context("NBD deadline expired")?;
        self.stream.set_read_timeout(Some(remaining))?;
        self.stream.set_write_timeout(Some(remaining))?;
        Ok(())
    }

    fn handshake(&mut self) -> Result<()> {
        ensure!(self.read_u64()? == NBDMAGIC, "NBD server sent no greeting");
        ensure!(
            self.read_u64()? == IHAVEOPT,
            "NBD server does not speak the newstyle protocol"
        );
        let server_flags = self.read_u16()?;
        ensure!(
            server_flags & FLAG_FIXED_NEWSTYLE != 0,
            "NBD server does not speak the fixed newstyle protocol"
        );
        let client_flags = u32::from(FLAG_FIXED_NEWSTYLE | (server_flags & FLAG_NO_ZEROES));
        self.stream.write_all(&client_flags.to_be_bytes())?;

        if self.request_structured_replies()? {
            self.request_allocation_context()?;
        }
        self.go()
    }

    fn request_structured_replies(&mut self) -> Result<bool> {
        self.send_option(OPT_STRUCTURED_REPLY, &[])?;
        let (reply, payload) = self.read_option_reply(OPT_STRUCTURED_REPLY)?;
        match reply {
            REP_ACK if payload.is_empty() => Ok(true),
            reply if reply & REP_ERROR_BIT != 0 => Ok(false),
            reply => bail!("NBD server sent option reply {reply} to structured replies"),
        }
    }

    fn request_allocation_context(&mut self) -> Result<()> {
        let mut data = Vec::new();
        // The default export has the empty name; one query follows.
        data.extend_from_slice(&0_u32.to_be_bytes());
        data.extend_from_slice(&1_u32.to_be_bytes());
        let query = CONTEXT_BASE_ALLOCATION.as_bytes();
        data.extend_from_slice(&u32::try_from(query.len())?.to_be_bytes());
        data.extend_from_slice(query);
        self.send_option(OPT_SET_META_CONTEXT, &data)?;
        loop {
            let (reply, payload) = self.read_option_reply(OPT_SET_META_CONTEXT)?;
            match reply {
                REP_META_CONTEXT => {
                    ensure!(payload.len() >= 4, "NBD meta context reply is truncated");
                    let (id, name) = payload.split_at(4);
                    if name == CONTEXT_BASE_ALLOCATION.as_bytes() {
                        self.allocation_context = Some(u32::from_be_bytes(id.try_into()?));
                    }
                }
                REP_ACK => return Ok(()),
                reply if reply & REP_ERROR_BIT != 0 => {
                    self.allocation_context = None;
                    return Ok(());
                }
                reply => bail!("NBD server sent option reply {reply} to a meta context request"),
            }
        }
    }

    fn go(&mut self) -> Result<()> {
        // The default export, and no information requests beyond the export
        // size and flags the server always sends.
        let mut data = Vec::new();
        data.extend_from_slice(&0_u32.to_be_bytes());
        data.extend_from_slice(&0_u16.to_be_bytes());
        self.send_option(OPT_GO, &data)?;
        let mut export = None;
        loop {
            let (reply, payload) = self.read_option_reply(OPT_GO)?;
            match reply {
                REP_INFO => {
                    ensure!(payload.len() >= 2, "NBD info reply is truncated");
                    if u16::from_be_bytes([payload[0], payload[1]]) == INFO_EXPORT {
                        ensure!(payload.len() == 12, "NBD export info has the wrong length");
                        let size = u64::from_be_bytes(payload[2..10].try_into()?);
                        let flags = u16::from_be_bytes([payload[10], payload[11]]);
                        export = Some((size, flags));
                    }
                }
                REP_ACK => break,
                reply if reply & REP_ERROR_BIT != 0 => {
                    bail!("NBD server refused the export (reply {reply:#x})")
                }
                reply => bail!("NBD server sent option reply {reply} to the export request"),
            }
        }
        let (size, flags) = export.context("NBD server sent no export size")?;
        self.size = size;
        self.read_only = flags & TRANSMISSION_FLAG_READ_ONLY != 0;
        Ok(())
    }

    /// The zero ranges in `[0, size)`, queried `window` bytes at a time.
    pub(super) fn zero_ranges(&mut self, window: u32) -> Result<Vec<Range<u64>>> {
        let context = self
            .allocation_context
            .context("NBD server reports no allocation metadata")?;
        ensure!(window > 0, "NBD block-status window is empty");
        let mut zero_ranges: Vec<Range<u64>> = Vec::new();
        let mut offset = 0;
        while offset < self.size {
            let length = u32::try_from((self.size - offset).min(u64::from(window)))?;
            let end = offset + u64::from(length);
            self.send_request(CMD_BLOCK_STATUS, 0, offset, length)?;
            let mut extents_seen = false;
            loop {
                let reply = self.read_structured_reply(0)?;
                match reply.kind {
                    REPLY_TYPE_BLOCK_STATUS => {
                        ensure!(
                            reply.payload.len() >= 4 && (reply.payload.len() - 4) % 8 == 0,
                            "NBD block-status reply has the wrong length"
                        );
                        let (id, descriptors) = reply.payload.split_at(4);
                        if u32::from_be_bytes(id.try_into()?) == context {
                            let mut cursor = offset;
                            for descriptor in descriptors.as_chunks::<8>().0 {
                                let length =
                                    u64::from(u32::from_be_bytes(descriptor[..4].try_into()?));
                                let flags = u32::from_be_bytes(descriptor[4..].try_into()?);
                                let extent_end = cursor
                                    .checked_add(length)
                                    .filter(|extent_end| length > 0 && *extent_end <= end)
                                    .context("NBD block-status returned an invalid extent")?;
                                if flags & STATE_ZERO != 0 {
                                    match zero_ranges.last_mut() {
                                        Some(last) if last.end == cursor => last.end = extent_end,
                                        _ => zero_ranges.push(cursor..extent_end),
                                    }
                                }
                                cursor = extent_end;
                            }
                            extents_seen = true;
                        }
                    }
                    REPLY_TYPE_NONE => {}
                    kind => bail!("NBD server sent reply type {kind} to block status"),
                }
                if reply.done {
                    break;
                }
            }
            ensure!(
                extents_seen,
                "NBD block status at byte {offset} returned no extents"
            );
            offset = end;
        }
        Ok(zero_ranges)
    }

    /// Reads every `(offset, length)` range. The requests are all sent before
    /// the first reply is read, so the server serves them concurrently.
    pub(super) fn read_ranges(&mut self, ranges: &[(u64, usize)]) -> Result<Vec<Vec<u8>>> {
        for (offset, length) in ranges {
            offset
                .checked_add(u64::try_from(*length)?)
                .filter(|end| *length > 0 && *end <= self.size)
                .context("invalid NBD read range")?;
        }
        for (cookie, (offset, length)) in ranges.iter().enumerate() {
            self.send_request(
                CMD_READ,
                u64::try_from(cookie)?,
                *offset,
                u32::try_from(*length)?,
            )?;
        }
        let mut buffers: Vec<Vec<u8>> = ranges.iter().map(|(_, length)| vec![0; *length]).collect();
        let mut filled = vec![0_usize; ranges.len()];
        let mut done = vec![false; ranges.len()];
        let mut first_error = None;
        while done.iter().any(|done| !done) {
            let (cookie, reply) = self.read_reply()?;
            let index = usize::try_from(cookie)
                .ok()
                .filter(|index| *index < ranges.len() && !done[*index])
                .context("NBD server answered a request it was not sent")?;
            let (offset, length) = ranges[index];
            match reply {
                Reply::Simple { error: 0 } => {
                    // Without structured replies the data follows the header.
                    self.stream.read_exact(&mut buffers[index])?;
                    filled[index] = length;
                    done[index] = true;
                }
                Reply::Simple { error } => {
                    first_error.get_or_insert_with(|| {
                        anyhow::anyhow!("NBD read at byte {offset} failed with error {error}")
                    });
                    done[index] = true;
                }
                Reply::Structured(reply) => {
                    match reply.kind {
                        REPLY_TYPE_OFFSET_DATA | REPLY_TYPE_OFFSET_HOLE => {
                            let (chunk_offset, chunk_length, data) =
                                if reply.kind == REPLY_TYPE_OFFSET_DATA {
                                    ensure!(reply.payload.len() > 8, "NBD data chunk is truncated");
                                    let data = &reply.payload[8..];
                                    (
                                        u64::from_be_bytes(reply.payload[..8].try_into()?),
                                        data.len(),
                                        Some(data),
                                    )
                                } else {
                                    ensure!(
                                        reply.payload.len() == 12,
                                        "NBD hole chunk has the wrong length"
                                    );
                                    let hole = u32::from_be_bytes(reply.payload[8..].try_into()?);
                                    (
                                        u64::from_be_bytes(reply.payload[..8].try_into()?),
                                        usize::try_from(hole)?,
                                        None,
                                    )
                                };
                            let start = chunk_offset
                                .checked_sub(offset)
                                .and_then(|start| usize::try_from(start).ok())
                                .filter(|start| {
                                    start
                                        .checked_add(chunk_length)
                                        .is_some_and(|end| end <= length)
                                })
                                .context("NBD server returned data outside the requested range")?;
                            // A hole reads as the zeroes the buffer already holds.
                            if let Some(data) = data {
                                buffers[index][start..start + chunk_length].copy_from_slice(data);
                            }
                            filled[index] += chunk_length;
                        }
                        REPLY_TYPE_NONE => {}
                        kind if kind & REPLY_TYPE_ERROR_BIT != 0 => {
                            first_error.get_or_insert_with(|| {
                                anyhow::anyhow!(
                                    "NBD read at byte {offset} failed: {}",
                                    reply.error_message()
                                )
                            });
                        }
                        kind => bail!("NBD server sent reply type {kind} to a read"),
                    }
                    done[index] = reply.done;
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        // The server must cover each read exactly once, so the chunks adding
        // up to the length rules out both gaps and overlaps.
        for (index, (offset, length)) in ranges.iter().enumerate() {
            ensure!(
                filled[index] == *length,
                "NBD reader returned a partial chunk at byte {offset}"
            );
        }
        Ok(buffers)
    }

    /// Ends the session. The server closes the socket without a reply.
    pub(super) fn disconnect(mut self) -> Result<()> {
        self.send_request(CMD_DISC, 0, 0, 0)?;
        self.stream.shutdown(std::net::Shutdown::Write)?;
        Ok(())
    }

    fn send_option(&mut self, option: u32, data: &[u8]) -> Result<()> {
        let mut message = Vec::with_capacity(16 + data.len());
        message.extend_from_slice(&IHAVEOPT.to_be_bytes());
        message.extend_from_slice(&option.to_be_bytes());
        message.extend_from_slice(&u32::try_from(data.len())?.to_be_bytes());
        message.extend_from_slice(data);
        self.stream.write_all(&message)?;
        Ok(())
    }

    fn read_option_reply(&mut self, option: u32) -> Result<(u32, Vec<u8>)> {
        ensure!(
            self.read_u64()? == OPTION_REPLY_MAGIC,
            "NBD server sent a malformed option reply"
        );
        ensure!(
            self.read_u32()? == option,
            "NBD server answered another option"
        );
        let reply = self.read_u32()?;
        let length = self.read_u32()?;
        ensure!(
            length <= MAX_OPTION_REPLY_BYTES,
            "NBD option reply is too large"
        );
        let mut payload = vec![0; usize::try_from(length)?];
        self.stream.read_exact(&mut payload)?;
        Ok((reply, payload))
    }

    fn send_request(&mut self, command: u16, cookie: u64, offset: u64, length: u32) -> Result<()> {
        let mut request = [0_u8; 28];
        request[..4].copy_from_slice(&REQUEST_MAGIC.to_be_bytes());
        request[6..8].copy_from_slice(&command.to_be_bytes());
        request[8..16].copy_from_slice(&cookie.to_be_bytes());
        request[16..24].copy_from_slice(&offset.to_be_bytes());
        request[24..].copy_from_slice(&length.to_be_bytes());
        self.stream.write_all(&request)?;
        Ok(())
    }

    fn read_reply(&mut self) -> Result<(u64, Reply)> {
        match self.read_u32()? {
            SIMPLE_REPLY_MAGIC => {
                let error = self.read_u32()?;
                Ok((self.read_u64()?, Reply::Simple { error }))
            }
            STRUCTURED_REPLY_MAGIC => {
                let (cookie, reply) = self.read_structured_reply_body()?;
                Ok((cookie, Reply::Structured(reply)))
            }
            magic => bail!("NBD server sent a reply with magic {magic:#x}"),
        }
    }

    fn read_structured_reply(&mut self, cookie: u64) -> Result<StructuredReply> {
        ensure!(
            self.read_u32()? == STRUCTURED_REPLY_MAGIC,
            "NBD server sent a simple reply to block status"
        );
        let (reply_cookie, reply) = self.read_structured_reply_body()?;
        ensure!(
            reply_cookie == cookie,
            "NBD server answered a request it was not sent"
        );
        if reply.kind & REPLY_TYPE_ERROR_BIT != 0 {
            bail!("NBD block status failed: {}", reply.error_message());
        }
        Ok(reply)
    }

    fn read_structured_reply_body(&mut self) -> Result<(u64, StructuredReply)> {
        let flags = self.read_u16()?;
        let kind = self.read_u16()?;
        let cookie = self.read_u64()?;
        let length = self.read_u32()?;
        // A data chunk carries one read; nothing else this client asks for
        // comes near the 32 MiB a server may send at once.
        ensure!(
            length <= 32 * 1024 * 1024 + 8,
            "NBD reply chunk is too large"
        );
        let mut payload = vec![0; usize::try_from(length)?];
        self.stream.read_exact(&mut payload)?;
        Ok((
            cookie,
            StructuredReply {
                done: flags & REPLY_FLAG_DONE != 0,
                kind,
                payload,
            },
        ))
    }

    fn read_u16(&mut self) -> Result<u16> {
        let mut bytes = [0; 2];
        self.stream.read_exact(&mut bytes)?;
        Ok(u16::from_be_bytes(bytes))
    }

    fn read_u32(&mut self) -> Result<u32> {
        let mut bytes = [0; 4];
        self.stream.read_exact(&mut bytes)?;
        Ok(u32::from_be_bytes(bytes))
    }

    fn read_u64(&mut self) -> Result<u64> {
        let mut bytes = [0; 8];
        self.stream.read_exact(&mut bytes)?;
        Ok(u64::from_be_bytes(bytes))
    }
}

enum Reply {
    Simple { error: u32 },
    Structured(StructuredReply),
}

struct StructuredReply {
    done: bool,
    kind: u16,
    payload: Vec<u8>,
}

impl StructuredReply {
    /// The message of an error chunk: an error code, then a length-prefixed
    /// message, then for some errors an offset.
    fn error_message(&self) -> String {
        let code = self
            .payload
            .get(..4)
            .and_then(|code| code.try_into().ok())
            .map_or(0, u32::from_be_bytes);
        let message = self
            .payload
            .get(4..6)
            .map(|length| usize::from(u16::from_be_bytes([length[0], length[1]])))
            .and_then(|length| self.payload.get(6..6 + length.min(MAX_ERROR_MESSAGE_BYTES)))
            .map(String::from_utf8_lossy)
            .unwrap_or_default();
        format!("error {code}: {message}")
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    /// A scripted server: the handshake every test shares, then `serve`.
    fn server(
        export_size: u64,
        transmission_flags: u16,
        allocation: bool,
        serve: impl FnOnce(&mut UnixStream) + Send + 'static,
    ) -> (tempfile::TempDir, thread::JoinHandle<()>) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nbd.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let join = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(&NBDMAGIC.to_be_bytes()).unwrap();
            stream.write_all(&IHAVEOPT.to_be_bytes()).unwrap();
            stream
                .write_all(&(FLAG_FIXED_NEWSTYLE | FLAG_NO_ZEROES).to_be_bytes())
                .unwrap();
            let mut flags = [0; 4];
            stream.read_exact(&mut flags).unwrap();
            loop {
                let (option, data) = read_option(&mut stream);
                match option {
                    OPT_STRUCTURED_REPLY => option_reply(&mut stream, option, REP_ACK, &[]),
                    OPT_SET_META_CONTEXT => {
                        assert!(data.ends_with(CONTEXT_BASE_ALLOCATION.as_bytes()));
                        if allocation {
                            let mut payload = 7_u32.to_be_bytes().to_vec();
                            payload.extend_from_slice(CONTEXT_BASE_ALLOCATION.as_bytes());
                            option_reply(&mut stream, option, REP_META_CONTEXT, &payload);
                        }
                        option_reply(&mut stream, option, REP_ACK, &[]);
                    }
                    OPT_GO => {
                        let mut info = INFO_EXPORT.to_be_bytes().to_vec();
                        info.extend_from_slice(&export_size.to_be_bytes());
                        info.extend_from_slice(&transmission_flags.to_be_bytes());
                        option_reply(&mut stream, option, REP_INFO, &info);
                        option_reply(&mut stream, option, REP_ACK, &[]);
                        break;
                    }
                    other => panic!("unexpected option {other}"),
                }
            }
            serve(&mut stream);
        });
        (directory, join)
    }

    fn read_option(stream: &mut UnixStream) -> (u32, Vec<u8>) {
        let mut header = [0; 16];
        stream.read_exact(&mut header).unwrap();
        assert_eq!(
            u64::from_be_bytes(header[..8].try_into().unwrap()),
            IHAVEOPT
        );
        let option = u32::from_be_bytes(header[8..12].try_into().unwrap());
        let mut data = vec![0; u32::from_be_bytes(header[12..].try_into().unwrap()) as usize];
        stream.read_exact(&mut data).unwrap();
        (option, data)
    }

    fn option_reply(stream: &mut UnixStream, option: u32, reply: u32, payload: &[u8]) {
        stream.write_all(&OPTION_REPLY_MAGIC.to_be_bytes()).unwrap();
        stream.write_all(&option.to_be_bytes()).unwrap();
        stream.write_all(&reply.to_be_bytes()).unwrap();
        stream
            .write_all(&(payload.len() as u32).to_be_bytes())
            .unwrap();
        stream.write_all(payload).unwrap();
    }

    /// Reads one request and returns `(command, cookie, offset, length)`.
    fn read_request(stream: &mut UnixStream) -> (u16, u64, u64, u32) {
        let mut request = [0; 28];
        stream.read_exact(&mut request).unwrap();
        assert_eq!(
            u32::from_be_bytes(request[..4].try_into().unwrap()),
            REQUEST_MAGIC
        );
        (
            u16::from_be_bytes(request[6..8].try_into().unwrap()),
            u64::from_be_bytes(request[8..16].try_into().unwrap()),
            u64::from_be_bytes(request[16..24].try_into().unwrap()),
            u32::from_be_bytes(request[24..].try_into().unwrap()),
        )
    }

    fn chunk(stream: &mut UnixStream, done: bool, kind: u16, cookie: u64, payload: &[u8]) {
        stream
            .write_all(&STRUCTURED_REPLY_MAGIC.to_be_bytes())
            .unwrap();
        stream.write_all(&u16::from(done).to_be_bytes()).unwrap();
        stream.write_all(&kind.to_be_bytes()).unwrap();
        stream.write_all(&cookie.to_be_bytes()).unwrap();
        stream
            .write_all(&(payload.len() as u32).to_be_bytes())
            .unwrap();
        stream.write_all(payload).unwrap();
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    #[test]
    fn negotiates_the_export_and_allocation_metadata() {
        let (directory, join) = server(4096, TRANSMISSION_FLAG_READ_ONLY, true, |stream| {
            assert_eq!(read_request(stream).0, CMD_DISC);
        });
        let client = NbdClient::connect(&directory.path().join("nbd.sock"), deadline()).unwrap();
        assert_eq!(client.size(), 4096);
        assert!(client.is_read_only());
        assert!(client.has_allocation_metadata());
        client.disconnect().unwrap();
        join.join().unwrap();
    }

    #[test]
    fn a_server_without_allocation_metadata_still_connects() {
        let (directory, join) = server(4096, 0, false, |_| {});
        let client = NbdClient::connect(&directory.path().join("nbd.sock"), deadline()).unwrap();
        assert!(!client.is_read_only());
        assert!(!client.has_allocation_metadata());
        drop(client);
        join.join().unwrap();
    }

    #[test]
    fn collects_zero_extents_window_by_window() {
        let (directory, join) = server(3000, TRANSMISSION_FLAG_READ_ONLY, true, |stream| {
            for (offset, extents) in [
                (0_u64, vec![(1000_u32, STATE_ZERO), (1000, 0)]),
                (2000, vec![(1000, STATE_ZERO | 1)]),
            ] {
                let (command, cookie, request_offset, length) = read_request(stream);
                assert_eq!((command, request_offset), (CMD_BLOCK_STATUS, offset));
                assert!(length <= 2000);
                let mut payload = 7_u32.to_be_bytes().to_vec();
                for (length, flags) in extents {
                    payload.extend_from_slice(&length.to_be_bytes());
                    payload.extend_from_slice(&flags.to_be_bytes());
                }
                chunk(stream, true, REPLY_TYPE_BLOCK_STATUS, cookie, &payload);
            }
        });
        let mut client =
            NbdClient::connect(&directory.path().join("nbd.sock"), deadline()).unwrap();
        assert_eq!(client.zero_ranges(2000).unwrap(), vec![0..1000, 2000..3000]);
        drop(client);
        join.join().unwrap();
    }

    #[test]
    fn an_extent_past_the_window_is_rejected() {
        let (directory, join) = server(1000, TRANSMISSION_FLAG_READ_ONLY, true, |stream| {
            let (_, cookie, _, _) = read_request(stream);
            let mut payload = 7_u32.to_be_bytes().to_vec();
            payload.extend_from_slice(&2000_u32.to_be_bytes());
            payload.extend_from_slice(&STATE_ZERO.to_be_bytes());
            chunk(stream, true, REPLY_TYPE_BLOCK_STATUS, cookie, &payload);
        });
        let mut client =
            NbdClient::connect(&directory.path().join("nbd.sock"), deadline()).unwrap();
        let error = client.zero_ranges(1000).unwrap_err();
        assert!(format!("{error:#}").contains("invalid extent"), "{error:#}");
        drop(client);
        join.join().unwrap();
    }

    #[test]
    fn pipelined_reads_assemble_data_and_hole_chunks_in_any_order() {
        let (directory, join) = server(64, TRANSMISSION_FLAG_READ_ONLY, true, |stream| {
            let first = read_request(stream);
            let second = read_request(stream);
            assert_eq!((first.0, first.2, first.3), (CMD_READ, 0, 16));
            assert_eq!((second.0, second.2, second.3), (CMD_READ, 32, 16));
            // The second read is answered first, as a hole and then data.
            let mut hole = 32_u64.to_be_bytes().to_vec();
            hole.extend_from_slice(&8_u32.to_be_bytes());
            chunk(stream, false, REPLY_TYPE_OFFSET_HOLE, second.1, &hole);
            let mut data = 40_u64.to_be_bytes().to_vec();
            data.extend_from_slice(&[2; 8]);
            chunk(stream, true, REPLY_TYPE_OFFSET_DATA, second.1, &data);
            let mut data = 0_u64.to_be_bytes().to_vec();
            data.extend_from_slice(&[1; 16]);
            chunk(stream, true, REPLY_TYPE_OFFSET_DATA, first.1, &data);
        });
        let mut client =
            NbdClient::connect(&directory.path().join("nbd.sock"), deadline()).unwrap();
        let buffers = client.read_ranges(&[(0, 16), (32, 16)]).unwrap();
        assert_eq!(buffers[0], vec![1; 16]);
        assert_eq!(buffers[1], [vec![0; 8], vec![2; 8]].concat());
        drop(client);
        join.join().unwrap();
    }

    #[test]
    fn a_read_that_leaves_a_gap_is_partial() {
        let (directory, join) = server(64, TRANSMISSION_FLAG_READ_ONLY, true, |stream| {
            let (_, cookie, _, _) = read_request(stream);
            let mut data = 0_u64.to_be_bytes().to_vec();
            data.extend_from_slice(&[1; 8]);
            chunk(stream, true, REPLY_TYPE_OFFSET_DATA, cookie, &data);
        });
        let mut client =
            NbdClient::connect(&directory.path().join("nbd.sock"), deadline()).unwrap();
        let error = client.read_ranges(&[(0, 16)]).unwrap_err();
        assert!(format!("{error:#}").contains("partial chunk"), "{error:#}");
        drop(client);
        join.join().unwrap();
    }

    #[test]
    fn a_server_error_fails_the_read_with_its_message() {
        let (directory, join) = server(64, TRANSMISSION_FLAG_READ_ONLY, true, |stream| {
            let (_, cookie, _, _) = read_request(stream);
            let mut payload = 5_u32.to_be_bytes().to_vec();
            payload.extend_from_slice(&(b"I/O error".len() as u16).to_be_bytes());
            payload.extend_from_slice(b"I/O error");
            chunk(stream, true, REPLY_TYPE_ERROR_BIT | 1, cookie, &payload);
        });
        let mut client =
            NbdClient::connect(&directory.path().join("nbd.sock"), deadline()).unwrap();
        let error = client.read_ranges(&[(0, 16)]).unwrap_err();
        assert!(
            format!("{error:#}").contains("error 5: I/O error"),
            "{error:#}"
        );
        drop(client);
        join.join().unwrap();
    }

    #[test]
    fn a_read_past_the_export_is_refused_before_sending() {
        let (directory, join) = server(64, TRANSMISSION_FLAG_READ_ONLY, true, |_| {});
        let mut client =
            NbdClient::connect(&directory.path().join("nbd.sock"), deadline()).unwrap();
        assert!(client.read_ranges(&[(60, 16)]).is_err());
        drop(client);
        join.join().unwrap();
    }

    fn on_path(name: &str) -> Option<std::path::PathBuf> {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|directory| directory.join(name))
            .find(|path| path.is_file())
    }

    /// The client against QEMU's own server, exporting a qcow2 with the raw
    /// view's arguments. Skips where qemu-img or qemu-storage-daemon is
    /// missing.
    #[test]
    fn reads_a_qemu_storage_daemon_export() {
        let (Some(qemu_img), Some(qsd)) = (on_path("qemu-img"), on_path("qemu-storage-daemon"))
        else {
            eprintln!("skipping: qemu-img or qemu-storage-daemon is not on PATH");
            return;
        };
        const MIB: usize = 1024 * 1024;
        let directory = tempfile::tempdir().unwrap();
        let mut raw = vec![0_u8; 8 * MIB];
        for (index, byte) in raw[MIB..MIB + 64 * 1024].iter_mut().enumerate() {
            *byte = (index % 251) as u8 + 1;
        }
        raw[6 * MIB..6 * MIB + MIB / 2].fill(0xa5);
        std::fs::write(directory.path().join("disk.raw"), &raw).unwrap();
        let qcow2 = directory.path().join("disk.qcow2");
        let converted = std::process::Command::new(qemu_img)
            .args(["convert", "-f", "raw", "-O", "qcow2"])
            .arg(directory.path().join("disk.raw"))
            .arg(&qcow2)
            .status()
            .unwrap();
        assert!(converted.success());
        let socket = directory.path().join("nbd.sock");
        let arguments = super::super::qsd_arguments(
            &qcow2,
            socket.to_str().unwrap(),
            &directory.path().join("qsd.pid"),
        )
        .unwrap();
        let mut daemon = std::process::Command::new(qsd)
            .args(arguments)
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !socket.exists() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "QSD never listened"
            );
            thread::sleep(Duration::from_millis(20));
        }

        let result = (|| -> Result<()> {
            let mut client = NbdClient::connect(&socket, deadline())?;
            ensure!(client.size() == raw.len() as u64, "wrong export size");
            ensure!(client.is_read_only(), "export is writable");
            ensure!(client.has_allocation_metadata(), "no allocation metadata");
            let zero_ranges = client.zero_ranges(MIB as u32)?;
            for range in &zero_ranges {
                let range = range.start as usize..range.end as usize;
                ensure!(
                    raw[range.clone()].iter().all(|byte| *byte == 0),
                    "{range:?} is not zero"
                );
            }
            let zero_bytes: u64 = zero_ranges
                .iter()
                .map(|range| range.end - range.start)
                .sum();
            ensure!(
                zero_bytes >= 6 * MIB as u64,
                "only {zero_bytes} zero bytes reported"
            );
            let ranges = (0..8)
                .map(|index| ((index * MIB) as u64, MIB))
                .collect::<Vec<_>>();
            ensure!(
                client.read_ranges(&ranges)?.concat() == raw,
                "read data differs"
            );
            client.disconnect()
        })();
        daemon.kill().unwrap();
        daemon.wait().unwrap();
        result.unwrap();
    }

    #[test]
    fn a_silent_server_times_out_at_the_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nbd.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        let started = Instant::now();
        let deadline = started + Duration::from_millis(200);
        assert!(NbdClient::connect(&path, deadline).is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
