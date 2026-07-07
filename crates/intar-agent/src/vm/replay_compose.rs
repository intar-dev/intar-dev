#![forbid(unsafe_code)]

//! Composes per-session asciicast recordings into one fixed-canvas cast.
//!
//! Raw PTY output cannot be centered by prefixing padding: escape sequences
//! address absolute coordinates and carriage returns jump to column zero.
//! Each session is therefore re-rendered through a virtual terminal (`avt`)
//! at its native dimensions and re-emitted as row repaints translated into
//! canvas coordinates. The canvas is 120x30 — the grid the live web terminal
//! is pinned to — so every recording renders at the same size; sessions
//! smaller than the canvas sit centered with symmetric bars, and the rare
//! larger session gets the smallest 4:1 canvas that contains it (the player
//! scales the font down instead of cropping). Re-rendering drops OSC
//! sequences (window titles, hyperlinks) and bells, which have no effect on
//! replay playback; the raw per-session casts remain available as separate
//! artifacts.

use std::fmt::Write as _;

use anyhow::{Context as _, Result};
use avt::{Color, Line, Pen, Vt};
use serde_json::{Value, json};

use super::replay_media::ParsedCast;

/// Duration of the "Session N of M" divider slide between sessions.
const RECORDING_DIVIDER_DURATION_S: f64 = 2.0;

/// The canvas targets a 16:9 pixel aspect. With the website player's cell
/// metrics (0.6em glyph advance, 1.35 line height — must match
/// `website/src/lib/replay/config.ts`) a 4:1 grid is exactly 16:9:
/// 120 * 0.6em : 30 * 1.35em = 72 : 40.5 = 16 : 9.
const CANVAS_COLS_PER_ROW: u16 = 4;
/// The base canvas is 120x30, the grid the live web terminal is pinned to.
const MIN_CANVAS_ROWS: u16 = 30;
/// Guard against absurd resize claims (canvas tops out at 480x120).
const MAX_CANVAS_ROWS: u16 = 120;

/// Hide cursor, reset the pen, clear the canvas, and home the cursor.
const CANVAS_RESET: &str = "\u{1b}[?25l\u{1b}[0m\u{1b}[2J\u{1b}[H";

pub(crate) fn compose_sessions(sessions: &[ParsedCast]) -> Result<String> {
    let first = sessions
        .first()
        .ok_or_else(|| anyhow::anyhow!("cannot combine an empty cast list"))?;

    let (canvas_cols, canvas_rows) = select_canvas_for_sessions(sessions);

    let mut header = first.header.clone();
    header.insert("version".to_string(), json!(2));
    header.insert("width".to_string(), json!(canvas_cols));
    header.insert("height".to_string(), json!(canvas_rows));
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
                &render_divider(canvas_cols, canvas_rows, index + 1, total_sessions),
            )
            .context("failed to write session divider")?;
            offset_s += RECORDING_DIVIDER_DURATION_S;
        }

        let mut renderer =
            SessionRenderer::new((canvas_cols, canvas_rows), (session.width, session.height));
        write_cast_event(&mut out, offset_s, "o", CANVAS_RESET)
            .context("failed to write session prelude")?;

        let events = &session.events;
        let mut index = 0;
        while index < events.len() {
            let event = &events[index];
            match event.kind.as_str() {
                "o" => {
                    // Coalesce bursts that land on the same millisecond so
                    // dirty-row dedup sees them as a single repaint.
                    let time = round_cast_time(event.time_s);
                    let mut data = event.payload.clone();
                    while index + 1 < events.len()
                        && events[index + 1].kind == "o"
                        && round_cast_time(events[index + 1].time_s) == time
                    {
                        index += 1;
                        data.push_str(&events[index].payload);
                    }
                    let payload = renderer.feed_output(&data);
                    if !payload.is_empty() {
                        write_cast_event(&mut out, offset_s + event.time_s, "o", &payload)
                            .context("failed to write combined cast event")?;
                    }
                }
                "r" => {
                    if let Some((cols, rows)) = parse_resize_payload(&event.payload) {
                        let payload = renderer.apply_resize(cols, rows);
                        if !payload.is_empty() {
                            write_cast_event(&mut out, offset_s + event.time_s, "o", &payload)
                                .context("failed to write resize repaint")?;
                        }
                    }
                }
                _ => {
                    write_cast_event(
                        &mut out,
                        offset_s + event.time_s,
                        &event.kind,
                        &event.payload,
                    )
                    .context("failed to write combined cast event")?;
                }
            }
            index += 1;
        }

        offset_s += session.duration_s;
    }

    Ok(out)
}

