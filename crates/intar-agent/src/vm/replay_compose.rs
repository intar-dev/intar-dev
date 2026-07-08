#![forbid(unsafe_code)]

//! Composes one kino session recording into an asciicast v3 file.
//!
//! The cast keeps the session's recorded geometry — raw PTY bytes stream
//! through verbatim and mid-session resizes become native asciicast `r`
//! events, so the player reproduces exactly what the terminal showed at its
//! original aspect ratio. No emulation round-trip, no reflow. Idle gaps are
//! clamped at the data level (asciicast v3 events carry intervals, not
//! absolute times); typed input passes through untouched (the player
//! ignores it for rendering, the website parses it into the command log).

use anyhow::{Context as _, Result};
use serde_json::json;

use super::krec::{KrecEventData, ParsedKrec};

/// Idle gaps longer than this are clamped (seconds). Mirrors the pacing the
/// player used to apply via `idle_time_limit`; baking it into the data keeps
/// the timeline honest.
const IDLE_TIME_LIMIT_S: f64 = 1.5;

pub(crate) fn compose_session(session: &ParsedKrec) -> Result<String> {
    let header = json!({
        "version": 3,
        "term": {
            "cols": session.width,
            "rows": session.height,
        },
        "timestamp": session.start_timestamp_ms / 1000,
    });
    let mut out = serde_json::to_string(&header).context("failed to serialize cast header")?;
    out.push('\n');

    let mut last_raw_s = 0.0_f64;
    for event in &session.events {
        let raw_s = event.time_s.max(last_raw_s);
        let interval_s = (raw_s - last_raw_s).min(IDLE_TIME_LIMIT_S);
        last_raw_s = raw_s;

        let (kind, payload) = match &event.data {
            KrecEventData::Output(data) => ("o", data.clone()),
            KrecEventData::Input(data) => ("i", data.clone()),
            KrecEventData::Resize { cols, rows } => ("r", format!("{cols}x{rows}")),
        };
        out.push_str(
            &serde_json::to_string(&(round_cast_time(interval_s), kind, payload))
                .context("failed to serialize cast event")?,
        );
        out.push('\n');
    }

    Ok(out)
}

fn round_cast_time(time_s: f64) -> f64 {
    (time_s.max(0.0) * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use anyhow::Result;

    use super::super::krec::{KrecEvent, KrecEventData, ParsedKrec};
    use super::super::replay_media::parse_cast;
    use super::compose_session;

    fn session(width: u16, height: u16, events: Vec<KrecEvent>) -> ParsedKrec {
        ParsedKrec {
            width,
            height,
            start_timestamp_ms: 1_700_000_000_000,
            duration_ms: 0,
            exit_code: None,
            events,
        }
    }

    fn output(time_s: f64, data: &str) -> KrecEvent {
        KrecEvent {
            time_s,
            data: KrecEventData::Output(data.to_string()),
        }
    }

    fn input(time_s: f64, data: &str) -> KrecEvent {
        KrecEvent {
            time_s,
            data: KrecEventData::Input(data.to_string()),
        }
    }

    fn resize(time_s: f64, cols: u16, rows: u16) -> KrecEvent {
        KrecEvent {
            time_s,
            data: KrecEventData::Resize { cols, rows },
        }
    }

    #[test]
    fn casts_keep_the_recorded_geometry() -> Result<()> {
        let payload = "\u{1b}[1;31mhello\u{1b}[0m world";
        let composed = compose_session(&session(80, 24, vec![output(0.5, payload)]))?;
        let parsed = parse_cast(&composed)?;

        assert_eq!(parsed.width, 80);
        assert_eq!(parsed.height, 24);
        assert!(
            parsed
                .events
                .iter()
                .any(|event| event.time_s == 0.5 && event.payload == payload),
            "expected the raw payload to pass through untouched"
        );
        Ok(())
    }

    #[test]
    fn header_carries_the_session_start_timestamp() -> Result<()> {
        let composed = compose_session(&session(120, 30, vec![output(0.0, "x")]))?;
        let header = composed.lines().next().expect("header line");
        assert!(header.contains("\"version\":3"));
        assert!(header.contains("\"timestamp\":1700000000"));
        Ok(())
    }

    #[test]
    fn resize_events_pass_through_natively() -> Result<()> {
        let composed = compose_session(&session(
            80,
            24,
            vec![
                output(0.0, "before"),
                resize(1.0, 100, 30),
                output(2.0, " after"),
            ],
        ))?;
        let parsed = parse_cast(&composed)?;

        let resize_event = parsed
            .events
            .iter()
            .find(|event| event.kind == "r")
            .expect("resize event should pass through");
        assert_eq!(resize_event.payload, "100x30");
        assert_eq!(resize_event.time_s, 1.0);
        Ok(())
    }

    #[test]
    fn idle_gaps_are_clamped_in_the_data() -> Result<()> {
        let composed = compose_session(&session(
            120,
            30,
            vec![output(0.0, "a"), output(60.0, "b"), output(60.2, "c")],
        ))?;
        let parsed = parse_cast(&composed)?;

        let time_of = |needle: &str| {
            parsed
                .events
                .iter()
                .find(|event| event.payload == needle)
                .map(|event| event.time_s)
                .unwrap_or_else(|| panic!("missing event {needle}"))
        };
        // The 60s gap clamps to 1.5s; the 0.2s gap is preserved.
        assert_eq!(time_of("b"), 1.5);
        assert_eq!(time_of("c"), 1.7);
        Ok(())
    }

    #[test]
    fn corrupt_offsets_never_rewind_the_timeline() -> Result<()> {
        let composed = compose_session(&session(
            80,
            24,
            vec![output(2.0, "first"), output(1.0, "second")],
        ))?;
        let parsed = parse_cast(&composed)?;
        assert!(parsed.events.iter().all(|event| event.time_s >= 0.0));
        let times: Vec<f64> = parsed.events.iter().map(|event| event.time_s).collect();
        assert!(times.windows(2).all(|pair| pair[0] <= pair[1]));
        Ok(())
    }

    #[test]
    fn input_events_pass_through_for_the_command_log() -> Result<()> {
        let composed = compose_session(&session(
            80,
            24,
            vec![input(0.0, "ls\r"), output(0.5, "listing")],
        ))?;
        let parsed = parse_cast(&composed)?;
        assert!(
            parsed
                .events
                .iter()
                .any(|event| event.kind == "i" && event.payload == "ls\r"),
        );
        Ok(())
    }
}
