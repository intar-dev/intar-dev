//! Plays a run's recorded terminal sessions (asciicast) in the recap, as the
//! website's replay does (`RunArtifactViewerReplay.tsx`): the recorded
//! geometry, idle gaps capped, check markers on the track, 1x/2x/4x.
//
// ponytail: the clock counts ticks, so a stalled main thread plays slower
// rather than skipping; seeking back re-feeds from the start, fine for the
// capped sizes `Subspace::replay` allows.

use std::time::Duration;

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use gpui::prelude::*;
use gpui::{
    Bounds, Context, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Task,
    Window, canvas, div, px, relative, rgb,
};
use serde_json::Value;

use super::kit::{self, Kind, Size as ButtonSize};
use super::terminal_view::{FONT_SIZE, LINE_HEIGHT, cell_width, frame, paint_frame};
use super::theme::{MONO, palette, term};
use crate::terminal::Size;

/// Idle gaps longer than this play as this long, as the website's
/// `REPLAY_IDLE_TIME_LIMIT_SECONDS`. New casts are clamped already.
const IDLE_TIME_LIMIT: f64 = 1.5;
/// How often a playing replay moves on.
const TICK: Duration = Duration::from_millis(33);
const SPEEDS: [f64; 3] = [1., 2., 4.];

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Output(String),
    Resize(Size),
    /// A check that first passed here (its probe id).
    Marker(String),
}

#[derive(Debug, PartialEq)]
pub struct Cast {
    pub width: usize,
    pub height: usize,
    /// Seconds from the start on the idle-capped timeline, in order.
    pub events: Vec<(f64, Event)>,
}

impl Cast {
    pub fn duration(&self) -> f64 {
        self.events.last().map_or(0., |(at, _)| *at)
    }
}

/// Reads an asciicast v2 (absolute times) or v3 (intervals). A line that is
/// not JSON fails the whole cast, as the website's player does; event kinds
/// the replay does not draw (`i`, unknown ones) are skipped.
pub fn parse(bytes: &[u8]) -> Result<Cast, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "The replay is not text.".to_owned())?;
    // v3 allows comment lines.
    let mut lines = text
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'));
    let header: Value = lines
        .next()
        .and_then(|line| serde_json::from_str(line).ok())
        .ok_or("The replay has no header.")?;
    let cells = |value: &Value| {
        value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0)
    };
    let (version, width, height) = match header["version"].as_u64() {
        Some(2) => (2, cells(&header["width"]), cells(&header["height"])),
        Some(3) => (
            3,
            cells(&header["term"]["cols"]),
            cells(&header["term"]["rows"]),
        ),
        _ => return Err("The replay's format is not one the app knows.".to_owned()),
    };
    let (Some(width), Some(height)) = (width, height) else {
        return Err("The replay does not say how large its terminal was.".to_owned());
    };

    let mut events = Vec::new();
    let (mut raw, mut at) = (0_f64, 0_f64);
    for (number, line) in lines.enumerate() {
        let bad = || format!("Line {} of the replay is damaged.", number + 2);
        let Ok(Value::Array(fields)) = serde_json::from_str::<Value>(line) else {
            return Err(bad());
        };
        let [time, Value::String(code), Value::String(data)] = &fields[..] else {
            return Err(bad());
        };
        let time = time.as_f64().filter(|t| t.is_finite()).ok_or_else(bad)?;
        let next = if version == 3 { raw + time } else { time };
        at += (next - raw).clamp(0., IDLE_TIME_LIMIT);
        raw = raw.max(next);
        let event = match code.as_str() {
            "o" => Event::Output(data.clone()),
            "m" => Event::Marker(data.clone()),
            "r" => {
                let size = data.split_once('x').and_then(|(columns, rows)| {
                    Some(Size {
                        columns: columns.parse().ok().filter(|n| *n > 0)?,
                        rows: rows.parse().ok().filter(|n| *n > 0)?,
                    })
                });
                match size {
                    Some(size) => Event::Resize(size),
                    None => continue,
                }
            }
            _ => continue,
        };
        events.push((at, event));
    }
    Ok(Cast {
        width,
        height,
        events,
    })
}

/// A cast and the screen at one point in it.
struct Player {
    cast: Cast,
    term: Term<VoidListener>,
    parser: Processor<StdSyncHandler>,
    /// The next event to feed.
    next: usize,
    at: f64,
}

