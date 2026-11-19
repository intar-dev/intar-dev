//! A machine's terminal in the window (#402): it draws the emulator's grid
//! and passes on what is typed. The session behind it is `terminal.rs`.
//
// ponytail: no input method support (composed characters arrive only as the
// platform hands them over as typed text), and no mouse reporting to the
// guest; add them when a learner misses them.

use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use gpui::prelude::*;
use gpui::{
    App, Bounds, ClipboardItem, Context, FocusHandle, Focusable, FontWeight, KeyDownEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, ScrollWheelEvent,
    SharedString, TextAlign, TextRun, Window, canvas, div, fill, font, outline, point, px, rgb,
    size,
};
use tokio::sync::mpsc::UnboundedReceiver;

use super::theme::{MONO, term};
use crate::terminal::{Replies, Size, Terminal, encode_key};

const FONT_SIZE: f32 = 14.;
const LINE_HEIGHT: f32 = 22.;
/// Room between the panel's edge and the grid.
const PAD: f32 = 14.;

/// The sixteen colours programs name, dark and bright.
const ANSI: [u32; 16] = [
    0x26292e, 0xf97772, 0x62d397, 0xefc469, 0x81bcf3, 0xc9a0f5, 0x6fd3d8, 0xdfe1e6, 0x91959d,
    0xff9892, 0x86e4b0, 0xf6d88f, 0xa6d0f8, 0xdcbdfa, 0x98e2e6, 0xffffff,
];
const SELECTION: u32 = 0x3a4250;

fn indexed(index: u8) -> u32 {
    match index {
        0..=15 => ANSI[usize::from(index)],
        // The 6×6×6 colour cube, then 24 greys.
        16..=231 => {
            let cube = u32::from(index) - 16;
            let level = |step: u32| if step == 0 { 0 } else { 55 + step * 40 };
            (level(cube / 36) << 16) | (level(cube / 6 % 6) << 8) | level(cube % 6)
        }
        _ => {
            let grey = 8 + (u32::from(index) - 232) * 10;
            (grey << 16) | (grey << 8) | grey
        }
    }
}

fn named(name: NamedColor) -> u32 {
    match name {
        NamedColor::Background => term::BG,
        NamedColor::Foreground | NamedColor::BrightForeground | NamedColor::Cursor => term::TEXT,
        NamedColor::DimForeground => term::MUTED,
        // Dim colours are drawn as their plain ones, dimmed by the cell's flag.
        NamedColor::DimBlack => ANSI[0],
        NamedColor::DimRed => ANSI[1],
        NamedColor::DimGreen => ANSI[2],
        NamedColor::DimYellow => ANSI[3],
        NamedColor::DimBlue => ANSI[4],
        NamedColor::DimMagenta => ANSI[5],
        NamedColor::DimCyan => ANSI[6],
        NamedColor::DimWhite => ANSI[7],
        plain => ANSI[plain as usize % 16],
    }
}

/// Halfway to the background: how dim text is drawn.
fn dimmed(colour: u32) -> u32 {
    let mix = |shift: u32| ((colour >> shift & 0xff) + (term::BG >> shift & 0xff)) / 2;
    (mix(16) << 16) | (mix(8) << 8) | mix(0)
}

/// One cell as it is painted.
#[derive(Clone, PartialEq)]
struct Cell {
    column: usize,
    text: char,
    fg: u32,
    /// `None` is the terminal's own background.
    bg: Option<u32>,
    bold: bool,
    underline: bool,
}

struct Frame {
    rows: Vec<Vec<Cell>>,
    /// Row and column of the cursor, when it is on screen and shown.
    cursor: Option<(usize, usize)>,
}

