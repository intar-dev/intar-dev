#![forbid(unsafe_code)]

//! Parser for kino raw event logs (`.krec`).
//!
//! The format is JSONL: a header line followed by event lines, written by
//! `crates/kino/src/recording.rs`. The replay pipeline consumes the raw log
//! directly — output bytes and resizes feed the compositor, typed input
//! rides through for the command log, and the exit marker is dropped. A
//! truncated final line is tolerated: kino syncs every 250ms, so a hard
//! teardown (SIGHUP, host stop) can leave a partial trailing event behind.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::Deserialize;

const RAW_RECORDING_FORMAT: &str = "kino.raw-event-log";
const RAW_RECORDING_VERSION: u8 = 1;

#[derive(Debug, Deserialize)]
struct RawRecordingHeader {
    #[serde(rename = "type")]
    line_type: String,
    format: String,
    version: u8,
    width: u16,
    height: u16,
    start_timestamp_ms: u64,
    #[allow(dead_code)]
    command: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    env: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct RawRecordingEvent {
    #[serde(rename = "type")]
    line_type: String,
    offset_ms: u64,
    event: String,
    data_b64: Option<String>,
    width: Option<u16>,
    height: Option<u16>,
    #[allow(dead_code)]
    exit_code: Option<i32>,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedKrec {
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) start_timestamp_s: u64,
    pub(crate) events: Vec<KrecEvent>,
}

#[derive(Debug, Clone)]
pub(crate) struct KrecEvent {
    pub(crate) time_s: f64,
    pub(crate) data: KrecEventData,
}

#[derive(Debug, Clone)]
pub(crate) enum KrecEventData {
    Output(String),
    /// Typed input never affects rendering, but it feeds the command log
    /// shown next to the replay, so it rides through composition.
    Input(String),
    /// Recorded rows ride along for format fidelity; the compositor pins
    /// the emulation height and only the width changes reflow behavior.
    Resize {
        cols: u16,
        #[allow(dead_code)]
        rows: u16,
    },
}

pub(crate) fn parse_krec<R: Read>(input: R) -> Result<ParsedKrec> {
    let mut reader = BufReader::new(input);
    let mut line = String::new();

    if reader
        .read_line(&mut line)
        .context("failed to read raw recording header")?
        == 0
    {
        bail!("raw recording is empty");
    }

    let header: RawRecordingHeader =
        serde_json::from_str(line.trim_end()).context("failed to parse raw recording header")?;
    validate_header(&header)?;

    let mut events = Vec::new();
    let mut output_decoder = Utf8StreamDecoder::new();
    let mut input_decoder = Utf8StreamDecoder::new();
    let mut last_offset_ms = 0_u64;

    loop {
        line.clear();
        let bytes_read = reader
            .read_line(&mut line)
            .context("failed to read raw recording event")?;
        if bytes_read == 0 {
            break;
        }

        let raw_line = line.trim_end();
        if raw_line.is_empty() {
            continue;
        }
        let event: RawRecordingEvent = match serde_json::from_str(raw_line) {
            Ok(event) => event,
            Err(error) if looks_like_truncated_final_event(raw_line, error.classify()) => break,
            Err(error) => {
                return Err(error).context("failed to parse raw recording event");
            }
        };
        if event.line_type != "event" {
            bail!("unexpected raw recording line type '{}'", event.line_type);
        }
        // Guard monotonicity so a corrupt offset can't rewind the timeline.
        last_offset_ms = event.offset_ms.max(last_offset_ms);
        let time_s = offset_ms_to_s(last_offset_ms);

        match event.event.as_str() {
            "o" => {
                let payload = decode_data(&event)?;
                let mut data = String::new();
                for chunk in output_decoder.decode_chunk(&payload) {
                    data.push_str(&chunk);
                }
                if !data.is_empty() {
                    events.push(KrecEvent {
                        time_s,
                        data: KrecEventData::Output(data),
                    });
                }
            }
            "i" => {
                let payload = decode_data(&event)?;
                let mut data = String::new();
                for chunk in input_decoder.decode_chunk(&payload) {
                    data.push_str(&chunk);
                }
                if !data.is_empty() {
                    events.push(KrecEvent {
                        time_s,
                        data: KrecEventData::Input(data),
                    });
                }
            }
            "r" => {
                let cols = event
                    .width
                    .ok_or_else(|| anyhow!("resize event missing width"))?;
                let rows = event
                    .height
                    .ok_or_else(|| anyhow!("resize event missing height"))?;
                if cols > 0 && rows > 0 {
                    events.push(KrecEvent {
                        time_s,
                        data: KrecEventData::Resize { cols, rows },
                    });
                }
            }
            // The exit marker carries no renderable state.
            "x" => {}
            other => bail!("unsupported raw recording event '{other}'"),
        }
    }

    if let Some(chunk) = output_decoder.flush() {
        events.push(KrecEvent {
            time_s: offset_ms_to_s(last_offset_ms),
            data: KrecEventData::Output(chunk),
        });
    }
    if let Some(chunk) = input_decoder.flush() {
        events.push(KrecEvent {
            time_s: offset_ms_to_s(last_offset_ms),
            data: KrecEventData::Input(chunk),
        });
    }

    Ok(ParsedKrec {
        width: header.width,
        height: header.height,
        start_timestamp_s: header.start_timestamp_ms / 1000,
        events,
    })
}

fn offset_ms_to_s(offset_ms: u64) -> f64 {
    std::time::Duration::from_millis(offset_ms).as_secs_f64()
}

fn looks_like_truncated_final_event(raw_line: &str, category: serde_json::error::Category) -> bool {
    !raw_line.is_empty()
        && matches!(
            category,
            serde_json::error::Category::Eof | serde_json::error::Category::Syntax
        )
}

fn validate_header(header: &RawRecordingHeader) -> Result<()> {
    if header.line_type != "header" {
        bail!(
            "unexpected raw recording header type '{}'",
            header.line_type
        );
    }
    if header.format != RAW_RECORDING_FORMAT {
        bail!("unsupported raw recording format '{}'", header.format);
    }
    if header.version != RAW_RECORDING_VERSION {
        bail!("unsupported raw recording version {}", header.version);
    }
    if header.width == 0 || header.height == 0 {
        bail!("raw recording header has invalid dimensions");
    }
    Ok(())
}

fn decode_data(event: &RawRecordingEvent) -> Result<Vec<u8>> {
    let payload = event
        .data_b64
        .as_deref()
        .ok_or_else(|| anyhow!("raw recording event '{}' is missing data_b64", event.event))?;
    BASE64_STANDARD
        .decode(payload)
        .with_context(|| format!("failed to decode base64 payload for '{}'", event.event))
}

/// Decodes a byte stream into UTF-8 across chunk boundaries: a multi-byte
/// character split between two PTY reads stays pending until its remaining
/// bytes arrive.
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    fn decode_chunk(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut decoded = Vec::new();

        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    if !valid.is_empty() {
                        decoded.push(valid.to_owned());
                    }
                    self.pending.clear();
                    return decoded;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        decoded.push(
                            String::from_utf8_lossy(&self.pending[..valid_up_to]).into_owned(),
                        );
                    }

