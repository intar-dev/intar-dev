//! Live mirrors of a run's terminals for public share links.
//!
//! Every PTY session of a shared run streams what its terminal shows, never
//! what the learner types, over one ingest socket to the control plane, which
//! stores it and fans it out to viewers.
//!
//! The bridge taps its output pump, and that pump kills the shell when output
//! delivery stalls for `BRIDGE_OUTPUT_TIMEOUT`. So the tap never awaits: it
//! appends to a bounded outbox under a short lock, and a writer task drains
//! the outbox to the socket. Output that does not fit is dropped and reported,
//! in its place in the stream, as a `gap`.

use std::{
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use dashmap::DashMap;
use futures_util::{
    Sink, SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use stargate_core::{
    Result, SHARE_INGEST_CLOSE_ENDED, SHARE_INGEST_CLOSE_LIMIT, SHARE_INGEST_CLOSE_STOPPED,
    SHARE_INGEST_PING, ShareEvent, ShareEventCode, ShareIngestMessage, StargateError,
    StoredTerminalRoute, TerminalSessionMode,
};
use tokio::{net::TcpStream, sync::Notify};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{
        self, Message,
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
        protocol::{CloseFrame, WebSocketConfig},
    },
};
use tokio_util::sync::CancellationToken;

use crate::SqliteRouteStore;

/// Output one session keeps while its writer is behind or reconnecting.
const OUTBOX_LIMIT_BYTES: usize = 1024 * 1024;
/// What a queued item costs besides its output, so that a flood of tiny
/// chunks can not hold more memory than the limit says.
const ITEM_COST_BYTES: usize = 64;
/// One `events` frame carries about this much JSON. An event holds one SSH
/// packet (at most 16 KiB, whose JSON is at most six times that), so a frame
/// stays well under the control plane's 256 KiB limit, which closes the socket
/// for good.
const FRAME_BYTES: usize = 32 * 1024;
/// The JSON of an event besides its data: `[<u64>,"o","…"],` is at most 30.
const EVENT_COST_BYTES: usize = 32;
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
const PING_INTERVAL: Duration = Duration::from_secs(30);
/// The control plane answers every ping, so this much silence, or a send that
/// makes no progress for this long, means the socket is dead even when TCP has
/// not noticed yet. TCP alone takes many minutes to give up on a lost peer.
const SILENCE_LIMIT: Duration = Duration::from_secs(75);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// The control plane only sends pongs and close frames.
const MAX_INBOUND_BYTES: usize = 64 * 1024;
/// The run stopped streaming to this share while the PTY lives on. Not
/// `SHARE_INGEST_CLOSE_ENDED`, and this writer does not resume.
const CLOSE_DETACHED: u16 = 1001;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The runs whose terminals stream to a share, cached from the store. `None`
/// when no ingest URL is configured: nothing is mirrored.
#[derive(Clone, Default)]
pub(crate) struct RunMirrors(Option<Arc<Mirrors>>);

pub(crate) struct Mirrors {
    /// `ws(s)://…/share-ingest`, without the share query.
    ingest_url: url::Url,
    store: SqliteRouteStore,
    targets: DashMap<String, Arc<MirrorTarget>>,
    /// One admin call at a time writes the store and then the cache, so the
    /// two never disagree.
    mutation: tokio::sync::Mutex<()>,
}

struct MirrorTarget {
    share_id: String,
    write_token: String,
    /// Cancelled when the run stops streaming to this share: every writer for
    /// it closes and does not resume.
    stopped: CancellationToken,
}

impl RunMirrors {
    pub(crate) async fn load(store: SqliteRouteStore, ingest_base_url: &url::Url) -> Result<Self> {
        let ingest_url = ingest_socket_url(ingest_base_url)?;
        if ingest_url.scheme() == "wss" {
            // The gateway links two rustls providers (aws-lc-rs through
            // reqwest, ring through sqlx), so rustls can not pick a process
            // default and the socket's TLS setup would panic without one.
            // reqwest already uses aws-lc-rs, so this changes nothing there.
            let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        }
        let targets = DashMap::new();
        for (run_id, share_id, write_token) in store.list_run_mirrors().await? {
            targets.insert(run_id, Arc::new(MirrorTarget::new(share_id, write_token)));
        }
        Ok(Self(Some(Arc::new(Mirrors {
            ingest_url,
            store,
            targets,
            mutation: tokio::sync::Mutex::new(()),
        }))))
    }

    /// The mirror API, or `None` when share ingest is not configured.
    pub(crate) fn enabled(&self) -> Option<&Mirrors> {
        self.0.as_deref()
    }

    /// The tap for one PTY session on `route`. It tracks the terminal size
    /// from the start, so a share that begins later reports the right one.
    pub(crate) fn session(
        &self,
        route: &StoredTerminalRoute,
        cols: u16,
        rows: u16,
    ) -> SessionMirror {
        SessionMirror(self.0.clone().map(|mirrors| Session {
            mirrors,
            run_id: route.metadata.run_id.clone(),
            vm_id: route.metadata.vm_id.clone(),
            mode: route.mode,
            id: uuid::Uuid::new_v4().to_string(),
            started: Instant::now(),
            started_unix_ms: unix_ms(),
            tap: Mutex::new(Tap {
                cols: cols.max(1),
                rows: rows.max(1),
                seen_output: false,
                writer: None,
            }),
        }))
    }
}

impl Mirrors {
    /// Stream the run to the share. A repeat with the same share and token
    /// keeps the live writers; anything else replaces them. Returns false, and
    /// changes nothing, when the run streams to another share that the control
    /// plane claimed later.
    pub(crate) async fn put(
        &self,
        run_id: &str,
        share_id: &str,
        write_token: &str,
        claimed_at_ms: i64,
    ) -> Result<bool> {
        let _mutation = self.mutation.lock().await;
        if !self
            .store
            .upsert_run_mirror(run_id, share_id, write_token, claimed_at_ms)
            .await?
        {
            return Ok(false);
        }
        let unchanged = self.targets.get(run_id).is_some_and(|current| {
            current.share_id == share_id && current.write_token == write_token
        });
        if !unchanged {
            let target = MirrorTarget::new(share_id.to_owned(), write_token.to_owned());
            // Publish the new share before stopping the old one, so the next
            // output already starts the writer for the new share.
            if let Some(previous) = self.targets.insert(run_id.to_owned(), Arc::new(target)) {
                previous.stopped.cancel();
            }
        }
        Ok(true)
    }

    /// Stop the run's mirror while it still streams to `share_id`. Returns
    /// false, and stops nothing, when it streams to another share. A run
    /// without a mirror is already stopped.
    pub(crate) async fn delete(&self, run_id: &str, share_id: &str) -> Result<bool> {
        let _mutation = self.mutation.lock().await;
        if !self.store.delete_run_mirror(run_id, share_id).await? {
            return Ok(false);
        }
        if let Some((_, target)) = self.targets.remove(run_id) {
            target.stopped.cancel();
        }
        Ok(true)
    }
}

impl MirrorTarget {
    fn new(share_id: String, write_token: String) -> Self {
        Self {
            share_id,
            write_token,
            stopped: CancellationToken::new(),
        }
    }
}

/// `https` maps to `wss`. Plain `http` is only for a loopback control plane:
/// the socket carries a bearer token.
fn ingest_socket_url(base: &url::Url) -> Result<url::Url> {
    let loopback = match base.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(name)) => name == "localhost",
        None => false,
    };
    let scheme = match base.scheme() {
        "https" => "wss",
        "http" if loopback => "ws",
        _ => {
            return Err(StargateError::Validation(
                "share.ingest_base_url must use https, or http on a loopback host".to_owned(),
            ));
        }
    };
    if !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(StargateError::Validation(
            "share.ingest_base_url must not carry credentials, a query, or a fragment".to_owned(),
        ));
    }
    let mut url = base.clone();
    url.set_scheme(scheme).map_err(|()| {
        StargateError::Validation("share.ingest_base_url has no WebSocket form".to_owned())
    })?;
    let path = format!("{}/share-ingest", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

/// The mirror tap of one PTY session. The methods are synchronous and only
/// take short locks, because the bridge calls them from its output pump.
/// Dropping the tap ends the session: the writer sends what is left and
/// closes with `SHARE_INGEST_CLOSE_ENDED`.
#[derive(Default)]
pub(crate) struct SessionMirror(Option<Session>);

struct Session {
    mirrors: Arc<Mirrors>,
    run_id: String,
    vm_id: String,
    mode: TerminalSessionMode,
    /// One id per PTY session. A writer that reconnects, or that starts again
    /// for another share, sends it again so the session continues.
    id: String,
    started: Instant,
    started_unix_ms: u64,
    tap: Mutex<Tap>,
}

struct Tap {
    cols: u16,
    rows: u16,
    /// The terminal drew output before the current writer started.
    seen_output: bool,
    writer: Option<Writer>,
}

/// The writer task of one share, and the outbox it drains.
struct Writer {
    target: Arc<MirrorTarget>,
    outbox: Arc<Outbox>,
}

impl SessionMirror {
    pub(crate) fn output(&self, data: &[u8]) {
        let Some(session) = &self.0 else {
            return;
        };
        let at = session.elapsed_ms();
        let mut tap = lock(&session.tap);
        if let Some(writer) = session.writer(&mut tap) {
            writer.outbox.push_output(at, data);
        }
        tap.seen_output = true;
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) {
        let Some(session) = &self.0 else {
            return;
        };
        let at = session.elapsed_ms();
        let mut tap = lock(&session.tap);
        (tap.cols, tap.rows) = (cols, rows);
        if let Some(writer) = session.writer(&mut tap) {
            writer.outbox.push_resize(at, cols, rows);
        }
    }
}

impl Drop for SessionMirror {
    fn drop(&mut self) {
        if let Some(session) = &mut self.0
            && let Some(writer) = &session
                .tap
                .get_mut()
                .unwrap_or_else(PoisonError::into_inner)
                .writer
        {
            writer.outbox.end();
        }
    }
}

impl Session {
    /// The writer for the run's current share. It starts one when the run
    /// started sharing, or moved to another share, since the last call, and
    /// forgets it when the run stopped sharing. A writer that stopped for good
    /// stays: the same share does not get a second one.
    fn writer<'tap>(&self, tap: &'tap mut Tap) -> Option<&'tap Writer> {
        let Some(target) = self
            .mirrors
            .targets
            .get(&self.run_id)
            .map(|entry| Arc::clone(entry.value()))
        else {
            tap.writer = None;
            return None;
        };
        let current = tap
            .writer
            .as_ref()
            .is_some_and(|writer| Arc::ptr_eq(&writer.target, &target));
        if !current {
            let outbox = Arc::new(Outbox::new(tap.cols, tap.rows));
            let mut url = self.mirrors.ingest_url.clone();
            url.query_pairs_mut().append_pair("s", &target.share_id);
            tokio::spawn(run_writer(WriterTask {
                url,
                target: Arc::clone(&target),
                outbox: Arc::clone(&outbox),
                run_id: self.run_id.clone(),
                session: self.id.clone(),
                vm_id: self.vm_id.clone(),
                mode: self.mode,
                at_ms: self.started_unix_ms,
                mid_session: tap.seen_output,
            }));
            tap.writer = Some(Writer { target, outbox });
        }
        tap.writer.as_ref()
    }

    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// What the tap queued for one writer. Output beyond `OUTBOX_LIMIT_BYTES` is