impl Player {
    fn new(cast: Cast) -> Self {
        let size = Size {
            columns: cast.width,
            rows: cast.height,
        };
        Self {
            term: Term::new(Config::default(), &size, VoidListener),
            parser: Processor::new(),
            next: 0,
            at: 0.,
            cast,
        }
    }

    /// Shows the screen as it was `at` seconds in.
    fn seek(&mut self, at: f64) {
        let at = at.clamp(0., self.cast.duration());
        if at < self.at {
            let cast = std::mem::replace(
                &mut self.cast,
                Cast {
                    width: 0,
                    height: 0,
                    events: Vec::new(),
                },
            );
            *self = Self::new(cast);
        }
        while let Some((time, event)) = self.cast.events.get(self.next) {
            if *time > at {
                break;
            }
            match event {
                Event::Output(data) => self.parser.advance(&mut self.term, data.as_bytes()),
                Event::Resize(size) => self.term.resize(*size),
                Event::Marker(_) => {}
            }
            self.next += 1;
        }
        self.at = at;
    }

    fn ended(&self) -> bool {
        self.at >= self.cast.duration()
    }
}

/// `m:ss`, as the website's `formatReplayClock`.
fn clock(seconds: f64) -> String {
    let whole = seconds.max(0.) as u64;
    format!("{}:{:02}", whole / 60, whole % 60)
}

/// One replay part's recording, ready to play.
pub struct ReplayView {
    player: Result<Player, String>,
    speed: usize,
    /// Moves a playing replay on; dropping it pauses.
    ticker: Option<Task<()>>,
    /// The scrub track in the window, from the last paint.
    track: Bounds<Pixels>,
    scrubbing: bool,
}

impl ReplayView {
    /// `cast` is the asciicast as `Subspace::replay` returns it.
    pub fn new(cast: Vec<u8>, _cx: &mut Context<Self>) -> Self {
        Self {
            player: parse(&cast).map(Player::new),
            speed: 0,
            ticker: None,
            track: Bounds::default(),
            scrubbing: false,
        }
    }

    pub fn playing(&self) -> bool {
        self.ticker.is_some()
    }

    /// Seconds into the replay.
    #[cfg(test)]
    pub fn position(&self) -> f64 {
        self.player.as_ref().map_or(0., |player| player.at)
    }

    pub fn play(&mut self, cx: &mut Context<Self>) {
        let Ok(player) = &mut self.player else {
            return;
        };
        if player.ended() {
            player.seek(0.);
        }
        self.ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                if !matches!(this.update(cx, |view, cx| view.tick(cx)), Ok(true)) {
                    break;
                }
            }
        }));
        cx.notify();
    }

    pub fn pause(&mut self, cx: &mut Context<Self>) {
        self.ticker = None;
        cx.notify();
    }

    /// Moves on one tick; false once the replay ended.
    fn tick(&mut self, cx: &mut Context<Self>) -> bool {
        let Ok(player) = &mut self.player else {
            return false;
        };
        player.seek(player.at + TICK.as_secs_f64() * SPEEDS[self.speed]);
        cx.notify();
        if player.ended() {
            // The task ends itself; dropping it from inside would cancel it mid-poll.
            if let Some(ticker) = self.ticker.take() {
                ticker.detach();
            }
            return false;
        }
        true
    }

    pub fn seek(&mut self, at: f64, cx: &mut Context<Self>) {
        if let Ok(player) = &mut self.player {
            player.seek(at);
            cx.notify();
        }
    }

    fn scrub_to(&mut self, x: Pixels, cx: &mut Context<Self>) {
        let Ok(player) = &self.player else {
            return;
        };
        let width = f32::from(self.track.size.width);
        if width <= 0. {
            return;
        }
        let fraction = (f32::from(x - self.track.origin.x) / width).clamp(0., 1.);
        let at = f64::from(fraction) * player.cast.duration();
        self.seek(at, cx);
    }

    fn scrub_down(&mut self, event: &MouseDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.scrubbing = true;
        self.scrub_to(event.position.x, cx);
    }

    fn scrub_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.scrubbing {
            self.scrub_to(event.position.x, cx);
        }
    }

    fn scrub_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.scrubbing = false;
    }
}

