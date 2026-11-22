//! What the window shows, and how the engine's events change it. No GPUI
//! here, so it is tested without a window.

use subspace::contract::{
    CatalogCourseV1, CatalogLectureV1, LocalLectureAnswerV1, LocalRunLearningV1, LocalRunV1,
};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::terminal::Terminal;

/// What the UI asks of the engine.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    /// Sent once at launch: use the stored sign-in, if there is one.
    Restore,
    SignIn,
    SignOut,
    LoadCatalog,
    StartRun {
        scenario_id: String,
        organization_id: Option<String>,
    },
    ReadRun {
        run_id: String,
    },
    EndRun {
        run_id: String,
    },
    /// Sent once at launch: ask intar whether a newer app is offered.
    CheckUpdate,
    /// Download the offered app, put it in this one's place and start it.
    InstallUpdate,
    /// A call about what the learner reads; it never touches the machine.
    Learn(Learn),
}

/// The theory and help around a lab, as the website's lecture page and
/// learning panel show them.
#[derive(Debug, PartialEq, Eq)]
pub enum Learn {
    Lecture(LectureRef),
    /// Marks a lecture without a lab as read.
    CompleteLecture(LectureRef),
    /// The run's theory, checks, hints and solution. The engine asks it
    /// itself when a run opens and after each report of its machine.
    Run {
        run_id: String,
    },
    RevealHint {
        run_id: String,
        hint_key: String,
    },
    RevealSolution {
        run_id: String,
    },
}

/// A lecture as intar's routes name it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LectureRef {
    pub course_id: String,
    pub lecture_id: String,
    pub organization_id: Option<String>,
}

/// What the engine tells the UI.
#[derive(Debug)]
pub enum Event {
    /// The link to open in the learner's browser.
    SignInStarted(String),
    SignedIn,
    SignedOut,
    Catalog(Vec<CatalogCourseV1>),
    /// The theory of the lecture on screen, or that it is locked.
    Lecture(LocalLectureAnswerV1),
    /// The run's theory, checks, hints and solution: after it opened, after
    /// a report of its machine, and after a reveal.
    Learning(LocalRunLearningV1),
    /// A run as the server holds it: after a start, a read or an end.
    Run(LocalRunV1),
    /// Where the run's machine on this computer stands.
    Machine(MachineStatus),
    /// A machine's terminal is open; the receiver hears when its grid changed.
    Terminal(Terminal, UnboundedReceiver<()>),
    /// The version of a newer app that intar offers, or that there is none.
    Update(Option<String>),
    /// The update could not be installed; this app goes on as it is.
    UpdateFailed(String),
    /// The new app is in place and starting: this one quits.
    Restart,
    Failed(String),
}

/// The run's machine on this computer, from its start to what its lab reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MachineStatus {
    Starting,
    /// The machine's image is on its way: `done` of `total` bytes.
    Downloading {
        done: u64,
        total: u64,
    },
    Booting,
    /// The lab is up; `passed` of its `tasks` are solved.
    Ready {
        passed: usize,
        tasks: usize,
    },
    /// The run is ending: the machine has stopped and its sessions are sent
    /// to intar.
    Saving,
    /// In words the learner can read.
    Failed(String),
}

