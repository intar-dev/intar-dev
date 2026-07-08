#![forbid(unsafe_code)]

//! Composes per-session kino recordings into one fixed-grid asciicast.
//!
//! The canvas is pinned to 120x30 — the grid the live web terminal uses
//! (`website/src/lib/replay/config.ts` must agree). Sessions recorded at
//! exactly that grid pass through untouched. Anything else is *reflowed*,
//! not padded: the session plays through a virtual terminal (`avt`) at its
//! recorded width, and after every output burst the full terminal state is
//! serialized (`Vt::dump`) and replayed into a fresh 120x30 shadow terminal.
//! `dump` emits hard line breaks only, so soft-wrapped lines re-wrap at 120
//! columns exactly like a real terminal resize — content fills the canvas
//! instead of floating in a letterbox. The shadow view is then diffed
//! row-by-row into compact repaints.
//!
//! The native emulation always runs at the canvas height: scrolling flows
//! are height-agnostic, while width semantics (`\r` redraws, absolute
//! column addressing) must be interpreted at the recorded width before
//! reflowing. Alt-screen TUIs recorded at foreign sizes cannot reflow —
//! only the live application could redraw for a new geometry — and render
//! cropped or underfilled instead. Idle gaps are clamped at the data level;
//! typed input passes through untouched (the player ignores it for
//! rendering, the website parses it into the command log).

use std::fmt::Write as _;

use anyhow::{Context as _, Result};
use avt::{Color, Line, Pen, Vt};
use serde_json::{Map, Value, json};

use super::krec::{KrecEvent, KrecEventData, ParsedKrec};

/// The pinned replay grid, matching the live web terminal.
pub(crate) const CANVAS_COLS: usize = 120;
pub(crate) const CANVAS_ROWS: usize = 30;

/// Idle gaps longer than this are clamped (seconds). Mirrors the pacing the
/// player used to apply via `idle_time_limit`; baking it into the data keeps
/// the timeline honest.
const IDLE_TIME_LIMIT_S: f64 = 1.5;

/// Duration of the "Session N of M" divider slide between sessions.
const RECORDING_DIVIDER_DURATION_S: f64 = 2.0;

/// Guard against absurd recorded widths.
const MAX_NATIVE_COLS: usize = 512;

/// Hide cursor, reset the pen, clear the canvas, and home the cursor.
const CANVAS_RESET: &str = "\u{1b}[?25l\u{1b}[0m\u{1b}[2J\u{1b}[H";

/// Same, but leaves the cursor visible — passthrough sessions stream raw
/// PTY output, which assumes the freshly attached terminal shows a cursor.
const PASSTHROUGH_RESET: &str = "\u{1b}[0m\u{1b}[2J\u{1b}[H\u{1b}[?25h";

pub(crate) fn compose_sessions(sessions: &[ParsedKrec]) -> Result<String> {
    let first = sessions
        .first()
        .ok_or_else(|| anyhow::anyhow!("cannot combine an empty recording list"))?;

    let mut header = Map::new();
    header.insert("version".to_string(), json!(2));
    header.insert("width".to_string(), json!(CANVAS_COLS));
    header.insert("height".to_string(), json!(CANVAS_ROWS));
    header.insert("timestamp".to_string(), json!(first.start_timestamp_s));
    let mut out = serde_json::to_string(&Value::Object(header))
        .context("failed to serialize combined cast header")?;
    out.push('\n');

    let total_sessions = sessions.len();
    let mut offset_s = 0.0_f64;
    for (index, session) in sessions.iter().enumerate() {
        if index > 0 {
            write_cast_event(
                &mut out,
                offset_s,
                "o",
                &render_divider(index + 1, total_sessions),
            )
            .context("failed to write session divider")?;
            offset_s += RECORDING_DIVIDER_DURATION_S;
        }

        let duration_s = if is_passthrough(session) {
            compose_passthrough(&mut out, offset_s, session)?
        } else {
            compose_reflowed(&mut out, offset_s, session)?
        };
        offset_s += duration_s;
    }

    Ok(out)
}

/// A session recorded on the exact canvas grid that never resized replays
/// verbatim — no emulation round-trip, pixel-perfect fidelity.
fn is_passthrough(session: &ParsedKrec) -> bool {
    usize::from(session.width) == CANVAS_COLS
        && usize::from(session.height) == CANVAS_ROWS
        && session
            .events
            .iter()
            .all(|event| !matches!(event.data, KrecEventData::Resize { .. }))
}

