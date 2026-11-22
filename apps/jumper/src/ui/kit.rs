//! The design's building blocks: type roles, icons, buttons and surfaces.
//! They follow the app's design (`jumper.css` in the design canvas).

use std::borrow::Cow;

use gpui::prelude::*;
use gpui::{
    AssetSource, Div, FontWeight, Img, SharedString, Stateful, Svg, div, img, px, relative, rgb,
    svg,
};

use super::theme::{MONO, Palette};

/// The icons and the logo, compiled in.
pub struct Assets;

macro_rules! assets {
    ($($path:literal),* $(,)?) => {
        fn asset(path: &str) -> Option<&'static [u8]> {
            match path {
                $($path => Some(include_bytes!(concat!("../../assets/", $path))),)*
                _ => None,
            }
        }
    };
}

assets!(
    "logo.svg",
    "icons/alert.svg",
    "icons/arrow-right.svg",
    "icons/check-circle.svg",
    "icons/check.svg",
    "icons/circle.svg",
    "icons/copy.svg",
    "icons/external.svg",
    "icons/grid.svg",
    "icons/lock.svg",
    "icons/monitor.svg",
    "icons/power.svg",
    "icons/search.svg",
    "icons/stop.svg",
);

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        Ok(asset(path).map(Cow::Borrowed))
    }

    fn list(&self, _path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

/// One of `assets/icons`, by its file name without the extension.
pub fn icon(name: &'static str, size: f32, color: u32) -> Svg {
    svg()
        .path(format!("icons/{name}.svg"))
        .size(px(size))
        .flex_none()
        .text_color(rgb(color))
}

pub fn logo() -> Img {
    img("logo.svg").size(px(22.)).flex_none()
}

fn text(size: f32, line: f32, weight: FontWeight, color: u32, s: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(size))
        .line_height(relative(line))
        .font_weight(weight)
        .text_color(rgb(color))
        .child(s.into())
}

// The type roles, largest first.
pub fn feature(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(32., 1.15, FontWeight::SEMIBOLD, p.text, s)
}
pub fn content(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(26., 1.18, FontWeight::SEMIBOLD, p.text, s)
}
pub fn page(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(24., 1.25, FontWeight::SEMIBOLD, p.text, s)
}
pub fn section(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(18., 1.33, FontWeight::SEMIBOLD, p.text, s)
}
pub fn lede(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(17., 1.5, FontWeight::NORMAL, p.muted, s)
}
pub fn card_title(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(15., 1.4, FontWeight::SEMIBOLD, p.text, s)
}
pub fn support(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(14., 1.55, FontWeight::NORMAL, p.muted, s)
}
pub fn meta(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(13., 1.5, FontWeight::NORMAL, p.disabled, s)
}
pub fn label(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(12., 1.4, FontWeight::MEDIUM, p.disabled, s)
}
pub fn caption(p: &Palette, s: impl Into<SharedString>) -> Div {
    text(12., 1.45, FontWeight::NORMAL, p.disabled, s)
}

/// A machine name or other literal, set as inline code.
pub fn code(p: &Palette, s: impl Into<SharedString>) -> Div {
    div()
        .font_family(MONO)
        .text_size(px(13.))
        .px(px(5.))
        .rounded(px(5.))
        .border_1()
        .border_color(rgb(p.border))
        .bg(rgb(p.subtle))
        .child(s.into())
}

