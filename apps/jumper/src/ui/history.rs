//! The learner's runs and an ended run's recap, as the website's runs page
//! (`apps/web/src/components/app/pages/RunsList.tsx`) and recap
//! (`apps/web/src/components/app/run/RunRecap.tsx`) show them.

use gpui::prelude::*;
use gpui::{Context, Div, ElementId, FontWeight, SharedString, Stateful, div, px, rgb};
use subspace::contract::{LocalRunRecapV1, LocalRunSummaryV1};

use super::kit::{self, Kind, Size};
use super::theme::Palette;
use crate::Jumper;
use crate::state::{self, Scenario};

/// "5 minutes ago", "yesterday", as the website's `formatRelativeTime`.
pub fn ago(now: i64, at: i64) -> String {
    let diff = (now - at).max(0);
    let units = [
        ("year", 31_536_000_000),
        ("month", 2_592_000_000),
        ("week", 604_800_000),
        ("day", 86_400_000),
        ("hour", 3_600_000),
        ("minute", 60_000),
        ("second", 1000),
    ];
    for (unit, ms) in units {
        if diff >= ms || unit == "second" {
            let n = (diff + ms / 2) / ms;
            return match (n, unit) {
                (0, _) => "now".to_owned(),
                (1, "day") => "yesterday".to_owned(),
                (1, "week" | "month" | "year") => format!("last {unit}"),
                (1, _) => format!("1 {unit} ago"),
                _ => format!("{n} {unit}s ago"),
            };
        }
    }
    "now".to_owned()
}

