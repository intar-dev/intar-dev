//! The intar desktop app (#391, #401): sign-in, the learner's courses, and a
//! run on this computer. The screens follow the app's design.

mod engine;
mod local;
mod pull;
mod qemu;
mod secrets;
mod state;
mod terminal;
mod ui;
mod update;

use gpui::prelude::*;
use gpui::{
    App, Bounds, ClickEvent, ClipboardItem, Context, Div, Entity, Focusable, FontWeight,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, SharedString, Stateful,
    Subscription, TitlebarOptions, Window, WindowBounds, WindowOptions, div, point, px, relative,
    rgb, size,
};
use gpui_platform::application;
use state::{Command, Event, History, Learn, MachineStatus, Screen, State};
use subspace::contract::{CatalogCourseV1, CatalogLectureV1, LocalRunV1};
use tokio::sync::mpsc::UnboundedSender;
use ui::kit::{self, Kind, Size};
use ui::markdown::markdown;
use ui::replay::ReplayView;
use ui::terminal_view::TerminalView;
use ui::text_input::TextInput;
use ui::theme::{self, MONO, Palette, palette, term};
use url::Url;

/// The window's title bar is the app's own on macOS; elsewhere the system draws one.
const OWN_TITLE_BAR: bool = cfg!(target_os = "macos");
/// How often a recap that is still being saved is asked again.
const RECAP_POLL: std::time::Duration = std::time::Duration::from_secs(3);

struct Jumper {
    state: State,
    commands: UnboundedSender<Command>,
    /// The website, for a run that is not on this computer.
    base: Url,
    /// The runs page's scenarios whose older attempts are shown.
    expanded: std::collections::HashSet<String>,
    /// The player of the replay part chosen on the recap, by its recording's id.
    replay: Option<(String, Entity<ReplayView>)>,
    /// Narrows the lecture list to titles that contain it.
    search: Entity<TextInput>,
    /// The learner pressed End run and is asked whether they mean it.
    ending: bool,
    /// The learner asked for the full solution and is asked whether they mean it.
    confirm_solution: bool,
    /// The terminal of the run's machine, once its SSH is up.
    terminal: Option<Entity<TerminalView>>,
    /// The terminal just opened and has not been given the keyboard yet.
    focus_terminal: bool,
    /// The sign-in link was copied; the button says so until the next event.
    copied: bool,
    /// The left button went down on the title bar: a move now drags the window.
    moving: bool,
    _subscriptions: Vec<Subscription>,
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// "Easy scenario · ~15 min", from what the lecture says about its scenario.
fn lecture_facts(lecture: &CatalogLectureV1) -> String {
    let difficulty = lecture.difficulty.as_ref().map(|difficulty| {
        let mut letters = difficulty.chars();
        let first = letters.next().map(|c| c.to_uppercase().collect::<String>());
        format!("{}{} scenario", first.unwrap_or_default(), letters.as_str())
    });
    let minutes = lecture
        .estimated_minutes
        .map(|minutes| format!("~{minutes} min"));
    let none = lecture
        .scenario_id
        .is_none()
        .then(|| "No scenario".to_owned());
    [none, difficulty, minutes]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}

fn solved(course: &CatalogCourseV1) -> usize {
    course
        .lectures
        .iter()
        .filter(|lecture| lecture.state == "completed")
        .count()
}

/// "1.2 GB" or "340 MB".
fn megabytes(bytes: u64) -> String {
    let megabytes = bytes as f32 / (1024. * 1024.);
    if megabytes >= 1024. {
        format!("{:.1} GB", megabytes / 1024.)
    } else {
        format!("{megabytes:.0} MB")
    }
}

/// "2 CPUs · 2 GB memory".
fn machine_facts(machine: &subspace::contract::LocalRunMachineV1) -> String {
    let cpus = machine.cpu_millis as f32 / 1000.0;
    let memory = if machine.memory_mib >= 1024 {
        format!("{} GB", machine.memory_mib as f32 / 1024.0)
    } else {
        format!("{} MB", machine.memory_mib)
    };
    format!(
        "{cpus} {} · {memory} memory",
        if cpus == 1.0 { "CPU" } else { "CPUs" }
    )
}

impl Jumper {
    fn new(
        commands: UnboundedSender<Command>,
        base: Url,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search =
            cx.new(|cx| TextInput::new("Search lectures", false, 0, cx).with_icon("search"));
        let subscriptions = vec![
            cx.observe(&search, |_, _, cx| cx.notify()),
            cx.observe_window_appearance(window, |_, window, cx| theme::apply(window, cx)),
        ];
        theme::apply(window, cx);
        // The engine answers with the stored sign-in or with "signed out".
        let _ = commands.send(Command::Restore);
        let _ = commands.send(Command::CheckUpdate);
        Self {
            state: State::default(),
            commands,
            base,
            expanded: Default::default(),
            replay: None,
            search,
            ending: false,
            confirm_solution: false,
            terminal: None,
            focus_terminal: false,
            copied: false,
            moving: false,
            _subscriptions: subscriptions,
        }
    }

    fn send(&self, command: Command) {
        // The engine is gone only while the app is quitting.
        let _ = self.commands.send(command);
    }