/// A status word with its dot, as in the title bar.
pub fn status(color: u32, s: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(7.))
        .text_size(px(13.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(color))
        .child(div().size(px(8.)).rounded_full().bg(rgb(color)))
        .child(s.into())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Primary,
    Outline,
    Ghost,
    Danger,
    /// An outline button whose label warns.
    QuietDanger,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Size {
    Small,
    Medium,
    Large,
}

/// A button without its click; `lead` and `trail` are icons around the label.
/// Its hover follows the website's buttons (`apps/web/src/components/ui/button.tsx`).
pub fn button(
    p: &Palette,
    id: &'static str,
    kind: Kind,
    size: Size,
    lead: Option<&'static str>,
    label: &'static str,
    trail: Option<&'static str>,
) -> Stateful<Div> {
    let (bg, fg, hover_border) = match kind {
        Kind::Primary => (p.accent_hover, p.on_accent, None),
        Kind::Danger => (p.red_hover, p.on_red, None),
        Kind::Outline => (p.outline_hover, p.text, Some(p.border_strong)),
        Kind::QuietDanger => (p.red_subtle, p.red, Some(p.red)),
        Kind::Ghost => (p.subtle, p.text, None),
    };
    surface(p, id, kind, size, lead, label, trail)
        .cursor_pointer()
        .hover(move |style| {
            let style = style.bg(rgb(bg)).text_color(rgb(fg));
            match hover_border {
                Some(border) => style.border_color(rgb(border)),
                None => style,
            }
        })
}

/// A button that cannot be pressed now: dimmed, with no hover and no pointer.
pub fn inert_button(
    p: &Palette,
    id: &'static str,
    kind: Kind,
    size: Size,
    lead: Option<&'static str>,
    label: &'static str,
    trail: Option<&'static str>,
) -> Stateful<Div> {
    surface(p, id, kind, size, lead, label, trail).opacity(0.45)
}

fn surface(
    p: &Palette,
    id: &'static str,
    kind: Kind,
    size: Size,
    lead: Option<&'static str>,
    label: &'static str,
    trail: Option<&'static str>,
) -> Stateful<Div> {
    let (bg, fg, border) = match kind {
        Kind::Primary => (Some(p.accent), p.on_accent, None),
        Kind::Danger => (Some(p.red), p.on_red, None),
        Kind::Outline => (Some(p.panel), p.text, Some(p.input_border)),
        Kind::QuietDanger => (Some(p.panel), p.red, Some(p.red_border)),
        Kind::Ghost => (None, p.muted, None),
    };
    let (height, pad, text_size, glyph) = match size {
        Size::Small => (32., 10., 13., 14.),
        Size::Medium => (36., 14., 14., 16.),
        Size::Large => (44., 18., 15., 16.),
    };
    div()
        .id(id)
        // Tests find the button by its id.
        .debug_selector(|| id.to_owned())
        .h(px(height))
        .px(px(pad))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap_2()
        .rounded_lg()
        .border_1()
        .border_color(border.map_or(gpui::transparent_black(), |c| rgb(c).into()))
        .when_some(bg, |b, bg| b.bg(rgb(bg)))
        .when(kind != Kind::Ghost, |b| b.shadow_sm())
        .text_size(px(text_size))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(fg))
        .children(lead.map(|name| icon(name, glyph, fg)))
        .child(label)
        .children(trail.map(|name| icon(name, glyph, fg)))
}

/// The window's large areas: the page behind cards.
pub fn panel(p: &Palette) -> Div {
    div()
        .bg(rgb(p.bg))
        .border_1()
        .border_color(rgb(p.border))
        .rounded_xl()
        .shadow_sm()
}

/// A raised surface; with rows in it, a list whose rows are divided by lines.
pub fn card(p: &Palette) -> Div {
    div()
        .bg(rgb(p.panel))
        .border_1()
        .border_color(rgb(p.border))
        .rounded_xl()
        .shadow_sm()
        .overflow_hidden()
}

/// A line of segments, `done` of `total` filled: progress through a course or a lab.
pub fn segments(p: &Palette, done: usize, total: usize, height: f32) -> Div {
    div().flex().gap(px(3.)).children((0..total).map(|index| {
        div()
            .h(px(height))
            .flex_1()
            .rounded(px(2.))
            .bg(rgb(if index < done { p.green } else { p.track }))
    }))
}

/// A notice that something went wrong, in the learner's words.
pub fn failure(p: &Palette, message: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .gap(px(10.))
        .px(px(14.))
        .py_3()
        .rounded(px(10.))
        .border_1()
        .border_color(rgb(p.red_border))
        .bg(rgb(p.red_subtle))
        .text_size(px(13.))
        .child(div().pt(px(2.)).child(icon("alert", 16., p.red)))
        .child(div().flex_1().min_w_0().child(message.into()))
}
