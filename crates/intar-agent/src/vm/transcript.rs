#![forbid(unsafe_code)]

//! Renders a kino session recording into a plain-text transcript.
//!
//! The session's output plays through an `avt` virtual terminal at the
//! recorded geometry, so carriage-return redraws, cursor addressing, and
//! erases resolve exactly like they did on screen. `Vt::text()` then yields
//! the primary buffer including scrollback, with soft-wrapped rows joined
//! back into logical lines and trailing whitespace trimmed. Alt-screen
//! applications (vim, htop) draw on the alternate buffer, which keeps no
//! scrollback — their frames never reach the transcript, only the
//! primary-screen shell content around them.

use avt::Vt;

use super::krec::{KrecEventData, ParsedKrec};
use super::replay_compose::{MAX_NATIVE_COLS, MAX_NATIVE_ROWS};

/// Memory bound while feeding: scrollback lines beyond this are evicted
/// oldest-first (and reported as truncation).
const TRANSCRIPT_SCROLLBACK_LIMIT: usize = 10_000;

/// Transcripts are stored as one D1 row per session and D1 caps a single
/// value at ~2 MB; stay well below it.
const TRANSCRIPT_MAX_BYTES: usize = 1_000_000;

const TRUNCATION_MARKER: &str = "[transcript truncated: earliest output omitted]";

pub(crate) struct Transcript {
    pub(crate) text: String,
    /// True when the earliest output was dropped, either by scrollback
    /// eviction while feeding or by the byte cap afterwards.
    pub(crate) truncated: bool,
}

pub(crate) fn render_transcript(session: &ParsedKrec) -> Transcript {
    let mut vt = Vt::builder()
        .size(clamp_cols(session.width), clamp_rows(session.height))
        .scrollback_limit(TRANSCRIPT_SCROLLBACK_LIMIT)
        .build();

    let mut evicted = 0_usize;
    for event in &session.events {
        match &event.data {
            KrecEventData::Output(data) => {
                evicted += vt.feed_str(data).scrollback.count();
            }
            KrecEventData::Resize { cols, rows } => {
                evicted += vt
                    .resize(clamp_cols(*cols), clamp_rows(*rows))
                    .scrollback
                    .count();
            }
            KrecEventData::Input(_) => {}
        }
    }

    let mut lines = vt.text();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }

    // Cap the stored size by dropping the oldest lines, mirroring how the
    // scrollback eviction already ages out the top of the transcript.
    let mut total_bytes = lines.iter().map(|line| line.len() + 1).sum::<usize>();
    let mut start = 0;
    while total_bytes > TRANSCRIPT_MAX_BYTES && start < lines.len() {
        total_bytes -= lines[start].len() + 1;
        start += 1;
    }

    let truncated = evicted > 0 || start > 0;
    let mut text = String::with_capacity(total_bytes + TRUNCATION_MARKER.len() + 1);
    if truncated {
        text.push_str(TRUNCATION_MARKER);
        text.push('\n');
    }
    for line in &lines[start..] {
        text.push_str(line);
        text.push('\n');
    }

    Transcript { text, truncated }
}

fn clamp_cols(cols: u16) -> usize {
    usize::from(cols.max(1)).min(MAX_NATIVE_COLS)
}

fn clamp_rows(rows: u16) -> usize {
    usize::from(rows.max(1)).min(MAX_NATIVE_ROWS)
}

#[cfg(test)]
mod tests {
    use super::super::krec::{KrecEvent, KrecEventData, ParsedKrec};
    use super::{TRANSCRIPT_MAX_BYTES, TRUNCATION_MARKER, render_transcript};

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

    #[test]
    fn carriage_return_redraws_collapse_to_the_final_line() {
        let transcript = render_transcript(&session(
            80,
            24,
            vec![output(0.0, "progress 10%"), output(0.5, "\rprogress 99%")],
        ));
        assert_eq!(transcript.text, "progress 99%\n");
        assert!(!transcript.truncated);
    }

    #[test]
    fn soft_wrapped_lines_join_into_one_logical_line() {
        let long_line = "x".repeat(100);
        let transcript = render_transcript(&session(80, 24, vec![output(0.0, &long_line)]));
        assert_eq!(transcript.text, format!("{long_line}\n"));
    }

    #[test]
    fn typed_input_never_leaks_into_the_transcript() {
        let transcript = render_transcript(&session(
            80,
            24,
            vec![
                KrecEvent {
                    time_s: 0.0,
                    data: KrecEventData::Input("secret-password".to_string()),
                },
                output(0.5, "shown"),
            ],
        ));
        assert_eq!(transcript.text, "shown\n");
    }

    #[test]
    fn alt_screen_frames_are_absent() {
        let transcript = render_transcript(&session(
            80,
            24,
            vec![
                output(0.0, "before\r\n"),
                output(0.5, "\u{1b}[?1049htui frame content"),
                output(1.0, "\u{1b}[?1049l"),
                output(1.5, "after"),
            ],
        ));
        assert!(transcript.text.contains("before"));
        assert!(transcript.text.contains("after"));
        assert!(!transcript.text.contains("tui frame content"));
    }

    #[test]
    fn scrollback_eviction_marks_the_transcript_truncated() {
        let flood = (0..12_000)
            .map(|index| format!("line-{index}\r\n"))
            .collect::<String>();
        let transcript = render_transcript(&session(80, 24, vec![output(0.0, &flood)]));
        assert!(transcript.truncated);
        assert!(transcript.text.starts_with(TRUNCATION_MARKER));
        assert!(!transcript.text.contains("line-0\n"));
        assert!(transcript.text.contains("line-11999"));
    }

    #[test]
    fn oversized_transcripts_drop_the_oldest_lines_to_fit_the_byte_cap() {
        // 5000 lines x ~300 bytes ≈ 1.5 MB: over the byte cap while staying
        // under the scrollback line limit, isolating the cap behavior.
        let wide = "z".repeat(299);
        let flood = (0..5_000)
            .map(|index| format!("{wide}{index}\r\n"))
            .collect::<String>();
        let transcript = render_transcript(&session(400, 24, vec![output(0.0, &flood)]));
        assert!(transcript.truncated);
        assert!(transcript.text.starts_with(TRUNCATION_MARKER));
        assert!(transcript.text.len() <= TRANSCRIPT_MAX_BYTES + TRUNCATION_MARKER.len() + 1);
        assert!(transcript.text.contains(&format!("{wide}4999")));
    }
}
