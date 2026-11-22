//! What the run's side panel teaches, as the website's learning panel shows it
//! (`apps/web/src/components/app/run/RunLearningPanel.tsx`): the checks, the
//! lecture, the hints and the full solution.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, div, px, rgb};
use subspace::contract::{LocalRunHintV1, LocalRunLearningV1};

use super::kit::{self, Kind, Size};
use super::markdown::markdown;
use super::theme::Palette;
use crate::Jumper;
use crate::state::{Command, Learn};

/// How many of the run's checks are verified.
pub fn verified(learning: &LocalRunLearningV1) -> usize {
    learning
        .checks
        .iter()
        .filter(|check| check.status == "verified")
        .count()
}

/// The hint ladders, each with its label and its hints by their position in
/// the run's list: the run's own first, then one per check in the checks'
/// order, then any whose check the run does not list.
fn ladders(learning: &LocalRunLearningV1) -> Vec<(String, Vec<(usize, &LocalRunHintV1)>)> {
    let mut keys: Vec<Option<&str>> = vec![None];
    let named = learning.checks.iter().map(|check| Some(check.key.as_str()));
    let hinted = learning.hints.iter().map(|hint| hint.check_key.as_deref());
    for key in named.chain(hinted) {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    let mut unnamed = 0;
    keys.into_iter()
        .filter_map(|key| {
            let hints: Vec<_> = learning
                .hints
                .iter()
                .enumerate()
                .filter(|(_, hint)| hint.check_key.as_deref() == key)
                .collect();
            if hints.is_empty() {
                return None;
            }
            let label = match key {
                None => "General guidance".to_owned(),
                Some(key) => match learning.checks.iter().find(|check| check.key == key) {
                    Some(check) => check.title.clone(),
                    None => {
                        unnamed += 1;
                        format!("Repair guidance {unnamed}")
                    }
                },
            };
            Some((label, hints))
        })
        .collect()
}

fn heading(p: &Palette, title: impl Into<SharedString>, count: Option<String>) -> Div {
    div()
        .flex()
        .items_baseline()
        .justify_between()
        .gap_3()
        .child(kit::label(p, title))
        .children(count.map(|count| kit::meta(p, count)))
}

impl Jumper {
    /// The checks, the lecture, the hints and the solution, under the
    /// panel's progress.
    pub(crate) fn learning(
        &self,
        p: &Palette,
        learning: &LocalRunLearningV1,
        cx: &Context<Self>,
    ) -> Div {
        let checks = learning.checks.iter().map(|check| {
            let (glyph, color, word) = match check.status.as_str() {
                "verified" => ("check-circle", p.green, "Verified"),
                "checking" => ("circle", p.disabled, "Checking"),
                _ => ("alert", p.red, "Needs repair"),
            };
            div()
                .flex()
                .items_start()
                .gap_3()
                .py(px(6.))
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
        let checks = if learning.checks.is_empty() {
            div().child(kit::support(p, "No checks are available yet."))
        } else {
            div().flex().flex_col().children(checks)
        };

        let lecture = div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_4()
            .border_t_1()
            .border_color(rgb(p.border))
            .child(kit::label(p, "Lecture"))
            .children(
                learning
                    .lecture_title
                    .clone()
                    .map(|title| kit::card_title(p, title)),
            )
            .child(markdown(p, &learning.lecture_markdown));

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(checks)
            .child(lecture)
            .child(self.hints(p, learning, cx))
            .child(self.solution(p, learning, cx))
    }

    fn hints(&self, p: &Palette, learning: &LocalRunLearningV1, cx: &Context<Self>) -> Div {
        let total = learning.hints.len();
        let used = learning.hints.iter().filter(|hint| hint.revealed).count();
        let section = div()
            .flex()
            .flex_col()
            .gap_3()
            .pt_4()
            .border_t_1()
            .border_color(rgb(p.border))
            .child(heading(
                p,
                "Hints",
                (total > 0).then(|| format!("{used}/{total} used")),
            ));
        if total == 0 {
            return section.child(kit::support(p, "No hints are available for this scenario."));
        }
        let ladders = ladders(learning);
        let several = ladders.len() > 1;
        let ladders = ladders.into_iter().map(|(label, hints)| {
            // Hints unlock in order: only the first one not yet revealed can
            // be, even if a malformed answer marks a later one.
            let next = hints
                .iter()
                .find(|(_, hint)| !hint.revealed)
                .map(|(_, hint)| &hint.key);
            let revealed = hints.iter().filter(|(_, hint)| hint.revealed).count();
            let rows = hints.iter().enumerate().map(|(index, (position, hint))| {
                let ordinal = format!("Hint {}", index + 1);
                let row = div()
                    .px_3()
                    .py(px(10.))
                    .when(index > 0, |row| row.border_t_1())
                    .border_color(rgb(p.border));
                if hint.revealed {
                    let title = hint
                        .title
                        .clone()
                        .filter(|title| !title.trim().is_empty())
                        .unwrap_or(ordinal);
                    return row
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(kit::card_title(p, title))
                        .children(hint.body_markdown.as_deref().map(|body| markdown(p, body)));
                }
                // A sealed hint shows its place in the ladder and nothing it says.
                let open = next == Some(&hint.key) && hint.unlocked;
                let reveal = open.then(|| {
                    let (run_id, hint_key) = (learning.run_id.clone(), hint.key.clone());
                    let button = kit::button(
                        p,
                        "reveal",
                        Kind::Outline,
                        Size::Small,
                        None,
                        "Reveal",
                        None,
                    );
                    // Each ladder has its own Reveal; the id keeps their clicks apart.
                    let key = hint.key.clone();
                    div()
                        .id(("hint", *position))
                        .debug_selector(move || format!("reveal-{key}"))
                        .child(Self::on_click(button, cx, move |this, _| {
                            this.send(Command::Learn(Learn::RevealHint {
                                run_id: run_id.clone(),
                                hint_key: hint_key.clone(),
                            }));
                        }))
                });
                row.flex()
                    .items_center()
                    .gap_2()
                    .min_h(px(36.))
                    .when(!open, |row| row.child(kit::icon("lock", 14., p.disabled)))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.))
                            .when(open, |word| word.font_weight(FontWeight::MEDIUM))
                            .when(!open, |word| word.text_color(rgb(p.disabled)))
                            .child(ordinal),
                    )
                    .children(reveal)
            });
            div()
                .flex()
                .flex_col()
                .gap_2()
                .when(several, |ladder| {
                    ladder.child(heading(
                        p,
                        label,
                        Some(format!("{revealed}/{}", hints.len())),
                    ))
                })
                .child(kit::card(p).children(rows))
        });
        section.children(ladders).when(used == total, |section| {
            section.child(kit::support(p, "You have used all available hints."))
        })
    }

    fn solution(&self, p: &Palette, learning: &LocalRunLearningV1, cx: &Context<Self>) -> Div {
        let solution = &learning.solution;
        let section = div()
            .flex()
            .flex_col()
            .gap_3()
            .pt_4()
            .border_t_1()
            .border_color(rgb(p.border))
            .child(kit::label(p, "Full solution"));
        let run_id = learning.run_id.clone();
        let reveal = move |this: &mut Self, _: &mut Context<Self>| {
            this.confirm_solution = false;
            this.send(Command::Learn(Learn::RevealSolution {
                run_id: run_id.clone(),
            }));
        };
        if solution.revealed {
            return section
                .child(kit::support(
                    p,
                    if solution.assisted {
                        "You used the full solution for this run."
                    } else {
                        "This solution unlocked after you completed the scenario."
                    },
                ))
                .child(match solution.body_markdown.as_deref() {
                    Some(body) => markdown(p, body),
                    None => kit::support(p, "Solution unavailable."),
                });
        }
        // Solved runs show it outright; before that it marks the run as
        // assisted, so the learner says they mean it.
        if solution.unlocked && learning.solved {
            let show = kit::button(
                p,
                "solution",
                Kind::Outline,
                Size::Medium,
                None,
                "Show the solution",
                None,
            );
            return section
                .child(kit::support(p, "The full solution is now available."))
                .child(div().flex().child(Self::on_click(show, cx, reveal)));
        }
        if self.confirm_solution {
            let keep = kit::button(
                p,
                "keep-trying",
                Kind::Outline,
                Size::Small,
                None,
                "Keep trying",
                None,
            );
            let confirm = kit::button(
                p,
                "reveal-solution",
                Kind::Primary,
                Size::Small,
                None,
                "Reveal solution",
                None,
            );
            return section.child(
                kit::card(p)
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(kit::card_title(p, "Reveal the full solution?"))
                    .child(kit::support(
                        p,
                        "This shows the full fix, marks this run as assisted, and keeps your checks and time.",
                    ))
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap_2()
                            .child(Self::on_click(keep, cx, |this, _| this.confirm_solution = false))
                            .child(Self::on_click(confirm, cx, reveal)),
                    ),
            );
        }
        let ask = kit::button(
            p,
            "solution",
            Kind::Outline,
            Size::Medium,
            Some("lock"),
            "Reveal the full solution",
            None,
        );
        section
            .child(kit::support(
                p,
                "Use this when you are ready to see the full fix.",
            ))
            .child(div().flex().child(Self::on_click(ask, cx, |this, _| {
                this.confirm_solution = true
            })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use subspace::contract::{LocalRunCheckV1, LocalRunSolutionV1};

    fn hint(key: &str, check_key: Option<&str>) -> LocalRunHintV1 {
        LocalRunHintV1 {
            key: key.into(),
            check_key: check_key.map(str::to_owned),
            title: None,
            revealed: false,
            unlocked: false,
            body_markdown: None,
        }
    }

    #[test]
    fn hints_are_laddered_by_their_check() {
        let check = |key: &str, title: &str| LocalRunCheckV1 {
            key: key.into(),
            machine: "web".into(),
            title: title.into(),
            description: None,
            status: "checking".into(),
            optional: false,
        };
        let learning = LocalRunLearningV1 {
            run_id: "run-1".into(),
            lecture_title: None,
            lecture_markdown: String::new(),
            solved: false,
            checks: vec![check("b", "Serve"), check("a", "Listen")],
            hints: vec![
                hint("1", Some("a")),
                hint("2", None),
                hint("3", Some("gone")),
                hint("4", Some("b")),
                hint("5", Some("a")),
            ],
            solution: LocalRunSolutionV1 {
                unlocked: false,
                assisted: false,
                revealed: false,
                body_markdown: None,
            },
        };
        let shape: Vec<(String, Vec<usize>)> = ladders(&learning)
            .into_iter()
            .map(|(label, hints)| (label, hints.into_iter().map(|(at, _)| at).collect()))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("General guidance".to_owned(), vec![1]),
                ("Serve".to_owned(), vec![3]),
                ("Listen".to_owned(), vec![0, 4]),
                ("Repair guidance 1".to_owned(), vec![2]),
            ]
        );
    }
}
