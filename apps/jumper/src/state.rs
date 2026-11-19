//! What the window shows, and how the engine's events change it. No GPUI
//! here, so it is tested without a window.

use subspace::contract::{CatalogCourseV1, CatalogLectureV1, LocalRunV1};

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
}

/// What the engine tells the UI.
#[derive(Debug)]
pub enum Event {
    /// The link to open in the learner's browser.
    SignInStarted(String),
    SignedIn,
    SignedOut,
    Catalog(Vec<CatalogCourseV1>),
    /// A run as the server holds it: after a start, a read or an end.
    Run(LocalRunV1),
    /// Where the run's machine on this computer stands.
    Machine(MachineStatus),
    Failed(String),
}

/// The run's machine on this computer, from its start to what its lab reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MachineStatus {
    Starting,
    Booting,
    /// The lab is up; `passed` of its `tasks` are solved.
    Ready {
        passed: usize,
        tasks: usize,
    },
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

    pub fn label(&self) -> String {
        match self {
            Self::Starting => "Starting the machine on this computer…".to_owned(),
            Self::Booting => "The machine is booting…".to_owned(),
            Self::Ready { passed, tasks } => {
                format!("The lab is ready. {passed} of {tasks} tasks solved.")
            }
            Self::Failed(reason) => reason.clone(),
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
    /// The lecture a run was opened from, to return to when the server refuses.
    opened_from: Option<(usize, usize)>,
}

impl State {
    /// Applies an event; the command to send next, if any.
    pub fn apply(&mut self, event: Event) -> Option<Command> {
        if !matches!(event, Event::Failed(_) | Event::Machine(_)) {
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
                }
                // The answer to a start or a read opens the run; news about a
                // run the learner has left does not pull them back to it.
                if same || self.screen == Screen::OpeningRun {
                    self.screen = Screen::Run(run);
                }
            }
            Event::Machine(status) => self.machine = Some(status),
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

    pub fn open_lecture(&mut self, course: usize, lecture: usize) {
        self.error = None;
        self.screen = Screen::Lecture { course, lecture };
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
        assert_eq!(
            state.machine.as_ref().map(MachineStatus::label).as_deref(),
            Some("The lab is ready. 1 of 3 tasks solved.")
        );
        state.apply(Event::Run(run(false)));
        assert_eq!(state.machine, None, "an ended run has no machine");

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
}