/// dropped and counted as a gap in its place, so the outbox stays bounded no
/// matter how long the writer is behind.
struct Outbox {
    state: Mutex<OutboxState>,
    /// Wakes the writer when a frame's worth is queued or the PTY ended.
    ready: Notify,
}

struct OutboxState {
    items: Vec<Item>,
    bytes: usize,
    cols: u16,
    rows: u16,
    ended: bool,
    /// The writer stopped for good, so nothing drains this outbox any more.
    closed: bool,
}

#[derive(Debug, PartialEq)]
enum Item {
    Output {
        at: u64,
        data: Vec<u8>,
    },
    Resize {
        at: u64,
        cols: u16,
        rows: u16,
    },
    /// Dropped items: `bytes` of output, and the size of the terminal after
    /// them, since a dropped resize must not leave viewers at the wrong size.
    Gap {
        bytes: u64,
        at: u64,
        cols: u16,
        rows: u16,
    },
}

impl Outbox {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            state: Mutex::new(OutboxState {
                items: Vec::new(),
                bytes: 0,
                cols,
                rows,
                ended: false,
                closed: false,
            }),
            ready: Notify::new(),
        }
    }

    fn push_output(&self, at: u64, data: &[u8]) {
        let mut state = lock(&self.state);
        if state.closed {
            return;
        }
        let cost = data.len() + ITEM_COST_BYTES;
        if state.bytes + cost > OUTBOX_LIMIT_BYTES {
            state.drop_item(at, data.len() as u64);
            return;
        }
        state.items.push(Item::Output {
            at,
            data: data.to_vec(),
        });
        state.bytes += cost;
        if state.bytes >= FRAME_BYTES {
            self.ready.notify_one();
        }
    }

    fn push_resize(&self, at: u64, cols: u16, rows: u16) {
        let mut state = lock(&self.state);
        (state.cols, state.rows) = (cols, rows);
        if state.closed {
            return;
        }
        // Only the last size of a burst matters, and folding the burst keeps a
        // resize flood from growing the outbox.
        if let Some(Item::Resize {
            at: last_at,
            cols: last_cols,
            rows: last_rows,
        }) = state.items.last_mut()
        {
            (*last_at, *last_cols, *last_rows) = (at, cols, rows);
            return;
        }
        if state.bytes + ITEM_COST_BYTES > OUTBOX_LIMIT_BYTES {
            state.drop_item(at, 0);
            return;
        }
        state.items.push(Item::Resize { at, cols, rows });
        state.bytes += ITEM_COST_BYTES;
    }

    fn end(&self) {
        lock(&self.state).ended = true;
        self.ready.notify_one();
    }

    /// Everything queued so far, and whether the PTY ended after it.
    fn take(&self) -> (Vec<Item>, bool) {
        let mut state = lock(&self.state);
        state.bytes = 0;
        (std::mem::take(&mut state.items), state.ended)
    }

    fn size(&self) -> (u16, u16) {
        let state = lock(&self.state);
        (state.cols, state.rows)
    }

    fn is_ended(&self) -> bool {
        lock(&self.state).ended
    }

    fn close(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        state.items = Vec::new();
        state.bytes = 0;
    }
}