    fn apply(&mut self, event: Event, cx: &mut Context<Self>) {
        let event = match event {
            // The terminal is a view of its own; it takes the keyboard when it opens.
            Event::Terminal(terminal, changes) => {
                self.terminal = Some(cx.new(|cx| TerminalView::new(terminal, changes, cx)));
                self.focus_terminal = true;
                cx.notify();
                return;
            }
            // The recording of the replay part on screen gets its player.
            Event::Replay {
                run_id,
                artifact_id,
                cast,
            } => {
                if self.state.playing(&run_id, &artifact_id) {
                    self.replay = Some((artifact_id, cx.new(|cx| ReplayView::new(cast, cx))));
                }
                self.state.error = None;
                cx.notify();
                return;
            }
            other => other,
        };
        if let Event::SignInStarted(url) = &event {
            cx.open_url(url);
        }
        // The new app is starting; this one makes room for it.
        if matches!(event, Event::Restart) {
            cx.quit();
            return;
        }
        self.copied = false;
        let recap = matches!(event, Event::Recap(_));
        if let Some(next) = self.state.apply(event) {
            self.send(next);
        }
        // A run still being saved has no recap yet: ask again while it is on screen.
        if let (true, Screen::Recap(run_id), Some(shown)) =
            (recap, &self.state.screen, &self.state.recap)
            && shown.kind == "saving"
        {
            let run_id = run_id.clone();
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(RECAP_POLL).await;
                let _ = this.update(cx, |this, _| {
                    if this.state.screen == Screen::Recap(run_id.clone()) {
                        this.send(Command::History(History::Recap { run_id }));
                    }
                });
            })
            .detach();
        }
        if !matches!(&self.state.screen, Screen::Run(run) if run.active) {
            self.ending = false;
            self.confirm_solution = false;
        }
        // The terminal belongs to a machine that runs; it goes with it. SSH
        // can be up while the lab is still preparing, so booting keeps it.
        if !matches!(
            self.state.machine,
            Some(MachineStatus::Booting | MachineStatus::Ready { .. })
        ) {
            self.terminal = None;
        }
        cx.notify();
    }

    /// Gives `element` its click; `act` may change the screen or ask the engine.
    fn on_click(
        element: Stateful<Div>,
        cx: &Context<Self>,
        act: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        element.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            act(this, cx);
            cx.notify();
        }))
    }

    /// `id` tells the title bar's button from the card's: two buttons with
    /// one id share their click, and only the first one drawn takes it.
    fn back_to_catalog(
        &self,
        p: &Palette,
        id: &'static str,
        kind: Kind,
        size: Size,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let button = kit::button(p, id, kind, size, None, "Back to catalog", None);
        Self::on_click(button, cx, |this, _| {
            let reload = this.state.back_to_catalog();
            this.send(reload);
        })
    }

    /// The run on screen, and its lecture's and course's titles when the catalog has them.
    fn run_titles(&self, run: &LocalRunV1) -> (SharedString, Option<SharedString>) {
        self.state
            .catalog
            .iter()
            .find_map(|course| {
                let lecture = course
                    .lectures
                    .iter()
                    .find(|lecture| lecture.scenario_id.as_deref() == Some(&run.scenario_id))?;
                Some((
                    lecture.title.clone().into(),
                    Some(course.title.clone().into()),
                ))
            })
            .unwrap_or_else(|| (run.scenario_id.clone().into(), None))
    }

    fn title_bar(&self, p: &Palette, cx: &Context<Self>) -> Stateful<Div> {
        let bar = div()
            .id("title-bar")
            // The app owns its title bar on macOS (`app_owns_titlebar_drag`), so
            // its buttons get the pointer; a press and a move here drag the
            // window, as Zed's title bar does, and a double-click does what the
            // system's title bar would.
            .when(OWN_TITLE_BAR, |bar| {
                bar.on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _: &MouseDownEvent, _, _| this.moving = true),
                )
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _: &MouseUpEvent, _, _| this.moving = false),
                )
                .on_mouse_down_out(
                    cx.listener(|this, _: &MouseDownEvent, _, _| this.moving = false),
                )
                .on_mouse_move(cx.listener(|this, _: &MouseMoveEvent, window, _| {
                    if std::mem::take(&mut this.moving) {
                        window.start_window_move();
                    }
                }))
                .on_click(|event, window, _| {
                    if event.click_count() == 2 {
                        window.titlebar_double_click();
                    }
                })
            })
            .h(px(46.))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(14.))
            // Room for the window's own buttons.
            .pl(px(if OWN_TITLE_BAR { 84. } else { 16. }))
            .pr(px(10.))
            .child(kit::logo());
        let wordmark = div()
            .text_size(px(15.))
            .font_weight(FontWeight::SEMIBOLD)
            .child("Intar");
        let fill = div().flex_1().min_w_0();
        // ponytail: "Connected" means the last call to intar worked; a live
        // connection state comes with the report outbox.
        let connected = self
            .state
            .error
            .is_none()
            .then(|| kit::status(p.green, "Connected").text_color(rgb(p.muted)));
        // Offered between runs only: an update restarts the app.
        let update = self.state.update.clone().map(|version| {
            let install = if self.state.updating {
                kit::inert_button(
                    p,
                    "update",
                    Kind::Outline,
                    Size::Small,
                    None,
                    "Updating…",
                    None,
                )
            } else {
                let install = kit::button(
                    p,
                    "update",
                    Kind::Outline,
                    Size::Small,
                    None,
                    "Update and restart",
                    None,
                );
                Self::on_click(install, cx, |this, _| {
                    this.state.updating = true;
                    this.send(Command::InstallUpdate);
                })
            };
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(10.))
                .child(kit::label(p, format!("Version {version} is available")))
                .child(install)
        });
        match &self.state.screen {
            Screen::Run(run) => {
                let (title, course) = self.run_titles(run);
                let (word, color) = match (&self.state.machine, run.active) {
                    (_, false) => ("Closed", p.muted),
                    (Some(MachineStatus::Saving), _) => ("Saving", p.brand_text),
                    (Some(MachineStatus::Failed(_)), _) => ("Could not start", p.red),
                    (Some(MachineStatus::Ready { passed, tasks }), _)
                        if tasks > &0 && passed == tasks =>
                    {
                        ("Solved", p.green)
                    }
                    (Some(MachineStatus::Ready { .. }), _) => ("Running", p.brand_text),
                    _ => ("Starting", p.brand_text),
                };
                let badge = div()
                    .h(px(22.))
                    .px_2()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(5.))
                    .rounded_md()
                    .border_1()
                    .border_color(rgb(p.border))
                    .bg(rgb(p.subtle))
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(rgb(p.muted))
                    .child(kit::icon("monitor", 12., p.muted))
                    .child("Local run");
                let leave = if matches!(self.state.machine, Some(MachineStatus::Saving)) {
                    // The run is already ending; a second end would only fail.
                    kit::inert_button(
                        p,
                        "end",
                        Kind::QuietDanger,
                        Size::Small,
                        Some("stop"),
                        "Ending…",
                        None,
                    )
                } else if run.active {
                    let end = kit::button(
                        p,
                        "end",
                        Kind::QuietDanger,
                        Size::Small,
                        Some("stop"),
                        "End run",
                        None,
                    );
                    // A press outside the open confirm closes it first, so this opens it.
                    Self::on_click(end, cx, |this, _| this.ending = true)
                } else {
                    self.back_to_catalog(p, "back", Kind::Outline, Size::Small, cx)
                };
                bar.child(kit::card_title(p, title).truncate())
                    .children(course.map(|course| kit::label(p, course).flex_none()))
                    .child(kit::status(color, word))
                    .child(badge)
                    .child(fill)
                    .children(connected)
                    .child(div().w(px(1.)).h(px(18.)).bg(rgb(p.border)))
                    .child(leave)
            }
            Screen::Catalog | Screen::Lecture { .. } | Screen::History | Screen::Recap(_) => {
                let runs = matches!(self.state.screen, Screen::History | Screen::Recap(_));
                let nav = |id: &'static str, glyph, label: &'static str, on: bool| {
                    let tab = div()
                        .id(id)
                        .debug_selector(move || id.to_owned())
                        .h(px(30.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .gap(px(7.))
                        .rounded_lg()
                        .border_1()
                        .cursor_pointer()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(kit::icon(glyph, 14., if on { p.accent } else { p.muted }))
                        .child(label);
                    if on {
                        tab.border_color(rgb(p.border)).bg(rgb(p.panel)).shadow_sm()
                    } else {
                        let hover = p.border;
                        tab.border_color(gpui::transparent_black())
                            .text_color(rgb(p.muted))
                            .hover(move |style| style.bg(rgb(hover)))
                    }
                };
                let catalog = Self::on_click(
                    nav("nav-catalog", "grid", "Catalog", !runs),
                    cx,
                    |this, _| {
                        let reload = this.state.back_to_catalog();
                        this.send(reload);
                    },
                );
                let history =
                    Self::on_click(nav("nav-runs", "monitor", "Runs", runs), cx, |this, _| {
                        let reload = this.state.open_history();
                        this.send(reload);
                    });
                let sign_out = kit::button(
                    p,
                    "sign-out",
                    Kind::Ghost,
                    Size::Small,
                    None,
                    "Sign out",
                    None,
                );
                bar.child(wordmark)
                    .child(div().flex().gap_1().child(catalog).child(history))
                    .child(fill)
                    .children(update)
                    .children(connected)
                    .child(Self::on_click(sign_out, cx, |this, _| {
                        this.send(Command::SignOut)
                    }))
            }
            // Signed out too: an app too old to sign in can still update.
            _ => bar.child(wordmark).child(fill).children(update),
        }
    }

    /// The screens before the catalog: one column in the middle of the window.
    fn front(&self, p: &Palette, cx: &Context<Self>) -> Div {
        let column = div().w(px(460.)).flex().flex_col().gap(px(28.));
        let words = |title: &'static str, lede: &'static str| {
            div()
                .flex()
                .flex_col()
                .gap_3()
                .child(kit::feature(p, title))
                .child(kit::lede(p, lede))
        };
        let column = match &self.state.screen {
            Screen::SigningIn(url) => {
                let again = kit::button(
                    p,
                    "again",
                    Kind::Outline,
                    Size::Medium,
                    Some("external"),
                    "Open the browser again",
                    None,
                );
                let copy = kit::button(
                    p,
                    "copy",
                    Kind::Outline,
                    Size::Small,
                    Some(if self.copied { "check" } else { "copy" }),
                    if self.copied { "Copied" } else { "Copy link" },
                    None,
                );
                let (open, link) = (url.clone(), url.clone());
                column
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_3()
                            .child(kit::status(p.brand_text, "Waiting for your browser"))
                            .child(kit::feature(p, "Finish signing in in your browser"))
                            .child(kit::lede(
                                p,
                                "A browser window opened on intar's sign-in page. Sign in there, and this window continues by itself.",
                            )),
                    )
                    .child(div().flex().child(Self::on_click(again, cx, move |_, cx| cx.open_url(&open))))
                    .child(
                        kit::card(p)
                            .flex()
                            .items_center()
                            .gap_3()
                            .px(px(14.))
                            .py_3()
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(div().font_weight(FontWeight::MEDIUM).child("Browser did not open?"))
                                    .child(kit::meta(
                                        p,
                                        "Copy the sign-in link and paste it into any browser on this computer.",
                                    )),
                            )
                            .child(Self::on_click(copy, cx, move |this, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(link.clone()));
                                this.copied = true;
                            })),
                    )
            }
            Screen::SignedOut => {
                let sign_in = kit::button(
                    p,
                    "sign-in",
                    Kind::Primary,
                    Size::Large,
                    None,
                    "Sign in with your browser",
                    Some("external"),
                );
                column
                    .child(words(
                        "Sign in to Intar",
                        "Intar opens your browser to sign you in, then brings you back here. You never type a password into this app.",
                    ))
                    .child(div().flex().child(Self::on_click(sign_in, cx, |this, _| this.send(Command::SignIn))))
            }
            Screen::Starting => column.child(words(
                "Opening your keychain…",
                "Intar keeps your sign-in there. Your computer may ask you to unlock it.",
            )),
            Screen::OpeningRun => column.child(words(
                "Asking Intar for the run…",
                "Intar checks your course and says which machines this scenario needs.",
            )),
            _ => column.child(words("Loading your courses…", "This takes a moment.")),
        };
        kit::panel(p)
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .p_8()
            .child(column.children(self.state.error.clone().map(|error| kit::failure(p, error))))
    }

    fn catalog(&self, p: &Palette, cx: &Context<Self>) -> Div {
        let courses = &self.state.catalog;
        let shown = self.state.course.min(courses.len().saturating_sub(1));
        let Some(course) = courses.get(shown) else {
            return kit::panel(p)
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_2()
                .child(kit::page(p, "No courses yet"))
                .child(kit::support(p, "Courses you can take show up here."));
        };
        let selected = match self.state.screen {
            Screen::Lecture { lecture, .. } => course.lectures.get(lecture).map(|l| (lecture, l)),
            _ => None,
        };

        let rail = div()
            .w(px(244.))
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(2.))
            .px_1()
            .pt(px(6.))
            .child(kit::label(p, "Your courses").px(px(10.)).pt_2().pb(px(6.)))
            .children(courses.iter().enumerate().map(|(index, course)| {
                let done = solved(course);
                let total = course.lectures.len();
                let row = div()
                    .id(("course", index))
                    .flex()
                    .flex_col()
                    .gap(px(5.))
                    .px(px(10.))
                    .py(px(9.))
                    .rounded_lg()
                    .border_1()
                    .cursor_pointer()
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .child(course.title.clone()),
                    )
                    .child(kit::segments(p, done, total, 3.))
                    .child(kit::caption(
                        p,
                        if done == 0 {
                            format!("Not started · {}", plural(total, "lecture", "lectures"))
                        } else {
                            format!("{done} of {total} solved")
                        },
                    ));
                let row = if index == shown {
                    row.bg(rgb(p.panel)).border_color(rgb(p.border)).shadow_sm()
                } else {
                    // Lifts toward the selected row's surface; `track` is the canvas's own tone.
                    let hover = p.bg;
                    row.border_color(gpui::transparent_black())
                        .hover(move |style| style.bg(rgb(hover)))
                };
                Self::on_click(row, cx, move |this, _| this.state.open_course(index))
            }));

        let typed = self.search.read(cx).text().trim().to_owned();
        let query = typed.to_lowercase();
        let minutes: u32 = course
            .lectures
            .iter()
            .filter_map(|l| l.estimated_minutes)
            .sum();
        let mut facts = vec![
            plural(course.lectures.len(), "lecture", "lectures"),
            format!("{} solved", solved(course)),
        ];
        if minutes > 0 {
            facts.push(format!("about {minutes} min"));
        }
        let rows: Vec<_> = course
            .lectures
            .iter()
            .enumerate()
            .filter(|(_, lecture)| lecture.title.to_lowercase().contains(&query))
            .enumerate()
            .map(|(position, (index, lecture))| {
                let (glyph, glyph_color) = match lecture.state.as_str() {
                    "completed" => ("check-circle", p.green),
                    "locked" => ("lock", p.disabled),
                    "in_progress" => ("circle", p.accent),
                    _ => ("circle", p.disabled),
                };
                let (word, word_color) = match lecture.state.as_str() {
                    "completed" => ("Solved", p.green),
                    "in_progress" => ("In progress", p.brand_text),
                    "locked" => ("Locked", p.disabled),
                    "waiting_for_scenario" => ("Not ready yet", p.disabled),
                    _ => ("Not started", p.disabled),
                };
                let row = div()
                    .id(("lecture", index))
                    .debug_selector(move || format!("lecture-{index}"))
                    .flex()
                    .items_start()
                    .gap_3()
                    .px_4()
                    .py(px(13.))
                    .when(position > 0, |row| row.border_t_1())
                    .border_color(rgb(p.border))
                    .cursor_pointer()
                    .child(div().pt(px(3.)).child(kit::icon(glyph, 16., glyph_color)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(kit::card_title(p, lecture.title.clone()))
                            .when(!lecture.summary.is_empty(), |text| {
                                text.child(kit::support(p, lecture.summary.clone()))
                            })
                            .child(kit::meta(p, lecture_facts(lecture))),
                    )
                    .child(
                        div()
                            .flex_none()
                            .flex()
                            .flex_col()
                            .items_end()
                            .gap(px(2.))
                            .pt(px(2.))
                            .child(kit::label(p, word).text_color(rgb(word_color)))
                            .when(lecture.active_run_id.is_some(), |right| {
                                right.child(kit::caption(p, "Run active"))
                            }),
                    );
                let row = if selected.is_some_and(|(at, _)| at == index) {
                    row.bg(rgb(p.selected))
                } else {
                    let hover = p.bg;
                    row.hover(move |style| style.bg(rgb(hover)))
                };
                Self::on_click(row, cx, move |this, _| {
                    if let Some(load) = this.state.open_lecture(shown, index) {
                        this.send(load);
                    }
                })
            })
            .collect();
        // A search that matches nothing says so instead of an empty card.
        let lectures = if rows.is_empty() {
            div().py_8().flex().justify_center().child(kit::support(
                p,
                format!("No lecture in this course matches \u{201c}{typed}\u{201d}."),
            ))
        } else {
            kit::card(p).children(rows)
        };
        let list = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(18.))
            .p_6()
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap_6()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(kit::page(p, course.title.clone()))
                            .child(kit::meta(p, facts.join(" · "))),
                    )
                    .child(div().w(px(260.)).child(self.search.clone())),
            )
            .children(self.state.error.clone().map(|error| kit::failure(p, error)))
            .child(
                div()
                    .id("lectures")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(lectures),
            );

        let detail = div()
            .w(px(372.))
            .flex_none()
            .flex()
            .flex_col()
            .border_l_1()
            .border_color(rgb(p.border));
        let words = div()
            .id("detail")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p_6();
        let foot = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .px_6()
            .pt_4()
            .pb(px(18.))
            .border_t_1()
            .border_color(rgb(p.border));
        let detail = match selected {
            None => detail.child(
                words.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(kit::label(p, "Course"))
                        .child(kit::content(p, course.title.clone()))
                        .child(kit::support(p, course.summary.clone()).text_size(px(15.)))
                        .when(!course.body_markdown.trim().is_empty(), |words| {
                            words.child(markdown(p, &course.body_markdown).pt_2())
                        })
                        .child(kit::meta(
                            p,
                            "Pick a lecture to see its theory and scenario.",
                        )),
                ),
            ),
            Some((index, lecture)) => {
                let label = if lecture.active_run_id.is_some() {
                    "Open the run"
                } else {
                    "Start scenario"
                };
                let blocked = match (&lecture.scenario_id, lecture.state.as_str()) {
                    (None, _) => Some("This lecture has no scenario."),
                    (_, "locked") => {
                        Some("Finish the lectures before this one to unlock its scenario.")
                    }
                    (_, "waiting_for_scenario") => {
                        Some("This lecture's scenario is not ready yet.")
                    }
                    _ => None,
                };
                let theory = self.state.theory.as_ref();
                let locked =
                    lecture.state == "locked" || theory.is_some_and(|answer| answer.locked);
                let foot = match blocked {
                    // A lecture without a lab is done once read.
                    Some(_) if lecture.scenario_id.is_none() => {
                        if lecture.state == "completed" {
                            foot.child(kit::status(p.green, "Lecture complete"))
                        } else if locked {
                            foot.child(kit::caption(p, "Finish the lectures before this one to unlock it."))
                        } else {
                            let read = kit::button(p, "read", Kind::Primary, Size::Large, Some("check"), "Mark as read", None);
                            foot.child(Self::on_click(read, cx, |this, _| {
                                if let Some(at) = this.state.lecture_ref() {
                                    this.send(Command::Learn(Learn::CompleteLecture(at)));
                                }
                            }))
                            .child(kit::caption(p, "This lecture has no scenario. Mark it as read when you are done."))
                        }
                    }
                    Some(why) => foot
                        .child(kit::inert_button(
                            p,
                            "start",
                            Kind::Primary,
                            Size::Large,
                            None,
                            label,
                            Some("arrow-right"),
                        ))
                        .child(kit::caption(p, why)),
                    None => foot
                        .child(Self::on_click(
                            kit::button(
                                p,
                                "start",
                                Kind::Primary,
                                Size::Large,
                                None,
                                label,
                                Some("arrow-right"),
                            ),
                            cx,
                            |this, _| {
                                if let Some(command) = this.state.open_run() {
                                    this.send(command);
                                }
                            },
                        ))
                        .child(kit::caption(
                            p,
                            "Runs on this computer. The result counts toward your course and is marked as a local run.",
                        )),
                };
                detail
                    .child(
                        words.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(kit::label(p, {
                                    let (ordinal, count) = match theory.and_then(|answer| answer.lecture.as_ref()) {
                                        Some(theory) => (theory.ordinal as usize, theory.count as usize),
                                        None => (index + 1, course.lectures.len()),
                                    };
                                    format!("Lecture {ordinal} of {count}")
                                }))
                                .child(kit::content(p, lecture.title.clone()))
                                .child(kit::support(p, lecture.summary.clone()).text_size(px(15.)))
                                .child(kit::meta(p, lecture_facts(lecture)))
                                .child(div().pt_2().child(match theory {
                                    None => kit::meta(p, "Loading the lecture…"),
                                    Some(answer) => match &answer.lecture {
                                        Some(theory) if !answer.locked => {
                                            markdown(p, &theory.body_markdown).debug_selector(|| "theory".to_owned())
                                        }
                                        _ => div()
                                            .flex()
                                            .items_start()
                                            .gap_2()
                                            .child(div().pt(px(2.)).child(kit::icon("lock", 14., p.muted)))
                                            .child(
                                                div()
                                                    .child(kit::card_title(p, "This lecture is locked"))
                                                    .child(kit::support(
                                                        p,
                                                        "Complete the required earlier lecture before you open this lecture.",
                                                    )),
                                            ),
                                    },
                                })),
                        ),
                    )
                    .child(foot)
            }
        };

        div().flex_1().min_w_0().flex().gap_2().child(rail).child(
            kit::panel(p)
                .flex_1()
                .min_w_0()
                .flex()
                .overflow_hidden()
                .child(list)
                .child(detail),
        )
    }

    /// The run's start, stage by stage; it sits where the terminal will be.
    fn stages(&self, p: &Palette, run: &LocalRunV1, cx: &Context<Self>) -> Div {
        let machines = plural(run.machines.len(), "machine", "machines");
        let failed = match &self.state.machine {
            Some(MachineStatus::Failed(reason)) => Some(reason.clone()),
            _ => None,
        };
        let stage = self.state.stage.min(3);
        let names = [
            "Checking with Intar".to_owned(),
            "Downloading images".to_owned(),
            format!("Booting {machines}"),
            "Ready".to_owned(),
        ];
        let download = match self.state.machine {
            Some(MachineStatus::Downloading { done, total }) if failed.is_none() => {
                Some((done, total))
            }
            _ => None,
        };
        let (headline, summary) = match (&failed, stage) {
            (Some(reason), _) => ("This run could not start".to_owned(), reason.clone()),
            (None, 0) => (
                "Preparing this run".to_owned(),
                "Intar looks up which machines this scenario needs on this computer.".to_owned(),
            ),
            (None, 1) => (
                names[1].clone(),
                "The machines for this scenario are downloaded once and kept on this computer."
                    .to_owned(),
            ),
            (None, _) => (
                names[2].clone(),
                "Each machine starts its system and then the lab inside it.".to_owned(),
            ),
        };
        let track = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .children((0..4).map(|index| {
                let dot = div().h(px(8.)).rounded(px(4.));
                match (index.cmp(&stage), failed.is_some()) {
                    (std::cmp::Ordering::Less, _) => dot.w(px(8.)).bg(rgb(p.green)),
                    (std::cmp::Ordering::Equal, true) => dot.w(px(64.)).bg(rgb(p.red)),
                    (std::cmp::Ordering::Equal, false) => dot
                        .w(px(64.))
                        .bg(rgb(p.brand_subtle))
                        .border_1()
                        .border_color(rgb(p.brand_border)),
                    (std::cmp::Ordering::Greater, _) => dot.w(px(8.)).bg(rgb(p.track)),
                }
            }));
        let steps = names.iter().enumerate().map(|(index, name)| {
            let mark = div()
                .size(px(24.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD);
            let number = (index + 1).to_string();
            let (mark, word, word_color, fill) = match (index.cmp(&stage), failed.is_some()) {
                (std::cmp::Ordering::Less, _) => (
                    mark.bg(rgb(p.green))
                        .child(kit::icon("check", 14., p.on_green)),
                    "Done",
                    p.green,
                    None,
                ),
                (std::cmp::Ordering::Equal, true) => (
                    mark.bg(rgb(p.red)).text_color(rgb(p.on_red)).child("!"),
                    "Failed",
                    p.red,
                    Some(p.red_subtle),
                ),
                (std::cmp::Ordering::Equal, false) => (
                    mark.bg(rgb(p.brand_subtle))
                        .border_1()
                        .border_color(rgb(p.brand_border))
                        .text_color(rgb(p.brand_text))
                        .child(number),
                    "In progress",
                    p.brand_text,
                    Some(p.selected),
                ),
                (std::cmp::Ordering::Greater, _) => (
                    mark.border_1()
                        .border_color(rgb(p.border_strong))
                        .text_color(rgb(p.muted))
                        .child(number),
                    "Up next",
                    p.disabled,
                    None,
                ),
            };
            // The download says how far it is, in bytes.
            let detail = download.filter(|_| index == 1).map(|(done, total)| {
                let part = if total == 0 { 0. } else { done as f32 / total as f32 };
                div()
                    .pl(px(36.))
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .h(px(8.))
                            .rounded(px(4.))
                            .bg(rgb(p.track))
                            .child(
                                div()
                                    .h_full()
                                    .w(relative(part.clamp(0., 1.)))
                                    .rounded(px(4.))
                                    .bg(rgb(p.accent)),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(format!("{} of {}", megabytes(done), megabytes(total))),
                            )
                            .child(kit::meta(p, format!("{:.0} %", part * 100.))),
                    )
                    .child(kit::caption(
                        p,
                        "Every piece is checked as it arrives. If you end the run now, the download starts again next time.",
                    ))
            });
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .p_3()
                .rounded(px(10.))
                .when_some(fill, |row, fill| row.bg(rgb(fill)))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .child(mark)
                        .child(div().flex_1().child(kit::card_title(p, name.clone())))
                        .child(kit::label(p, word).text_color(rgb(word_color))),
                )
                .children(detail)
        });
        kit::card(p)
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(22.))
            .px_12()
            .py_8()
            .child(
                div()
                    .max_w(px(640.))
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(track)
                            .child(kit::label(p, format!("Stage {} of 4", stage + 1))),
                    )
                    .child(kit::page(p, headline))
                    .child(kit::support(p, summary).text_size(px(15.))),
            )
            .child(
                div()
                    .max_w(px(720.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .children(steps),
            )
            .when(failed.is_some(), |card| {
                card.child(div().flex().child(self.back_to_catalog(
                    p,
                    "back-card",
                    Kind::Outline,
                    Size::Medium,
                    cx,
                )))
            })
    }

    /// The terminal, once the lab is up.
    fn terminal(&self, run: &LocalRunV1, cx: &Context<Self>) -> Div {
        let shown = self
            .terminal
            .as_ref()
            .map(|view| view.read(cx).machine().to_owned());
        let tabs = run.machines.iter().map(|machine| {
            let on = shown.as_deref() == Some(machine.name.as_str());
            div()
                .flex()
                .items_center()
                .gap_2()
                .px_3()
                .font_family(MONO)
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgb(if on { term::TEXT } else { term::MUTED }))
                .when(on, |tab| tab.border_b_2().border_color(rgb(term::BRAND)))
                .child(div().size(px(6.)).rounded_full().bg(rgb(term::GREEN)))
                .child(machine.name.clone())
        });
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded_xl()
            .border_1()
            .border_color(rgb(term::BORDER))
            .bg(rgb(term::BG))
            .child(
                div()
                    .h(px(42.))
                    .flex_none()
                    .flex()
                    .items_stretch()
                    .gap(px(2.))
                    .px_2()
                    .bg(rgb(term::SURFACE))
                    .border_b_1()
                    .border_color(rgb(term::BORDER))
                    .children(tabs)
                    .child(div().flex_1())
                    .children(run.machines.first().map(|machine| {
                        div()
                            .flex()
                            .items_center()
                            .pr(px(6.))
                            .text_size(px(12.))
                            .text_color(rgb(term::MUTED))
                            .child(machine_facts(machine))
                    })),
            )
            .child(match &self.terminal {
                Some(view) => div().flex_1().min_h_0().child(view.clone()),
                None => div()
                    .flex_1()
                    .px(px(18.))
                    .py(px(14.))
                    .font_family(MONO)
                    .text_size(px(14.))
                    .text_color(rgb(term::MUTED))
                    .child("Opening the terminal…"),
            })
    }

    fn run(&self, p: &Palette, run: &LocalRunV1, cx: &Context<Self>) -> Div {
        let body = div().flex_1().min_w_0().flex().gap_2();
        if !run.active {
            let closed = kit::card(p)
                .w(px(460.))
                .p_6()
                .flex()
                .flex_col()
                .gap_4()
                .child(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(14.))
                        .child(
                            div()
                                .size(px(36.))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(10.))
                                .border_1()
                                .border_color(rgb(p.border))
                                .bg(rgb(p.subtle))
                                .child(kit::icon("power", 16., p.muted)),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(6.))
                                .child(kit::section(p, "This run was closed"))
                                .child(kit::support(
                                    p,
                                    "Its machines on this computer have stopped. Tasks verified before then stay on your account.",
                                )),
                        ),
                )
                // What went wrong while the run ended, such as an unsaved replay.
                .children(self.state.error.clone().map(|error| kit::failure(p, error)))
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(self.back_to_catalog(p, "back-card", Kind::Outline, Size::Medium, cx))
                        .child({
                            let see = kit::button(p, "see-recap", Kind::Primary, Size::Medium, None, "See your recap", Some("arrow-right"));
                            let run_id = run.run_id.clone();
                            Self::on_click(see, cx, move |this, _| {
                                let load = this.state.open_recap(&run_id);
                                this.send(load);
                            })
                        }),
                );
            return body.child(
                kit::panel(p)
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(closed),
            );
        }
        let (passed, tasks) = match self.state.machine {
            Some(MachineStatus::Ready { passed, tasks }) => (passed, Some(tasks)),
            _ => (0, None),
        };
        let stage = match (&self.state.machine, tasks) {
            // The run is ending: the machine is off and its sessions go to intar.
            (Some(MachineStatus::Saving), _) => kit::card(p)
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_2()
                .child(kit::page(p, "Saving your sessions"))
                .child(kit::support(
                    p,
                    "The machine has stopped. What you did in the terminal is sent to Intar for this run's replay.",
                )),
            (_, Some(_)) => self.terminal(run, cx),
            (_, None) => self.stages(p, run, cx),
        };
        let machines = run.machines.iter().enumerate().map(|(position, machine)| {
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(14.))
                .py(px(10.))
                .when(position > 0, |row| row.border_t_1())
                .border_color(rgb(p.border))
                .child(kit::icon("monitor", 16., p.disabled))
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .child(kit::code(p, machine.name.clone())),
                )
                .child(kit::meta(p, machine_facts(machine)).text_color(rgb(p.muted)))
        });
        // intar's checks once it answered; the machine's own count until then.
        let learning = self.state.learning.as_ref();
        let (passed, tasks) = match learning {
            Some(learning) => (
                ui::learning::verified(learning),
                Some(learning.checks.len()),
            ),
            None => (passed, tasks),
        };
        let solved = match learning {
            Some(learning) => learning.solved,
            None => tasks.is_some_and(|tasks| tasks > 0 && passed == tasks),
        };
        let side = div()
            .flex()
            .flex_col()
            .gap_4()
            .p_4()
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .justify_between()
                    .px_1()
                    .child(kit::section(p, "Checks"))
                    .child({
                        let progress = match (tasks, &self.state.machine) {
                            (Some(tasks), _) => format!("{passed} of {tasks} verified"),
                            (None, Some(MachineStatus::Saving)) => "The run is ending".to_owned(),
                            (None, _) => "Begin when the machines are ready".to_owned(),
                        };
                        // Tests read the count by it.
                        let selector = progress.clone();
                        kit::meta(p, progress).debug_selector(|| selector)
                    }),
            )
            .children(tasks.map(|tasks| kit::segments(p, passed, tasks, 4.).px_1()))
            .when(solved, |side| {
                side.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .px(px(14.))
                        .py_3()
                        .rounded(px(10.))
                        .border_1()
                        .border_color(rgb(p.green_border))
                        .bg(rgb(p.green_subtle))
                        .child(kit::icon("check-circle", 20., p.green))
                        .child(
                            div()
                                .child(kit::card_title(p, "All checks verified"))
                                .child(kit::meta(p, "Saved to your course as a local run")),
                        ),
                )
            })
            .children(self.state.error.clone().map(|error| kit::failure(p, error)))
            .children(learning.map(|learning| self.learning(p, learning, cx).px_1()))
            .child(kit::label(p, "Machines").px_1())
            .child(kit::card(p).mt(px(-8.)).children(machines));
        let side = kit::panel(p)
            .id("side")
            .w(px(400.))
            .flex_none()
            .overflow_y_scroll()
            .child(side);
        body.child(stage).child(side)
    }

    /// Asks before a run ends: its machines are deleted with it.
    fn end_confirm(&self, p: &Palette, run: &LocalRunV1, cx: &Context<Self>) -> Div {
        let keep = kit::button(
            p,
            "keep",
            Kind::Outline,
            Size::Small,
            None,
            "Keep working",
            None,
        );
        let end = kit::button(
            p,
            "end-now",
            Kind::Danger,
            Size::Small,
            None,
            "End run and delete machines",
            None,
        );
        let run_id = run.run_id.clone();
        kit::card(p)
            .absolute()
            .top(px(48.))
            .right(px(10.))
            .w(px(348.))
            .occlude()
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.ending = false;
                cx.notify();
            }))
            .shadow_lg()
            .p_4()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(kit::card_title(p, "End this run?"))
                    .child(kit::support(
                        p,
                        "The machines stop and their disks are deleted from this computer. Tasks verified so far stay on your account.",
                    )),
            )
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap_2()
                    .child(Self::on_click(keep, cx, |this, _| this.ending = false))
                    .child(Self::on_click(end, cx, move |this, _| {
                        this.ending = false;
                        this.send(Command::EndRun { run_id: run_id.clone() });
                    })),
            )
    }
}