impl Render for ReplayView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = palette(cx);
        let player = match &self.player {
            Ok(player) => player,
            Err(message) => return div().child(kit::failure(p, message.clone())),
        };
        let duration = player.cast.duration();
        let (columns, rows) = (player.term.columns(), player.term.screen_lines());
        let shown = frame(&player.term);
        let fraction = if duration > 0. {
            (player.at / duration) as f32
        } else {
            0.
        };
        let markers: Vec<f32> = player
            .cast
            .events
            .iter()
            .filter(|(_, event)| matches!(event, Event::Marker(_)))
            .map(|(at, _)| {
                if duration > 0. {
                    (at / duration) as f32
                } else {
                    0.
                }
            })
            .collect();
        let view = cx.entity();

        let screen = div()
            .flex_1()
            .min_h_0()
            .p(px(14.))
            .rounded_lg()
            .bg(rgb(term::BG))
            .overflow_hidden()
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, (), window, cx| {
                        // The recorded geometry, shrunk to fit; never enlarged.
                        let cell = f32::from(cell_width(FONT_SIZE, window));
                        let scale = (f32::from(bounds.size.width) / (cell * columns as f32))
                            .min(f32::from(bounds.size.height) / (LINE_HEIGHT * rows as f32))
                            .min(1.);
                        paint_frame(&shown, FONT_SIZE * scale, true, bounds.origin, window, cx);
                    },
                )
                .size_full(),
            );

        let (play_id, play_label) = if self.playing() {
            ("replay-pause", "Pause")
        } else {
            ("replay-play", "Play")
        };
        let speed_label = ["1x", "2x", "4x"][self.speed];
        let track = div()
            .id("replay-track")
            .flex_1()
            .h(px(20.))
            .relative()
            .flex()
            .items_center()
            .cursor_pointer()
            .on_mouse_down(MouseButton::Left, cx.listener(Self::scrub_down))
            .on_mouse_move(cx.listener(Self::scrub_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::scrub_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::scrub_up))
            .child(
                canvas(
                    move |bounds, _, cx| view.update(cx, |view, _| view.track = bounds),
                    |_, (), _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(
                div()
                    .w_full()
                    .h(px(4.))
                    .rounded_full()
                    .bg(rgb(p.track))
                    .child(
                        div()
                            .h_full()
                            .w(relative(fraction))
                            .rounded_full()
                            .bg(rgb(p.accent)),
                    ),
            )
            .children(markers.into_iter().map(|at| {
                div()
                    .absolute()
                    .left(relative(at))
                    .w(px(3.))
                    .h(px(12.))
                    .rounded_full()
                    .bg(rgb(p.green))
            }));

        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_3()
            .child(screen)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        kit::button(
                            p,
                            play_id,
                            Kind::Primary,
                            ButtonSize::Small,
                            None,
                            play_label,
                            None,
                        )
                        .on_click(cx.listener(|view, _, _, cx| {
                            if view.playing() {
                                view.pause(cx);
                            } else {
                                view.play(cx);
                            }
                        })),
                    )
                    .child(
                        kit::button(
                            p,
                            "replay-restart",
                            Kind::Outline,
                            ButtonSize::Small,
                            None,
                            "Restart",
                            None,
                        )
                        .on_click(cx.listener(|view, _, _, cx| view.seek(0., cx))),
                    )
                    .child(
                        kit::button(
                            p,
                            "replay-speed",
                            Kind::Outline,
                            ButtonSize::Small,
                            None,
                            speed_label,
                            None,
                        )
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.speed = (view.speed + 1) % SPEEDS.len();
                            cx.notify();
                        })),
                    )
                    .child(track)
                    .child(
                        div()
                            .flex_none()
                            .font_family(MONO)
                            .text_size(px(13.))
                            .text_color(rgb(p.muted))
                            .child(format!("{} / {}", clock(player.at), clock(duration))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use gpui::{Modifiers, TestAppContext};

    use super::*;

    const V3: &str = concat!(
        r#"{"version":3,"term":{"cols":20,"rows":3},"timestamp":1}"#,
        "\n",
        r#"[0.5,"o","one\r\n"]"#,
        "\n",
        r#"[0.25,"i","x"]"#,
        "\n",
        r#"[10,"o","two\r\n"]"#,
        "\n",
        r#"[0.25,"m","web-serves"]"#,
        "\n",
        r#"[0.25,"r","30x4"]"#,
        "\n",
    );

    /// The screen's text, lines trimmed, as `terminal.rs`'s tests read it.
    fn text(term: &Term<VoidListener>) -> String {
        let mut lines = vec![String::new(); term.screen_lines()];
        for cell in term.renderable_content().display_iter {
            if let Some(line) = usize::try_from(cell.point.line.0)
                .ok()
                .and_then(|line| lines.get_mut(line))
            {
                line.push(cell.c);
            }
        }
        lines
            .iter()
            .map(|line| line.trim_end())
            .collect::<Vec<_>>()
            .join("\n")
            .trim_end()
            .to_owned()
    }

    #[test]
    fn v3_intervals_add_up_with_idle_gaps_capped() {
        let cast = parse(V3.as_bytes()).expect("cast");
        assert_eq!((cast.width, cast.height), (20, 3));
        // The input is skipped but its time counts; the 10 s gap plays as 1.5 s.
        assert_eq!(
            cast.events,
            vec![
                (0.5, Event::Output("one\r\n".into())),
                (2.25, Event::Output("two\r\n".into())),
                (2.5, Event::Marker("web-serves".into())),
                (
                    2.75,
                    Event::Resize(Size {
                        columns: 30,
                        rows: 4
                    })
                ),
            ]
        );
        assert_eq!(cast.duration(), 2.75);
    }

    #[test]
    fn v2_times_are_absolute() {
        let cast = parse(
            b"{\"version\":2,\"width\":80,\"height\":24}\n[1.0,\"o\",\"a\"]\n[1.5,\"o\",\"b\"]\n[9.0,\"o\",\"c\"]\n",
        )
        .expect("cast");
        assert_eq!((cast.width, cast.height), (80, 24));
        let times: Vec<f64> = cast.events.iter().map(|(at, _)| *at).collect();
        assert_eq!(times, vec![1.0, 1.5, 3.0]);
    }

    #[test]
    fn damaged_casts_are_refused() {
        assert!(parse(b"").is_err());
        assert!(parse(b"{\"version\":1,\"width\":80,\"height\":24}\n").is_err());
        assert!(parse(b"{\"version\":3,\"term\":{}}\n").is_err());
        let truncated = format!("{V3}[0.1,\"o\",\"cut");
        assert_eq!(
            parse(truncated.as_bytes()),
            Err("Line 7 of the replay is damaged.".to_owned())
        );
        // Comments and blank lines are not events; unknown kinds are skipped.
        let fine = format!("{V3}\n# note\n[0.1,\"x\",\"?\"]\n");
        assert_eq!(parse(fine.as_bytes()).map(|cast| cast.events.len()), Ok(4));
    }

    #[test]
    fn seeking_shows_the_screen_at_that_time_and_back() {
        let mut player = Player::new(parse(V3.as_bytes()).expect("cast"));
        player.seek(1.);
        assert_eq!(text(&player.term), "one");
        player.seek(2.6);
        assert_eq!(text(&player.term), "one\ntwo");
        assert_eq!(player.term.columns(), 20);
        player.seek(10.);
        assert!(player.ended());
        assert_eq!((player.term.columns(), player.term.screen_lines()), (30, 4));
        // Back to before the first output: a fresh screen.
        player.seek(0.2);
        assert_eq!(text(&player.term), "");
        assert_eq!(player.term.columns(), 20);
    }

    #[gpui::test]
    fn play_and_pause_move_the_replay(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(|_, cx| ReplayView::new(V3.as_bytes().to_vec(), cx));
        let click = |cx: &mut gpui::VisualTestContext, selector: &'static str| {
            let bounds = cx
                .debug_bounds(selector)
                .unwrap_or_else(|| panic!("{selector} is not on screen"));
            cx.simulate_click(bounds.center(), Modifiers::none());
            cx.run_until_parked();
        };
        click(cx, "replay-play");
        assert!(view.read_with(cx, |view, _| view.playing()));
        cx.executor().advance_clock(Duration::from_secs(1));
        cx.run_until_parked();
        let paused_at = view.read_with(cx, |view, _| view.position());
        assert!(paused_at > 0.5 && paused_at < 1.5, "{paused_at}");

        click(cx, "replay-pause");
        cx.executor().advance_clock(Duration::from_secs(1));
        cx.run_until_parked();
        assert!(!view.read_with(cx, |view, _| view.playing()));
        assert_eq!(view.read_with(cx, |view, _| view.position()), paused_at);

        // 4x plays out to the end, where the replay stops by itself.
        click(cx, "replay-speed");
        click(cx, "replay-speed");
        click(cx, "replay-play");
        cx.executor().advance_clock(Duration::from_secs(2));
        cx.run_until_parked();
        assert!(!view.read_with(cx, |view, _| view.playing()));
        assert_eq!(view.read_with(cx, |view, _| view.position()), 2.75);

        click(cx, "replay-restart");
        assert_eq!(view.read_with(cx, |view, _| view.position()), 0.);
    }
}
