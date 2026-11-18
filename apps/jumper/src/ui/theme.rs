// SPDX-License-Identifier: Apache-2.0
// Derived from korora-tech/eloquawk; see apps/jumper/LICENSE-APACHE.

//! Colour palettes and the active-theme global.
//!
//! Ported from korora-tech/eloquawk's `src/ui/theme.rs` (Apache-2.0). The
//! tokens are the website's (`apps/web/src/styles/global.css`), light and
//! dark. Every view reads colours through [`palette`], so switching the
//! [`Theme`] global and refreshing the windows restyles the whole app. The
//! contrast tests hold both palettes to WCAG AA.
//
// ponytail: the theme follows the system; a saved preference and an override
// (eloquawk has both) come with the settings screen.

use gpui::{App, Global, SharedString, Window, WindowAppearance};

/// Every colour token, as `0xrrggbb`.
#[derive(Debug, PartialEq, Eq)]
pub struct Palette {
    pub bg: u32,
    /// Cards and other raised surfaces.
    pub panel: u32,
    pub border: u32,
    pub text: u32,
    pub muted: u32,
    /// Placeholders.
    pub disabled: u32,
    pub accent: u32,
    pub accent_hover: u32,
    pub on_accent: u32,
    pub green: u32,
    pub red: u32,
    /// Text selection fill; opaque, painted under the text.
    pub selection: u32,
    pub input_border: u32,
}

pub static LIGHT: Palette = Palette {
    bg: 0xf9f5ee,
    panel: 0xfffdf9,
    border: 0xe3dacb,
    text: 0x1f1a14,
    muted: 0x5b5348,
    disabled: 0x6a6155,
    accent: 0xc74700,
    accent_hover: 0xbe4000,
    on_accent: 0xfdfbf9,
    green: 0x0b7643,
    red: 0xba2b2b,
    selection: 0xeec7b0,
    input_border: 0x928777,
};

pub static DARK: Palette = Palette {
    bg: 0x1a1714,
    panel: 0x24201c,
    border: 0x322c26,
    text: 0xefe8df,
    muted: 0xaea597,
    disabled: 0x9d9386,
    accent: 0xf88a3d,
    accent_hover: 0xfc9d51,
    on_accent: 0x21110a,
    green: 0x62d397,
    red: 0xf97772,
    selection: 0x5a3a26,
    input_border: 0x73695e,
};

/// The palette every view draws with.
pub struct Theme(pub &'static Palette);

impl Global for Theme {}

/// The active palette (light until a theme is applied).
pub fn palette(cx: &App) -> &'static Palette {
    cx.try_global::<Theme>().map_or(&LIGHT, |t| t.0)
}

/// The palette for the window's appearance.
pub fn resolve(appearance: WindowAppearance) -> &'static Palette {
    match appearance {
        WindowAppearance::Dark | WindowAppearance::VibrantDark => &DARK,
        WindowAppearance::Light | WindowAppearance::VibrantLight => &LIGHT,
    }
}

/// Follows `window`'s appearance: sets the global and redraws every window
/// when the palette changed.
pub fn apply(window: &Window, cx: &mut App) {
    let next = resolve(window.appearance());
    if !std::ptr::eq(palette(cx), next) || !cx.has_global::<Theme>() {
        cx.set_global(Theme(next));
        cx.refresh_windows();
    }
}

/// UI font families, best first. gpui's Linux default is "IBM Plex Sans"; when that family is
/// not installed, cosmic-text falls back to a single face, so every `font_weight` renders
/// regular. The first family here that is installed is set on each window's root instead.
const UI_FONTS: &[&str] = &[
    "IBM Plex Sans",
    "Inter",
    "Cantarell",
    "Noto Sans",
    "Adwaita Sans",
    "DejaVu Sans",
    "Liberation Sans",
];

/// The UI font family chosen at start; `None` keeps gpui's default.
pub struct UiFont(pub Option<SharedString>);

impl Global for UiFont {}

/// The first [`UI_FONTS`] family among the installed ones.
pub fn pick_ui_font<'a>(installed: impl IntoIterator<Item = &'a str>) -> Option<&'static str> {
    let installed: std::collections::HashSet<&str> = installed.into_iter().collect();
    UI_FONTS.iter().copied().find(|f| installed.contains(f))
}

/// Chooses the UI font from the installed families; called once at start.
pub fn init_ui_font(cx: &mut App) {
    let names = cx.text_system().all_font_names();
    let font = pick_ui_font(names.iter().map(String::as_str)).map(SharedString::from);
    cx.set_global(UiFont(font));
}

/// The UI font family for a window root, when one was chosen.
pub fn ui_font(cx: &App) -> Option<SharedString> {
    cx.try_global::<UiFont>().and_then(|f| f.0.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_font_prefers_the_gpui_default_then_the_list_order() {
        assert_eq!(
            pick_ui_font(["DejaVu Sans", "Inter", "IBM Plex Sans"]),
            Some("IBM Plex Sans")
        );
        assert_eq!(pick_ui_font(["DejaVu Sans", "Inter"]), Some("Inter"));
        assert_eq!(pick_ui_font(["Inter Display", "Comic Mono"]), None);
        assert_eq!(pick_ui_font([]), None);
    }

    /// WCAG contrast ratio between two colours.
    fn contrast(a: u32, b: u32) -> f32 {
        let lum = |c: u32| {
            let ch = |shift: u32| {
                let v = ((c >> shift) & 0xff) as f32 / 255.0;
                if v <= 0.03928 {
                    v / 12.92
                } else {
                    ((v + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0)
        };
        let (la, lb) = (lum(a), lum(b));
        (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
    }

    #[test]
    fn both_palettes_meet_contrast() {
        for (name, p) in [("light", &LIGHT), ("dark", &DARK)] {
            for (sn, s) in [("bg", p.bg), ("panel", p.panel)] {
                for (fname, f) in [
                    ("text", p.text),
                    ("muted", p.muted),
                    ("red", p.red),
                    ("green", p.green),
                ] {
                    let r = contrast(f, s);
                    assert!(r >= 4.5, "{name}: {fname} on {sn} is {r:.2}");
                }
                // Placeholders, and the accent as a state colour.
                for (fname, f) in [
                    ("disabled", p.disabled),
                    ("accent", p.accent),
                    ("input_border", p.input_border),
                ] {
                    let r = contrast(f, s);
                    assert!(r >= 3.0, "{name}: {fname} on {sn} is {r:.2}");
                }
            }
            for accent in [p.accent, p.accent_hover] {
                let r = contrast(p.on_accent, accent);
                assert!(r >= 4.5, "{name}: on_accent on {accent:06x} is {r:.2}");
            }
            // Selected text stays readable over its highlight.
            assert!(contrast(p.text, p.selection) >= 4.5, "{name} selection");
        }
    }

    #[test]
    fn follows_the_system_appearance() {
        assert!(std::ptr::eq(resolve(WindowAppearance::Dark), &DARK));
        assert!(std::ptr::eq(resolve(WindowAppearance::VibrantDark), &DARK));
        assert!(std::ptr::eq(resolve(WindowAppearance::Light), &LIGHT));
        assert!(std::ptr::eq(
            resolve(WindowAppearance::VibrantLight),
            &LIGHT
        ));
    }
}