impl OutboxState {
    /// Fold a dropped item into the gap that ends the queue. A gap costs
    /// nothing, and two gaps are never adjacent, so they stay bounded too.
    fn drop_item(&mut self, at: u64, bytes: u64) {
        let (cols, rows) = (self.cols, self.rows);
        if let Some(Item::Gap {
            bytes: total,
            at: last_at,
            cols: last_cols,
            rows: last_rows,
        }) = self.items.last_mut()
        {
            *total += bytes;
            (*last_at, *last_cols, *last_rows) = (at, cols, rows);
        } else {
            self.items.push(Item::Gap {
                bytes,
                at,
                cols,
                rows,
            });
        }
    }
}

/// Turn queued items into ingest frames: `events` frames of about
/// `FRAME_BYTES` of JSON each, with every gap in its place.
fn frames(items: Vec<Item>, decoder: &mut Utf8Decoder) -> Vec<ShareIngestMessage> {
    let mut frames = Frames::default();
    for item in items {
        match item {
            Item::Output { at, data } => {
                let text = decoder.decode(&data);
                if !text.is_empty() {
                    frames.event(ShareEvent(at, ShareEventCode::Output, text));
                }
            }
            Item::Resize { at, cols, rows } => frames.event(resize_event(at, cols, rows)),
            Item::Gap {
                bytes,
                at,
                cols,
                rows,
            } => {
                if bytes > 0 {
                    frames.flush();
                    frames.done.push(ShareIngestMessage::Gap { bytes });
                    // The output after a gap does not continue a character
                    // that the dropped output began.
                    decoder.reset();
                }
                frames.event(resize_event(at, cols, rows));
            }
        }
    }
    frames.flush();
    frames.done
}

