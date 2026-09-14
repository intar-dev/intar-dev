//! Registry upload-admission sessions.
//!
//! One publish holds one session from the first chunk-exists probe until the
//! manifest is stored. The registry refuses cleanup while the session is open,
//! and it rejects any session-aware call whose session header is unknown or
//! superseded. A heartbeat keeps long uploads admitted; a failed heartbeat makes
//! the session unusable, so the caller stops instead of writing against a stale
//! session. A superseded session is discarded and replaced, and the chunk-exists
//! probe runs again, because the replacement session protects nothing the old
//! one claimed.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Opaque admission handle sent with every registry call of one upload.
pub(crate) const SESSION_HEADER: &str = "x-intar-registry-session";

/// Registry routes that own session registration and lifecycle actions.
pub(crate) const SESSION_ROUTE: &str = "upload-sessions";
pub(crate) const SESSION_HEARTBEAT_ACTION: &str = "heartbeat";
pub(crate) const SESSION_COMPLETE_ACTION: &str = "complete";

/// Error codes the registry returns when a session no longer protects work.
pub(crate) const SESSION_SUPERSEDED_CODE: &str = "registry_session_superseded";
pub(crate) const SESSION_UNKNOWN_CODE: &str = "registry_session_unknown";
pub(crate) const SESSION_CLOSED_CODE: &str = "registry_session_closed";

const MIN_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(250);
const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// Shutdown waits at most this long for the beat request that is in flight.
const STOP_BOUND: Duration = Duration::from_secs(5);

/// The registry reports the beat interval. A missing or nonsensical value
/// falls back to a conservative interval; a tiny value is floored so a broken
/// response cannot turn into a request storm.
pub(crate) fn heartbeat_interval(millis: Option<u64>) -> Duration {
    match millis {
        Some(millis) if millis > 0 => Duration::from_millis(millis).max(MIN_HEARTBEAT_INTERVAL),
        _ => DEFAULT_HEARTBEAT_INTERVAL,
    }
}

/// Why the registry stopped admitting the session.
#[derive(Clone, Debug)]
pub(crate) enum BeatFailure {
    /// The lease lapsed or a sweep started. The upload may continue on a fresh
    /// session after a new chunk-exists probe.
    Superseded,
    /// The session is gone or belongs to another owner. There is no recovery.
    Fatal(String),
}

impl BeatFailure {
    pub(crate) fn detail(&self) -> &str {
        match self {
            Self::Superseded => "the session lease lapsed or a sweep started",
            Self::Fatal(detail) => detail,
        }
    }
}

/// Classify a heartbeat response body. The registry reports an unusable
/// session with one of the two session codes; anything else is fatal.
pub(crate) fn classify_beat_failure(status: reqwest::StatusCode, body: &str) -> BeatFailure {
    match session_code(status, body) {
        Some(_) => BeatFailure::Superseded,
        None => BeatFailure::Fatal(format!(
            "registry heartbeat failed with HTTP {status}: {body}"
        )),
    }
}

/// The session code carried by a registry error body, when it reports that the
/// session no longer protects the upload.
pub(crate) fn session_code(status: reqwest::StatusCode, body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let code = value.get("code")?.as_str()?;
    match code {
        SESSION_SUPERSEDED_CODE | SESSION_CLOSED_CODE => Some(code.to_owned()),
        SESSION_UNKNOWN_CODE if status.as_u16() == 404 => Some(code.to_owned()),
        _ => None,
    }
}

#[derive(Default)]
struct BeatState {
    stopped: bool,
    finished: bool,
    failure: Option<BeatFailure>,
}

/// Heartbeat thread of one admission session.
pub(crate) struct SessionHeartbeat {
    state: Arc<(Mutex<BeatState>, Condvar)>,
}

impl SessionHeartbeat {
    pub(crate) fn start<F>(interval: Duration, mut beat: F) -> Self
    where
        F: FnMut() -> std::result::Result<(), BeatFailure> + Send + 'static,
    {
        let state = Arc::new((Mutex::new(BeatState::default()), Condvar::new()));
        let thread_state = Arc::clone(&state);
        std::thread::spawn(move || {
            loop {
                {
                    let (lock, changed) = &*thread_state;
                    let mut beat_state = lock.lock().unwrap_or_else(|error| error.into_inner());
                    if beat_state.stopped {
                        break;
                    }
                    let (next, _) = changed
                        .wait_timeout(beat_state, interval)
                        .unwrap_or_else(|error| error.into_inner());
                    beat_state = next;
                    if beat_state.stopped {
                        break;
                    }
                }
                let Err(error) = beat() else { continue };
                let (lock, _) = &*thread_state;
                lock.lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .failure = Some(error);
                break;
            }
            let (lock, changed) = &*thread_state;
            let mut beat_state = lock.lock().unwrap_or_else(|error| error.into_inner());
            beat_state.finished = true;
            changed.notify_all();
        });
        Self { state }
    }

