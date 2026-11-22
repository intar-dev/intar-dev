//! Plays a run's recorded terminal sessions (asciicast) in the recap.

use gpui::{Context, IntoElement, ParentElement, Render, Styled, Window, div};

/// One replay part's recording, ready to play. Placeholder until the player lands.
pub struct ReplayView {
    cast: Vec<u8>,
}

impl ReplayView {
    /// `cast` is the asciicast as `Subspace::replay` returns it.
    pub fn new(cast: Vec<u8>, _cx: &mut Context<Self>) -> Self {
        Self { cast }
    }
}

impl Render for ReplayView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(format!("{} bytes", self.cast.len()))
    }
}