/// Rewrites event times so no gap exceeds the idle limit while relative
/// pacing within bursts is preserved.
fn clamped_times(events: &[KrecEvent]) -> Vec<f64> {
    let mut times = Vec::with_capacity(events.len());
    let mut last_raw_s = 0.0_f64;
    let mut last_clamped_s = 0.0_f64;
    for event in events {
        let raw_s = event.time_s.max(last_raw_s);
        last_clamped_s += (raw_s - last_raw_s).min(IDLE_TIME_LIMIT_S);
        last_raw_s = raw_s;
        times.push(last_clamped_s);
    }
    times
}

fn compose_passthrough(out: &mut String, offset_s: f64, session: &ParsedKrec) -> Result<f64> {
    write_cast_event(out, offset_s, "o", PASSTHROUGH_RESET)
        .context("failed to write session prelude")?;

    let times = clamped_times(&session.events);
    for (event, time_s) in session.events.iter().zip(&times) {
        match &event.data {
            KrecEventData::Output(data) => {
                write_cast_event(out, offset_s + time_s, "o", data)
                    .context("failed to write passthrough event")?;
            }
            KrecEventData::Input(data) => {
                write_cast_event(out, offset_s + time_s, "i", data)
                    .context("failed to write passthrough input event")?;
            }
            KrecEventData::Resize { .. } => {}
        }
    }
    Ok(times.last().copied().unwrap_or(0.0))
}

fn compose_reflowed(out: &mut String, offset_s: f64, session: &ParsedKrec) -> Result<f64> {
    let mut renderer = ReflowRenderer::new(session.width);
    write_cast_event(out, offset_s, "o", CANVAS_RESET)
        .context("failed to write session prelude")?;

    let events = &session.events;
    let times = clamped_times(events);
    let mut index = 0;
    while index < events.len() {
        let time_s = round_cast_time(times[index]);
        match &events[index].data {
            KrecEventData::Output(data) => {
                // Coalesce bursts that land on the same millisecond so
                // dirty-row dedup sees them as a single repaint.
                let mut data = data.clone();
                while index + 1 < events.len()
                    && round_cast_time(times[index + 1]) == time_s
                    && let KrecEventData::Output(next) = &events[index + 1].data
                {
                    index += 1;
                    data.push_str(next);
                }
                let payload = renderer.feed_output(&data);
                if !payload.is_empty() {
                    write_cast_event(out, offset_s + time_s, "o", &payload)
                        .context("failed to write reflowed event")?;
                }
            }
            KrecEventData::Input(data) => {
                // Input never touches the terminal; it feeds the command log.
                write_cast_event(out, offset_s + time_s, "i", data)
                    .context("failed to write reflowed input event")?;
            }
            KrecEventData::Resize { cols, rows: _ } => {
                let payload = renderer.apply_resize(*cols);
                if !payload.is_empty() {
                    write_cast_event(out, offset_s + time_s, "o", &payload)
                        .context("failed to write reflow resize repaint")?;
                }
            }
        }
        index += 1;
    }
    Ok(times.last().copied().unwrap_or(0.0))
}

fn render_divider(session_number: usize, total_sessions: usize) -> String {
    let label = format!("Session {session_number} of {total_sessions}");
    let row = CANVAS_ROWS / 2;
    let col = (CANVAS_COLS.saturating_sub(label.chars().count()) / 2).max(1);
    format!("{CANVAS_RESET}\u{1b}[{row};{col}H{label}")
}

/// Re-renders one session's PTY stream, reflowed onto the canvas grid.
struct ReflowRenderer {
    /// Emulates the session at its recorded width but at canvas height:
    /// scrolling output is height-agnostic, while `\r` redraws and column
    /// addressing need the true width to be interpreted correctly.
    native: Vt,
    /// Last emitted content per canvas row; repaints dedup against this.
    painted: Vec<String>,
    last_cursor: Option<(usize, usize, bool)>,
}

