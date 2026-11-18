//! The intar desktop app (#391, #401). This first shell signs in and lists
//! the learner's courses.

mod engine;
mod secrets;
mod state;
mod ui;

use gpui::prelude::*;
use gpui::{
    App, Bounds, ClickEvent, Context, Div, Entity, SharedString, Subscription, TitlebarOptions,
    Window, WindowBounds, WindowOptions, div, px, rgb, size,
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

    fn button(
        &self,
        p: &Palette,
        label: &'static str,
        command: fn() -> Command,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let hover = p.accent_hover;
        div()
            .id(label)
            .px_4()
            .py_2()
            .rounded_md()
            .bg(rgb(p.accent))
            .hover(move |style| style.bg(rgb(hover)))
            .text_color(rgb(p.on_accent))
            .cursor_pointer()
            .child(label)
            .on_click(cx.listener(move |this, _: &ClickEvent, _, _| this.send(command())))
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
                .child(
                    div()
                        .flex()
                        .child(self.button(p, "Sign in", || Command::SignIn, cx)),
                ),
            Screen::SigningIn(url) => card(p, "Finish signing in in your browser")
                .child(muted(p, "If no browser opened, open this link yourself:"))
                .child(muted(p, url.clone())),
            Screen::Loading => card(p, "Loading your courses…"),
            Screen::Catalog(courses) if courses.is_empty() => {
                card(p, "No courses yet").child(muted(p, "Courses you can take show up here."))
            }
            Screen::Catalog(courses) => {
                let filter = self.filter.read(cx).text().trim().to_lowercase();
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
                            .child(self.button(p, "Sign out", || Command::SignOut, cx)),
                    )
                    .children(courses.iter().map(|course| {
                        card(p, course.title.clone())
                            .child(muted(p, course.summary.clone()))
                            .children(
                                course
                                    .lectures
                                    .iter()
                                    .filter(|lecture| {
                                        lecture.title.to_lowercase().contains(&filter)
                                    })
                                    .map(|lecture| {
                                        div()
                                            .flex()
                                            .justify_between()
                                            .gap_4()
                                            .child(lecture.title.clone())
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .text_color(rgb(lecture_color(
                                                        p,
                                                        &lecture.state,
                                                    )))
                                                    .child(lecture.state.replace('_', " ")),
                                            )
                                    }),
                            )
                    }))
            }
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
                    .map(|error| div().text_color(rgb(p.red)).child(error)),
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