impl MachineStatus {
    /// What one report of the guest's Kino means for the learner.
    pub fn of(report: &zpm::reports::GuestReport) -> Self {
        use intar_contracts::bridge_v9::{CheckStatus, LabState};
        if let Some(reason) = &report.failed {
            return Self::Failed(format!("The machine failed to start: {reason}"));
        }
        match report.lab.state {
            LabState::Failed => Self::Failed("The lab on this machine failed to start.".to_owned()),
            LabState::Preparing => Self::Booting,
            LabState::Ready => Self::Ready {
                passed: report
                    .lab
                    .tasks
                    .iter()
                    .filter(|task| task.status == CheckStatus::Pass)
                    .count(),
                tasks: report.lab.tasks.len(),
            },
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub enum Screen {
    /// Until the engine has looked in the keychain.
    #[default]
    Starting,
    SignedOut,
    /// Waiting for the browser; the link is shown in case none opened.
    SigningIn(String),
    Loading,
    Catalog,
    /// One lecture of the catalog, by its course's and its own position.
    Lecture {
        course: usize,
        lecture: usize,
    },
    /// Waiting for the server's answer about a run.
    OpeningRun,
    Run(LocalRunV1),
}

#[derive(Debug, Default)]
pub struct State {
    pub screen: Screen,
    /// The courses as last loaded; the lecture screen points into them.
    pub catalog: Vec<CatalogCourseV1>,
    /// The last failure, shown until the next event that is not one.
    pub error: Option<String>,
    /// The machine of the run on screen, once the engine started on it.
    pub machine: Option<MachineStatus>,
    /// How far the machine's start came: 0 starting, 1 downloading, 2 booting,
    /// 3 ready. A
    /// failure keeps it, so the screen can say where the start stopped.
    pub stage: usize,
    /// The course the catalog shows.
    pub course: usize,
    /// The version of a newer app on offer.
    pub update: Option<String>,
    /// The offered app is being downloaded and installed.
    pub updating: bool,
    /// The theory of the lecture on screen, once intar answered.
    pub theory: Option<LocalLectureAnswerV1>,
    /// What the run on screen teaches, once intar answered.
    pub learning: Option<LocalRunLearningV1>,
    /// The lecture a run was opened from, to return to when the server refuses.
    opened_from: Option<(usize, usize)>,
}

impl State {
    /// Applies an event; the command to send next, if any.
    pub fn apply(&mut self, event: Event) -> Option<Command> {
        if !matches!(
            event,
            Event::Failed(_)
                | Event::Machine(_)
                | Event::Learning(_)
                | Event::Terminal(..)
                | Event::Update(_)
                | Event::UpdateFailed(_)
                | Event::Restart
        ) {
            self.error = None;
        }
        match event {
            Event::SignInStarted(url) => self.screen = Screen::SigningIn(url),
            Event::SignedIn => {
                self.screen = Screen::Loading;
                return Some(Command::LoadCatalog);
            }
            Event::SignedOut => {
                self.machine = None;
                self.stage = 0;
                self.catalog.clear();
                self.screen = Screen::SignedOut;
            }
            Event::Catalog(courses) => {
                self.catalog = courses;
                // A reload while a lecture or a run is open keeps that screen.
                if matches!(self.screen, Screen::Loading | Screen::Catalog)
                    || self.lecture().is_none() && matches!(self.screen, Screen::Lecture { .. })
                {
                    self.screen = Screen::Catalog;
                }
            }
            Event::Run(run) => {
                // A run that has ended has no machine; a new run starts without one.
                let same = matches!(&self.screen, Screen::Run(shown) if shown.run_id == run.run_id);
                if !run.active || !same {
                    self.machine = None;
                    self.stage = 0;
                }
                // The answer to a start or a read opens the run; news about a
                // run the learner has left does not pull them back to it.
                if same || self.screen == Screen::OpeningRun {
                    if !same {
                        self.learning = None;
                    }
                    self.screen = Screen::Run(run);
                }
            }
            Event::Lecture(answer) => {
                let (_, shown) = self.lecture()?;
                // An answer about a lecture the learner has since left.
                if answer
                    .lecture
                    .as_ref()
                    .is_some_and(|theory| theory.lecture_id != shown.lecture_id)
                {
                    return None;
                }
                // The lecture moved on, as after Mark as read: the catalog's
                // states are behind.
                let stale = answer
                    .lecture
                    .as_ref()
                    .is_some_and(|theory| theory.state != shown.state);
                self.theory = Some(answer);
                return stale.then_some(Command::LoadCatalog);
            }
            Event::Learning(learning) => {
                if matches!(&self.screen, Screen::Run(run) if run.run_id == learning.run_id) {
                    self.learning = Some(learning);
                }
            }
            // The window keeps the terminal; it is no part of what is tested here.
            Event::Terminal(..) => {}
            Event::Update(version) => {
                self.update = version;
                self.updating = false;
            }
            // The screen stays where it is: an update is beside the point of it.
            Event::UpdateFailed(message) => {
                self.updating = false;
                self.error = Some(message);
            }
            // The window quits; nothing of its state matters any more.
            Event::Restart => {}
            Event::Machine(status) => {
                self.stage = match status {
                    MachineStatus::Starting => 0,
                    MachineStatus::Downloading { .. } => 1,
                    MachineStatus::Booting => 2,
                    MachineStatus::Ready { .. } => 3,
                    MachineStatus::Saving | MachineStatus::Failed(_) => self.stage,
                };
                self.machine = Some(status);
            }
            Event::Failed(message) => {
                self.error = Some(message);
                self.screen = match std::mem::take(&mut self.screen) {
                    // A failed sign-in or first load has nothing to show: start over.
                    Screen::Starting | Screen::SigningIn(_) | Screen::Loading => Screen::SignedOut,
                    // A refused start or read returns to the lecture it came from.
                    Screen::OpeningRun => match self.opened_from {
                        Some((course, lecture)) => Screen::Lecture { course, lecture },
                        None => Screen::Catalog,
                    },
                    other => other,
                };
            }
        }
        None
    }

    /// The lecture on screen and its course.
    pub fn lecture(&self) -> Option<(&CatalogCourseV1, &CatalogLectureV1)> {
        let Screen::Lecture { course, lecture } = self.screen else {
            return None;
        };
        let course = self.catalog.get(course)?;
        Some((course, course.lectures.get(lecture)?))
    }

    /// Shows another course's lectures, with none of them selected.
    pub fn open_course(&mut self, course: usize) {
        self.error = None;
        self.course = course;
        self.screen = Screen::Catalog;
    }

    /// Shows a lecture; the command loads its theory.
    pub fn open_lecture(&mut self, course: usize, lecture: usize) -> Option<Command> {
        self.error = None;
        self.course = course;
        self.theory = None;
        self.screen = Screen::Lecture { course, lecture };
        self.lecture_ref()
            .map(|at| Command::Learn(Learn::Lecture(at)))
    }

    /// The lecture on screen, as intar's routes name it.
    pub fn lecture_ref(&self) -> Option<LectureRef> {
        let (course, lecture) = self.lecture()?;
        Some(LectureRef {
            course_id: course.course_id.clone(),
            lecture_id: lecture.lecture_id.clone(),
            organization_id: course.organization_id.clone(),
        })
    }

    /// Back to the courses, reloading them: a run changes a lecture's state.
    pub fn back_to_catalog(&mut self) -> Command {
        self.error = None;
        self.screen = Screen::Catalog;
        Command::LoadCatalog
    }

    /// Starts the lecture's lab here, or opens the run it already has.
    pub fn open_run(&mut self) -> Option<Command> {
        let Screen::Lecture { course, lecture } = self.screen else {
            return None;
        };
        let (in_course, shown) = self.lecture()?;
        let command = match (&shown.active_run_id, &shown.scenario_id) {
            (Some(run_id), _) => Command::ReadRun {
                run_id: run_id.clone(),
            },
            (None, Some(scenario_id)) => Command::StartRun {
                scenario_id: scenario_id.clone(),
                organization_id: in_course.organization_id.clone(),
            },
            (None, None) => return None,
        };
        self.error = None;
        self.opened_from = Some((course, lecture));
        self.screen = Screen::OpeningRun;
        Some(command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn course(lectures: Vec<CatalogLectureV1>) -> CatalogCourseV1 {
        CatalogCourseV1 {
            course_id: "c".into(),
            organization_id: Some("org-1".into()),
            organization_name: None,
            title: "Web".into(),
            summary: String::new(),
            body_markdown: String::new(),
            sequential: false,
            lectures,
        }
    }

    fn lecture(scenario_id: Option<&str>, active_run_id: Option<&str>) -> CatalogLectureV1 {
        CatalogLectureV1 {
            lecture_id: "l".into(),
            title: "Serve".into(),
            summary: String::new(),
            category: String::new(),
            tags: vec![],
            difficulty: None,
            estimated_minutes: None,
            scenario_id: scenario_id.map(str::to_owned),
            state: "available".into(),
            active_run_id: active_run_id.map(str::to_owned),
        }
    }

    fn run(active: bool) -> LocalRunV1 {
        LocalRunV1 {
            run_id: "run-1".into(),
            scenario_id: "intar/web".into(),
            state: "provisioning".into(),
            active,
            user_id: None,
            execution_id: None,
            generation: None,
            machines: vec![],
        }
    }

    #[test]
    fn follows_a_sign_in_to_the_catalog_and_back() {
        let mut state = State::default();
        assert_eq!(state.screen, Screen::Starting);
        // No stored sign-in.
        state.apply(Event::SignedOut);
        assert_eq!(state.screen, Screen::SignedOut);
        assert!(
            state
                .apply(Event::SignInStarted("https://intar.dev/x".into()))
                .is_none()
        );
        assert_eq!(
            state.screen,
            Screen::SigningIn("https://intar.dev/x".into())
        );
        assert_eq!(state.apply(Event::SignedIn), Some(Command::LoadCatalog));
        assert_eq!(state.screen, Screen::Loading);
        state.apply(Event::Catalog(vec![]));
        assert_eq!(state.screen, Screen::Catalog);

        // A failure with the catalog on screen keeps it; the message shows above it.
        state.apply(Event::Failed("offline".into()));
        assert_eq!(
            (&state.screen, state.error.as_deref()),
            (&Screen::Catalog, Some("offline"))
        );
        state.apply(Event::SignedOut);
        assert_eq!(
            (&state.screen, state.error.as_deref()),
            (&Screen::SignedOut, None)
        );

        // A failed sign-in returns to the start with its message.
        state.apply(Event::SignInStarted("u".into()));
        state.apply(Event::Failed(
            "the browser's answer does not belong to this sign-in".into(),
        ));
        assert_eq!(state.screen, Screen::SignedOut);
        assert!(state.error.is_some());

        // A keychain that cannot be read at launch: signed out, with the reason.
        let mut state = State::default();
        state.apply(Event::Failed("keychain locked".into()));
        assert_eq!(state.screen, Screen::SignedOut);
        assert_eq!(state.error.as_deref(), Some("keychain locked"));
    }

    #[test]
    fn opens_a_lecture_and_its_run() {
        let mut state = State::default();
        state.apply(Event::SignedIn);
        state.apply(Event::Catalog(vec![course(vec![
            lecture(Some("intar/web"), None),
            lecture(Some("intar/dns"), Some("run-9")),
            lecture(None, None),
        ])]));

        // A lecture with a lab and no run starts one, in its course's organization.
        state.open_lecture(0, 0);
        assert_eq!(
            state.open_run(),
            Some(Command::StartRun {
                scenario_id: "intar/web".into(),
                organization_id: Some("org-1".into())
            })
        );
        assert_eq!(state.screen, Screen::OpeningRun);
        // The server refuses: back on the lecture, with the reason.
        state.apply(Event::Failed(
            "no machine images exist for this computer's architecture yet".into(),
        ));
        assert_eq!(
            state.screen,
            Screen::Lecture {
                course: 0,
                lecture: 0
            }
        );
        assert!(state.error.is_some());

        // The server accepts: the run is on screen until the learner leaves it.
        state.open_run();
        state.apply(Event::Run(run(true)));
        assert_eq!(state.screen, Screen::Run(run(true)));
        state.apply(Event::Catalog(vec![]));
        assert_eq!(
            state.screen,
            Screen::Run(run(true)),
            "a reload does not close the run"
        );
        state.apply(Event::Run(run(false)));
        assert_eq!(state.back_to_catalog(), Command::LoadCatalog);
        assert_eq!(state.screen, Screen::Catalog);

        // News about a run arrives while the learner is elsewhere: they stay there.
        let mut state = State::default();
        state.apply(Event::SignedIn);
        state.apply(Event::Catalog(vec![]));
        state.apply(Event::Run(run(false)));
        assert_eq!(state.screen, Screen::Catalog);

        // The machine's status belongs to the run on screen and goes with it.
        let mut state = State {
            screen: Screen::OpeningRun,
            ..State::default()
        };
        state.apply(Event::Run(run(true)));
        state.apply(Event::Machine(MachineStatus::Booting));
        state.apply(Event::Machine(MachineStatus::Failed("no disk".into())));
        assert_eq!(state.stage, 2, "a failure keeps the stage it happened in");
        state.apply(Event::Machine(MachineStatus::Booting));
        state.apply(Event::Run(run(true)));
        assert_eq!(
            state.machine,
            Some(MachineStatus::Booting),
            "a re-read keeps it"
        );
        state.apply(Event::Machine(MachineStatus::Ready {
            passed: 1,
            tasks: 3,
        }));
        assert_eq!(state.stage, 3);
        state.apply(Event::Run(run(false)));
        assert_eq!(state.machine, None, "an ended run has no machine");
        assert_eq!(state.stage, 0);

        let mut state = State::default();
        state.apply(Event::SignedIn);
        state.apply(Event::Catalog(vec![course(vec![
            lecture(Some("intar/dns"), Some("run-9")),
            lecture(None, None),
        ])]));
        // A lecture that already has a run opens that run instead of starting one.
        state.apply(Event::Catalog(vec![course(vec![
            lecture(Some("intar/dns"), Some("run-9")),
            lecture(None, None),
        ])]));
        state.open_lecture(0, 0);
        assert_eq!(
            state.open_run(),
            Some(Command::ReadRun {
                run_id: "run-9".into()
            })
        );
        // A lecture without a lab has nothing to run.
        state.open_lecture(0, 1);
        assert_eq!(state.open_run(), None);
        assert_eq!(
            state.screen,
            Screen::Lecture {
                course: 0,
                lecture: 1
            }
        );

        // The lecture on screen vanished from a reloaded catalog: back to the courses.
        state.apply(Event::Catalog(vec![]));
        assert_eq!(state.screen, Screen::Catalog);
    }

    fn theory(lecture_id: &str, state: &str) -> LocalLectureAnswerV1 {
        LocalLectureAnswerV1 {
            protocol: 1,
            locked: false,
            lecture: Some(subspace::contract::LocalLectureV1 {
                course_id: "c".into(),
                lecture_id: lecture_id.into(),
                title: "Serve".into(),
                body_markdown: "# Serve".into(),
                ordinal: 1,
                count: 1,
                state: state.into(),
            }),
        }
    }

    fn learning(run_id: &str) -> LocalRunLearningV1 {
        LocalRunLearningV1 {
            run_id: run_id.into(),
            lecture_title: None,
            lecture_markdown: String::new(),
            solved: false,
            checks: vec![],
            hints: vec![],
            solution: subspace::contract::LocalRunSolutionV1 {
                unlocked: false,
                assisted: false,
                revealed: false,
                body_markdown: None,
            },
        }
    }

    #[test]
    fn a_lecture_loads_its_theory_and_a_read_one_reloads_the_catalog() {
        let mut state = State::default();
        state.apply(Event::SignedIn);
        state.apply(Event::Catalog(vec![course(vec![lecture(None, None)])]));
        assert_eq!(
            state.open_lecture(0, 0),
            Some(Command::Learn(Learn::Lecture(LectureRef {
                course_id: "c".into(),
                lecture_id: "l".into(),
                organization_id: Some("org-1".into()),
            })))
        );
        // An answer about another lecture is not this one's theory.
        assert_eq!(
            state.apply(Event::Lecture(theory("other", "available"))),
            None
        );
        assert_eq!(state.theory, None);
        assert_eq!(state.apply(Event::Lecture(theory("l", "available"))), None);
        assert!(state.theory.is_some());
        // Marked as read: the catalog still says available, so it reloads.
        assert_eq!(
            state.apply(Event::Lecture(theory("l", "completed"))),
            Some(Command::LoadCatalog)
        );
        // Opening a lecture forgets the last one's theory.
        state.open_lecture(0, 0);
        assert_eq!(state.theory, None);
    }

    #[test]
    fn learning_belongs_to_the_run_on_screen() {
        let mut state = State {
            screen: Screen::OpeningRun,
            error: Some("Could not reveal".into()),
            ..State::default()
        };
        state.apply(Event::Learning(learning("run-1")));
        assert_eq!(state.learning, None, "no run on screen yet");
        state.apply(Event::Run(run(true)));
        state.error = Some("Could not reveal".into());
        state.apply(Event::Learning(learning("run-2")));
        assert_eq!(state.learning, None, "another run's");
        state.apply(Event::Learning(learning("run-1")));
        assert_eq!(state.learning, Some(learning("run-1")));
        assert!(state.error.is_some(), "a refresh keeps what was said");
        // A re-read keeps it; another run opening drops it.
        state.apply(Event::Run(run(true)));
        assert!(state.learning.is_some());
        let mut other = run(true);
        other.run_id = "run-2".into();
        state.screen = Screen::OpeningRun;
        state.apply(Event::Run(other));
        assert_eq!(state.learning, None);
    }

    #[test]
    fn an_update_is_offered_beside_whatever_is_on_screen_and_a_failed_one_says_why() {
        let mut state = State {
            screen: Screen::Catalog,
            error: Some("an earlier failure".into()),
            ..State::default()
        };
        // An offer changes neither the screen nor what was said before it.
        assert_eq!(state.apply(Event::Update(Some("0.2.0".into()))), None);
        assert_eq!(state.update.as_deref(), Some("0.2.0"));
        assert_eq!(state.screen, Screen::Catalog);
        assert_eq!(state.error.as_deref(), Some("an earlier failure"));

        // A failed install is said, the offer stays, and the screen too.
        state.updating = true;
        state.apply(Event::UpdateFailed("The app was not updated.".into()));
        assert!(!state.updating);
        assert_eq!(state.error.as_deref(), Some("The app was not updated."));
        assert_eq!(state.update.as_deref(), Some("0.2.0"));
        assert_eq!(state.screen, Screen::Catalog);

        // No offer any more.
        state.apply(Event::Update(None));
        assert_eq!(state.update, None);
    }
}