fn select_canvas_for_sessions(sessions: &[ParsedCast]) -> (u16, u16) {
    let mut max_cols = 0_u16;
    let mut max_rows = 0_u16;
    for session in sessions {
        max_cols = max_cols.max(session.width);
        max_rows = max_rows.max(session.height);
        for event in &session.events {
            if event.kind == "r"
                && let Some((cols, rows)) = parse_resize_payload(&event.payload)
            {
                max_cols = max_cols.max(cols);
                max_rows = max_rows.max(rows);
            }
        }
    }
    select_canvas(max_cols, max_rows)
}

/// Picks the smallest 16:9 (4:1 grid) canvas that fits `max_cols` x
/// `max_rows`, with a 120x30 floor so everything the pinned web terminal
/// records lands on the identical canvas.
fn select_canvas(max_cols: u16, max_rows: u16) -> (u16, u16) {
    let rows = max_rows
        .max(max_cols.div_ceil(CANVAS_COLS_PER_ROW))
        .clamp(MIN_CANVAS_ROWS, MAX_CANVAS_ROWS);
    (rows * CANVAS_COLS_PER_ROW, rows)
}

fn parse_resize_payload(payload: &str) -> Option<(u16, u16)> {
    let (cols, rows) = payload.trim().split_once('x')?;
    let cols = cols.trim().parse::<u16>().ok()?;
    let rows = rows.trim().parse::<u16>().ok()?;
    (cols > 0 && rows > 0).then_some((cols, rows))
}

fn render_divider(
    canvas_cols: u16,
    canvas_rows: u16,
    session_number: usize,
    total_sessions: usize,
) -> String {
    let label = format!("Session {session_number} of {total_sessions}");
    let label_width = u16::try_from(label.chars().count()).unwrap_or(u16::MAX);
    let row = (canvas_rows / 2).max(1);
    let col = if canvas_cols > label_width {
        ((canvas_cols - label_width) / 2).max(1)
    } else {
        1
    };
    format!("{CANVAS_RESET}\u{1b}[{row};{col}H{label}")
}

/// Re-renders one session's PTY stream into canvas-relative repaints.
struct SessionRenderer {
    vt: Vt,
    cols: usize,
    rows: usize,
    pad_left: usize,
    pad_top: usize,
    canvas_cols: usize,
    canvas_rows: usize,
    /// Last serialized content per session row; avt marks rows dirty even
    /// when nothing visible changed, so repaints dedup against this.
    painted: Vec<String>,
    last_cursor: Option<(usize, usize, bool)>,
}

impl SessionRenderer {
    fn new(canvas: (u16, u16), session: (u16, u16)) -> Self {
        let canvas_cols = usize::from(canvas.0);
        let canvas_rows = usize::from(canvas.1);
        let cols = usize::from(session.0.max(1)).min(canvas_cols);
        let rows = usize::from(session.1.max(1)).min(canvas_rows);
        let vt = Vt::builder().size(cols, rows).scrollback_limit(0).build();
        Self {
            vt,
            cols,
            rows,
            pad_left: (canvas_cols - cols) / 2,
            pad_top: (canvas_rows - rows) / 2,
            canvas_cols,
            canvas_rows,
            painted: vec![String::new(); rows],
            last_cursor: None,
        }
    }

    fn feed_output(&mut self, data: &str) -> String {
        let mut dirty = {
            let changes = self.vt.feed_str(data);
            changes.lines
        };
        dirty.sort_unstable();
        dirty.dedup();

        let mut out = String::new();
        for row in dirty {
            if row < self.rows {
                self.push_row_repaint(&mut out, row);
            }
        }
        self.push_cursor_sync(&mut out);
        out
    }

    /// A resize keeps the canvas fixed: re-center, clear, and repaint.
    fn apply_resize(&mut self, cols: u16, rows: u16) -> String {
        let cols = usize::from(cols).min(self.canvas_cols);
        let rows = usize::from(rows).min(self.canvas_rows);
        if cols == self.cols && rows == self.rows {
            return String::new();
        }

        let _ = self.vt.resize(cols, rows);
        self.cols = cols;
        self.rows = rows;
        self.pad_left = (self.canvas_cols - cols) / 2;
        self.pad_top = (self.canvas_rows - rows) / 2;
        self.painted = vec![String::new(); rows];
        self.last_cursor = None;

        let mut out = String::from(CANVAS_RESET);
        for row in 0..self.rows {
            self.push_row_repaint(&mut out, row);
        }
        self.push_cursor_sync(&mut out);
        out
    }

