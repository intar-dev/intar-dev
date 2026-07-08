#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};

use super::krec::{ParsedKrec, parse_krec};
use super::replay_compose::compose_sessions;

pub const PRIMARY_REPLAY_KIND: &str = "ssh_recording";
pub const PRIMARY_REPLAY_FILENAME: &str = "replay.cast";

/// Renders the combined replay cast from the raw session recordings
/// (`.krec`) in `artifacts_dir`. Returns `None` when there is nothing to
/// render. The reflow emulation is CPU-bound and runs on a blocking thread.
pub async fn create_primary_replay_cast(artifacts_dir: &Path) -> Result<Option<PathBuf>> {
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

    let combined = tokio::task::spawn_blocking(move || -> Result<String> {
        let sessions = krec_paths
            .iter()
            .map(|path| parse_krec_file(path))
            .collect::<Result<Vec<_>>>()?;
        compose_sessions(&sessions)
    })
    .await
    .context("replay rendering task panicked")??;

    let replay_path = artifacts_dir.join(PRIMARY_REPLAY_FILENAME);
    tokio::fs::write(&replay_path, combined)
        .await
        .with_context(|| format!("failed to write replay cast at {}", replay_path.display()))?;

    Ok(Some(replay_path))
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

    use super::{PRIMARY_REPLAY_FILENAME, create_primary_replay_cast, parse_cast};

    fn krec_fixture(width: u16, height: u16, events: &[(u64, &str)]) -> String {
        let mut out = format!(
            "{{\"type\":\"header\",\"format\":\"kino.raw-event-log\",\"version\":1,\"width\":{width},\"height\":{height},\"start_timestamp_ms\":1700000000000}}\n"
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
    async fn create_primary_replay_cast_composes_sessions_on_the_fixed_grid() -> Result<()> {
        let dir = tempfile::tempdir()?;
        tokio::fs::write(
            dir.path().join("ssh-session-1700000000000-10.krec"),
            krec_fixture(120, 30, &[(0, "alpha"), (1000, "omega")]),
        )
        .await?;
        tokio::fs::write(
            dir.path().join("ssh-session-1700000100000-11.krec"),
            krec_fixture(80, 24, &[(500, "bravo")]),
        )
        .await?;

        let replay_path = create_primary_replay_cast(dir.path())
            .await?
            .expect("combined replay should exist");
        assert_eq!(
            replay_path.file_name().and_then(|value| value.to_str()),
            Some(PRIMARY_REPLAY_FILENAME)
        );

        let combined = tokio::fs::read_to_string(&replay_path).await?;
        let parsed = parse_cast(&combined)?;

        // One fixed grid, no resize events.
        assert_eq!(parsed.width, 120);
        assert_eq!(parsed.height, 30);
        assert!(parsed.events.iter().all(|event| event.kind != "r"));

        // Session 1 (exact grid) passes through; the divider holds for two
        // seconds; session 2 is shifted past it.
        assert!(
            parsed
                .events
                .iter()
                .any(|event| event.time_s == 0.0 && event.payload == "alpha")
        );
        let divider = parsed
            .events
            .iter()
            .find(|event| event.payload.contains("Session 2 of 2"))
            .expect("divider slide should exist");
        assert_eq!(divider.time_s, 1.0);
        assert!(
            parsed
                .events
                .iter()
                .any(|event| event.time_s == 3.5 && event.payload.contains("bravo"))
        );

        // Replaying the composed output ends on session 2's content,
        // reflowed onto the canvas at column zero — no letterbox padding.
        let mut vt = avt::Vt::builder().size(120, 30).scrollback_limit(0).build();
        for event in &parsed.events {
            if event.kind == "o" {
                let _ = vt.feed_str(&event.payload);
            }
        }
        let row = vt.line(0).text();
        assert_eq!(row.trim_end(), "bravo");
        Ok(())
    }

    #[tokio::test]
    async fn create_primary_replay_cast_returns_none_when_no_sessions_exist() -> Result<()> {
        let dir = tempfile::tempdir()?;
        assert!(create_primary_replay_cast(dir.path()).await?.is_none());
        Ok(())
    }
}
