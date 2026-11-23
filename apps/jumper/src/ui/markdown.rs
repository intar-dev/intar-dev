//! Markdown from intar (course bodies, lecture theory, hints, solutions) as
//! GPUI elements. `parse` turns the source into blocks without a window;
//! `markdown` draws them. Tables, images and raw HTML come out as plain text:
//! nothing is fetched or executed.

use std::ops::Range;

use gpui::{
    App, Div, FontStyle, FontWeight, HighlightStyle, InteractiveText, ParentElement, SharedString,
    Styled, StyledText, UnderlineStyle, Window, div, px, relative, rgb,
};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

use super::kit;
use super::theme::{MONO, Palette};

/// The inline style of a run of text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Style {
    bold: bool,
    italic: bool,
    code: bool,
    link: Option<String>,
}

/// A styled byte range of a `Text`; unstyled text has no span.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Span {
    range: Range<usize>,
    style: Style,
}

/// Inline content: the text and the ranges that are not plain.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Text {
    text: String,
    spans: Vec<Span>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Block {
    Heading(u8, String),
    Paragraph(Text),
    List {
        start: Option<u64>,
        items: Vec<Vec<Block>>,
    },
    Code(String),
    Quote(Vec<Block>),
    Rule,
}

enum Frame {
    /// The root, a block quote or a list item.
    Blocks(Vec<Block>),
    List {
        start: Option<u64>,
        items: Vec<Vec<Block>>,
    },
}

#[derive(Default)]
struct Builder {
    stack: Vec<Frame>,
    inline: Option<Text>,
    style: Style,
    /// Set inside a code block, whose text is kept whole.
    code: Option<String>,
    heading: Option<u8>,
}

impl Builder {
    fn push(&mut self, block: Block) {
        self.flush();
        if let Some(Frame::Blocks(v)) = self.stack.last_mut() {
            v.push(block);
        }
    }

    /// Ends the open paragraph; a heading keeps only the plain text.
    fn flush(&mut self) {
        let Some(t) = self.inline.take() else { return };
        let block = match self.heading.take() {
            Some(level) => Block::Heading(level, t.text),
            None => Block::Paragraph(t),
        };
        if let Some(Frame::Blocks(v)) = self.stack.last_mut() {
            v.push(block);
        }
    }

    fn text(&mut self, s: &str) {
        if let Some(code) = &mut self.code {
            code.push_str(s);
            return;
        }
        let t = self.inline.get_or_insert_with(Text::default);
        let start = t.text.len();
        t.text.push_str(s);
        if self.style != Style::default() && !s.is_empty() {
            t.spans.push(Span {
                range: start..t.text.len(),
                style: self.style.clone(),
            });
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => self.flush(),
            Tag::Heading { level, .. } => {
                self.flush();
                self.heading = Some(level as u8);
                self.inline = Some(Text::default());
            }
            Tag::BlockQuote(_) => {
                self.flush();
                self.stack.push(Frame::Blocks(Vec::new()));
            }
            Tag::CodeBlock(_) => {
                self.flush();
                self.code = Some(String::new());
            }
            Tag::List(start) => {
                self.flush();
                self.stack.push(Frame::List {
                    start,
                    items: Vec::new(),
                });
            }
            Tag::Item => self.stack.push(Frame::Blocks(Vec::new())),
            Tag::Emphasis => self.style.italic = true,
            Tag::Strong => self.style.bold = true,
            Tag::Link { dest_url, .. } => self.style.link = Some(dest_url.into_string()),
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::Heading(_) => self.flush(),
            TagEnd::BlockQuote(_) => {
                self.flush();
                if let Some(Frame::Blocks(v)) = self.stack.pop() {
                    self.push(Block::Quote(v));
                }
            }
            TagEnd::CodeBlock => {
                if let Some(code) = self.code.take() {
                    self.push(Block::Code(code.trim_end_matches('\n').to_owned()));
                }
            }
            TagEnd::List(_) => {
                if let Some(Frame::List { start, items }) = self.stack.pop() {
                    self.push(Block::List { start, items });
                }
            }
            TagEnd::Item => {
                self.flush();
                if let Some(Frame::Blocks(v)) = self.stack.pop()
                    && let Some(Frame::List { items, .. }) = self.stack.last_mut()
                {
                    items.push(v);
                }
            }
            TagEnd::Emphasis => self.style.italic = false,
            TagEnd::Strong => self.style.bold = false,
            TagEnd::Link => self.style.link = None,
            TagEnd::TableCell => self.text(" "),
            TagEnd::TableHead | TagEnd::TableRow => self.text("\n"),
            TagEnd::Table => self.flush(),
            _ => {}
        }
    }
}

fn parse(source: &str) -> Vec<Block> {
    let mut b = Builder {
        stack: vec![Frame::Blocks(Vec::new())],
        ..Builder::default()
    };
    for event in Parser::new_ext(source, Options::ENABLE_TABLES) {
        match event {
            Event::Start(tag) => b.start(tag),
            Event::End(tag) => b.end(tag),
            Event::Text(s) | Event::Html(s) | Event::InlineHtml(s) => b.text(&s),
            Event::Code(s) => {
                let was = std::mem::replace(&mut b.style.code, true);
                b.text(&s);
                b.style.code = was;
            }
            Event::SoftBreak => b.text(" "),
            Event::HardBreak => b.text("\n"),
            Event::Rule => b.push(Block::Rule),
            _ => {}
        }
    }
    b.flush();
    match b.stack.pop() {
        Some(Frame::Blocks(v)) => v,
        _ => Vec::new(),
    }
}

/// Renders `source` as a column of blocks.
pub fn markdown(p: &Palette, source: &str) -> Div {
    let mut ids = 0;
    blocks(p, &parse(source), &mut ids)
        .text_size(px(14.))
        .line_height(relative(1.55))
        .text_color(rgb(p.text))
}