impl ReflowRenderer {
    fn new(cols: u16) -> Self {
        let cols = usize::from(cols.max(1)).min(MAX_NATIVE_COLS);
        let native = Vt::builder()
            .size(cols, CANVAS_ROWS)
            .scrollback_limit(0)
            .build();
        Self {
            native,
            painted: vec![String::new(); CANVAS_ROWS],
            last_cursor: None,
        }
    }

    fn feed_output(&mut self, data: &str) -> String {
        let _ = self.native.feed_str(data);
        self.render_snapshot()
    }

    /// Only the width matters: it changes how the recorded stream wraps.
    /// Height stays pinned to the canvas.
    fn apply_resize(&mut self, cols: u16) -> String {
        let cols = usize::from(cols.max(1)).min(MAX_NATIVE_COLS);
        let _ = self.native.resize(cols, CANVAS_ROWS);
        self.render_snapshot()
    }

    /// Serializes the native terminal (`dump` writes hard line breaks only)
    /// and replays it into a fresh canvas-sized shadow terminal, so
    /// soft-wrapped lines re-wrap at the canvas width. The shadow view is
    /// diffed against the previously emitted rows.
    fn render_snapshot(&mut self) -> String {
        let mut shadow = Vt::builder()
            .size(CANVAS_COLS, CANVAS_ROWS)
            .scrollback_limit(0)
            .build();
        let _ = shadow.feed_str(&self.native.dump());

        let mut out = String::new();
        for row in 0..CANVAS_ROWS {
            let content = serialize_line(shadow.line(row));
            if self.painted[row] != content {
                // Reset before erasing so background-color-erase can't
                // bleed into the cleared tail of the row.
                let _ = write!(out, "\u{1b}[{};1H\u{1b}[0m\u{1b}[K{content}", row + 1);
                self.painted[row] = content;
            }
        }

        let cursor = shadow.cursor();
        let state = (cursor.col, cursor.row, cursor.visible);
        if !(out.is_empty() && self.last_cursor == Some(state)) {
            if cursor.visible {
                // The column can sit one past the edge while a wrap is
                // pending.
                let col = cursor.col.min(CANVAS_COLS - 1);
                let row = cursor.row.min(CANVAS_ROWS - 1);
                let _ = write!(out, "\u{1b}[{};{}H\u{1b}[?25h", row + 1, col + 1);
            } else {
                out.push_str("\u{1b}[?25l");
            }
            self.last_cursor = Some(state);
        }
        out
    }
}

/// Serializes a terminal row as styled runs, trimming trailing blank cells
/// (the repaint's erase-to-end-of-line already covers those).
fn serialize_line(line: &Line) -> String {
    let cells = line.cells();
    let end = cells
        .iter()
        .rposition(|cell| !cell.is_default())
        .map_or(0, |index| index + 1);

    let mut out = String::new();
    let mut pen = Pen::default();
    for cell in &cells[..end] {
        if cell.width() == 0 {
            // Skip the tail cell of a wide character; the head already
            // advanced the display by two columns.
            continue;
        }
        if *cell.pen() != pen {
            pen = *cell.pen();
            push_sgr(&mut out, &pen);
        }
        out.push(cell.char());
    }
    out
}

/// Emits one full SGR sequence for `pen`, starting from a reset.
fn push_sgr(out: &mut String, pen: &Pen) {
    out.push_str("\u{1b}[0");
    if pen.is_bold() {
        out.push_str(";1");
    }
    if pen.is_faint() {
        out.push_str(";2");
    }
    if pen.is_italic() {
        out.push_str(";3");
    }
    if pen.is_underline() {
        out.push_str(";4");
    }
    if pen.is_blink() {
        out.push_str(";5");
    }
    if pen.is_inverse() {
        out.push_str(";7");
    }
    if pen.is_strikethrough() {
        out.push_str(";9");
    }
    if let Some(color) = pen.foreground() {
        push_sgr_color(out, color, 30, 90, 38);
    }
    if let Some(color) = pen.background() {
        push_sgr_color(out, color, 40, 100, 48);
    }
    out.push('m');
}

