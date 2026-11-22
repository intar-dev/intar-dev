//! Markdown from intar (course bodies, lecture theory, hints, solutions) as
//! GPUI elements.

use gpui::{Div, IntoElement, ParentElement, Styled, div};

use super::kit;
use super::theme::Palette;

/// Renders `source` as a column of blocks. Placeholder until the renderer lands.
pub fn markdown(p: &Palette, source: &str) -> Div {
    div().flex().flex_col().gap_2().child(kit::content(p, source.to_owned()).into_any_element())
}
