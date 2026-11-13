//! What a markdown field may not hold. The web renders markdown without
//! HTML, and nothing but the text itself ships.

use pulldown_cmark::{Event, Parser, Tag};

/// The byte offset and the reason of the first problem, if any.
pub(super) fn check(text: &str) -> Option<(usize, &'static str)> {
    if let Some(offset) = unclosed_fence(text) {
        return Some((offset, "a code fence is never closed"));
    }
    Parser::new(text)
        .into_offset_iter()
        .find_map(|(event, range)| match event {
            Event::Html(_) | Event::InlineHtml(_) | Event::Start(Tag::HtmlBlock) => {
                Some((range.start, "raw HTML is not rendered"))
            }
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. })
                if !is_absolute(&dest_url) =>
            {
                Some((range.start, "a relative link or image target does not ship"))
            }
            _ => None,
        })
}

fn is_absolute(target: &str) -> bool {
    ["https://", "http://", "mailto:", "#"]
        .iter()
        .any(|prefix| target.starts_with(prefix))
}

/// The offset of a fence that is still open at the end. pulldown-cmark
/// closes it silently, as CommonMark says.
fn unclosed_fence(text: &str) -> Option<usize> {
    let mut open: Option<(usize, char, usize)> = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let indent = line.len() - line.trim_start_matches(' ').len();
        let rest = &line[indent..];
        let mark = rest
            .chars()
            .next()
            .filter(|mark| indent < 4 && matches!(mark, '`' | '~'));
        let length = mark.map_or(0, |mark| {
            rest.chars().take_while(|next| *next == mark).count()
        });
        match (open, mark) {
            (None, Some(mark)) if length >= 3 => open = Some((offset, mark, length)),
            (Some((_, fence, minimum)), Some(mark))
                if mark == fence && length >= minimum && rest[length..].trim().is_empty() =>
            {
                open = None;
            }
            _ => {}
        }
        offset += line.len();
    }
    open.map(|(offset, _, _)| offset)
}
