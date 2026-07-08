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
use super::transcript::render_transcript;

pub(crate) const SESSION_CAST_KIND: &str = "ssh_recording_segment";
pub(crate) const TIMELINE_VERSION: u32 = 1;

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

/// Renders every parseable `.krec` in `artifacts_dir`. Returns `None` when
/// there is nothing to render. A session that fails to parse is skipped so
/// one corrupt reconnect does not cost the whole timeline. The emulation is
/// CPU-bound and runs on a blocking thread.
pub(crate) async fn render_session_media(
    artifacts_dir: &Path,
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

    let artifacts_dir = artifacts_dir.to_path_buf();
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
            let cast_path = artifacts_dir.join(&cast_filename);
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

fn parse_krec_file(path: &Path) -> Result<ParsedKrec> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("failed to open recording {}", path.display()))?;
    parse_krec(file).with_context(|| format!("failed to parse recording {}", path.display()))
}

/// Test-only asciicast reader used to verify composed output.
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

    let width = header
        .get("width")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| anyhow::anyhow!("cast header is missing a valid width"))?;
    let height = header
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| anyhow::anyhow!("cast header is missing a valid height"))?;

    let mut events = Vec::new();
    for raw_line in lines {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let (time_s, kind, payload) = serde_json::from_str::<(f64, String, String)>(line)
            .context("failed to parse cast event")?;
        events.push(CastEvent {
            time_s,
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

    use super::{TIMELINE_VERSION, parse_cast, render_session_media};

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

        let rendered = render_session_media(dir.path())
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

        // Each cast is a standalone fixed-grid recording that starts at zero
        // and carries its own session's start timestamp.
        for (path, session) in rendered.cast_paths.iter().zip(&rendered.timeline.sessions) {
            let content = tokio::fs::read_to_string(path).await?;
            let parsed = parse_cast(&content)?;
            assert_eq!(parsed.width, 120);
            assert_eq!(parsed.height, 30);
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

        let rendered = render_session_media(dir.path())
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
        assert!(render_session_media(dir.path()).await?.is_none());
        Ok(())
    }
}
