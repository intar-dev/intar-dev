#![forbid(unsafe_code)]

//! Renders the raw session recordings (`.krec`) in an artifacts directory
//! into per-session replay media: one asciicast per SSH session plus a
//! timeline document (session metadata and plain-text transcripts) that the
//! agent submits to the control plane. Only the casts become R2 artifacts;
//! the timeline lives in the control plane's database.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use serde::Serialize;
use tracing::warn;

use super::krec::{ParsedKrec, parse_krec};
use super::replay_compose::compose_session;
use super::transcript::{render_transcript, trim_transcript_to_byte_limit};

pub(crate) const SESSION_CAST_KIND: &str = "ssh_recording_segment";
pub(crate) const TIMELINE_VERSION: u32 = 1;
/// The control plane accepts at most 4 MiB of decoded transcript text per
/// timeline. The HTTP request can be larger because JSON escaping adds bytes.
pub(crate) const TIMELINE_TRANSCRIPT_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Wire payload for `POST /agent/runs/{runId}/vms/{vmName}/timeline`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimelineDocument {
    pub(crate) version: u32,
    pub(crate) sessions: Vec<TimelineSession>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimelineSession {
    /// 1-based chronological session number.
    pub(crate) index: u32,
    pub(crate) start_timestamp_ms: u64,
    /// Wall-clock session length — reconnect gaps in the UI are computed
    /// from this, so it is never idle-clamped like the cast timing.
    pub(crate) duration_ms: u64,
    pub(crate) exit_code: Option<i32>,
    pub(crate) cast_filename: String,
    pub(crate) transcript: String,
    pub(crate) transcript_truncated: bool,
}

pub(crate) struct RenderedSessionMedia {
    /// One cast per session, in timeline order.
    pub(crate) cast_paths: Vec<PathBuf>,
    pub(crate) timeline: TimelineDocument,
}

/// Renders recordings from `artifacts_dir` into a separate `output_dir`.
/// Archive retries use a private output directory so a detached blocking
/// renderer can never write the deterministic cast paths owned by a retry.
pub(crate) async fn render_session_media_into(
    artifacts_dir: &Path,
    output_dir: &Path,
) -> Result<Option<RenderedSessionMedia>> {
    let mut krec_paths = Vec::new();
    let mut dir = match tokio::fs::read_dir(artifacts_dir).await {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(anyhow::anyhow!(
                "failed to read artifact directory {}: {error}",
                artifacts_dir.display()
            ));
        }
    };

    while let Some(entry) = dir
        .next_entry()
        .await
        .context("failed to iterate artifact directory")?
    {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("krec") {
            krec_paths.push(path);
        }
    }

    if krec_paths.is_empty() {
        return Ok(None);
    }

    // Session files are named ssh-session-<start-ms>-<pid>.krec, so the
    // lexicographic order is the chronological order.
    krec_paths.sort();

    let output_dir = output_dir.to_path_buf();
    let rendered = tokio::task::spawn_blocking(move || -> Result<Option<RenderedSessionMedia>> {
        let mut cast_paths = Vec::new();
        let mut sessions = Vec::new();

        for path in &krec_paths {
            let session = match parse_krec_file(path) {
                Ok(session) => session,
                Err(error) => {
                    warn!(
                        error = %error,
                        recording = %path.display(),
                        "skipping unparseable session recording"
                    );
                    continue;
                }
            };

            let index = u32::try_from(sessions.len() + 1).unwrap_or(u32::MAX);
            let cast_filename = format!("session-{index:02}.cast");
            let cast = compose_session(&session)
                .with_context(|| format!("failed to compose {}", path.display()))?;
            let cast_path = output_dir.join(&cast_filename);
            std::fs::write(&cast_path, cast)
                .with_context(|| format!("failed to write cast at {}", cast_path.display()))?;
            cast_paths.push(cast_path);

            let transcript = render_transcript(&session);
            sessions.push(TimelineSession {
                index,
                start_timestamp_ms: session.start_timestamp_ms,
                duration_ms: session.duration_ms,
                exit_code: session.exit_code,
                cast_filename,
                transcript: transcript.text,
                transcript_truncated: transcript.truncated,
            });
        }

        if sessions.is_empty() {
            return Ok(None);
        }

        apply_timeline_transcript_budget(&mut sessions, TIMELINE_TRANSCRIPT_MAX_BYTES);

        Ok(Some(RenderedSessionMedia {
            cast_paths,
            timeline: TimelineDocument {
                version: TIMELINE_VERSION,
                sessions,
            },
        }))
    })
    .await
    .context("replay rendering task panicked")??;

    Ok(rendered)
}