#[derive(Default)]
struct Frames {
    done: Vec<ShareIngestMessage>,
    events: Vec<ShareEvent>,
    /// An upper bound of the JSON of `events`.
    size: usize,
}

impl Frames {
    fn event(&mut self, event: ShareEvent) {
        self.size += EVENT_COST_BYTES + json_len(&event.2);
        self.events.push(event);
        if self.size >= FRAME_BYTES {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if !self.events.is_empty() {
            self.done.push(ShareIngestMessage::Events {
                events: std::mem::take(&mut self.events),
            });
        }
        self.size = 0;
    }
}

/// The length of `text` as a JSON string. Terminal output is full of control
/// characters, and each one becomes a six-byte `\u00XX` escape.
fn json_len(text: &str) -> usize {
    text.chars()
        .map(|c| match c {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
            c if c < ' ' => 6,
            c => c.len_utf8(),
        })
        .sum()
}

fn resize_event(at: u64, cols: u16, rows: u16) -> ShareEvent {
    ShareEvent(at, ShareEventCode::Resize, format!("{cols}x{rows}"))
}

/// Incremental UTF-8: a character split across two chunks is carried into the
/// next chunk, and an invalid byte becomes U+FFFD.
#[derive(Default)]
struct Utf8Decoder {
    carry: Vec<u8>,
}

impl Utf8Decoder {
    fn decode(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.carry);
        bytes.extend_from_slice(chunk);
        let mut text = String::with_capacity(bytes.len());
        let mut rest = bytes.as_slice();
        while !rest.is_empty() {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    break;
                }
                Err(error) => {
                    let (valid, invalid) = rest.split_at(error.valid_up_to());
                    text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        Some(len) => {
                            text.push(char::REPLACEMENT_CHARACTER);
                            rest = &invalid[len..];
                        }
                        None => {
                            self.carry = invalid.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        text
    }

    fn reset(&mut self) {
        self.carry.clear();
    }
}

struct WriterTask {
    /// The ingest URL with this writer's share id. Never logged.
    url: url::Url,
    target: Arc<MirrorTarget>,
    outbox: Arc<Outbox>,
    run_id: String,
    session: String,
    vm_id: String,
    mode: TerminalSessionMode,
    at_ms: u64,
    mid_session: bool,
}

#[derive(PartialEq)]
enum Streamed {
    /// The writer is done: the PTY ended, the share stopped, or the control
    /// plane stopped the writer.
    Done,
    /// The socket dropped. The writer reconnects and resumes the session.
    Dropped,
}

async fn run_writer(mut task: WriterTask) {
    let mut backoff = BACKOFF_MIN;
    let mut decoder = Utf8Decoder::default();
    // Output that was taken from the outbox and not delivered.
    let mut lost = 0;
    loop {
        let connected = tokio::select! {
            biased;
            () = task.target.stopped.cancelled() => break,
            connected = connect(&task.url, &task.target.write_token) => connected,
        };
        match connected {
            Ok(socket) => {
                let connected_at = Instant::now();
                if task.stream(socket, &mut decoder, &mut lost).await == Streamed::Done {
                    break;
                }
                // Only a connection that held resets the backoff, so a control
                // plane that accepts and drops at once is not hammered.
                if connected_at.elapsed() >= BACKOFF_MAX {
                    backoff = BACKOFF_MIN;
                }
                task.mid_session = true;
                tracing::info!(
                    run_id = %task.run_id,
                    session = %task.session,
                    "share ingest socket dropped, resuming"
                );
            }
            Err(tungstenite::Error::Http(response))
                if matches!(response.status().as_u16(), 401 | 403 | 404 | 410) =>
            {
                tracing::warn!(
                    run_id = %task.run_id,
                    session = %task.session,
                    status = response.status().as_u16(),
                    "share ingest refused the writer"
                );
                break;
            }
            Err(error) => {
                tracing::warn!(
                    run_id = %task.run_id,
                    session = %task.session,
                    error = %error,
                    "share ingest connection failed"
                );
                // After the PTY ended there is only the tail left to deliver,
                // and it is not worth retrying for.
                if task.outbox.is_ended() {
                    break;
                }
            }
        }
        tokio::select! {
            biased;
            () = task.target.stopped.cancelled() => break,
            () = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
    task.outbox.close();
}

impl WriterTask {
    async fn stream(&self, socket: Socket, decoder: &mut Utf8Decoder, lost: &mut u64) -> Streamed {
        let (mut sink, mut source) = socket.split();
        let (cols, rows) = self.outbox.size();
        let mut opening = vec![ShareIngestMessage::Start {
            session: self.session.clone(),
            vm_id: self.vm_id.clone(),
            mode: self.mode,
            cols,
            rows,
            at_ms: self.at_ms,
            mid_session: self.mid_session,
        }];
        if *lost > 0 {
            opening.push(ShareIngestMessage::Gap {
                bytes: std::mem::take(lost),
            });
            decoder.reset();
        }
        if !send_frames(&mut sink, opening, lost).await {
            return Streamed::Dropped;
        }

        let mut flush = tokio::time::interval(FLUSH_INTERVAL);
        let mut ping =
            tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
        let mut heard = Instant::now();
        loop {
            tokio::select! {
                biased;
                () = self.target.stopped.cancelled() => {
                    close(&mut sink, &mut source, CLOSE_DETACHED).await;
                    return Streamed::Done;
                }
                message = source.next() => match message {
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.map(|frame| u16::from(frame.code));
                        if matches!(code, Some(SHARE_INGEST_CLOSE_LIMIT | SHARE_INGEST_CLOSE_STOPPED)) {
                            tracing::info!(
                                run_id = %self.run_id,
                                session = %self.session,
                                code,
                                "control plane stopped the share writer"
                            );
                            return Streamed::Done;
                        }
                        return Streamed::Dropped;
                    }
                    Some(Ok(_)) => {
                        heard = Instant::now();
                        continue;
                    }
                    Some(Err(_)) | None => return Streamed::Dropped,
                },
                _ = ping.tick() => {
                    if heard.elapsed() > SILENCE_LIMIT
                        || !send(&mut sink, Message::text(SHARE_INGEST_PING)).await
                    {
                        return Streamed::Dropped;
                    }
                    continue;
                }
                () = self.outbox.ready.notified() => {}
                _ = flush.tick() => {}
            }
            let (items, ended) = self.outbox.take();
            if !send_frames(&mut sink, frames(items, decoder), lost).await {
                return Streamed::Dropped;
            }
            if ended {
                close(&mut sink, &mut source, SHARE_INGEST_CLOSE_ENDED).await;
                return Streamed::Done;
            }
        }
    }
}

async fn connect(url: &url::Url, write_token: &str) -> tungstenite::Result<Socket> {
    let mut request = url.as_str().into_client_request()?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {write_token}"))?;
    authorization.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, authorization);
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_INBOUND_BYTES))
        .max_frame_size(Some(MAX_INBOUND_BYTES));
    let (socket, _) = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(config), true),
    )
    .await
    .map_err(|_| tungstenite::Error::Io(std::io::ErrorKind::TimedOut.into()))??;
    Ok(socket)
}

