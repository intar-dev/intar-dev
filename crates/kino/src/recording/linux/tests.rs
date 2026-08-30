use super::{
    RAW_RECORDING_FORMAT, RAW_RECORDING_VERSION, RawEventLogWriter, RecordingMetadata,
    record_command, shell_startup_args,
};
use crate::config::RecordingConfig;
use crate::recording::ShellStartupMode;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

#[test]
fn cast_writer_atomically_publishes_a_finished_recording() {
    let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let start_ts_unix_ms = 1_700_000_000_000;
    let metadata = RecordingMetadata {
        command: Some("/bin/sh".to_owned()),
        env: BTreeMap::from([
            ("SHELL".to_owned(), "/bin/sh".to_owned()),
            ("TERM".to_owned(), "xterm-256color".to_owned()),
        ]),
    };
    let (mut writer, recording_path) =
        RawEventLogWriter::start(temp.path(), start_ts_unix_ms, 120, 40, metadata)
            .unwrap_or_else(|error| panic!("recording writer start failed: {error}"));
    let partial_path = writer.partial_path.clone();
    assert!(!recording_path.exists());
    assert!(partial_path.exists());

    writer
        .write_input_bytes(start_ts_unix_ms, b"echo hello\n")
        .unwrap_or_else(|error| panic!("write input failed: {error}"));
    writer
        .write_output_bytes(start_ts_unix_ms + 500, b"hello\n")
        .unwrap_or_else(|error| panic!("write output failed: {error}"));
    writer
        .write_resize(start_ts_unix_ms + 900, 100, 30)
        .unwrap_or_else(|error| panic!("write resize failed: {error}"));
    writer
        .write_exit(start_ts_unix_ms + 900, 0)
        .unwrap_or_else(|error| panic!("write exit failed: {error}"));
    writer
        .finish()
        .unwrap_or_else(|error| panic!("finish failed: {error}"));
    assert!(recording_path.exists());
    assert!(!partial_path.exists());
    writer
        .finish()
        .unwrap_or_else(|error| panic!("second finish failed: {error}"));

    let content = fs::read_to_string(recording_path)
        .unwrap_or_else(|error| panic!("failed to read recording file: {error}"));
    let lines = content.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 5);

    let header = serde_json::from_str::<Value>(lines[0])
        .unwrap_or_else(|error| panic!("invalid recording header: {error}"));
    assert_eq!(header["type"], "header");
    assert_eq!(header["format"], RAW_RECORDING_FORMAT);
    assert_eq!(header["version"], RAW_RECORDING_VERSION);
    assert_eq!(header["width"], 120);
    assert_eq!(header["height"], 40);
    assert_eq!(header["start_timestamp_ms"], start_ts_unix_ms);
    assert_eq!(header["command"], "/bin/sh");
    assert_eq!(header["env"]["SHELL"], "/bin/sh");
    assert_eq!(header["env"]["TERM"], "xterm-256color");

    let input = serde_json::from_str::<Value>(lines[1])
        .unwrap_or_else(|error| panic!("invalid input event: {error}"));
    assert_eq!(input["type"], "event");
    assert_eq!(input["offset_ms"], 0);
    assert_eq!(input["event"], "i");
    assert_eq!(
        BASE64_STANDARD
            .decode(input["data_b64"].as_str().unwrap_or_default())
            .unwrap_or_else(|error| panic!("invalid input event bytes: {error}")),
        b"echo hello\n"
    );

    let output = serde_json::from_str::<Value>(lines[2])
        .unwrap_or_else(|error| panic!("invalid output event: {error}"));
    assert_eq!(output["event"], "o");
    assert_eq!(
        BASE64_STANDARD
            .decode(output["data_b64"].as_str().unwrap_or_default())
            .unwrap_or_else(|error| panic!("invalid output event bytes: {error}")),
        b"hello\n"
    );

    let resize = serde_json::from_str::<Value>(lines[3])
        .unwrap_or_else(|error| panic!("invalid resize event: {error}"));
    assert_eq!(resize["event"], "r");
    assert_eq!(resize["width"], 100);
    assert_eq!(resize["height"], 30);

    let exit = serde_json::from_str::<Value>(lines[4])
        .unwrap_or_else(|error| panic!("invalid exit event: {error}"));
    assert_eq!(exit["event"], "x");
    assert_eq!(exit["exit_code"], 0);
}

#[test]
fn cast_writer_does_not_replace_a_final_path_created_after_start() {
    let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let (mut writer, recording_path) = RawEventLogWriter::start(
        temp.path(),
        1_700_000_000_000,
        80,
        24,
        RecordingMetadata::default(),
    )
    .unwrap_or_else(|error| panic!("recording writer start failed: {error}"));

    fs::write(&recording_path, b"existing recording")
        .unwrap_or_else(|error| panic!("create final-path collision failed: {error}"));

    let error = writer
        .finish()
        .expect_err("finish must reject a final path that appeared after start");
    assert_eq!(error.kind(), ErrorKind::AlreadyExists);
    assert_eq!(
        fs::read(&recording_path)
            .unwrap_or_else(|error| panic!("read collision target failed: {error}")),
        b"existing recording"
    );
}

