//! What the window shows, and how the engine's events change it. No GPUI
//! here, so it is tested without a window.

use subspace::contract::CatalogCourseV1;

/// What the UI asks of the engine.
#[derive(Debug)]
pub enum Command {
    /// Sent once at launch: use the stored sign-in, if there is one.
    Restore,
    SignIn,
    SignOut,
    LoadCatalog,
}

/// What the engine tells the UI.
#[derive(Debug)]
pub enum Event {
    /// The link to open in the learner's browser.
    SignInStarted(String),
    SignedIn,
    SignedOut,
    Catalog(Vec<CatalogCourseV1>),
    Failed(String),
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
    Catalog(Vec<CatalogCourseV1>),
}

#[derive(Debug, Default)]
pub struct State {
    pub screen: Screen,
    /// The last failure, shown until the next event that is not one.
    pub error: Option<String>,
}

impl State {
    /// Applies an event; the command to send next, if any.
    pub fn apply(&mut self, event: Event) -> Option<Command> {
        if !matches!(event, Event::Failed(_)) {
            self.error = None;
        }
        match event {
            Event::SignInStarted(url) => self.screen = Screen::SigningIn(url),
            Event::SignedIn => {
                self.screen = Screen::Loading;
                return Some(Command::LoadCatalog);
            }
            Event::SignedOut => self.screen = Screen::SignedOut,
            Event::Catalog(courses) => self.screen = Screen::Catalog(courses),
            Event::Failed(message) => {
                self.error = Some(message);
                // A failed sign-in or first load has nothing to show: start over.
                if matches!(
                    self.screen,
                    Screen::Starting | Screen::SigningIn(_) | Screen::Loading
                ) {
                    self.screen = Screen::SignedOut;
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(matches!(
            state.apply(Event::SignedIn),
            Some(Command::LoadCatalog)
        ));
        assert_eq!(state.screen, Screen::Loading);
        state.apply(Event::Catalog(vec![]));
        assert_eq!(state.screen, Screen::Catalog(vec![]));

        // A failure with a catalog on screen keeps it; the message shows above it.
        state.apply(Event::Failed("offline".into()));
        assert_eq!(
            (&state.screen, state.error.as_deref()),
            (&Screen::Catalog(vec![]), Some("offline"))
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
}