/// "04:12", or "1:02:03" past an hour, as the website's solve times.
pub fn clock(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

/// The run's outcome in words, with its colour.
fn outcome(p: &Palette, run: &LocalRunSummaryV1) -> (String, u32) {
    match (run.activity.as_str(), run.outcome.as_str()) {
        ("foreground", _) => ("In progress".to_owned(), p.brand_text),
        ("background", _) => ("Finishing".to_owned(), p.warning),
        (_, "succeeded") => match run.solve_duration_ms {
            Some(ms) => (format!("Solved {}", clock(ms)), p.green),
            None => ("Solved".to_owned(), p.green),
        },
        (_, "failed") => ("Could not finish".to_owned(), p.red),
        (_, "cancelled") => ("Ended early".to_owned(), p.muted),
        _ => ("In progress".to_owned(), p.muted),
    }
}

/// The line under a run's title: outcome, attempt, help and when.
fn facts(p: &Palette, run: &LocalRunSummaryV1, attempt: Option<usize>) -> Div {
    let (word, color) = outcome(p, run);
    let now = now();
    let started = if run.activity == "foreground" {
        format!("started {}", ago(now, run.created_at))
    } else {
        ago(now, run.created_at)
    };
    let rest = [
        attempt.map(|n| format!("Attempt {n}")),
        run.solution_assisted.then(|| "Solution used".to_owned()),
        run.local.then(|| "Local run".to_owned()),
        Some(started),
    ];
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x_2()
        .child(kit::status(color, word))
        .children(
            rest.into_iter()
                .flatten()
                .map(|item| kit::meta(p, format!("· {item}"))),
        )
}

/// A whole row that is pressed as one, found by `id` in tests.
fn row(id: String) -> Stateful<Div> {
    let selector = id.clone();
    div()
        .id(ElementId::Name(id.into()))
        .debug_selector(move || selector)
        .cursor_pointer()
}

fn section(p: &Palette, title: &'static str) -> Div {
    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(kit::section(p, title))
}

impl Jumper {
    /// The learner's runs: active work, runs still being saved, and one row
    /// per scenario for the rest.
    pub(crate) fn history(&self, p: &Palette, cx: &Context<Self>) -> Div {
        let column = div()
            .w_full()
            .max_w(px(760.))
            .flex()
            .flex_col()
            .gap(px(28.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(kit::page(p, "Your runs"))
                    .child(kit::meta(
                        p,
                        "Every scenario you started, on this computer or on Intar.",
                    )),
            )
            .children(self.state.error.clone().map(|error| kit::failure(p, error)));
        let column = match self.state.history.as_deref() {
            // A failed load says why above instead.
            None if self.state.error.is_some() => column,
            None => column.child(kit::meta(p, "Loading your runs…")),
            Some([]) => {
                let browse = kit::button(
                    p,
                    "browse",
                    Kind::Primary,
                    Size::Small,
                    None,
                    "Browse courses",
                    None,
                );
                column.child(
                    kit::card(p)
                        .p_8()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap_2()
                        .child(kit::section(p, "No runs yet"))
                        .child(kit::support(
                            p,
                            "Launch a scenario to get a VM-backed environment — finished runs keep their replay here.",
                        ))
                        .child(div().pt_2().child(Self::on_click(browse, cx, |this, _| {
                            let reload = this.state.back_to_catalog();
                            this.send(reload);
                        }))),
                )
            }
            Some(runs) => {
                let groups = state::group_runs(runs);
                column
                    .when(!groups.active.is_empty(), |column| {
                        column.child(
                            section(p, "Active work").children(
                                groups
                                    .active
                                    .iter()
                                    .enumerate()
                                    .map(|(index, run)| self.active_card(p, index, run, cx)),
                            ),
                        )
                    })
                    .when(!groups.finishing.is_empty(), |column| {
                        column.child(section(p, "Finishing in background").child(
                            kit::card(p).children(groups.finishing.iter().enumerate().map(
                                |(index, run)| {
                                    self.run_row(p, format!("finishing-{index}"), run, None, cx)
                                        .when(index > 0, |row| row.border_t_1())
                                },
                            )),
                        ))
                    })
                    .when(!groups.past.is_empty(), |column| {
                        column.child(
                            section(p, "History").child(
                                kit::card(p).children(groups.past.iter().enumerate().map(
                                    |(index, scenario)| self.scenario(p, index, scenario, cx),
                                )),
                            ),
                        )
                    })
            }
        };
        kit::panel(p)
            .flex_1()
            .min_w_0()
            .flex()
            .overflow_hidden()
            .child(
                div()
                    .id("history")
                    .flex_1()
                    .overflow_y_scroll()
                    .flex()
                    .justify_center()
                    .p_8()
                    .child(column),
            )
    }

    /// An active run: a local one opens here, another one on the website.
    fn active_card(
        &self,
        p: &Palette,
        index: usize,
        run: &LocalRunSummaryV1,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let card = row(format!("active-{index}"))
            .flex()
            .items_center()
            .gap_4()
            .p_4()
            .bg(rgb(p.panel))
            .border_1()
            .border_color(rgb(p.border))
            .rounded_xl()
            .shadow_sm()
            .child(
                div()
                    .size(px(40.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(10.))
                    .border_1()
                    .border_color(rgb(p.brand_border))
                    .bg(rgb(p.brand_subtle))
                    .child(div().size(px(8.)).rounded_full().bg(rgb(p.accent))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(kit::card_title(p, run.title.clone()))
                    .child(facts(p, run, None))
                    .when(!run.local, |text| {
                        text.child(kit::caption(
                            p,
                            "This run is running on Intar. Open it in your browser.",
                        ))
                    }),
            );
        let run_id = run.run_id.clone();
        if run.local {
            let resume = kit::button(
                p,
                "resume",
                Kind::Primary,
                Size::Small,
                None,
                "Resume",
                Some("arrow-right"),
            );
            Self::on_click(card.child(resume), cx, move |this, _| {
                let read = this.state.resume(&run_id);
                this.send(read);
            })
        } else {
            let open = kit::button(
                p,
                "open-web",
                Kind::Outline,
                Size::Small,
                None,
                "Open in browser",
                Some("external"),
            );
            Self::on_click(card.child(open), cx, move |this, cx| {
                if let Ok(url) = this.base.join(&format!("runs/{run_id}")) {
                    cx.open_url(url.as_str());
                }
            })
        }
    }

    /// One run in a list; it opens the run's recap.
    fn run_row(
        &self,
        p: &Palette,
        id: String,
        run: &LocalRunSummaryV1,
        attempt: Option<usize>,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let action = if run.activity == "background" {
            "View progress"
        } else if run.has_replay {
            "Watch replay"
        } else {
            "View"
        };
        let hover = p.bg;
        let row = row(id)
            .flex()
            .items_center()
            .gap_4()
            .px_4()
            .py(px(13.))
            .border_color(rgb(p.border))
            .hover(move |style| style.bg(rgb(hover)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(kit::card_title(p, run.title.clone()))
                    .child(facts(p, run, attempt)),
            )
            .child(kit::button(
                p,
                "view",
                Kind::Outline,
                Size::Small,
                None,
                action,
                Some("arrow-right"),
            ));
        let run_id = run.run_id.clone();
        Self::on_click(row, cx, move |this, _| {
            let load = this.state.open_recap(&run_id);
            this.send(load);
        })
    }

    /// A scenario's latest run, and its older attempts on demand.
    fn scenario(&self, p: &Palette, index: usize, scenario: &Scenario, cx: &Context<Self>) -> Div {
        let total = scenario.attempts.len();
        let open = self.expanded.contains(&scenario.key);
        let mut attempts = scenario.attempts.iter();
        let latest = attempts.next().map(|(attempt, run)| {
            self.run_row(p, format!("past-{index}"), run, Some(*attempt), cx)
        });
        let toggle = (total > 1).then(|| {
            let key = scenario.key.clone();
            let hover = p.outline_hover;
            let toggle = row(format!("attempts-{index}"))
                .h(px(28.))
                .px(px(10.))
                .flex()
                .flex_none()
                .items_center()
                .rounded_lg()
                .border_1()
                .border_color(rgb(p.input_border))
                .bg(rgb(p.panel))
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .hover(move |style| style.bg(rgb(hover)))
                .child(SharedString::from(if open {
                    "Hide older attempts".to_owned()
                } else {
                    format!("Show all {total} attempts")
                }));
            Self::on_click(toggle, cx, move |this, _| {
                if !this.expanded.remove(&key) {
                    this.expanded.insert(key.clone());
                }
            })
        });
        div()
            .when(index > 0, |group| group.border_t_1())
            .border_color(rgb(p.border))
            .when(total > 1, |group| {
                group.child(
                    div()
                        .flex()
                        .justify_between()
                        .px_4()
                        .py_2()
                        .border_b_1()
                        .border_color(rgb(p.border))
                        .bg(rgb(p.subtle))
                        .child(kit::label(p, "Latest attempt"))
                        .child(kit::caption(p, format!("{total} attempts"))),
                )
            })
            .children(latest)
            .children(toggle.map(|toggle| {
                div()
                    .px_4()
                    .py_3()
                    .border_t_1()
                    .border_color(rgb(p.border))
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(div().flex().child(toggle))
                    .when(open, |older| {
                        older.child(kit::card(p).children(attempts.enumerate().map(
                            |(position, (attempt, run))| {
                                self.run_row(
                                    p,
                                    format!("attempt-{index}-{attempt}"),
                                    run,
                                    Some(*attempt),
                                    cx,
                                )
                                .when(position > 0, |row| row.border_t_1())
                            },
                        )))
                    })
            }))
    }

    /// An ended run's recap, or that it is still being saved.
    pub(crate) fn recap(&self, p: &Palette, cx: &Context<Self>) -> Div {
        let back = kit::button(
            p,
            "back-runs",
            Kind::Outline,
            Size::Small,
            None,
            "All runs",
            None,
        );
        let back = Self::on_click(back, cx, |this, _| {
            let reload = this.state.open_history();
            this.send(reload);
        });
        let column = div()
            .w_full()
            .max_w(px(760.))
            .flex()
            .flex_col()
            .gap(px(28.))
            .child(div().flex().child(back))
            .children(self.state.error.clone().map(|error| kit::failure(p, error)));
        let column = match &self.state.recap {
            None if self.state.error.is_some() => column,
            None => column.child(kit::meta(p, "Loading the recap…")),
            Some(recap) => {
                let column = column.child(header(p, recap));
                if recap.kind == "saving" {
                    column.child(kit::meta(
                        p,
                        "Your work is safe. This page updates by itself once the run is saved.",
                    ))
                } else {
                    column
                        .children(checks(p, recap))
                        .child(summary(p, recap))
                        .children(self.replay_section(p, recap, cx))
                        .child(self.next_step(p, recap, cx))
                }
            }
        };
        kit::panel(p)
            .flex_1()
            .min_w_0()
            .flex()
            .overflow_hidden()
            .child(
                div()
                    .id("recap")
                    .flex_1()
                    .overflow_y_scroll()
                    .flex()
                    .justify_center()
                    .p_8()
                    .child(column),
            )
    }

    fn replay_section(
        &self,
        p: &Palette,
        recap: &LocalRunRecapV1,
        cx: &Context<Self>,
    ) -> Option<Div> {
        let body = match recap.replay.as_str() {
            "pending" => kit::support(p, "Your replay is being prepared."),
            "ready" if !recap.replay_parts.is_empty() => {
                let chosen = self.state.replay.as_deref();
                let chips = recap.replay_parts.iter().enumerate().map(|(index, part)| {
                    let label = match &part.machine_label {
                        Some(machine) => format!("{} · {machine}", part.part_label),
                        None => part.part_label.clone(),
                    };
                    let on = part.cast_artifact_id.is_some()
                        && part.cast_artifact_id.as_deref() == chosen;
                    let chip = row(format!("part-{index}"))
                        .h(px(32.))
                        .px(px(10.))
                        .flex()
                        .flex_none()
                        .items_center()
                        .rounded_lg()
                        .border_1()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(label);
                    let chip = if on {
                        chip.bg(rgb(p.accent))
                            .border_color(rgb(p.accent))
                            .text_color(rgb(p.on_accent))
                    } else {
                        chip.bg(rgb(p.panel)).border_color(rgb(p.input_border))
                    };
                    match part.cast_artifact_id.clone() {
                        // A part whose recording is missing cannot be played.
                        None => chip.opacity(0.45),
                        Some(artifact_id) => {
                            let hover = p.outline_hover;
                            let chip = chip.when(!on, |chip| chip.hover(move |s| s.bg(rgb(hover))));
                            Self::on_click(chip, cx, move |this, _| {
                                if let Some(fetch) = this.state.play(&artifact_id) {
                                    this.send(fetch);
                                }
                            })
                        }
                    }
                });
                let player = chosen.map(|artifact_id| match &self.replay {
                    Some((shown, view)) if shown == artifact_id => {
                        div().h(px(440.)).child(view.clone())
                    }
                    // A refused fetch unchooses the part and says why above.
                    _ => kit::meta(p, "Loading the replay…"),
                });
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(div().flex().flex_wrap().gap_2().children(chips))
                    .child(player.unwrap_or_else(|| kit::meta(p, "Choose a part to play it.")))
            }
            "ready" | "unavailable" => kit::support(p, "Replay unavailable."),
            _ => return None,
        };
        Some(section(p, "Watch replay").child(body))
    }

    /// What to do next: the lecture again, or on through the course.
    fn next_step(&self, p: &Palette, recap: &LocalRunRecapV1, cx: &Context<Self>) -> Div {
        let solved = recap.kind == "solved";
        let lecture = self
            .state
            .catalog
            .iter()
            .enumerate()
            .find_map(|(at, course)| {
                course
                    .lectures
                    .iter()
                    .position(|lecture| lecture.scenario_id.as_deref() == Some(&recap.scenario_id))
                    .map(|lecture| (at, lecture))
            });
        let button =
            |label, trail| kit::button(p, "next", Kind::Primary, Size::Medium, None, label, trail);
        let action = match (solved, lecture) {
            (true, Some((course, _))) => {
                Self::on_click(button("Back to course", None), cx, move |this, _| {
                    this.state.open_course(course)
                })
            }
            (false, Some((course, lecture))) => Self::on_click(
                button("Read lecture and try again", Some("arrow-right")),
                cx,
                move |this, _| {
                    if let Some(load) = this.state.open_lecture(course, lecture) {
                        this.send(load);
                    }
                },
            ),
            (true, None) => Self::on_click(button("Back to my runs", None), cx, |this, _| {
                let reload = this.state.open_history();
                this.send(reload);
            }),
            (false, None) => Self::on_click(
                button("Browse courses", Some("arrow-right")),
                cx,
                |this, _| {
                    let reload = this.state.back_to_catalog();
                    this.send(reload);
                },
            ),
        };
        kit::card(p)
            .p_5()
            .flex()
            .flex_col()
            .gap_4()
            .child(kit::section(
                p,
                if solved {
                    "Keep learning"
                } else {
                    "Give it another try"
                },
            ))
            .child(div().flex().child(action))
    }
}

/// The outcome's badge, the heading and the line intar gives for it.
fn header(p: &Palette, recap: &LocalRunRecapV1) -> Div {
    let (glyph, color, fill, border) = match recap.kind.as_str() {
        "solved" => ("check-circle", p.green, p.green_subtle, p.green_border),
        "could_not_finish" => ("alert", p.red, p.red_subtle, p.red_border),
        "saving" => ("circle", p.brand_text, p.brand_subtle, p.brand_border),
        _ => ("power", p.muted, p.subtle, p.border),
    };
    div()
        .flex()
        .items_center()
        .gap_5()
        .child(
            div()
                .size(px(56.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(14.))
                .border_1()
                .border_color(rgb(border))
                .bg(rgb(fill))
                .child(kit::icon(glyph, 26., color)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap_1()
                .child(kit::feature(p, recap.heading.clone()))
                .child(kit::support(p, recap.description.clone())),
        )
}

/// The final checks and how many were verified.
fn checks(p: &Palette, recap: &LocalRunRecapV1) -> Option<Div> {
    if recap.checks.is_empty() {
        return None;
    }
    let verified = recap
        .checks
        .iter()
        .filter(|check| check.status == "verified")
        .count();
    let count = format!("{verified}/{} verified", recap.checks.len());
    let selector = count.clone();
    let rows = recap.checks.iter().enumerate().map(|(index, check)| {
        let (glyph, color, word) = if check.status == "verified" {
            ("check-circle", p.green, "Verified")
        } else {
            ("circle", p.warning, "Needs repair")
        };
        div()
            .flex()
            .items_start()
            .gap_3()
            .px_4()
            .py_3()
            .when(index > 0, |row| row.border_t_1())
            .border_color(rgb(p.border))
            .child(div().pt(px(2.)).child(kit::icon(glyph, 16., color)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .font_weight(FontWeight::MEDIUM)
                    .child(check.title.clone()),
            )
            .child(kit::label(p, word).text_color(rgb(color)))
    });
    Some(
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .justify_between()
                    .child(kit::section(p, "Final checks"))
                    .child(kit::meta(p, count).debug_selector(|| selector)),
            )
            .child(kit::segments(p, verified, recap.checks.len(), 4.))
            .child(kit::card(p).children(rows)),
    )
}

/// Solve time, hints used and whether the full solution was used.
fn summary(p: &Palette, recap: &LocalRunRecapV1) -> Div {
    let solve = recap
        .solve_duration_ms
        .filter(|_| recap.kind == "solved")
        .map(|ms| ("Solve time", clock(ms)));
    let hints = match recap.hints_revealed {
        1 => "1 hint".to_owned(),
        n => format!("{n} hints"),
    };
    let solution = if recap.solution_used {
        "Used"
    } else {
        "Not used"
    };
    let cells = solve.into_iter().chain([
        ("Hints used", hints),
        ("Full solution", solution.to_owned()),
    ]);
    kit::card(p)
        .flex()
        .children(cells.enumerate().map(|(index, (label, value))| {
            let selector = format!("{label}: {value}");
            div()
                .flex_1()
                .px_5()
                .py_4()
                .when(index > 0, |cell| cell.border_l_1())
                .border_color(rgb(p.border))
                .debug_selector(move || selector)
                .child(kit::label(p, label))
                .child(
                    div()
                        .pt_1()
                        .text_size(px(22.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(value),
                )
        }))
}

/// Unix milliseconds now.
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_when_and_how_long_like_the_website() {
        let minute = 60_000;
        assert_eq!(ago(10 * minute, 10 * minute), "now");
        assert_eq!(ago(10 * minute, 5 * minute), "5 minutes ago");
        assert_eq!(ago(48 * 60 * minute, 24 * 60 * minute), "yesterday");
        assert_eq!(ago(30 * 24 * 60 * minute, 0), "last month");
        assert_eq!(clock(252_000), "04:12");
        assert_eq!(clock(3_723_000), "01:02:03");
    }
}