#[test]
fn cast_writer_preserves_partial_recording_when_publish_collides() {
    let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let (mut writer, recording_path) = RawEventLogWriter::start(
        temp.path(),
        1_700_000_000_000,
        80,
        24,
        RecordingMetadata::default(),
    )
    .unwrap_or_else(|error| panic!("recording writer start failed: {error}"));
    let partial_path = writer.partial_path.clone();
    writer
        .write_output_bytes(1_700_000_000_001, b"still recoverable\n")
        .unwrap_or_else(|error| panic!("write output failed: {error}"));
    fs::write(&recording_path, b"existing recording")
        .unwrap_or_else(|error| panic!("create final-path collision failed: {error}"));

    assert!(writer.finish().is_err());
    assert!(partial_path.exists());
    let partial = fs::read_to_string(&partial_path)
        .unwrap_or_else(|error| panic!("read partial recording failed: {error}"));
    assert!(partial.contains(&BASE64_STANDARD.encode(b"still recoverable\n")));
}

#[test]
fn record_command_creates_recording_file() {
    let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let config = RecordingConfig {
        output_dir: temp.path().to_path_buf(),
        real_shell: PathBuf::from("/bin/sh"),
    };

    let exit_code = record_command(&config, "printf 'hello\\n'; >&2 printf 'oops\\n'")
        .unwrap_or_else(|error| panic!("record_command failed: {error}"));
    assert_eq!(exit_code, 0);

    let entries = fs::read_dir(temp.path())
        .unwrap_or_else(|error| panic!("read_dir failed: {error}"))
        .map(|entry| {
            entry
                .unwrap_or_else(|error| panic!("dir entry failed: {error}"))
                .path()
        })
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 1);

    let content = fs::read_to_string(&entries[0])
        .unwrap_or_else(|error| panic!("failed to read recording file: {error}"));
    let lines = content.lines().skip(1).collect::<Vec<_>>();
    let events = lines
        .iter()
        .map(|line| {
            serde_json::from_str::<Value>(line)
                .unwrap_or_else(|error| panic!("invalid recording line: {error}"))
        })
        .collect::<Vec<_>>();

    assert!(events.iter().any(|event| {
        event["event"] == "i"
            && BASE64_STANDARD
                .decode(event["data_b64"].as_str().unwrap_or_default())
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .as_deref()
                .is_some_and(|data| data.contains("printf 'hello"))
    }));
    assert!(events.iter().all(|event| {
        event["offset_ms"].is_number()
            && matches!(event["event"].as_str(), Some("i" | "o" | "r" | "x"))
    }));
    assert!(events.iter().any(|event| {
        event["event"] == "o"
            && BASE64_STANDARD
                .decode(event["data_b64"].as_str().unwrap_or_default())
                .ok()
                .as_deref()
                == Some(b"hello\n".as_slice())
    }));
    assert!(events.iter().any(|event| {
        event["event"] == "o"
            && BASE64_STANDARD
                .decode(event["data_b64"].as_str().unwrap_or_default())
                .ok()
                .as_deref()
                == Some(b"oops\n".as_slice())
    }));
}

#[test]
fn record_command_fails_closed_when_output_dir_is_a_file() {
    let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let output_path = temp.path().join("not-a-directory");
    fs::write(&output_path, "occupied").unwrap_or_else(|error| panic!("write failed: {error}"));

    let config = RecordingConfig {
        output_dir: output_path,
        real_shell: PathBuf::from("/bin/sh"),
    };

    let result = record_command(&config, "printf 'hello\\n'");
    assert!(result.is_err());
}

#[test]
fn shell_startup_args_use_login_mode_by_default() {
    assert_eq!(
        shell_startup_args(ShellStartupMode::Login, None),
        vec!["-l".to_owned()]
    );
}

#[test]
fn shell_startup_args_support_interactive_mode() {
    assert_eq!(
        shell_startup_args(ShellStartupMode::Interactive, None),
        vec!["-i".to_owned()]
    );
}

#[test]
fn shell_startup_args_prefer_command_execution() {
    assert_eq!(
        shell_startup_args(ShellStartupMode::Login, Some("printf hi")),
        vec!["-c".to_owned(), "printf hi".to_owned()]
    );
    assert_eq!(
        shell_startup_args(ShellStartupMode::Interactive, Some("printf hi")),
        vec!["-c".to_owned(), "printf hi".to_owned()]
    );
}