/// Send the frames in order. On a failure the output they carried counts as
/// lost, and the next connection reports it as a gap.
async fn send_frames(
    sink: &mut (impl Sink<Message> + Unpin),
    frames: Vec<ShareIngestMessage>,
    lost: &mut u64,
) -> bool {
    for (index, frame) in frames.iter().enumerate() {
        let Ok(text) = serde_json::to_string(frame) else {
            continue;
        };
        if !send(sink, Message::text(text)).await {
            *lost += frames[index..].iter().map(output_bytes).sum::<u64>();
            return false;
        }
    }
    true
}

/// One send, bounded: a send to a lost peer would otherwise wait until TCP
/// gives up, and neither the silence check nor a stopped share could end it.
async fn send(sink: &mut (impl Sink<Message> + Unpin), message: Message) -> bool {
    matches!(
        tokio::time::timeout(SILENCE_LIMIT, sink.send(message)).await,
        Ok(Ok(()))
    )
}

fn output_bytes(frame: &ShareIngestMessage) -> u64 {
    match frame {
        ShareIngestMessage::Events { events } => events
            .iter()
            .filter(|event| event.1 == ShareEventCode::Output)
            .map(|event| event.2.len() as u64)
            .sum(),
        ShareIngestMessage::Gap { bytes } => *bytes,
        ShareIngestMessage::Start { .. } => 0,
    }
}