/// Applies a fair, deterministic total transcript limit without removing any
/// timeline or cast entry. When the aggregate is over budget, nonempty
/// sessions receive equal byte increments. Short transcripts stop taking
/// increments and their unused share is redistributed. A final one-byte
/// remainder goes to earlier sessions in chronological order. Each affected
/// transcript then keeps its newest complete lines where possible.
fn apply_timeline_transcript_budget(sessions: &mut [TimelineSession], max_total_bytes: usize) {
    let total_bytes = sessions.iter().fold(0_usize, |total, session| {
        total.saturating_add(session.transcript.len())
    });
    if total_bytes <= max_total_bytes {
        return;
    }

    let byte_limits = fair_transcript_byte_limits(sessions, max_total_bytes);
    for (session, byte_limit) in sessions.iter_mut().zip(byte_limits) {
        trim_transcript_to_byte_limit(
            &mut session.transcript,
            &mut session.transcript_truncated,
            byte_limit,
        );
    }

    debug_assert!(
        sessions.iter().fold(0_usize, |total, session| {
            total.saturating_add(session.transcript.len())
        }) <= max_total_bytes
    );
}

fn fair_transcript_byte_limits(sessions: &[TimelineSession], max_total_bytes: usize) -> Vec<usize> {
    let transcript_lengths = sessions
        .iter()
        .map(|session| session.transcript.len())
        .collect::<Vec<_>>();
    let mut limits = vec![0; sessions.len()];
    let mut remaining = max_total_bytes;
    let mut active = transcript_lengths
        .iter()
        .enumerate()
        .filter_map(|(index, length)| (*length > 0).then_some(index))
        .collect::<Vec<_>>();

    while remaining > 0 && !active.is_empty() {
        let equal_increment = remaining / active.len();
        if equal_increment == 0 {
            for index in active.into_iter().take(remaining) {
                limits[index] += 1;
            }
            break;
        }

        let mut consumed = 0;
        for &index in &active {
            let available = transcript_lengths[index] - limits[index];
            let increment = available.min(equal_increment);
            limits[index] += increment;
            consumed += increment;
        }
        remaining -= consumed;
        active.retain(|&index| limits[index] < transcript_lengths[index]);
    }

    limits
}

fn parse_krec_file(path: &Path) -> Result<ParsedKrec> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("failed to open recording {}", path.display()))?;
    parse_krec(file).with_context(|| format!("failed to parse recording {}", path.display()))
}

/// Test-only asciicast v3 reader used to verify composed output. Event
/// intervals are accumulated into absolute `time_s` for easy assertions.
#[cfg(test)]
pub(crate) struct ParsedCast {
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) events: Vec<CastEvent>,
}

#[cfg(test)]
pub(crate) struct CastEvent {
    pub(crate) time_s: f64,
    pub(crate) kind: String,
    pub(crate) payload: String,
}