fn push_sgr_color(out: &mut String, color: Color, base: u8, bright_base: u8, extended: u8) {
    match color {
        Color::Indexed(index) if index < 8 => {
            let _ = write!(out, ";{}", base + index);
        }
        Color::Indexed(index) if index < 16 => {
            let _ = write!(out, ";{}", bright_base + (index - 8));
        }
        Color::Indexed(index) => {
            let _ = write!(out, ";{extended};5;{index}");
        }
        Color::RGB(rgb) => {
            let _ = write!(out, ";{extended};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        }
    }
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

    use super::super::krec::{KrecEvent, KrecEventData, ParsedKrec};
    use super::super::replay_media::parse_cast;
    use super::{CANVAS_COLS, CANVAS_ROWS, compose_sessions, render_divider};

    fn session(width: u16, height: u16, events: Vec<KrecEvent>) -> ParsedKrec {
        ParsedKrec {
            width,
            height,
            start_timestamp_s: 1_700_000_000,
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

    /// Feeds every output payload of a composed cast into a canvas-sized vt.
    fn replay_composed(combined: &str) -> Result<avt::Vt> {
        let parsed = parse_cast(combined)?;
        assert_eq!(usize::from(parsed.width), CANVAS_COLS);
        assert_eq!(usize::from(parsed.height), CANVAS_ROWS);
        let mut vt = avt::Vt::builder()
            .size(CANVAS_COLS, CANVAS_ROWS)
            .scrollback_limit(0)
            .build();
        for event in &parsed.events {
            if event.kind == "o" {
                let _ = vt.feed_str(&event.payload);
            }
        }
        Ok(vt)
    }

    #[test]
    fn exact_grid_sessions_pass_through_verbatim() -> Result<()> {
        let payload = "\u{1b}[1;31mhello\u{1b}[0m world";
        let sessions = vec![session(120, 30, vec![output(0.5, payload)])];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

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
    fn narrow_sessions_reflow_to_fill_the_width() -> Result<()> {
        // A 100-char line soft-wraps on an 80-col terminal. After reflow to
        // 120 cols the line must occupy a single row again — no letterbox.
        let long_line = "x".repeat(100);
        let sessions = vec![session(80, 24, vec![output(0.0, &long_line)])];
        let combined = compose_sessions(&sessions)?;

        let vt = replay_composed(&combined)?;
        assert_eq!(vt.line(0).text().trim_end(), long_line);
        assert!(vt.line(1).text().trim().is_empty());
        Ok(())
    }

    #[test]
    fn wide_sessions_reflow_by_wrapping_down() -> Result<()> {
        // A 200-col terminal fits the line on one row; on the 120-col canvas
        // it wraps into two rows without losing content.
        let long_line = "y".repeat(200);
        let sessions = vec![session(200, 50, vec![output(0.0, &long_line)])];
        let combined = compose_sessions(&sessions)?;

        let vt = replay_composed(&combined)?;
        assert_eq!(vt.line(0).text(), "y".repeat(120));
        assert_eq!(vt.line(1).text().trim_end(), "y".repeat(80));
        Ok(())
    }

    #[test]
    fn carriage_return_redraws_survive_reflow_at_the_recorded_width() -> Result<()> {
        // Progress-bar style output: a 150-char line on a 200-col terminal
        // redrawn in place via `\r`. Interpreted at the recorded width the
        // redraw replaces the line; fed naively into 120 cols it would have
        // appended junk rows.
        let first = format!("{} 10%", "#".repeat(146));
        let second = format!("{} 99%", "#".repeat(146));
        let sessions = vec![session(
            200,
            50,
            vec![output(0.0, &first), output(0.5, &format!("\r{second}"))],
        )];
        let combined = compose_sessions(&sessions)?;

        let vt = replay_composed(&combined)?;
        let screen = (0..CANVAS_ROWS)
            .map(|row| vt.line(row).text())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(screen.contains("99%"), "final redraw must win: {screen}");
        assert!(
            !screen.contains("10%"),
            "stale redraw must vanish: {screen}"
        );
        Ok(())
    }

    #[test]
    fn styles_and_wide_chars_round_trip_through_reflow() -> Result<()> {
        let payload = concat!(
            "\u{1b}[1;31mbold red\u{1b}[0m plain ",
            "\u{1b}[38;5;196mx\u{1b}[48;2;10;20;30my\u{1b}[0m\r\n",
            "\u{1b}[4;7minverse underline\u{1b}[0m 日本語\r\n",
            "tail"
        );
        let sessions = vec![session(40, 6, vec![output(0.0, payload)])];
        let combined = compose_sessions(&sessions)?;

        let mut reference = avt::Vt::builder()
            .size(CANVAS_COLS, CANVAS_ROWS)
            .scrollback_limit(0)
            .build();
        let _ = reference.feed_str(payload);

        let vt = replay_composed(&combined)?;
        for row in 0..CANVAS_ROWS {
            let rendered = vt.line(row).cells();
            let expected = reference.line(row).cells();
            for col in 0..CANVAS_COLS {
                assert_eq!(
                    rendered[col].char(),
                    expected[col].char(),
                    "char mismatch at {row}:{col}"
                );
                assert_eq!(
                    rendered[col].pen(),
                    expected[col].pen(),
                    "pen mismatch at {row}:{col}"
                );
            }
        }
        Ok(())
    }

    #[test]
    fn resize_events_change_the_reflow_width_without_resize_output() -> Result<()> {
        let sessions = vec![session(
            80,
            24,
            vec![
                output(0.0, "before"),
                resize(1.0, 100, 30),
                output(2.0, " after"),
            ],
        )];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

        assert!(parsed.events.iter().all(|event| event.kind != "r"));
        assert_eq!(usize::from(parsed.width), CANVAS_COLS);
        assert_eq!(usize::from(parsed.height), CANVAS_ROWS);

        let vt = replay_composed(&combined)?;
        assert_eq!(vt.line(0).text().trim_end(), "before after");
        Ok(())
    }

    #[test]
    fn idle_gaps_are_clamped_in_the_data() -> Result<()> {
        let sessions = vec![session(
            120,
            30,
            vec![output(0.0, "a"), output(60.0, "b"), output(60.2, "c")],
        )];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

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
    fn no_op_repaints_are_skipped() -> Result<()> {
        let sessions = vec![session(
            80,
            24,
            vec![
                output(0.0, "stable"),
                // Rewrites the same content: rows go dirty but nothing
                // visible changes and the cursor returns to the same spot.
                output(1.0, "\r"),
                output(1.2, "stable"),
            ],
        )];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

        let repaints = parsed
            .events
            .iter()
            .filter(|event| event.payload.contains("stable"))
            .count();
        assert_eq!(repaints, 1, "identical content must not repaint");
        Ok(())
    }

    #[test]
    fn input_events_pass_through_for_the_command_log() -> Result<()> {
        // Both the passthrough and the reflow path must carry typed input —
        // the website derives its command log from `i` events.
        for dims in [(120, 30), (80, 24)] {
            let sessions = vec![session(
                dims.0,
                dims.1,
                vec![input(0.0, "ls\r"), output(0.5, "listing")],
            )];
            let combined = compose_sessions(&sessions)?;
            let parsed = parse_cast(&combined)?;
            assert!(
                parsed
                    .events
                    .iter()
                    .any(|event| event.kind == "i" && event.payload == "ls\r"),
                "input event missing for {dims:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn divider_is_centered_on_the_canvas() {
        let slide = render_divider(2, 3);
        assert!(slide.contains("Session 2 of 3"));
        // Row 15 of 30; "Session 2 of 3" is 14 chars -> column (120-14)/2 = 53.
        assert!(slide.contains("\u{1b}[15;53H"));
        assert!(slide.starts_with("\u{1b}[?25l\u{1b}[0m\u{1b}[2J\u{1b}[H"));
    }

    #[test]
    fn sessions_concat_with_divider_timing() -> Result<()> {
        let sessions = vec![
            session(120, 30, vec![output(0.0, "alpha"), output(1.0, "omega")]),
            session(80, 24, vec![output(0.5, "bravo")]),
        ];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

        let divider = parsed
            .events
            .iter()
            .find(|event| event.payload.contains("Session 2 of 2"))
            .expect("divider slide should exist");
        // Session 1 lasts 1.0s, the divider holds for 2.0s, and session 2's
        // event lands 0.5s after that.
        assert_eq!(divider.time_s, 1.0);
        assert!(
            parsed
                .events
                .iter()
                .any(|event| event.time_s == 3.5 && event.payload.contains("bravo"))
        );

        // Replaying ends on session 2's content, reflowed onto the canvas.
        let vt = replay_composed(&combined)?;
        assert_eq!(vt.line(0).text().trim_end(), "bravo");
        Ok(())
    }
}
