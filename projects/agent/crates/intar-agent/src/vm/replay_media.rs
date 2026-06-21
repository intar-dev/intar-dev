#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use serde::Serialize;
use serde_json::{Map, Value, json};

pub const PRIMARY_REPLAY_KIND: &str = "ssh_recording";
pub const REPLAY_SEGMENT_KIND: &str = "ssh_recording_segment";
pub const PRIMARY_REPLAY_FILENAME: &str = "replay.cast";

const SESSION_DIVIDER_DURATION_S: f64 = 2.0;

#[derive(Debug, Clone)]
struct ParsedCast {
    header: Map<String, Value>,
    width: u16,
    height: u16,
    events: Vec<CastEvent>,
    duration_s: f64,
}

#[derive(Debug, Clone)]
struct CastEvent {
    time_s: f64,
    kind: String,
    payload: String,
}

#[derive(Debug, Serialize)]
struct CombinedCastHeader {
    #[serde(flatten)]
    fields: Map<String, Value>,
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
    let combined = build_combined_cast(&sessions)?;
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

fn parse_cast(content: &str) -> Result<ParsedCast> {
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

fn build_combined_cast(sessions: &[ParsedCast]) -> Result<String> {
    let first = sessions
        .first()
        .ok_or_else(|| anyhow::anyhow!("cannot combine an empty cast list"))?;
    let mut out = String::new();
    let header = CombinedCastHeader {
        fields: first.header.clone(),
    };
    out.push_str(
        &serde_json::to_string(&header).context("failed to serialize combined cast header")?,
    );
    out.push('\n');

    let total_sessions = sessions.len();
    let mut offset_s = 0.0_f64;
    for (index, session) in sessions.iter().enumerate() {
        if index > 0 {
            write_session_divider(
                &mut out,
                offset_s,
                session.width,
                session.height,
                index + 1,
                total_sessions,
            )
            .context("failed to write session divider")?;
            offset_s += SESSION_DIVIDER_DURATION_S;
        }

        for event in &session.events {
            write_cast_event(
                &mut out,
                offset_s + event.time_s,
                &event.kind,
                &event.payload,
            )
            .context("failed to write combined cast event")?;
        }
        offset_s += session.duration_s;
    }

    Ok(out)
}

fn write_session_divider(
    out: &mut String,
    start_time_s: f64,
    width: u16,
    height: u16,
    session_number: usize,
    total_sessions: usize,
) -> Result<()> {
    write_cast_event(out, start_time_s, "r", &format!("{width}x{height}"))?;
    write_cast_event(
        out,
        start_time_s,
        "o",
        &render_session_divider(width, height, session_number, total_sessions),
    )?;
    write_cast_event(
        out,
        start_time_s + SESSION_DIVIDER_DURATION_S,
        "o",
        "\u{1b}[2J\u{1b}[H",
    )?;
    Ok(())
}

fn render_session_divider(
    width: u16,
    height: u16,
    session_number: usize,
    total_sessions: usize,
) -> String {
    let label = format!("Session {session_number} of {total_sessions}");
    let label_width = label.chars().count() as u16;
    let row = (height / 2).max(1);
    let col = if width > label_width {
        ((width - label_width) / 2).max(1)
    } else {
        1
    };
    format!("\u{1b}[2J\u{1b}[H\u{1b}[{row};{col}H{label}")
}

fn write_cast_event(out: &mut String, time_s: f64, kind: &str, payload: &str) -> Result<()> {
    out.push_str(
        &serde_json::to_string(&(round_cast_time(time_s), kind, payload))
            .context("failed to serialize cast event")?,
    );
    out.push('\n');
    Ok(())
}

fn round_cast_time(time_s: f64) -> f64 {
    (time_s.max(0.0) * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use anyhow::Result;

    use super::{
        PRIMARY_REPLAY_FILENAME, create_primary_replay_cast, parse_cast, render_session_divider,
    };

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
    async fn create_primary_replay_cast_concatenates_sessions_with_divider() -> Result<()> {
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
        assert_eq!(parsed.width, 80);
        assert_eq!(parsed.height, 24);
        assert_eq!(parsed.events.len(), 6);
        assert_eq!(parsed.events[0].payload, "alpha");
        assert_eq!(parsed.events[1].payload, "omega");
        assert_eq!(parsed.events[2].kind, "r");
        assert_eq!(parsed.events[2].payload, "120x30");
        assert!(parsed.events[3].payload.contains("Session 2 of 2"));
        assert_eq!(parsed.events[3].time_s, 1.0);
        assert_eq!(parsed.events[4].time_s, 3.0);
        assert_eq!(parsed.events[5].payload, "bravo");
        assert_eq!(parsed.events[5].time_s, 3.5);

        Ok(())
    }

    #[tokio::test]
    async fn create_primary_replay_cast_returns_none_when_no_sessions_exist() -> Result<()> {
        let dir = tempfile::tempdir()?;
        assert!(create_primary_replay_cast(dir.path()).await?.is_none());
        Ok(())
    }

    #[test]
    fn session_divider_centers_text_inside_terminal() {
        let slide = render_session_divider(80, 24, 2, 3);
        assert!(slide.contains("Session 2 of 3"));
        assert!(slide.starts_with("\u{1b}[2J\u{1b}[H\u{1b}[12;"));
    }
}
