#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use serde_json::{Map, Value, json};

use super::replay_compose::compose_sessions;

pub const PRIMARY_REPLAY_KIND: &str = "ssh_recording";
pub const REPLAY_SEGMENT_KIND: &str = "ssh_recording_segment";
pub const PRIMARY_REPLAY_FILENAME: &str = "replay.cast";

#[derive(Debug, Clone)]
pub(crate) struct ParsedCast {
    pub(crate) header: Map<String, Value>,
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) events: Vec<CastEvent>,
    pub(crate) duration_s: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct CastEvent {
    pub(crate) time_s: f64,
    pub(crate) kind: String,
    pub(crate) payload: String,
}

pub async fn create_primary_replay_cast(artifacts_dir: &Path) -> Result<Option<PathBuf>> {
    let mut cast_paths = Vec::new();
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
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".cast") || file_name == PRIMARY_REPLAY_FILENAME {
            continue;
        }
        cast_paths.push(path);
    }

    if cast_paths.is_empty() {
        return Ok(None);
    }

    cast_paths.sort_by(|left, right| {
        recording_sort_key(left)
            .cmp(&recording_sort_key(right))
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });

    let sessions = cast_paths
        .iter()
        .map(|path| parse_cast_file(path))
        .collect::<Result<Vec<_>>>()?;
    let replay_path = artifacts_dir.join(PRIMARY_REPLAY_FILENAME);
    let combined = compose_sessions(&sessions)?;
    tokio::fs::write(&replay_path, combined)
        .await
        .with_context(|| format!("failed to write replay cast at {}", replay_path.display()))?;

    Ok(Some(replay_path))
}

fn recording_sort_key(path: &Path) -> (String, u8) {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default()
        .to_owned();
    let extension_rank = match path.extension().and_then(|ext| ext.to_str()) {
        Some("cast") => 0,
        _ => 1,
    };
    (stem, extension_rank)
}

fn parse_cast_file(path: &Path) -> Result<ParsedCast> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read cast {}", path.display()))?;
    parse_cast(&content).with_context(|| format!("failed to parse cast {}", path.display()))
}

pub(crate) fn parse_cast(content: &str) -> Result<ParsedCast> {
    let mut lines = content.lines();
    let header_line = lines
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("cast is empty"))?;
    let mut header = serde_json::from_str::<Map<String, Value>>(header_line)
        .context("failed to parse cast header")?;

    let version = header
        .get("version")
        .and_then(Value::as_u64)
        .unwrap_or(2)
        .clamp(2, 3);
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

    header.insert("version".to_string(), json!(2));
    header.insert("width".to_string(), json!(width));
    header.insert("height".to_string(), json!(height));
    header.remove("duration");

    let mut events = Vec::new();
    let mut duration_s = 0.0_f64;
    let mut relative_time_s = 0.0_f64;

    for raw_line in lines {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let event = serde_json::from_str::<Value>(line).context("failed to parse cast event")?;
        let parts = event
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("cast event must be an array"))?;
        if parts.len() < 3 {
            anyhow::bail!("cast event must have at least 3 fields");
        }

        let raw_time_s = parts[0]
            .as_f64()
            .ok_or_else(|| anyhow::anyhow!("cast event timestamp must be numeric"))?;
        let kind = parts[1]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("cast event kind must be a string"))?
            .to_string();
        let payload = parts[2]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("cast event payload must be a string"))?
            .to_string();
        let time_s = if version == 3 {
            relative_time_s += raw_time_s.max(0.0);
            relative_time_s
        } else {
            raw_time_s.max(0.0)
        };
        duration_s = duration_s.max(time_s);
        events.push(CastEvent {
            time_s,
            kind,
            payload,
        });
    }

    Ok(ParsedCast {
        header,
        width,
        height,
        events,
        duration_s,
    })
}

#[cfg(test)]
mod tests {
    use anyhow::Result;

    use super::{PRIMARY_REPLAY_FILENAME, create_primary_replay_cast, parse_cast};

    fn cast_fixture(width: u16, height: u16, events: &[(&str, f64, &str)]) -> String {
        let mut out = format!(
            "{{\"version\":2,\"width\":{width},\"height\":{height},\"timestamp\":1700000000}}\n"
        );
        for (kind, time_s, payload) in events {
            out.push_str(&format!(
                "[{time_s},\"{kind}\",{}]\n",
                serde_json::to_string(payload).expect("payload should serialize")
            ));
        }
        out
    }

    #[tokio::test]
    async fn create_primary_replay_cast_composes_sessions_on_a_fixed_canvas() -> Result<()> {
        let dir = tempfile::tempdir()?;
        tokio::fs::write(
            dir.path().join("session-01.cast"),
            cast_fixture(80, 24, &[("o", 0.0, "alpha"), ("o", 1.0, "omega")]),
        )
        .await?;
        tokio::fs::write(
            dir.path().join("session-02.cast"),
            cast_fixture(120, 30, &[("o", 0.5, "bravo")]),
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

        // The pinned 16:9 canvas fits both 80x24 and 120x30, no mid-playback
        // resize events.
        assert_eq!(parsed.width, 120);
        assert_eq!(parsed.height, 30);
        assert!(parsed.events.iter().all(|event| event.kind != "r"));

        // Session 1 output stays at its original offsets, the divider slide
        // holds for two seconds, and session 2 is shifted past it.
        assert!(
            parsed
                .events
                .iter()
                .any(|event| event.time_s == 0.0 && event.payload.contains("alpha"))
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

        // Replaying the composed output ends on session 2's content, which
        // matches the canvas exactly (120x30 -> no padding).
        let mut vt = avt::Vt::builder().size(120, 30).scrollback_limit(0).build();
        for event in &parsed.events {
            if event.kind == "o" {
                let _ = vt.feed_str(&event.payload);
            }
        }
        let row = vt.line(0).text();
        assert_eq!(row.trim(), "bravo");
        assert_eq!(row.len() - row.trim_start().len(), 0);

        Ok(())
    }

    #[tokio::test]
    async fn create_primary_replay_cast_returns_none_when_no_sessions_exist() -> Result<()> {
        let dir = tempfile::tempdir()?;
        assert!(create_primary_replay_cast(dir.path()).await?.is_none());
        Ok(())
    }
}