fn blocks(p: &Palette, list: &[Block], ids: &mut usize) -> Div {
    let mut col = div().flex().flex_col().gap_2();
    for b in list {
        col = col.child(block(p, b, ids));
    }
    col
}

fn block(p: &Palette, b: &Block, ids: &mut usize) -> Div {
    match b {
        Block::Heading(1, s) => kit::page(p, s.clone()),
        Block::Heading(2, s) => kit::section(p, s.clone()),
        Block::Heading(_, s) => kit::card_title(p, s.clone()),
        Block::Paragraph(t) => div().child(inline(p, t, ids)),
        Block::List { start, items } => {
            let mut col = div().flex().flex_col().gap_1();
            for (i, item) in items.iter().enumerate() {
                let marker = match start {
                    Some(n) => format!("{}.", n + i as u64),
                    None => "•".to_owned(),
                };
                col = col.child(
                    div()
                        .flex()
                        .gap_2()
                        .child(div().flex_none().text_color(rgb(p.muted)).child(marker))
                        .child(blocks(p, item, ids).flex_1().min_w_0()),
                );
            }
            col
        }
        Block::Code(s) => div()
            .font_family(MONO)
            .text_size(px(13.))
            .p_3()
            .rounded(px(6.))
            .border_1()
            .border_color(rgb(p.border))
            .bg(rgb(p.subtle))
            .child(s.clone()),
        Block::Quote(inner) => blocks(p, inner, ids)
            .pl_3()
            .border_l_2()
            .border_color(rgb(p.border_strong))
            .text_color(rgb(p.muted)),
        Block::Rule => div().h(px(1.)).bg(rgb(p.border)),
    }
}

/// One wrapped run of text; web links open in the browser.
fn inline(p: &Palette, t: &Text, ids: &mut usize) -> InteractiveText {
    let mut highlights = Vec::new();
    let mut mono = Vec::new();
    let mut links: Vec<(Range<usize>, String)> = Vec::new();
    for s in &t.spans {
        let mut h = HighlightStyle::default();
        if s.style.bold {
            h.font_weight = Some(FontWeight::SEMIBOLD);
        }
        if s.style.italic {
            h.font_style = Some(FontStyle::Italic);
        }
        if s.style.code {
            h.background_color = Some(rgb(p.subtle).into());
            mono.push((s.range.clone(), SharedString::from(MONO)));
        }
        if let Some(url) = &s.style.link {
            h.color = Some(rgb(p.accent).into());
            h.underline = Some(UnderlineStyle {
                thickness: px(1.),
                color: Some(rgb(p.accent).into()),
                wavy: false,
            });
            // Only web links open; anything else is styled, not followed.
            if url.starts_with("https://") || url.starts_with("http://") {
                links.push((s.range.clone(), url.clone()));
            }
        }
        highlights.push((s.range.clone(), h));
    }
    let styled = StyledText::new(t.text.clone())
        .with_highlights(highlights)
        .with_font_family_overrides(mono);
    *ids += 1;
    let (ranges, urls): (Vec<_>, Vec<_>) = links.into_iter().unzip();
    InteractiveText::new(("md", *ids), styled).on_click(
        ranges,
        move |i, _: &mut Window, cx: &mut App| {
            if let Some(url) = urls.get(i) {
                cx.open_url(url);
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(b: &Block) -> &Text {
        match b {
            Block::Paragraph(t) => t,
            other => panic!("not a paragraph: {other:?}"),
        }
    }

    #[test]
    fn headings_and_paragraphs() {
        let b = parse("# One\n\n### Three\n\nbody\ntext\n\n---\n");
        assert_eq!(b[0], Block::Heading(1, "One".into()));
        assert_eq!(b[1], Block::Heading(3, "Three".into()));
        assert_eq!(para(&b[2]).text, "body text");
        assert_eq!(b[3], Block::Rule);
    }

    #[test]
    fn inline_ranges() {
        let b = parse("a **b** `c` _d_ [e](https://x.test)");
        let t = para(&b[0]);
        assert_eq!(t.text, "a b c d e");
        let at = |i: usize| (&t.text[t.spans[i].range.clone()], &t.spans[i].style);
        assert_eq!(at(0).0, "b");
        assert!(at(0).1.bold);
        assert_eq!(at(1).0, "c");
        assert!(at(1).1.code);
        assert_eq!(at(2).0, "d");
        assert!(at(2).1.italic);
        assert_eq!(at(3).0, "e");
        assert_eq!(at(3).1.link.as_deref(), Some("https://x.test"));
    }

    #[test]
    fn nested_lists() {
        let b = parse("1. one\n   - inner\n2. two\n");
        let Block::List { start, items } = &b[0] else {
            panic!("not a list: {b:?}");
        };
        assert_eq!(*start, Some(1));
        assert_eq!(items.len(), 2);
        assert_eq!(para(&items[0][0]).text, "one");
        assert!(matches!(&items[0][1], Block::List { start: None, items } if items.len() == 1));
    }

    #[test]
    fn code_blocks_keep_whitespace() {
        let b = parse("```sh\nif x; then\n    y\nfi\n```\n\n    indented\n");
        assert_eq!(b[0], Block::Code("if x; then\n    y\nfi".into()));
        assert_eq!(b[1], Block::Code("indented".into()));
    }

    #[test]
    fn quotes_and_plain_html() {
        let b = parse("> quoted\n\n<b>raw</b>\n");
        assert!(matches!(&b[0], Block::Quote(q) if para(&q[0]).text == "quoted"));
        assert!(para(&b[1]).text.contains("raw"));
    }
}