    fn push_row_repaint(&mut self, out: &mut String, row: usize) {
        let content = serialize_line(self.vt.line(row));
        if self.painted[row] == content {
            return;
        }
        // Reset before erasing so background-color-erase can't paint a bar
        // into the padding; the erase covers the trimmed line tail.
        let _ = write!(
            out,
            "\u{1b}[{};{}H\u{1b}[0m\u{1b}[K{content}",
            self.pad_top + row + 1,
            self.pad_left + 1
        );
        self.painted[row] = content;
    }

    fn push_cursor_sync(&mut self, out: &mut String) {
        let cursor = self.vt.cursor();
        let state = (cursor.col, cursor.row, cursor.visible);
        if out.is_empty() && self.last_cursor == Some(state) {
            return;
        }
        if cursor.visible {
            // The column can sit one past the edge while a wrap is pending.
            let col = cursor.col.min(self.cols.saturating_sub(1));
            let row = cursor.row.min(self.rows.saturating_sub(1));
            let _ = write!(
                out,
                "\u{1b}[{};{}H\u{1b}[?25h",
                self.pad_top + row + 1,
                self.pad_left + col + 1
            );
        } else {
            out.push_str("\u{1b}[?25l");
        }
        self.last_cursor = Some(state);
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

pub(crate) fn write_cast_event(
    out: &mut String,
    time_s: f64,
    kind: &str,
    payload: &str,
) -> Result<()> {
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
    use serde_json::{Map, json};

    use super::super::replay_media::{CastEvent, ParsedCast, parse_cast};
    use super::{compose_sessions, render_divider, select_canvas};

    fn session(width: u16, height: u16, events: Vec<CastEvent>) -> ParsedCast {
        let mut header = Map::new();
        header.insert("version".to_string(), json!(2));
        header.insert("width".to_string(), json!(width));
        header.insert("height".to_string(), json!(height));
        header.insert("timestamp".to_string(), json!(1_700_000_000));
        let duration_s = events
            .iter()
            .map(|event| event.time_s)
            .fold(0.0_f64, f64::max);
        ParsedCast {
            header,
            width,
            height,
            events,
            duration_s,
        }
    }

    fn event(time_s: f64, kind: &str, payload: &str) -> CastEvent {
        CastEvent {
            time_s,
            kind: kind.to_string(),
            payload: payload.to_string(),
        }
    }

    /// Feeds every output payload of a composed cast into a canvas-sized vt.
    fn replay_composed(combined: &str) -> Result<avt::Vt> {
        let parsed = parse_cast(combined)?;
        let mut vt = avt::Vt::builder()
            .size(usize::from(parsed.width), usize::from(parsed.height))
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
    fn select_canvas_keeps_16_9_ratio() {
        // Everything that fits the pinned 120x30 grid gets exactly 120x30.
        assert_eq!(select_canvas(80, 24), (120, 30));
        assert_eq!(select_canvas(120, 30), (120, 30));
        assert_eq!(select_canvas(10, 5), (120, 30));
        // Bigger sessions get the smallest containing 4:1 canvas.
        assert_eq!(select_canvas(150, 30), (152, 38));
        assert_eq!(select_canvas(200, 50), (200, 50));
        assert_eq!(select_canvas(200, 60), (240, 60));
        // Absurd claims are capped.
        assert_eq!(select_canvas(2000, 10), (480, 120));
    }

    #[test]
    fn composed_cast_centers_session_content() -> Result<()> {
        let sessions = vec![session(80, 24, vec![event(0.0, "o", "hello")])];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

        assert_eq!(parsed.width, 120);
        assert_eq!(parsed.height, 30);
        // pad_left = (120 - 80) / 2 = 20, pad_top = (30 - 24) / 2 = 3, so the
        // session's row 0 repaints at canvas row 4, column 21.
        assert!(
            parsed
                .events
                .iter()
                .any(|event| event.payload.contains("\u{1b}[4;21H")),
            "expected a repaint at the padded origin"
        );

        let vt = replay_composed(&combined)?;
        let row = vt.line(3).text();
        assert_eq!(row.trim(), "hello");
        assert_eq!(row.len() - row.trim_start().len(), 20);

        Ok(())
    }

    #[test]
    fn composed_cast_round_trips_styles_and_wide_chars() -> Result<()> {
        let payload = concat!(
            "\u{1b}[1;31mbold red\u{1b}[0m plain ",
            "\u{1b}[38;5;196mx\u{1b}[48;2;10;20;30my\u{1b}[0m\r\n",
            "\u{1b}[4;7minverse underline\u{1b}[0m 日本語\r\n",
            "tail"
        );
        let sessions = vec![session(40, 6, vec![event(0.0, "o", payload)])];
        let combined = compose_sessions(&sessions)?;

        let mut reference = avt::Vt::builder().size(40, 6).scrollback_limit(0).build();
        let _ = reference.feed_str(payload);

        let vt = replay_composed(&combined)?;
        let (pad_left, pad_top) = ((120 - 40) / 2, (30 - 6) / 2);
        for row in 0..6 {
            let canvas_cells = vt.line(pad_top + row).cells();
            let reference_cells = reference.line(row).cells();
            for col in 0..40 {
                let canvas_cell = canvas_cells[pad_left + col];
                let reference_cell = reference_cells[col];
                assert_eq!(
                    canvas_cell.char(),
                    reference_cell.char(),
                    "char mismatch at {row}:{col}"
                );
                assert_eq!(
                    canvas_cell.pen(),
                    reference_cell.pen(),
                    "pen mismatch at {row}:{col}"
                );
            }
        }

        Ok(())
    }

    #[test]
    fn composed_cast_replaces_resize_events_with_repaints() -> Result<()> {
        let sessions = vec![session(
            80,
            24,
            vec![
                event(0.0, "o", "before"),
                event(1.0, "r", "100x30"),
                event(2.0, "o", "after"),
            ],
        )];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

        assert!(parsed.events.iter().all(|event| event.kind != "r"));
        // Max dims 100x30 still fit the pinned 120x30 canvas.
        assert_eq!(parsed.width, 120);
        assert_eq!(parsed.height, 30);

        // The resize repaint clears the canvas and re-centers: the new
        // padding is ((120 - 100) / 2, (30 - 30) / 2) = (10, 0).
        let resize_event = parsed
            .events
            .iter()
            .find(|event| event.time_s == 1.0)
            .expect("resize repaint should exist");
        assert!(resize_event.payload.contains("\u{1b}[2J"));
        assert!(resize_event.payload.contains("\u{1b}[1;11H"));

        let vt = replay_composed(&combined)?;
        let row = vt.line(0).text();
        assert_eq!(row.trim(), "beforeafter");
        assert_eq!(row.len() - row.trim_start().len(), 10);

        Ok(())
    }

    #[test]
    fn composed_cast_skips_no_op_repaints() -> Result<()> {
        let sessions = vec![session(
            80,
            24,
            vec![
                event(0.0, "o", "stable"),
                // Rewrites the same content: rows go dirty but nothing
                // visible changes and the cursor returns to the same spot.
                event(1.0, "o", "\r"),
                event(1.5, "o", "stable"),
            ],
        )];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

        let repaints: Vec<_> = parsed
            .events
            .iter()
            .filter(|event| event.payload.contains("stable"))
            .collect();
        assert_eq!(repaints.len(), 1, "identical content must not repaint");

        Ok(())
    }

    #[test]
    fn divider_is_centered_on_the_canvas() {
        let slide = render_divider(120, 30, 2, 3);
        assert!(slide.contains("Session 2 of 3"));
        // Row 15 of 30; "Session 2 of 3" is 14 chars -> column (120-14)/2 = 53.
        assert!(slide.contains("\u{1b}[15;53H"));
        assert!(slide.starts_with("\u{1b}[?25l\u{1b}[0m\u{1b}[2J\u{1b}[H"));
    }

    #[test]
    fn oversized_sessions_grow_the_canvas() -> Result<()> {
        let sessions = vec![session(200, 60, vec![event(0.0, "o", "hello")])];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

        // The smallest 4:1 canvas containing 200x60 is 240x60 — the player
        // shrinks the font instead of the compositor cropping content.
        assert_eq!(parsed.width, 240);
        assert_eq!(parsed.height, 60);

        let vt = replay_composed(&combined)?;
        let row = vt.line(0).text();
        assert_eq!(row.trim(), "hello");
        assert_eq!(row.len() - row.trim_start().len(), (240 - 200) / 2);

        Ok(())
    }

    #[test]
    fn input_and_marker_events_pass_through() -> Result<()> {
        let sessions = vec![session(
            80,
            24,
            vec![
                event(0.0, "i", "ls\r"),
                event(0.5, "o", "listing"),
                event(1.0, "m", "checkpoint"),
            ],
        )];
        let combined = compose_sessions(&sessions)?;
        let parsed = parse_cast(&combined)?;

        assert!(
            parsed
                .events
                .iter()
                .any(|event| event.kind == "i" && event.payload == "ls\r")
        );
        assert!(
            parsed
                .events
                .iter()
                .any(|event| event.kind == "m" && event.payload == "checkpoint")
        );

        Ok(())
    }
}
