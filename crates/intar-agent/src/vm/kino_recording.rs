use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::{Deserialize, Serialize};

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
    command: Option<String>,
    #[serde(default)]
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
    exit_code: Option<i32>,
}

#[derive(Debug, Serialize)]
struct CastHeader {
    version: u8,
    width: u16,
    height: u16,
    timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    env: BTreeMap<String, String>,
}

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

pub fn convert_raw_recording_to_cast<R: Read, W: Write>(input: R, mut output: W) -> Result<()> {
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

    let cast_header = CastHeader {
        version: 2,
        width: header.width,
        height: header.height,
        timestamp: header.start_timestamp_ms / 1000,
        command: header.command,
        env: header.env,
    };
    write_json_line(&mut output, &cast_header).context("failed to write asciicast header")?;

    let mut input_decoder = Utf8StreamDecoder::new();
    let mut output_decoder = Utf8StreamDecoder::new();
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
        last_offset_ms = event.offset_ms;

        match event.event.as_str() {
            "i" => {
                let payload = decode_data(&event)?;
                for chunk in input_decoder.decode_chunk(&payload) {
                    write_cast_event(&mut output, event.offset_ms, "i", &chunk)
                        .context("failed to write asciicast input event")?;
                }
            }
            "o" => {
                let payload = decode_data(&event)?;
                for chunk in output_decoder.decode_chunk(&payload) {
                    write_cast_event(&mut output, event.offset_ms, "o", &chunk)
                        .context("failed to write asciicast output event")?;
                }
            }
            "r" => {
                let width = event
                    .width
                    .ok_or_else(|| anyhow!("resize event missing width"))?;
                let height = event
                    .height
                    .ok_or_else(|| anyhow!("resize event missing height"))?;
                write_cast_event(
                    &mut output,
                    event.offset_ms,
                    "r",
                    &format!("{width}x{height}"),
                )
                .context("failed to write asciicast resize event")?;
            }
            "x" => {
                if event.exit_code.is_none() {
                    bail!("exit event missing exit_code");
                }
            }
            other => bail!("unsupported raw recording event '{other}'"),
        }
    }

    if let Some(chunk) = input_decoder.flush() {
        write_cast_event(&mut output, last_offset_ms, "i", &chunk)
            .context("failed to flush trailing asciicast input bytes")?;
    }
    if let Some(chunk) = output_decoder.flush() {
        write_cast_event(&mut output, last_offset_ms, "o", &chunk)
            .context("failed to flush trailing asciicast output bytes")?;
    }

    output.flush().context("failed to flush asciicast output")?;
    Ok(())
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

fn write_json_line<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<()> {
    serde_json::to_writer(&mut *writer, value).context("failed to serialize json line")?;
    writer
        .write_all(b"\n")
        .context("failed to write json newline")?;
    Ok(())
}

fn write_cast_event<W: Write>(
    writer: &mut W,
    offset_ms: u64,
    kind: &'static str,
    payload: &str,
) -> Result<()> {
    let offset_s = Duration::from_millis(offset_ms).as_secs_f64();
    write_json_line(writer, &(offset_s, kind, payload))
}

#[cfg(test)]
mod tests {
    use super::convert_raw_recording_to_cast;
    use serde_json::Value;

    #[test]
    fn converts_raw_recording_to_asciicast() {
        let raw = concat!(
            "{\"type\":\"header\",\"format\":\"kino.raw-event-log\",\"version\":1,\"width\":120,\"height\":40,\"start_timestamp_ms\":1700000000000,\"command\":\"/bin/sh\",\"env\":{\"SHELL\":\"/bin/sh\"}}\n",
            "{\"type\":\"event\",\"offset_ms\":0,\"event\":\"i\",\"data_b64\":\"ZWNobyBoZWxsbwo=\"}\n",
            "{\"type\":\"event\",\"offset_ms\":250,\"event\":\"o\",\"data_b64\":\"aGVsbG8K\"}\n",
            "{\"type\":\"event\",\"offset_ms\":500,\"event\":\"r\",\"width\":100,\"height\":30}\n",
            "{\"type\":\"event\",\"offset_ms\":750,\"event\":\"x\",\"exit_code\":0}\n",
        );

        let mut cast = Vec::new();
        convert_raw_recording_to_cast(raw.as_bytes(), &mut cast)
            .unwrap_or_else(|error| panic!("conversion failed: {error}"));

        let text = String::from_utf8(cast)
            .unwrap_or_else(|error| panic!("cast output is not utf-8: {error}"));
        let lines = text.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 4);

        let header = serde_json::from_str::<Value>(lines[0])
            .unwrap_or_else(|error| panic!("invalid cast header: {error}"));
        assert_eq!(header["version"], 2);
        assert_eq!(header["width"], 120);
        assert_eq!(header["height"], 40);
        assert_eq!(header["timestamp"], 1_700_000_000_u64);
        assert_eq!(header["command"], "/bin/sh");
        assert_eq!(header["env"]["SHELL"], "/bin/sh");

        let input = serde_json::from_str::<Value>(lines[1])
            .unwrap_or_else(|error| panic!("invalid cast input event: {error}"));
        assert_eq!(input[1], "i");
        assert_eq!(input[2], "echo hello\n");

        let output = serde_json::from_str::<Value>(lines[2])
            .unwrap_or_else(|error| panic!("invalid cast output event: {error}"));
        assert_eq!(output[1], "o");
        assert_eq!(output[2], "hello\n");

        let resize = serde_json::from_str::<Value>(lines[3])
            .unwrap_or_else(|error| panic!("invalid cast resize event: {error}"));
        assert_eq!(resize[1], "r");
        assert_eq!(resize[2], "100x30");
    }

    #[test]
    fn tolerates_missing_exit_event() {
        let raw = concat!(
            "{\"type\":\"header\",\"format\":\"kino.raw-event-log\",\"version\":1,\"width\":120,\"height\":40,\"start_timestamp_ms\":1700000000000,\"env\":{\"SHELL\":\"/bin/sh\"}}\n",
            "{\"type\":\"event\",\"offset_ms\":0,\"event\":\"o\",\"data_b64\":\"bGlzdGluZy4uLiAwJQ==\"}\n",
        );

        let mut cast = Vec::new();
        convert_raw_recording_to_cast(raw.as_bytes(), &mut cast)
            .unwrap_or_else(|error| panic!("conversion failed: {error}"));

        let text = String::from_utf8(cast)
            .unwrap_or_else(|error| panic!("cast output is not utf-8: {error}"));
        assert!(text.contains("listing... 0%"));
    }
}