    pub(crate) fn failure(&self) -> Option<BeatFailure> {
        let (lock, _) = &*self.state;
        lock.lock()
            .unwrap_or_else(|error| error.into_inner())
            .failure
            .clone()
    }

    /// Stop the heartbeat and report why it stopped.
    ///
    /// The wait is bounded: a beat that outlives the bound is left behind, and
    /// a heartbeat that stops does not release the admission by itself: the
    /// unresolved writer row keeps blocking every destructive sweep until the
    /// operator resolves it. A late beat therefore cannot reopen admission for
    /// work the caller has already finished.
    pub(crate) fn stop(&self) -> Option<BeatFailure> {
        let (lock, changed) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(|error| error.into_inner());
        state.stopped = true;
        changed.notify_all();
        let deadline = Instant::now() + STOP_BOUND;
        while !state.finished {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            state = changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|error| error.into_inner())
                .0;
        }
        state.failure.clone()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    use super::{BeatFailure, SessionHeartbeat, classify_beat_failure, heartbeat_interval};

    #[test]
    fn uses_the_registry_beat_interval() {
        assert_eq!(heartbeat_interval(Some(15_000)), Duration::from_secs(15));
        assert_eq!(heartbeat_interval(Some(90_000)), Duration::from_secs(90));
        // A nonsense interval cannot become a request storm.
        assert_eq!(heartbeat_interval(Some(1)), Duration::from_millis(250));
        assert_eq!(heartbeat_interval(Some(0)), Duration::from_secs(30));
        assert_eq!(heartbeat_interval(None), Duration::from_secs(30));
    }

    #[test]
    fn classifies_a_session_the_registry_no_longer_admits() {
        let superseded = classify_beat_failure(
            reqwest::StatusCode::CONFLICT,
            r#"{"error":"session superseded","code":"registry_session_superseded"}"#,
        );
        assert!(matches!(superseded, BeatFailure::Superseded));

        let unknown = classify_beat_failure(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"code":"registry_session_unknown"}"#,
        );
        assert!(matches!(unknown, BeatFailure::Superseded));

        let owner = classify_beat_failure(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"code":"registry_session_owner_mismatch"}"#,
        );
        assert!(matches!(owner, BeatFailure::Fatal(_)));

        let closed = classify_beat_failure(
            reqwest::StatusCode::CONFLICT,
            r#"{"code":"registry_session_closed","state":"reaped"}"#,
        );
        assert!(matches!(closed, BeatFailure::Superseded));

        let outage = classify_beat_failure(reqwest::StatusCode::BAD_GATEWAY, "not json");
        assert!(matches!(outage, BeatFailure::Fatal(_)));
    }

    #[test]
    fn beats_until_stopped() {
        let beats = Arc::new(AtomicU32::new(0));
        let counted = Arc::clone(&beats);
        let (tx, rx) = mpsc::channel();
        let heartbeat = SessionHeartbeat::start(Duration::from_millis(10), move || {
            let count = counted.fetch_add(1, Ordering::SeqCst) + 1;
            tx.send(count).unwrap();
            Ok(())
        });
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 1);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 2);
        assert!(heartbeat.stop().is_none());
        let seen = beats.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(beats.load(Ordering::SeqCst), seen);
    }

    #[test]
    fn records_the_first_beat_failure() {
        let (tx, rx) = mpsc::channel();
        let heartbeat = SessionHeartbeat::start(Duration::from_millis(5), move || {
            tx.send(()).unwrap();
            Err(BeatFailure::Fatal("heartbeat rejected".to_owned()))
        });
        rx.recv_timeout(Duration::from_secs(2))
            .expect("the heartbeat must beat before it can fail");
        assert!(matches!(
            heartbeat.stop(),
            Some(BeatFailure::Fatal(detail)) if detail.contains("heartbeat rejected")
        ));
    }

    #[test]
    fn a_waiting_heartbeat_stops_without_beating() {
        let heartbeat = SessionHeartbeat::start(Duration::from_secs(30), || Ok(()));
        assert!(heartbeat.failure().is_none());
        assert!(heartbeat.stop().is_none());
    }
}