/// What is on screen, with colours resolved and the selection marked.
fn frame(grid: &Term<Replies>) -> Frame {
    let content = grid.renderable_content();
    let offset = i32::try_from(content.display_offset).unwrap_or(i32::MAX);
    let resolve = |colour: Color| match colour {
        Color::Spec(rgb) => (u32::from(rgb.r) << 16) | (u32::from(rgb.g) << 8) | u32::from(rgb.b),
        Color::Indexed(index) => content.colors[usize::from(index)].map_or_else(
            || indexed(index),
            |rgb| (u32::from(rgb.r) << 16) | (u32::from(rgb.g) << 8) | u32::from(rgb.b),
        ),
        Color::Named(name) => content.colors[name as usize].map_or_else(
            || named(name),
            |rgb| (u32::from(rgb.r) << 16) | (u32::from(rgb.g) << 8) | u32::from(rgb.b),
        ),
    };
    let mut rows = vec![Vec::new(); grid.screen_lines()];
    for cell in content.display_iter {
        let Some(row) = usize::try_from(cell.point.line.0 + offset)
            .ok()
            .and_then(|row| rows.get_mut(row))
        else {
            continue;
        };
        let flags = cell.flags;
        if flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            continue;
        }
        let (mut fg, mut bg) = (resolve(cell.fg), resolve(cell.bg));
        if flags.contains(Flags::INVERSE) {
            std::mem::swap(&mut fg, &mut bg);
        }
        if flags.contains(Flags::DIM) {
            fg = dimmed(fg);
        }
        let selected = content
            .selection
            .is_some_and(|range| range.contains(cell.point));
        let bg = if selected {
            Some(SELECTION)
        } else {
            (bg != term::BG).then_some(bg)
        };
        let text = if cell.c == '\0' || flags.contains(Flags::HIDDEN) {
            ' '
        } else {
            cell.c
        };
        // Blank cells of the plain background need no paint at all.
        if text == ' ' && bg.is_none() && !flags.intersects(Flags::ALL_UNDERLINES) {
            continue;
        }
        row.push(Cell {
            column: cell.point.column.0,
            text,
            fg,
            bg,
            bold: flags.contains(Flags::BOLD),
            underline: flags.intersects(Flags::ALL_UNDERLINES),
        });
    }
    let cursor = content
        .mode
        .contains(TermMode::SHOW_CURSOR)
        .then(|| {
            let row = usize::try_from(content.cursor.point.line.0 + offset).ok()?;
            (row < rows.len()).then_some((row, content.cursor.point.column.0))
        })
        .flatten();
    Frame { rows, cursor }
}

pub struct TerminalView {
    terminal: Terminal,
    focus: FocusHandle,
    /// Where the grid starts in the window and how large a cell is, from the
    /// last paint; the mouse needs both.
    origin: Point<Pixels>,
    cell_width: Pixels,
    selecting: bool,
}

