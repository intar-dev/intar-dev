//! The intar desktop app (#391, #401). This first shell signs in and lists
//! the learner's courses.

mod engine;
mod local;
mod secrets;
mod state;
mod ui;

use gpui::prelude::*;
use gpui::{
    App, Bounds, ClickEvent, Context, Div, Entity, SharedString, Stateful, Subscription,
    TitlebarOptions, Window, WindowBounds, WindowOptions, div, px, rgb, size,
};
use gpui_platform::application;
use state::{Command, Event, Screen, State};
use tokio::sync::mpsc::UnboundedSender;
use ui::text_input::TextInput;
use ui::theme::{self, Palette, palette};
use url::Url;

struct Jumper {
    state: State,
    commands: UnboundedSender<Command>,
    /// Narrows the catalog to lectures whose title contains it.
    filter: Entity<TextInput>,
    _subscriptions: Vec<Subscription>,
}

impl Jumper {
    fn new(
        commands: UnboundedSender<Command>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let filter = cx.new(|cx| TextInput::new("Filter lectures", false, 0, cx));
        let subscriptions = vec![
            cx.observe(&filter, |_, _, cx| cx.notify()),
            cx.observe_window_appearance(window, |_, window, cx| theme::apply(window, cx)),
        ];
        theme::apply(window, cx);
        // The engine answers with the stored sign-in or with "signed out".
        let _ = commands.send(Command::Restore);
        Self {
            state: State::default(),
            commands,
            filter,
            _subscriptions: subscriptions,
        }
    }

    fn send(&self, command: Command) {
        // The engine is gone only while the app is quitting.
        let _ = self.commands.send(command);
    }

    fn apply(&mut self, event: Event, cx: &mut Context<Self>) {
        if let Event::SignInStarted(url) = &event {
            cx.open_url(url);
        }
        if let Some(next) = self.state.apply(event) {
            self.send(next);
        }
        cx.notify();
    }

    /// A button; `act` runs on a click and may change the screen or ask the engine.
    fn button(
        &self,
        p: &Palette,
        label: &'static str,
        primary: bool,
        act: impl Fn(&mut Self, &mut Context<Self>) + 'static,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let (bg, hover, text) = if primary {
            (p.accent, p.accent_hover, p.on_accent)
        } else {
            (p.panel, p.border, p.text)
        };
        div()
            .id(label)
            .px_4()
            .py_2()
            .rounded_md()
            .border_1()
            .border_color(rgb(if primary { p.accent } else { p.input_border }))
            .bg(rgb(bg))
            .hover(move |style| style.bg(rgb(hover)))
            .text_color(rgb(text))
            .cursor_pointer()
            .child(label)
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                act(this, cx);
                cx.notify();
            }))
    }

    /// A button that only asks the engine for something.
    fn command_button(
        &self,
        p: &Palette,
        label: &'static str,
        primary: bool,
        command: impl Fn() -> Command + 'static,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        self.button(p, label, primary, move |this, _| this.send(command()), cx)
    }

    fn catalog(&self, p: &Palette, cx: &Context<Self>) -> Div {
        if self.state.catalog.is_empty() {
            return card(p, "No courses yet")
                .child(muted(p, "Courses you can take show up here."))
                .child(div().flex().child(self.command_button(
                    p,
                    "Sign out",
                    false,
                    || Command::SignOut,
                    cx,
                )));
        }
        let filter = self.filter.read(cx).text().trim().to_lowercase();
        let courses = self
            .state
            .catalog
            .iter()
            .enumerate()
            .map(|(course_index, course)| {
                let lectures = course
                    .lectures
                    .iter()
                    .enumerate()
                    .filter(|(_, lecture)| lecture.title.to_lowercase().contains(&filter))
                    .map(|(lecture_index, lecture)| {
                        let hover = p.border;
                        div()
                            .id(("lecture", course_index * 10_000 + lecture_index))
                            .flex()
                            .justify_between()
                            .gap_4()
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .cursor_pointer()
                            .hover(move |style| style.bg(rgb(hover)))
                            .child(lecture.title.clone())
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(rgb(lecture_color(p, &lecture.state)))
                                    .child(lecture.state.replace('_', " ")),
                            )
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                this.state.open_lecture(course_index, lecture_index);
                                cx.notify();
                            }))
                    });
                card(p, course.title.clone())
                    .child(muted(p, course.summary.clone()))
                    .children(lectures)
            });
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                div()
                    .w(px(520.))
                    .flex()
                    .gap_3()
                    .items_center()
                    .child(div().flex_1().child(self.filter.clone()))
                    .child(self.command_button(p, "Sign out", false, || Command::SignOut, cx)),
            )
            .children(courses)
    }

    fn lecture(&self, p: &Palette, cx: &Context<Self>) -> Div {
        let Some((course, lecture)) = self.state.lecture() else {
            return card(p, "This lecture is no longer in your courses");
        };
        let back = self.button(
            p,
            "Back to courses",
            false,
            |this, _| {
                let reload = this.state.back_to_catalog();
                this.send(reload)
            },
            cx,
        );
        let facts = [
            Some(course.title.clone()),
            lecture.difficulty.clone(),
            lecture
                .estimated_minutes
                .map(|minutes| format!("{minutes} min")),
            Some(lecture.state.replace('_', " ")),
        ];
        let body = card(p, lecture.title.clone())
            .child(muted(
                p,
                facts.into_iter().flatten().collect::<Vec<_>>().join(" · "),
            ))
            .child(div().child(lecture.summary.clone()));
        let run = self.button(
            p,
            if lecture.active_run_id.is_some() {
                "Open the run"
            } else {
                "Start on this computer"
            },
            true,
            |this, _| {
                if let Some(command) = this.state.open_run() {
                    this.send(command);
                }
            },
            cx,
        );
        match (&lecture.scenario_id, lecture.state.as_str()) {
            (None, _) => body
                .child(muted(p, "This lecture has no lab."))
                .child(div().flex().child(back)),
            (Some(_), "locked") => body
                .child(muted(
                    p,
                    "Finish the lectures before this one to unlock its lab.",
                ))
                .child(div().flex().child(back)),
            (Some(_), "waiting_for_scenario") => body
                .child(muted(p, "This lecture's lab is not ready yet."))
                .child(div().flex().child(back)),
            (Some(_), _) => body.child(div().flex().gap_3().child(run).child(back)),
        }
    }

    fn run(&self, p: &Palette, run: &subspace::contract::LocalRunV1, cx: &Context<Self>) -> Div {
        let back = self.button(
            p,
            "Back to courses",
            false,
            |this, _| {
                let reload = this.state.back_to_catalog();
                this.send(reload)
            },
            cx,
        );
        let machines = run.machines.iter().map(|machine| {
            div()
                .flex()
                .justify_between()
                .gap_4()
                .child(machine.name.clone())
                .child(muted(
                    p,
                    format!(
                        "{} CPU · {} MiB memory · {} MiB disk",
                        machine.cpu_millis as f32 / 1000.0,
                        machine.memory_mib,
                        machine.disk_mib
                    ),
                ))
        });
        let body = card(p, run.scenario_id.clone())
            .child(muted(
                p,
                format!(
                    "{} · {}",
                    if run.active { "Active" } else { "Ended" },
                    run.state.replace('_', " ")
                ),
            ))
            .children(machines);
        if !run.active {
            return body.child(div().flex().child(back));
        }
        let run_id = run.run_id.clone();
        let end = self.command_button(
            p,
            "End run",
            true,
            move || Command::EndRun {
                run_id: run_id.clone(),
            },
            cx,
        );
        // The machine's own status: starting, booting, the lab's tasks, or why it failed.
        let status = match &self.state.machine {
            Some(status @ state::MachineStatus::Failed(_)) => {
                div().text_sm().text_color(rgb(p.red)).child(status.label())
            }
            Some(status @ state::MachineStatus::Ready { .. }) => div()
                .text_sm()
                .text_color(rgb(p.green))
                .child(status.label()),
            Some(status) => muted(p, status.label()),
            None => muted(p, "Waiting for the machine…"),
        };
        body.child(status)
            // ponytail: no terminal in the app yet (#402), so a ready lab cannot be worked on from here.
            .child(muted(
                p,
                "The terminal is not built into this version of the app yet.",
            ))
            .child(div().flex().gap_3().child(end).child(back))
    }
}