                    if let Some(invalid_len) = error.error_len() {
                        decoded.push("\u{FFFD}".to_owned());
                        self.pending.drain(..valid_up_to + invalid_len);
                    } else {
                        if valid_up_to > 0 {
                            self.pending.drain(..valid_up_to);
                        }
                        return decoded;
                    }
                }
            }
        }
    }

    fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let data = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        (!data.is_empty()).then_some(data)
    }
}

#[cfg(test)]
mod tests {
    use super::{KrecEventData, parse_krec};

    fn header_line(width: u16, height: u16) -> String {
        format!(
            "{{\"type\":\"header\",\"format\":\"kino.raw-event-log\",\"version\":1,\"width\":{width},\"height\":{height},\"start_timestamp_ms\":1700000000000,\"command\":\"/bin/sh\",\"env\":{{\"SHELL\":\"/bin/sh\"}}}}\n"
        )
    }

    #[test]
    fn parses_output_and_resize_events() {
        let raw = format!(
            "{}{}{}{}{}",
            header_line(120, 40),
            "{\"type\":\"event\",\"offset_ms\":0,\"event\":\"i\",\"data_b64\":\"ZWNobyBoZWxsbwo=\"}\n",
            "{\"type\":\"event\",\"offset_ms\":250,\"event\":\"o\",\"data_b64\":\"aGVsbG8K\"}\n",
            "{\"type\":\"event\",\"offset_ms\":500,\"event\":\"r\",\"width\":100,\"height\":30}\n",
            "{\"type\":\"event\",\"offset_ms\":750,\"event\":\"x\",\"exit_code\":0}\n",
        );

        let parsed = parse_krec(raw.as_bytes()).expect("krec should parse");
        assert_eq!(parsed.width, 120);
        assert_eq!(parsed.height, 40);
        assert_eq!(parsed.start_timestamp_s, 1_700_000_000);
        assert_eq!(parsed.events.len(), 3);

        assert_eq!(parsed.events[0].time_s, 0.0);
        match &parsed.events[0].data {
            KrecEventData::Input(data) => assert_eq!(data, "echo hello\n"),
            other => panic!("expected input event, got {other:?}"),
        }

        assert_eq!(parsed.events[1].time_s, 0.25);
        match &parsed.events[1].data {
            KrecEventData::Output(data) => assert_eq!(data, "hello\n"),
            other => panic!("expected output event, got {other:?}"),
        }

        assert_eq!(parsed.events[2].time_s, 0.5);
        match &parsed.events[2].data {
            KrecEventData::Resize { cols, rows } => {
                assert_eq!((*cols, *rows), (100, 30));
            }
            other => panic!("expected resize event, got {other:?}"),
        }
    }

    #[test]
    fn joins_utf8_sequences_split_across_events() {
        // "日" (e6 97 a5) split into two output chunks.
        let raw = format!(
            "{}{}{}",
            header_line(80, 24),
            "{\"type\":\"event\",\"offset_ms\":0,\"event\":\"o\",\"data_b64\":\"5g==\"}\n",
            "{\"type\":\"event\",\"offset_ms\":10,\"event\":\"o\",\"data_b64\":\"l6U=\"}\n",
        );

        let parsed = parse_krec(raw.as_bytes()).expect("krec should parse");
        let combined = parsed
            .events
            .iter()
            .filter_map(|event| match &event.data {
                KrecEventData::Output(data) => Some(data.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert_eq!(combined, "日");
    }

    #[test]
    fn tolerates_truncated_final_event() {
        let raw = format!(
            "{}{}{}",
            header_line(80, 24),
            "{\"type\":\"event\",\"offset_ms\":0,\"event\":\"o\",\"data_b64\":\"aGVsbG8K\"}\n",
            "{\"type\":\"event\",\"offset_ms\":99,\"event\":\"o\",\"data_",
        );

        let parsed = parse_krec(raw.as_bytes()).expect("truncated tail should be tolerated");
        assert_eq!(parsed.events.len(), 1);
    }

    #[test]
    fn rejects_foreign_formats() {
        let raw = "{\"type\":\"header\",\"format\":\"other\",\"version\":1,\"width\":80,\"height\":24,\"start_timestamp_ms\":0}\n";
        assert!(parse_krec(raw.as_bytes()).is_err());
    }
}