#[cfg(test)]
pub(crate) fn parse_cast(content: &str) -> Result<ParsedCast> {
    use serde_json::{Map, Value};

    let mut lines = content.lines();
    let header_line = lines
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("cast is empty"))?;
    let header = serde_json::from_str::<Map<String, Value>>(header_line)
        .context("failed to parse cast header")?;

    if header.get("version").and_then(Value::as_u64) != Some(3) {
        anyhow::bail!("expected an asciicast v3 header");
    }
    let term = header
        .get("term")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("cast header is missing term"))?;
    let dimension = |key: &str| {
        term.get(key)
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| anyhow::anyhow!("cast header is missing a valid term.{key}"))
    };
    let width = dimension("cols")?;
    let height = dimension("rows")?;

    let mut events = Vec::new();
    let mut elapsed_s = 0.0_f64;
    for raw_line in lines {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let (interval_s, kind, payload) = serde_json::from_str::<(f64, String, String)>(line)
            .context("failed to parse cast event")?;
        elapsed_s += interval_s;
        events.push(CastEvent {
            time_s: (elapsed_s * 1000.0).round() / 1000.0,
            kind,
            payload,
        });
    }

    Ok(ParsedCast {
        width,
        height,
        events,
    })
}

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;

    use super::{
        TIMELINE_TRANSCRIPT_MAX_BYTES, TIMELINE_VERSION, TimelineSession,
        apply_timeline_transcript_budget, parse_cast, render_session_media_into,
    };

    fn timeline_session(index: u32, transcript: String) -> TimelineSession {
        TimelineSession {
            index,
            start_timestamp_ms: 1_700_000_000_000 + u64::from(index),
            duration_ms: u64::from(index),
            exit_code: Some(0),
            cast_filename: format!("session-{index:02}.cast"),
            transcript,
            transcript_truncated: false,
        }
    }

    fn krec_fixture(width: u16, height: u16, start_ms: u64, events: &[(u64, &str)]) -> String {
        let mut out = format!(
            "{{\"type\":\"header\",\"format\":\"kino.raw-event-log\",\"version\":1,\"width\":{width},\"height\":{height},\"start_timestamp_ms\":{start_ms}}}\n"
        );
        for (offset_ms, payload) in events {
            out.push_str(&format!(
                "{{\"type\":\"event\",\"offset_ms\":{offset_ms},\"event\":\"o\",\"data_b64\":\"{}\"}}\n",
                BASE64_STANDARD.encode(payload)
            ));
        }
        out
    }

    #[tokio::test]
    async fn renders_one_cast_and_timeline_entry_per_session() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut first = krec_fixture(120, 30, 1_700_000_000_000, &[(0, "alpha"), (1000, "omega")]);
        first.push_str("{\"type\":\"event\",\"offset_ms\":1200,\"event\":\"x\",\"exit_code\":0}\n");
        tokio::fs::write(dir.path().join("ssh-session-1700000000000-10.krec"), first).await?;
        tokio::fs::write(
            dir.path().join("ssh-session-1700000100000-11.krec"),
            krec_fixture(80, 24, 1_700_000_100_000, &[(500, "bravo")]),
        )
        .await?;

        let rendered = render_session_media_into(dir.path(), dir.path())
            .await?
            .expect("session media should render");
        assert_eq!(rendered.cast_paths.len(), 2);
        assert_eq!(rendered.timeline.version, TIMELINE_VERSION);
        assert_eq!(rendered.timeline.sessions.len(), 2);

        let first = &rendered.timeline.sessions[0];
        assert_eq!(first.index, 1);
        assert_eq!(first.start_timestamp_ms, 1_700_000_000_000);
        assert_eq!(first.duration_ms, 1200);
        assert_eq!(first.exit_code, Some(0));
        assert_eq!(first.cast_filename, "session-01.cast");
        assert_eq!(first.transcript, "alphaomega\n");
        assert!(!first.transcript_truncated);

        let second = &rendered.timeline.sessions[1];
        assert_eq!(second.index, 2);
        assert_eq!(second.start_timestamp_ms, 1_700_000_100_000);
        assert_eq!(second.duration_ms, 500);
        assert_eq!(second.exit_code, None);
        assert_eq!(second.cast_filename, "session-02.cast");
        assert_eq!(second.transcript, "bravo\n");

        // Each cast is a standalone recording at its session's native
        // geometry, starting at zero with its own start timestamp.
        let expected_dimensions = [(120, 30), (80, 24)];
        for ((path, session), (cols, rows)) in rendered
            .cast_paths
            .iter()
            .zip(&rendered.timeline.sessions)
            .zip(expected_dimensions)
        {
            let content = tokio::fs::read_to_string(path).await?;
            let parsed = parse_cast(&content)?;
            assert_eq!(parsed.width, cols);
            assert_eq!(parsed.height, rows);
            assert!(
                content
                    .lines()
                    .next()
                    .is_some_and(|header| header.contains(&format!(
                        "\"timestamp\":{}",
                        session.start_timestamp_ms / 1000
                    )))
            );
            assert!(parsed.events.iter().all(|event| event.time_s >= 0.0));
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_corrupt_session_is_skipped_without_costing_the_rest() -> Result<()> {
        let dir = tempfile::tempdir()?;
        tokio::fs::write(
            dir.path().join("ssh-session-1700000000000-10.krec"),
            "{\"type\":\"header\",\"format\":\"other\"}\n",
        )
        .await?;
        tokio::fs::write(
            dir.path().join("ssh-session-1700000100000-11.krec"),
            krec_fixture(120, 30, 1_700_000_100_000, &[(0, "survivor")]),
        )
        .await?;

        let rendered = render_session_media_into(dir.path(), dir.path())
            .await?
            .expect("healthy session should render");
        assert_eq!(rendered.timeline.sessions.len(), 1);
        assert_eq!(rendered.timeline.sessions[0].index, 1);
        assert_eq!(rendered.timeline.sessions[0].transcript, "survivor\n");
        Ok(())
    }

    #[tokio::test]
    async fn returns_none_when_no_sessions_exist() -> Result<()> {
        let dir = tempfile::tempdir()?;
        assert!(
            render_session_media_into(dir.path(), dir.path())
                .await?
                .is_none()
        );
        Ok(())
    }

    #[test]
    fn total_transcript_budget_fairly_trims_multiple_sessions_without_dropping_entries() {
        let mut sessions = (1..=3)
            .map(|index| {
                timeline_session(
                    index,
                    format!(
                        "old-session-{index}-{}\nrecent-session-{index}\n",
                        "x".repeat(100)
                    ),
                )
            })
            .collect::<Vec<_>>();

        apply_timeline_transcript_budget(&mut sessions, 240);

        assert_eq!(sessions.len(), 3);
        assert!(sessions.iter().all(|session| session.transcript_truncated));
        assert!(
            sessions
                .iter()
                .all(|session| session.transcript.len() <= 80)
        );
        assert!(sessions.iter().enumerate().all(|(offset, session)| {
            let index = offset + 1;
            session.index == index as u32
                && session.cast_filename == format!("session-{index:02}.cast")
                && session
                    .transcript
                    .contains(&format!("recent-session-{index}\n"))
        }));
        assert!(
            sessions
                .iter()
                .map(|session| session.transcript.len())
                .sum::<usize>()
                <= 240
        );
    }

    #[test]
    fn total_transcript_budget_is_a_noop_when_the_document_fits() {
        let mut sessions = vec![
            timeline_session(1, "first\n".to_string()),
            timeline_session(2, "second\n".to_string()),
        ];
        let before = sessions
            .iter()
            .map(|session| (session.transcript.clone(), session.transcript_truncated))
            .collect::<Vec<_>>();

        apply_timeline_transcript_budget(&mut sessions, TIMELINE_TRANSCRIPT_MAX_BYTES);

        let after = sessions
            .iter()
            .map(|session| (session.transcript.clone(), session.transcript_truncated))
            .collect::<Vec<_>>();
        assert_eq!(after, before);
    }
}
