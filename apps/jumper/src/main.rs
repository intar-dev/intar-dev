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
    SharedString, Stateful, Subscription, TitlebarOptions, Window, WindowBounds, WindowOptions,
    div, point, px, relative, rgb, size,
};
use gpui_platform::application;
use state::{Command, Event, MachineStatus, Screen, State};
use subspace::contract::{CatalogCourseV1, CatalogLectureV1, LocalRunV1};
use tokio::sync::mpsc::UnboundedSender;
use ui::kit::{self, Kind, Size};
use ui::terminal_view::TerminalView;
use ui::text_input::TextInput;
use ui::theme::{self, MONO, Palette, palette, term};
use url::Url;

/// The window's title bar is the app's own on macOS; elsewhere the system draws one.
const OWN_TITLE_BAR: bool = cfg!(target_os = "macos");

struct Jumper {
    state: State,
    commands: UnboundedSender<Command>,
    /// Narrows the lecture list to titles that contain it.
    search: Entity<TextInput>,
    /// The learner pressed End run and is asked whether they mean it.
    ending: bool,
    /// The terminal of the run's machine, once its SSH is up.
    terminal: Option<Entity<TerminalView>>,
    /// The terminal just opened and has not been given the keyboard yet.
    focus_terminal: bool,
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
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search = cx.new(|cx| TextInput::new("Search lectures", false, 0, cx));
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
            search,
            ending: false,
            terminal: None,
            focus_terminal: false,
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
        if let Some(next) = self.state.apply(event) {
            self.send(next);
        }
        if !matches!(&self.state.screen, Screen::Run(run) if run.active) {
            self.ending = false;
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

    fn back_to_catalog(
        &self,
        p: &Palette,
        kind: Kind,
        size: Size,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let button = kit::button(p, "back", kind, size, None, "Back to catalog", None);
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

    fn title_bar(&self, p: &Palette, cx: &Context<Self>) -> Div {
        let bar = div()
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
                let leave = if run.active {
                    let end = kit::button(
                        p,
                        "end",
                        Kind::QuietDanger,
                        Size::Small,
                        Some("stop"),
                        "End run",
                        None,
                    );
                    Self::on_click(end, cx, |this, _| this.ending = !this.ending)
                } else {
                    self.back_to_catalog(p, Kind::Outline, Size::Small, cx)
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
            Screen::Catalog | Screen::Lecture { .. } => {
                let catalog = div()
                    .h(px(30.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .rounded_lg()
                    .border_1()
                    .border_color(rgb(p.border))
                    .bg(rgb(p.panel))
                    .shadow_sm()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(kit::icon("grid", 14., p.accent))
                    .child("Catalog");
                let sign_out = kit::button(
                    p,
                    "sign-out",
                    Kind::Ghost,
                    Size::Small,
                    None,
                    "Sign out",
                    None,
                );
                // Offered between runs only: an update restarts the app.
                let update = self.state.update.clone().map(|version| {
                    let install = kit::button(
                        p,
                        "update",
                        Kind::Outline,
                        Size::Small,
                        None,
                        if self.state.updating {
                            "Updating…"
                        } else {
                            "Update and restart"
                        },
                        None,
                    );
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(px(10.))
                        .child(kit::label(p, format!("Version {version} is available")))
                        .child(Self::on_click(install, cx, |this, _| {
                            if !this.state.updating {
                                this.state.updating = true;
                                this.send(Command::InstallUpdate);
                            }
                        }))
                });
                bar.child(wordmark)
                    .child(catalog)
                    .child(fill)
                    .children(update)
                    .children(connected)
                    .child(Self::on_click(sign_out, cx, |this, _| {
                        this.send(Command::SignOut)
                    }))
            }
            _ => bar.child(wordmark),
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
                    Some("copy"),
                    "Copy link",
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
                            .child(Self::on_click(copy, cx, move |_, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(link.clone()));
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
                    let hover = p.track;
                    row.border_color(gpui::transparent_black())
                        .hover(move |style| style.bg(rgb(hover)))
                };
                Self::on_click(row, cx, move |this, _| this.state.open_course(index))
            }));

        let query = self.search.read(cx).text().trim().to_lowercase();
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
        let rows = course
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
                    this.state.open_lecture(shown, index)
                })
            });
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
                    .child(kit::card(p).children(rows)),
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
                        .child(kit::meta(p, "Pick a lecture to see its scenario.")),
                ),
            ),
            Some((index, lecture)) => {
                let start = kit::button(
                    p,
                    "start",
                    Kind::Primary,
                    Size::Large,
                    None,
                    if lecture.active_run_id.is_some() {
                        "Open the run"
                    } else {
                        "Start scenario"
                    },
                    Some("arrow-right"),
                );
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
                let foot = match blocked {
                    Some(why) if lecture.scenario_id.is_none() => foot.child(kit::caption(p, why)),
                    Some(why) => foot
                        .child(start.opacity(0.5).cursor_default())
                        .child(kit::caption(p, why)),
                    None => foot
                        .child(Self::on_click(start, cx, |this, _| {
                            if let Some(command) = this.state.open_run() {
                                this.send(command);
                            }
                        }))
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
                                .child(kit::label(
                                    p,
                                    format!("Lecture {} of {}", index + 1, course.lectures.len()),
                                ))
                                .child(kit::content(p, lecture.title.clone()))
                                .child(kit::support(p, lecture.summary.clone()).text_size(px(15.)))
                                .child(kit::meta(p, lecture_facts(lecture))),
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
                .child(div().flex().justify_end().child(self.back_to_catalog(p, Kind::Primary, Size::Medium, cx)));
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
        let side = kit::panel(p)
            .w(px(400.))
            .flex_none()
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
                    .child(kit::section(p, "Tasks"))
                    .child(kit::meta(
                        p,
                        match tasks {
                            Some(tasks) => format!("{passed} of {tasks} verified"),
                            None => "Begin when the machines are ready".to_owned(),
                        },
                    )),
            )
            .children(tasks.map(|tasks| kit::segments(p, passed, tasks, 4.).px_1()))
            .when(
                tasks.is_some_and(|tasks| tasks > 0 && passed == tasks),
                |side| {
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
                                    .child(kit::card_title(p, "All tasks verified"))
                                    .child(kit::meta(p, "Saved to your course as a local run")),
                            ),
                    )
                },
            )
            .children(self.state.error.clone().map(|error| kit::failure(p, error)))
            .child(kit::label(p, "Machines").px_1())
            .child(kit::card(p).mt(px(-8.)).children(machines));
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
        let (body, confirm) = match &self.state.screen {
            Screen::Catalog | Screen::Lecture { .. } => (self.catalog(p, cx), None),
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
    } = match engine::start(base) {
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
                ..Default::default()
            };
            let opened = cx.open_window(options, move |window, cx| {
                let view = cx.new(|cx| Jumper::new(commands, window, cx));
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