fn card(p: &Palette, title: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .flex_col()
        .gap_3()
        .p_6()
        .w(px(520.))
        .rounded_lg()
        .bg(rgb(p.panel))
        .border_1()
        .border_color(rgb(p.border))
        .child(div().text_xl().child(title.into()))
}

fn muted(p: &Palette, text: impl Into<SharedString>) -> Div {
    div().text_sm().text_color(rgb(p.muted)).child(text.into())
}

fn lecture_color(p: &Palette, state: &str) -> u32 {
    match state {
        "completed" => p.green,
        "in_progress" => p.accent,
        _ => p.muted,
    }
}

impl Render for Jumper {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = palette(cx);
        let content = match &self.state.screen {
            Screen::Starting => card(p, "Opening your keychain…").child(muted(
                p,
                "intar keeps your sign-in there. Your computer may ask you to unlock it.",
            )),
            Screen::SignedOut => card(p, "Sign in to intar")
                .child(muted(
                    p,
                    "Your browser opens intar's sign-in page. Labs then run on this computer.",
                ))
                .child(div().flex().child(self.command_button(
                    p,
                    "Sign in",
                    true,
                    || Command::SignIn,
                    cx,
                ))),
            Screen::SigningIn(url) => card(p, "Finish signing in in your browser")
                .child(muted(p, "If no browser opened, open this link yourself:"))
                .child(muted(p, url.clone())),
            Screen::Loading => card(p, "Loading your courses…"),
            Screen::Catalog => self.catalog(p, cx),
            Screen::Lecture { .. } => self.lecture(p, cx),
            Screen::OpeningRun => card(p, "Asking intar for the run…"),
            Screen::Run(run) => self.run(p, run, cx),
        };
        div()
            .id("jumper")
            .when_some(theme::ui_font(cx), |root, font| root.font_family(font))
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_4()
            .overflow_y_scroll()
            .bg(rgb(p.bg))
            .text_color(rgb(p.text))
            .children(
                self.state
                    .error
                    .clone()
                    .map(|error| div().max_w(px(520.)).text_color(rgb(p.red)).child(error)),
            )
            .child(content)
    }
}

fn main() {
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
    application().run(move |cx: &mut App| {
        ui::text_input::bind_keys(cx);
        theme::init_ui_font(cx);
        let bounds = Bounds::centered(None, size(px(960.), px(680.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("intar".into()),
                ..Default::default()
            }),
            window_min_size: Some(size(px(640.), px(480.))),
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