impl TerminalView {
    pub fn new(
        terminal: Terminal,
        mut changes: UnboundedReceiver<()>,
        cx: &mut Context<Self>,
    ) -> Self {
        // Redraw when the session changed the grid; a burst of output is one redraw.
        cx.spawn(async move |this, cx| {
            while changes.recv().await.is_some() {
                while changes.try_recv().is_ok() {}
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            terminal,
            focus: cx.focus_handle(),
            origin: Point::default(),
            cell_width: px(8.),
            selecting: false,
        }
    }

    pub fn machine(&self) -> &str {
        &self.terminal.machine
    }

    fn key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let (key, held) = (&event.keystroke, event.keystroke.modifiers);
        let paste = key.key == "v" && (held.platform || held.control && held.shift);
        let copy = key.key == "c" && (held.platform || held.control && held.shift);
        if paste {
            self.paste(cx);
        } else if copy {
            if let Some(text) = self.terminal.grid.lock().selection_to_string() {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
            }
        } else if held.shift && matches!(key.key.as_str(), "pageup" | "pagedown") {
            self.terminal
                .grid
                .lock()
                .scroll_display(if key.key == "pageup" {
                    Scroll::PageUp
                } else {
                    Scroll::PageDown
                });
        } else {
            let mut grid = self.terminal.grid.lock();
            let Some(bytes) = encode_key(
                &key.key,
                key.key_char.as_deref(),
                held.control,
                held.alt,
                held.shift,
                held.platform,
                grid.mode().contains(TermMode::APP_CURSOR),
            ) else {
                return;
            };
            // Typing looks at the prompt again and lets go of a selection.
            grid.scroll_display(Scroll::Bottom);
            grid.selection = None;
            drop(grid);
            self.terminal.write(bytes);
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn paste(&self, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            return;
        };
        let bracketed = self
            .terminal
            .grid
            .lock()
            .mode()
            .contains(TermMode::BRACKETED_PASTE);
        let bytes = if bracketed {
            // The end marker inside the text would end the paste early.
            format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', ""))
        } else {
            text.replace("\r\n", "\r").replace('\n', "\r")
        };
        self.terminal.write(bytes.into_bytes());
    }

    fn scroll(&mut self, event: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
        let moved = f32::from(event.delta.pixel_delta(px(LINE_HEIGHT)).y) / LINE_HEIGHT;
        let lines = moved.round() as i32;
        if lines == 0 {
            return;
        }
        let mut grid = self.terminal.grid.lock();
        if grid.mode().contains(TermMode::ALT_SCREEN) {
            // A full-screen program has no scrollback; it gets arrow keys, as
            // terminals do for pagers and editors.
            let app_cursor = grid.mode().contains(TermMode::APP_CURSOR);
            drop(grid);
            let arrow = if lines > 0 { "up" } else { "down" };
            if let Some(bytes) = encode_key(arrow, None, false, false, false, false, app_cursor) {
                self.terminal
                    .write(bytes.repeat(lines.unsigned_abs() as usize));
            }
        } else {
            grid.scroll_display(Scroll::Delta(lines));
        }
        cx.notify();
    }

    /// The grid cell under a window position, and which half of it.
    fn cell_at(&self, position: Point<Pixels>) -> (GridPoint, Side) {
        let grid = self.terminal.grid.lock();
        let across = (f32::from(position.x - self.origin.x) / f32::from(self.cell_width)).max(0.);
        let down = (f32::from(position.y - self.origin.y) / LINE_HEIGHT).max(0.);
        let column = (across as usize).min(grid.columns().saturating_sub(1));
        let row = (down as usize).min(grid.screen_lines().saturating_sub(1));
        let offset = i32::try_from(grid.grid().display_offset()).unwrap_or(i32::MAX);
        let line = i32::try_from(row).unwrap_or(i32::MAX) - offset;
        let side = if across.fract() < 0.5 {
            Side::Left
        } else {
            Side::Right
        };
        (GridPoint::new(Line(line), Column(column)), side)
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let (at, side) = self.cell_at(event.position);
        let kind = match event.click_count {
            2 => SelectionType::Semantic,
            3 => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        self.terminal.grid.lock().selection = Some(Selection::new(kind, at, side));
        self.selecting = true;
        cx.notify();
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selecting {
            return;
        }
        let (at, side) = self.cell_at(event.position);
        if let Some(selection) = self.terminal.grid.lock().selection.as_mut() {
            selection.update(at, side);
        }
        cx.notify();
    }

    fn mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.selecting = false;
        // A click without a drag selects nothing.
        let mut grid = self.terminal.grid.lock();
        if grid.selection.as_ref().is_some_and(Selection::is_empty) {
            grid.selection = None;
        }
        cx.notify();
    }
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Paints one frame into `bounds` and fits the grid to it.
fn paint(
    terminal: &Terminal,
    focused: bool,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Pixels {
    let mono = font(MONO);
    let run = |len: usize, colour: u32, bold: bool, underline: bool| TextRun {
        len,
        font: if bold {
            mono.clone().bold()
        } else {
            mono.clone()
        },
        color: rgb(colour).into(),
        background_color: None,
        underline: underline.then(|| gpui::UnderlineStyle {
            thickness: px(1.),
            color: None,
            wavy: false,
        }),
        strikethrough: None,
    };
    let shape = |text: String, runs: &[TextRun], window: &mut Window| {
        window
            .text_system()
            .shape_line(SharedString::from(text), px(FONT_SIZE), runs, None)
    };
    let cell_width = shape("M".into(), &[run(1, term::TEXT, false, false)], window).x_for_index(1);

    // As many cells as fit; the guest hears of a change.
    let fit = |length: Pixels, cell: f32| ((f32::from(length) / cell) as usize).max(2);
    terminal.resize(Size {
        columns: fit(bounds.size.width, f32::from(cell_width)),
        rows: fit(bounds.size.height, LINE_HEIGHT),
    });

    let frame = frame(&terminal.grid.lock());
    let at = |row: usize, column: usize| {
        bounds.origin + point(cell_width * column as f32, px(LINE_HEIGHT * row as f32))
    };
    let cell_size = size(cell_width, px(LINE_HEIGHT));
    for (row, cells) in frame.rows.iter().enumerate() {
        for cell in cells {
            if let Some(bg) = cell.bg {
                // A wide character's background covers both of its cells.
                let wide = if cell.text.is_ascii() { 1. } else { 2. };
                let area = size(cell_width * wide, px(LINE_HEIGHT));
                window.paint_quad(fill(Bounds::new(at(row, cell.column), area), rgb(bg)));
            }
        }
        // Plain ASCII of one style is shaped as a run; anything else is placed
        // cell by cell, so wide and fallback glyphs cannot shift what follows.
        let mut index = 0;
        while let Some(first) = cells.get(index) {
            let mut text = String::from(first.text);
            let mut next = index + 1;
            while let Some(cell) = cells.get(next).filter(|cell| {
                first.text.is_ascii()
                    && cell.text.is_ascii()
                    && cell.column == first.column + (next - index)
                    && (cell.fg, cell.bold, cell.underline)
                        == (first.fg, first.bold, first.underline)
            }) {
                text.push(cell.text);
                next += 1;
            }
            if !text.trim().is_empty() || first.underline {
                let runs = [run(text.len(), first.fg, first.bold, first.underline)];
                let line = shape(text, &runs, window);
                let _ = line.paint(
                    at(row, first.column),
                    px(LINE_HEIGHT),
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
            index = next;
        }
    }
    if let Some((row, column)) = frame.cursor {
        let area = Bounds::new(at(row, column), cell_size);
        if focused {
            window.paint_quad(fill(area, rgb(term::TEXT)));
            // The character under a filled cursor is drawn in the background's colour.
            if let Some(cell) = frame.rows[row].iter().find(|cell| cell.column == column) {
                let runs = [run(cell.text.len_utf8(), term::BG, cell.bold, false)];
                let line = shape(cell.text.to_string(), &runs, window);
                let _ = line.paint(
                    area.origin,
                    px(LINE_HEIGHT),
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
        } else {
            window.paint_quad(outline(
                area,
                rgb(term::MUTED),
                gpui::BorderStyle::default(),
            ));
        }
    }
    cell_width
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let terminal = self.terminal.clone();
        let focused = self.focus.is_focused(window);
        let view = cx.entity();
        div()
            .size_full()
            .p(px(PAD))
            .track_focus(&self.focus)
            .cursor_text()
            .font_weight(FontWeight::NORMAL)
            .on_key_down(cx.listener(Self::key))
            .on_scroll_wheel(cx.listener(Self::scroll))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
            .on_mouse_move(cx.listener(Self::mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::mouse_up))
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, (), window, cx| {
                        let cell_width = paint(&terminal, focused, bounds, window, cx);
                        view.update(cx, |view, _| {
                            view.origin = bounds.origin;
                            view.cell_width = cell_width;
                        });
                    },
                )
                .size_full(),
            )
    }
}