impl Render for Jumper {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = palette(cx);
        if let Some(view) = self.terminal.as_ref().filter(|_| self.focus_terminal) {
            window.focus(&view.focus_handle(cx), cx);
            self.focus_terminal = false;
        }
        // The player goes with the replay part it plays.
        if self.state.replay.as_ref() != self.replay.as_ref().map(|(shown, _)| shown) {
            self.replay = None;
        }
        let (body, confirm) = match &self.state.screen {
            Screen::Catalog | Screen::Lecture { .. } => (self.catalog(p, cx), None),
            Screen::History => (self.history(p, cx), None),
            Screen::Recap(_) => (self.recap(p, cx), None),
            Screen::Run(run) => (
                self.run(p, run, cx),
                self.ending.then(|| self.end_confirm(p, run, cx)),
            ),
            _ => (self.front(p, cx), None),
        };
        div()
            .when_some(theme::ui_font(cx), |root, font| root.font_family(font))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(p.canvas))
            .text_color(rgb(p.text))
            .text_size(px(14.))
            .child(self.title_bar(p, cx))
            .child(div().flex_1().min_h_0().flex().px_2().pb_2().child(body))
            .children(confirm)
    }
}

fn main() {
    // QEMU runs the app itself as `<app> relay <port>` for a guest without
    // internet access; that is no window, only a pipe to the app's port.
    let mut arguments = std::env::args().skip(1);
    match arguments.next().as_deref() {
        Some("relay") => {
            let relayed = arguments
                .next()
                .and_then(|port| port.parse().ok())
                .ok_or_else(|| std::io::Error::other("relay takes a port"))
                .and_then(zpm::relay::relay);
            std::process::exit(i32::from(relayed.is_err()));
        }
        // What a release checks its bundle by, and an update compares.
        Some("--version") => {
            println!("jumper {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        // Replaces this app with the one in a zip, without a window:
        // `<app> install-update <zip> <sha256>`. The app's own update does the
        // same after its download; this is that step by itself.
        Some("install-update") => {
            let installed = match (arguments.next(), arguments.next()) {
                (Some(zip), Some(sha256)) => std::env::current_exe()
                    .map_err(update::Refusal::from)
                    .and_then(|program| update::bundle_of(&program))
                    .and_then(|bundle| {
                        update::install(
                            &bundle,
                            env!("CARGO_PKG_VERSION"),
                            std::path::Path::new(&zip),
                            &sha256,
                        )
                    }),
                _ => Err(update::Refusal::NotTheUpdate(
                    "install-update takes a zip and its SHA-256".to_owned(),
                )),
            };
            match installed {
                Ok(bundle) => println!("installed {}", bundle.display()),
                Err(refusal) => {
                    eprintln!("jumper: not updated: {refusal}");
                    std::process::exit(1);
                }
            }
            return;
        }
        _ => {}
    }
    // INTAR_URL points the app at another intar, such as a local Worker.
    let base = std::env::var("INTAR_URL").unwrap_or_else(|_| "https://intar.dev".into());
    let base = match Url::parse(&base) {
        Ok(base) => base,
        Err(error) => {
            eprintln!("jumper: INTAR_URL is not a URL: {error}");
            std::process::exit(2);
        }
    };
    let engine::Engine {
        commands,
        mut events,
    } = match engine::start(base.clone()) {
        Ok(engine) => engine,
        Err(error) => {
            eprintln!("jumper: could not start: {error}");
            std::process::exit(1);
        }
    };
    application()
        .with_assets(kit::Assets)
        .run(move |cx: &mut App| {
            ui::text_input::bind_keys(cx);
            theme::init_ui_font(cx);
            let bounds = Bounds::centered(None, size(px(1280.), px(760.)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("Intar".into()),
                    appears_transparent: OWN_TITLE_BAR,
                    traffic_light_position: Some(point(px(16.), px(15.))),
                }),
                window_min_size: Some(size(px(1040.), px(600.))),
                // Otherwise AppKit keeps the title bar's strip, where the app's
                // own buttons never see the pointer and clicks wait on a
                // double-click check (macOS 27).
                app_owns_titlebar_drag: OWN_TITLE_BAR,
                ..Default::default()
            };
            let opened = cx.open_window(options, move |window, cx| {
                let view = cx.new(|cx| Jumper::new(commands, base, window, cx));
                // Engine → view. The task ends with the engine or the window.
                let weak = view.downgrade();
                cx.spawn(async move |cx| {
                    while let Some(event) = events.recv().await {
                        if weak.update(cx, |view, cx| view.apply(event, cx)).is_err() {
                            break;
                        }
                    }
                })
                .detach();
                view
            });
            match opened {
                Ok(_) => cx.activate(true),
                Err(error) => {
                    eprintln!("jumper: could not open a window: {error}");
                    cx.quit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Modifiers, TestAppContext, VisualTestContext};
    use subspace::contract::{
        CatalogCourseV1, LocalReplayPartV1, LocalRunRecapV1, LocalRunSummaryV1,
    };
    use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

    /// The window with `state` on screen, and what it asks of the engine.
    fn open(
        cx: &mut TestAppContext,
        state: State,
    ) -> (
        Entity<Jumper>,
        &mut VisualTestContext,
        UnboundedReceiver<Command>,
    ) {
        let (commands, mut heard) = unbounded_channel();
        let (view, cx) = cx.add_window_view(|window, cx| {
            let base = Url::parse("https://intar.dev").unwrap_or_else(|error| panic!("{error}"));
            let mut jumper = Jumper::new(commands, base, window, cx);
            jumper.state = state;
            jumper
        });
        cx.run_until_parked();
        // What the window asks at launch.
        while heard.try_recv().is_ok() {}
        (view, cx, heard)
    }

    fn click(cx: &mut VisualTestContext, selector: &'static str) {
        let bounds = cx
            .debug_bounds(selector)
            .unwrap_or_else(|| panic!("{selector} is not on screen"));
        cx.simulate_click(bounds.center(), Modifiers::none());
        cx.run_until_parked();
    }

    fn lecture(state: &str) -> CatalogLectureV1 {
        CatalogLectureV1 {
            lecture_id: "l".into(),
            title: "Serve".into(),
            summary: String::new(),
            category: String::new(),
            tags: vec![],
            difficulty: None,
            estimated_minutes: None,
            scenario_id: Some("intar/web".into()),
            state: state.into(),
            active_run_id: None,
        }
    }

    fn catalog(state: &str) -> Vec<CatalogCourseV1> {
        vec![CatalogCourseV1 {
            course_id: "c".into(),
            organization_id: None,
            organization_name: None,
            title: "Web".into(),
            summary: String::new(),
            body_markdown: String::new(),
            sequential: true,
            lectures: vec![lecture(state)],
        }]
    }

    #[gpui::test]
    fn a_locked_lecture_does_not_start_and_an_open_one_does(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.catalog = catalog("locked");
        state.screen = Screen::Lecture {
            course: 0,
            lecture: 0,
        };
        let (view, cx, mut heard) = open(cx, state);
        click(cx, "start");
        assert!(heard.try_recv().is_err(), "a locked start asks nothing");

        view.update(cx, |view, cx| {
            view.state.catalog = catalog("available");
            cx.notify();
        });
        cx.run_until_parked();
        click(cx, "start");
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::StartRun {
                scenario_id: "intar/web".into(),
                organization_id: None
            })
        );
    }

    #[gpui::test]
    fn the_end_confirm_closes_outside_and_ends_on_its_button(cx: &mut TestAppContext) {
        let run = LocalRunV1 {
            run_id: "run-1".into(),
            scenario_id: "intar/web".into(),
            state: "running".into(),
            active: true,
            user_id: None,
            execution_id: None,
            generation: None,
            machines: vec![],
        };
        let mut state = State::default();
        state.screen = Screen::Run(run);
        let (view, cx, mut heard) = open(cx, state);
        click(cx, "end");
        assert!(view.read_with(cx, |view, _| view.ending));
        // Pressing End run again keeps it open rather than flickering.
        click(cx, "end");
        assert!(view.read_with(cx, |view, _| view.ending));

        cx.simulate_click(point(px(200.), px(400.)), Modifiers::none());
        cx.run_until_parked();
        assert!(!view.read_with(cx, |view, _| view.ending), "closed outside");

        click(cx, "end");
        click(cx, "keep");
        assert!(!view.read_with(cx, |view, _| view.ending));
        assert!(heard.try_recv().is_err());

        click(cx, "end");
        click(cx, "end-now");
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::EndRun {
                run_id: "run-1".into()
            })
        );
    }

    #[gpui::test]
    fn copy_link_copies_and_says_so(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.screen = Screen::SigningIn("https://intar.dev/sign-in".into());
        let (view, cx, _heard) = open(cx, state);
        click(cx, "copy");
        assert!(view.read_with(cx, |view, _| view.copied));
        assert_eq!(
            cx.read_from_clipboard().and_then(|item| item.text()),
            Some("https://intar.dev/sign-in".into())
        );
        // The next event takes the word back.
        view.update(cx, |view, cx| view.apply(Event::Update(None), cx));
        assert!(!view.read_with(cx, |view, _| view.copied));
    }

    #[gpui::test]
    fn an_update_in_progress_is_not_started_again(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.screen = Screen::SignedOut;
        state.update = Some("0.2.0".into());
        let (view, cx, mut heard) = open(cx, state);
        click(cx, "update");
        assert_eq!(heard.try_recv().ok(), Some(Command::InstallUpdate));
        assert!(view.read_with(cx, |view, _| view.state.updating));
        click(cx, "update");
        assert!(heard.try_recv().is_err(), "Updating… asks nothing");
    }

    fn run(active: bool) -> LocalRunV1 {
        LocalRunV1 {
            run_id: "run-1".into(),
            scenario_id: "intar/web".into(),
            state: "running".into(),
            active,
            user_id: None,
            execution_id: None,
            generation: None,
            machines: vec![],
        }
    }

    #[gpui::test]
    fn the_closed_cards_back_button_returns_to_the_catalog(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.screen = Screen::Run(run(false));
        let (view, cx, mut heard) = open(cx, state);
        // The title bar has a Back to catalog of its own; the card's must work too.
        click(cx, "back-card");
        assert_eq!(heard.try_recv().ok(), Some(Command::LoadCatalog));
        assert!(view.read_with(cx, |view, _| view.state.screen == Screen::Catalog));
    }

    fn theory_lecture() -> subspace::contract::LocalLectureAnswerV1 {
        subspace::contract::LocalLectureAnswerV1 {
            protocol: 1,
            locked: false,
            lecture: Some(subspace::contract::LocalLectureV1 {
                course_id: "c".into(),
                lecture_id: "l".into(),
                title: "Serve".into(),
                body_markdown: "Serve **files**.".into(),
                ordinal: 1,
                count: 1,
                state: "available".into(),
            }),
        }
    }

    #[gpui::test]
    fn a_selected_lecture_loads_and_shows_its_theory(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.catalog = catalog("available");
        state.screen = Screen::Catalog;
        let (view, cx, mut heard) = open(cx, state);
        click(cx, "lecture-0");
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::Learn(Learn::Lecture(state::LectureRef {
                course_id: "c".into(),
                lecture_id: "l".into(),
                organization_id: None,
            })))
        );
        assert!(cx.debug_bounds("theory").is_none(), "not loaded yet");
        view.update(cx, |view, cx| {
            view.apply(Event::Lecture(theory_lecture()), cx)
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("theory").is_some());
    }

    #[gpui::test]
    fn a_lecture_without_a_scenario_is_marked_as_read(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.catalog = catalog("available");
        state.catalog[0].lectures[0].scenario_id = None;
        state.screen = Screen::Lecture {
            course: 0,
            lecture: 0,
        };
        let (_view, cx, mut heard) = open(cx, state);
        assert!(cx.debug_bounds("start").is_none(), "nothing to start");
        click(cx, "read");
        assert!(matches!(
            heard.try_recv().ok(),
            Some(Command::Learn(Learn::CompleteLecture(at))) if at.lecture_id == "l"
        ));
    }

    fn learning() -> subspace::contract::LocalRunLearningV1 {
        use subspace::contract::{LocalRunCheckV1, LocalRunHintV1, LocalRunSolutionV1};
        let check = |key: &str, status: &str| LocalRunCheckV1 {
            key: key.into(),
            machine: "web".into(),
            title: key.into(),
            description: None,
            status: status.into(),
            optional: false,
        };
        let hint = |key: &str, revealed: bool, unlocked: bool| LocalRunHintV1 {
            key: key.into(),
            check_key: None,
            title: revealed.then(|| "Look at the port".to_owned()),
            revealed,
            unlocked,
            body_markdown: revealed.then(|| "It is `8080`.".to_owned()),
        };
        subspace::contract::LocalRunLearningV1 {
            run_id: "run-1".into(),
            lecture_title: Some("Serve".into()),
            lecture_markdown: String::new(),
            solved: false,
            checks: vec![
                check("listen", "verified"),
                check("serve", "checking"),
                check("cache", "needs_repair"),
            ],
            hints: vec![
                hint("h1", true, false),
                hint("h2", false, true),
                hint("h3", false, false),
            ],
            solution: LocalRunSolutionV1 {
                unlocked: false,
                assisted: false,
                revealed: false,
                body_markdown: None,
            },
        }
    }

    fn learning_run(
        cx: &mut TestAppContext,
    ) -> (
        Entity<Jumper>,
        &mut VisualTestContext,
        UnboundedReceiver<Command>,
    ) {
        let mut state = State::default();
        state.screen = Screen::Run(run(true));
        state.learning = Some(learning());
        open(cx, state)
    }

    #[gpui::test]
    fn the_checks_count_what_intar_verified(cx: &mut TestAppContext) {
        let (_view, cx, _heard) = learning_run(cx);
        assert!(cx.debug_bounds("1 of 3 verified").is_some());
    }

    #[gpui::test]
    fn only_the_unlocked_hint_can_be_revealed(cx: &mut TestAppContext) {
        let (_view, cx, mut heard) = learning_run(cx);
        assert!(cx.debug_bounds("reveal-h1").is_none(), "already revealed");
        assert!(cx.debug_bounds("reveal-h3").is_none(), "still sealed");
        click(cx, "reveal-h2");
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::Learn(Learn::RevealHint {
                run_id: "run-1".into(),
                hint_key: "h2".into(),
            }))
        );
    }

    #[gpui::test]
    fn the_solution_is_revealed_only_after_its_confirm(cx: &mut TestAppContext) {
        let (view, cx, mut heard) = learning_run(cx);
        click(cx, "solution");
        assert!(heard.try_recv().is_err(), "asks first");
        click(cx, "keep-trying");
        assert!(!view.read_with(cx, |view, _| view.confirm_solution));
        assert!(heard.try_recv().is_err());

        click(cx, "solution");
        click(cx, "reveal-solution");
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::Learn(Learn::RevealSolution {
                run_id: "run-1".into()
            }))
        );
        assert!(!view.read_with(cx, |view, _| view.confirm_solution));
    }

    fn summary(run_id: &str, scenario: &str, activity: &str, created_at: i64) -> LocalRunSummaryV1 {
        LocalRunSummaryV1 {
            run_id: run_id.into(),
            scenario_id: scenario.into(),
            organization_id: None,
            title: scenario.into(),
            local: true,
            active: activity == "foreground",
            outcome: if activity == "foreground" {
                "in_progress"
            } else {
                "succeeded"
            }
            .into(),
            activity: activity.into(),
            created_at,
            finished_at: None,
            solved_at: None,
            solve_duration_ms: Some(252_000),
            solution_assisted: false,
            has_replay: true,
        }
    }

    fn history_screen(
        cx: &mut TestAppContext,
    ) -> (
        Entity<Jumper>,
        &mut VisualTestContext,
        UnboundedReceiver<Command>,
    ) {
        let mut state = State::default();
        state.screen = Screen::History;
        let mut remote = summary("run-remote", "intar/dns", "foreground", 5);
        remote.local = false;
        state.history = Some(vec![
            summary("run-old", "intar/web", "settled", 1),
            summary("run-new", "intar/web", "settled", 3),
            summary("run-live", "intar/k8s", "foreground", 4),
            remote,
            summary("run-dns", "intar/dns", "settled", 2),
        ]);
        open(cx, state)
    }

    #[gpui::test]
    fn the_runs_page_lists_active_work_first_and_one_row_per_scenario(cx: &mut TestAppContext) {
        let (_view, cx, mut heard) = history_screen(cx);
        let top = |cx: &mut VisualTestContext, selector| {
            cx.debug_bounds(selector)
                .unwrap_or_else(|| panic!("{selector} is not on screen"))
                .top()
        };
        assert!(top(cx, "active-0") < top(cx, "past-0"));
        assert!(
            top(cx, "past-0") < top(cx, "past-1"),
            "newest scenario first"
        );
        assert!(
            cx.debug_bounds("past-2").is_none(),
            "two scenarios, two rows"
        );
        // The older attempt shows on demand.
        assert!(cx.debug_bounds("attempt-0-1").is_none());
        assert!(
            cx.debug_bounds("attempts-1").is_none(),
            "one attempt, no disclosure"
        );
        click(cx, "attempts-0");
        assert!(cx.debug_bounds("attempt-0-1").is_some());

        // A local active run opens here; one on intar does not.
        click(cx, "active-0");
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::ReadRun {
                run_id: "run-live".into()
            })
        );
    }

    #[gpui::test]
    fn a_past_run_opens_its_recap(cx: &mut TestAppContext) {
        let (view, cx, mut heard) = history_screen(cx);
        click(cx, "active-1");
        assert!(
            heard.try_recv().is_err(),
            "a run on intar opens the website"
        );
        click(cx, "past-0");
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::History(History::Recap {
                run_id: "run-new".into()
            }))
        );
        assert!(view.read_with(cx, |view, _| view.state.screen
            == Screen::Recap("run-new".into())));
    }

    fn recap() -> LocalRunRecapV1 {
        let check = |key: &str, status: &str| subspace::contract::LocalRunCheckV1 {
            key: key.into(),
            machine: "web".into(),
            title: key.into(),
            description: None,
            status: status.into(),
            optional: false,
        };
        let part = |key: &str, artifact: Option<&str>| LocalReplayPartV1 {
            key: key.into(),
            machine_label: Some("web".into()),
            part_label: key.into(),
            cast_artifact_id: artifact.map(str::to_owned),
            size_bytes: None,
        };
        LocalRunRecapV1 {
            run_id: "run-1".into(),
            scenario_id: "intar/web".into(),
            title: "Serve".into(),
            kind: "solved".into(),
            heading: "Solved".into(),
            description: "You completed this scenario.".into(),
            solve_duration_ms: Some(252_000),
            hints_revealed: 2,
            solution_used: true,
            checks: vec![check("listen", "verified"), check("serve", "missing")],
            replay: "ready".into(),
            replay_parts: vec![part("Part 1", Some("cast-1")), part("Part 2", None)],
        }
    }

    #[gpui::test]
    fn the_recap_shows_checks_help_and_replay_parts(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.screen = Screen::Recap("run-1".into());
        state.recap = Some(recap());
        let (view, cx, mut heard) = open(cx, state);
        for shown in [
            "1/2 verified",
            "Solve time: 04:12",
            "Hints used: 2 hints",
            "Full solution: Used",
            "part-0",
            "part-1",
        ] {
            assert!(cx.debug_bounds(shown).is_some(), "{shown}");
        }
        // A part without its recording cannot be played.
        click(cx, "part-1");
        assert!(heard.try_recv().is_err());
        click(cx, "part-0");
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::History(History::Replay {
                run_id: "run-1".into(),
                artifact_id: "cast-1".into()
            }))
        );
        // Another run's recording is not this part's; this one's gets its player.
        view.update(cx, |view, cx| {
            view.apply(
                Event::Replay {
                    run_id: "run-2".into(),
                    artifact_id: "cast-1".into(),
                    cast: vec![],
                },
                cx,
            )
        });
        assert!(view.read_with(cx, |view, _| view.replay.is_none()));
        view.update(cx, |view, cx| {
            view.apply(
                Event::Replay {
                    run_id: "run-1".into(),
                    artifact_id: "cast-1".into(),
                    cast: vec![],
                },
                cx,
            )
        });
        assert!(view.read_with(cx, |view, _| view.replay.is_some()));
        click(cx, "back-runs");
        assert_eq!(heard.try_recv().ok(), Some(Command::History(History::List)));
    }

    #[gpui::test]
    fn a_recap_being_saved_is_asked_again_until_it_is_left(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.screen = Screen::Recap("run-1".into());
        let (view, cx, mut heard) = open(cx, state);
        let mut saving = recap();
        saving.kind = "saving".into();
        view.update(cx, |view, cx| view.apply(Event::Recap(saving.clone()), cx));
        cx.executor().advance_clock(RECAP_POLL);
        cx.run_until_parked();
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::History(History::Recap {
                run_id: "run-1".into()
            }))
        );
        view.update(cx, |view, cx| {
            view.apply(Event::Recap(saving), cx);
            view.state.open_history();
        });
        cx.executor().advance_clock(RECAP_POLL);
        cx.run_until_parked();
        assert!(heard.try_recv().is_err(), "left: no more asking");
    }

    #[gpui::test]
    fn a_closed_run_offers_its_recap(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.screen = Screen::Run(run(false));
        let (view, cx, mut heard) = open(cx, state);
        click(cx, "see-recap");
        assert_eq!(
            heard.try_recv().ok(),
            Some(Command::History(History::Recap {
                run_id: "run-1".into()
            }))
        );
        assert!(view.read_with(cx, |view, _| view.state.screen
            == Screen::Recap("run-1".into())));
    }

    #[gpui::test]
    fn a_run_that_is_ending_cannot_be_ended_again(cx: &mut TestAppContext) {
        let mut state = State::default();
        state.screen = Screen::Run(run(true));
        state.machine = Some(MachineStatus::Saving);
        let (view, cx, mut heard) = open(cx, state);
        click(cx, "end");
        assert!(!view.read_with(cx, |view, _| view.ending));
        assert!(heard.try_recv().is_err());
    }
}