/// Close with `code`, then wait briefly for the control plane's close frame so
/// the code arrives before the connection drops. Best effort, and bounded as a
/// whole: a dead connection must not hold the writer.
async fn close(sink: &mut SplitSink<Socket, Message>, source: &mut SplitStream<Socket>, code: u16) {
    let frame = CloseFrame {
        code: code.into(),
        reason: "".into(),
    };
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
        if sink.send(Message::Close(Some(frame))).await.is_ok() {
            while let Some(Ok(_)) = source.next().await {}
        }
    })
    .await;
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use anyhow::{Context, bail};
    use futures_util::StreamExt;
    use stargate_core::{
        RouteMetadata, ShareEvent, ShareEventCode, ShareIngestMessage, StoredTarget,
        StoredTerminalRoute, TerminalSessionMode,
    };
    use time::OffsetDateTime;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{
        WebSocketStream,
        tungstenite::{
            Message,
            handshake::server::{Callback, ErrorResponse, Request, Response},
            protocol::Role,
        },
    };

    use super::{
        FRAME_BYTES, ITEM_COST_BYTES, Item, OUTBOX_LIMIT_BYTES, Outbox, RunMirrors, SILENCE_LIMIT,
        Utf8Decoder, frames, send_frames,
    };
    use crate::SqliteRouteStore;

    const SHARE_ID: &str = "share-id-0123456789abc";
    const OTHER_SHARE_ID: &str = "other-id-0123456789abc";
    const WRITE_TOKEN: &str = "write-token-0123456789abcdefghijklmnopqrstu";

    /// The socket carries a bearer token, so plain http is only for loopback.
    #[test]
    fn the_ingest_url_needs_https_off_loopback() -> anyhow::Result<()> {
        let url = |base: &str| -> anyhow::Result<String> {
            Ok(super::ingest_socket_url(&base.parse()?)?.to_string())
        };
        assert_eq!(url("https://intar.dev")?, "wss://intar.dev/share-ingest");
        assert_eq!(
            url("https://intar.dev/api/")?,
            "wss://intar.dev/api/share-ingest"
        );
        assert_eq!(
            url("http://127.0.0.1:8787")?,
            "ws://127.0.0.1:8787/share-ingest"
        );
        assert!(url("http://intar.dev").is_err());
        assert!(url("https://user:secret@intar.dev").is_err());
        assert!(url("https://intar.dev/?s=1").is_err());
        Ok(())
    }

    #[test]
    fn split_characters_carry_over_and_invalid_bytes_become_replacements() {
        let mut decoder = Utf8Decoder::default();
        let euro = "€".as_bytes();
        assert_eq!(decoder.decode(&[b'a', euro[0]]), "a");
        assert_eq!(decoder.decode(&euro[1..2]), "");
        assert_eq!(decoder.decode(&[euro[2], b'b']), "€b");
        assert_eq!(decoder.decode(&[b'x', 0xff, b'y', 0xe2]), "x\u{fffd}y");
        // The carried lead byte does not start a character after all.
        assert_eq!(decoder.decode(b"z"), "\u{fffd}z");
    }

    #[test]
    fn frames_batch_output_and_keep_each_gap_in_place() -> anyhow::Result<()> {
        // Frames are budgeted by their JSON size, escapes included.
        for text in ["plain", "\u{1b}[1;31m\"quoted\\\"\r\n\t\0\u{7f}é€"] {
            assert_eq!(
                super::json_len(text) + 2,
                serde_json::to_string(text)?.len()
            );
        }
        let half = "a".repeat(FRAME_BYTES / 2 + 1);
        let items = vec![
            output(1, &half),
            output(2, &half),
            output(3, "b"),
            Item::Gap {
                bytes: 7,
                at: 4,
                cols: 100,
                rows: 30,
            },
            output(5, "c"),
        ];
        let event = |at, code, data: &str| ShareEvent(at, code, data.to_owned());
        assert_eq!(
            frames(items, &mut Utf8Decoder::default()),
            vec![
                ShareIngestMessage::Events {
                    events: vec![
                        event(1, ShareEventCode::Output, &half),
                        event(2, ShareEventCode::Output, &half),
                    ],
                },
                ShareIngestMessage::Events {
                    events: vec![event(3, ShareEventCode::Output, "b")],
                },
                ShareIngestMessage::Gap { bytes: 7 },
                ShareIngestMessage::Events {
                    events: vec![
                        event(4, ShareEventCode::Resize, "100x30"),
                        event(5, ShareEventCode::Output, "c"),
                    ],
                },
            ]
        );
        Ok(())
    }

    /// Every event costs JSON besides its data, so a backlog of tiny chunks
    /// still splits into frames far below the control plane's 256 KiB limit.
    #[test]
    fn a_backlog_of_tiny_chunks_splits_into_small_frames() -> anyhow::Result<()> {
        let items = (0..20_000)
            .map(|_| Item::Output {
                at: u64::MAX,
                data: b"x".to_vec(),
            })
            .collect();
        let frames = frames(items, &mut Utf8Decoder::default());
        for frame in &frames {
            assert!(serde_json::to_string(frame)?.len() < FRAME_BYTES + 1024);
        }
        assert_eq!(shown_output(&frames).len(), 20_000);
        Ok(())
    }

    /// A peer that stops reading must not hold the writer until TCP gives up:
    /// the send ends after `SILENCE_LIMIT`, and its output counts as lost.
    #[tokio::test(start_paused = true)]
    async fn a_send_that_never_completes_gives_up_and_counts_the_output() {
        let (stream, _peer_that_never_reads) = tokio::io::duplex(64);
        let socket = WebSocketStream::from_raw_socket(stream, Role::Client, None).await;
        let (mut sink, _source) = socket.split();
        let frames = vec![
            ShareIngestMessage::Events {
                events: vec![ShareEvent(1, ShareEventCode::Output, "x".repeat(4096))],
            },
            ShareIngestMessage::Gap { bytes: 5 },
        ];
        let mut lost = 0;
        let started = tokio::time::Instant::now();
        assert!(!send_frames(&mut sink, frames, &mut lost).await);
        assert!(started.elapsed() >= SILENCE_LIMIT);
        assert_eq!(lost, 4096 + 5);
    }

    /// A plain test, not an async one: the tap can not await.
    #[test]
    fn a_full_outbox_drops_output_into_a_counted_gap() {
        let outbox = Outbox::new(80, 24);
        let chunk = vec![b'x'; 64 * 1024];
        for at in 0..20 {
            outbox.push_output(at, &chunk);
        }
        outbox.push_resize(20, 100, 30);
        outbox.push_output(21, b"fits");

        let (items, ended) = outbox.take();
        assert!(!ended);
        let kept = OUTBOX_LIMIT_BYTES / (chunk.len() + ITEM_COST_BYTES);
        assert!(
            items[..kept]
                .iter()
                .all(|item| matches!(item, Item::Output { data, .. } if *data == chunk))
        );
        assert_eq!(
            items[kept..],
            [
                Item::Gap {
                    bytes: ((20 - kept) * chunk.len()) as u64,
                    at: 19,
                    cols: 80,
                    rows: 24,
                },
                Item::Resize {
                    at: 20,
                    cols: 100,
                    rows: 30,
                },
                output(21, "fits"),
            ]
        );
        // Taking the queue frees its room.
        outbox.push_output(22, &chunk);
        assert_eq!(
            outbox.take().0,
            [Item::Output {
                at: 22,
                data: chunk
            }]
        );
    }

    /// The tap tracks the size while the run does not share, so a share that
    /// starts later begins at the size the terminal has now, flagged as
    /// mid-session. Ending the PTY closes the socket as ended.
    #[tokio::test]
    async fn a_share_that_starts_mid_session_reports_the_latest_size() -> anyhow::Result<()> {
        let (_temp_dir, store, listener, mirrors) = mirrors_with_ingest().await?;
        let mirror = mirrors.session(&route(), 80, 24);
        mirror.output(b"before");
        mirror.resize(100, 30);
        assert!(
            api(&mirrors)?
                .put("run-01", SHARE_ID, WRITE_TOKEN, 1)
                .await?
        );
        mirror.output(b"after");
        drop(mirror);

        let (target, authorization, mut socket) = accept_writer(&listener).await?;
        assert_eq!(target, format!("/share-ingest?s={SHARE_ID}"));
        assert_eq!(authorization, format!("Bearer {WRITE_TOKEN}"));
        let (frames, close_code) = read_frames(&mut socket, usize::MAX).await?;
        let Some(ShareIngestMessage::Start {
            vm_id,
            mode,
            cols,
            rows,
            mid_session,
            ..
        }) = frames.first()
        else {
            bail!("the first frame is not a start: {frames:?}");
        };
        assert_eq!(
            (vm_id.as_str(), *mode, *cols, *rows, *mid_session),
            ("vm-01", TerminalSessionMode::Native, 100, 30, true)
        );
        assert_eq!(shown_output(&frames[1..]), "after");
        assert_eq!(close_code, Some(super::SHARE_INGEST_CLOSE_ENDED));

        // The mirror outlives a restart.
        let reloaded = RunMirrors::load(store, &"http://127.0.0.1:9".parse()?).await?;
        assert!(api(&reloaded)?.targets.contains_key("run-01"));
        Ok(())
    }

    #[tokio::test]
    async fn stopping_the_share_detaches_the_writer_without_ending_the_session()
    -> anyhow::Result<()> {
        let (_temp_dir, _store, listener, mirrors) = mirrors_with_ingest().await?;
        assert!(
            api(&mirrors)?
                .put("run-01", SHARE_ID, WRITE_TOKEN, 1)
                .await?
        );
        let mirror = mirrors.session(&route(), 80, 24);
        mirror.output(b"live");
        let (_, _, mut socket) = accept_writer(&listener).await?;
        let (frames, _) = read_frames(&mut socket, 2).await?;
        assert!(matches!(
            frames.first(),
            Some(ShareIngestMessage::Start {
                mid_session: false,
                ..
            })
        ));
        assert_eq!(shown_output(&frames), "live");

        // A delete for an older share must not stop the current one.
        assert!(!api(&mirrors)?.delete("run-01", OTHER_SHARE_ID).await?);
        assert!(api(&mirrors)?.delete("run-01", SHARE_ID).await?);
        let (frames, close_code) = read_frames(&mut socket, usize::MAX).await?;
        assert_eq!((frames, close_code), (vec![], Some(super::CLOSE_DETACHED)));
        // The run streams nowhere now, which is what a repeat delete wants.
        assert!(api(&mirrors)?.delete("run-01", SHARE_ID).await?);
        drop(mirror);
        Ok(())
    }

    fn output(at: u64, data: &str) -> Item {
        Item::Output {
            at,
            data: data.as_bytes().to_vec(),
        }
    }

    fn shown_output(frames: &[ShareIngestMessage]) -> String {
        frames
            .iter()
            .flat_map(|frame| match frame {
                ShareIngestMessage::Events { events } => events.as_slice(),
                _ => &[],
            })
            .filter(|event| event.1 == ShareEventCode::Output)
            .map(|event| event.2.as_str())
            .collect()
    }

    fn api(mirrors: &RunMirrors) -> anyhow::Result<&super::Mirrors> {
        mirrors.enabled().context("share ingest is configured")
    }

    async fn mirrors_with_ingest()
    -> anyhow::Result<(tempfile::TempDir, SqliteRouteStore, TcpListener, RunMirrors)> {
        let temp_dir = tempfile::tempdir()?;
        let store = SqliteRouteStore::connect(temp_dir.path().join("stargate.db")).await?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?).parse()?;
        let mirrors = RunMirrors::load(store.clone(), &base).await?;
        Ok((temp_dir, store, listener, mirrors))
    }

    /// Accept one writer, and return its request target and bearer header.
    async fn accept_writer(
        listener: &TcpListener,
    ) -> anyhow::Result<(String, String, WebSocketStream<TcpStream>)> {
        let (stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept()).await??;
        let mut seen = (String::new(), String::new());
        let socket = tokio_tungstenite::accept_hdr_async(stream, Handshake(&mut seen)).await?;
        Ok((seen.0, seen.1, socket))
    }

    /// Records the request target and the bearer header of a handshake.
    struct Handshake<'a>(&'a mut (String, String));

    impl Callback for Handshake<'_> {
        fn on_request(
            self,
            request: &Request,
            response: Response,
        ) -> Result<Response, ErrorResponse> {
            self.0.0 = request.uri().to_string();
            self.0.1 = request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            Ok(response)
        }
    }

    /// Read until `count` frames arrived or the writer closed, and return the
    /// frames with the close code.
    async fn read_frames(
        socket: &mut WebSocketStream<TcpStream>,
        count: usize,
    ) -> anyhow::Result<(Vec<ShareIngestMessage>, Option<u16>)> {
        let mut frames = Vec::new();
        while frames.len() < count {
            match tokio::time::timeout(Duration::from_secs(5), socket.next()).await? {
                Some(Ok(Message::Text(text))) => frames.push(serde_json::from_str(&text)?),
                Some(Ok(Message::Close(frame))) => {
                    return Ok((frames, frame.map(|frame| u16::from(frame.code))));
                }
                Some(Ok(_)) => {}
                other => bail!("the writer left without a close frame: {other:?}"),
            }
        }
        Ok((frames, None))
    }

    fn route() -> StoredTerminalRoute {
        let now = OffsetDateTime::now_utc();
        StoredTerminalRoute {
            route_username: "run-01-web".to_owned(),
            generation: "exec-01:7".to_owned(),
            expires_at: now + time::Duration::hours(1),
            mode: TerminalSessionMode::Native,
            metadata: RouteMetadata {
                host_id: "host-01".to_owned(),
                run_id: "run-01".to_owned(),
                vm_id: "vm-01".to_owned(),
                user_id: "user-01".to_owned(),
            },
            target: StoredTarget::Missing,
            created_at: now,
            updated_at: now,
        }
    }
}
