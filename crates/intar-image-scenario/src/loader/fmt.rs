//! `fmt`: the canonical layout of `intar.hcl`, `images/*.hcl` and
//! `scenarios/*/scenario.hcl`. hcl-edit has no formatter and `hcl::format`
//! drops comments, so this prints the parsed structure itself:
//!
//! - two spaces per block level;
//! - `=` aligned within a run of attributes that no blank line, comment or
//!   block interrupts;
//! - a block stays on one line only when it holds at most one single-line
//!   attribute and no comment; every other block is expanded;
//! - at most one blank line in a row, none at the start or end of a block;
//! - comments are kept, each on its own line at the block's indentation, or
//!   after the structure on its line;
//! - expressions are kept as written, heredocs byte for byte except that a
//!   whitespace-only line inside a heredoc becomes empty.
//!
//! Formatting formatted text changes nothing.

use super::Diagnostic;
use hcl::edit::expr::Expression;
use hcl::edit::structure::{Block, Body, Structure};
use hcl::edit::{Decorate as _, RawString, Span as _};
use std::ops::Range;
use std::path::{Path, PathBuf};

const INDENT: &str = "  ";

type Formatted<T> = Result<T, (Option<Range<usize>>, String)>;

/// What stands before a structure: blank lines and comments, in order.
#[derive(Clone, Copy, PartialEq)]
enum Line<'a> {
    Blank,
    Comment(&'a str),
}

fn is_comment(raw: &str) -> bool {
    let text = raw.trim();
    !text.is_empty()
}

fn decor_text(raw: Option<&RawString>) -> &str {
    raw.map_or("", |raw| raw)
}

/// The blank lines and comments of a decor prefix. It starts right after
/// the previous line's end, and its last segment is the indentation on the
/// structure's own line.
fn lines(prefix: &str) -> Vec<Line<'_>> {
    let segments: Vec<&str> = prefix.split('\n').collect();
    let last = segments.len() - 1;
    segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| match segment.trim() {
            "" if index < last => Some(Line::Blank),
            "" => None,
            text => Some(Line::Comment(text)),
        })
        .collect()
}

struct Printer<'a> {
    text: &'a str,
    out: String,
}

impl Printer<'_> {
    fn raw(&self, span: Option<Range<usize>>) -> Formatted<&str> {
        span.clone()
            .and_then(|span| self.text.get(span))
            .ok_or((span, "fmt lost track of a span".to_owned()))
    }

    /// Spaces only: a comment here has no canonical place.
    fn plain(&self, raw: Option<&RawString>, span: Option<Range<usize>>) -> Formatted<()> {
        if is_comment(decor_text(raw)) {
            return Err((
                span,
                "fmt keeps comments only on their own line or at the end of a line; move this one"
                    .to_owned(),
            ));
        }
        Ok(())
    }

    fn line(&mut self, depth: usize, text: &str) {
        self.out.push_str(&INDENT.repeat(depth));
        self.out.push_str(text);
        self.out.push('\n');
    }

    /// A comment after a structure, at the column the author chose.
    fn trailing(&mut self, raw: Option<&RawString>) {
        let raw = decor_text(raw).trim_end();
        if raw.trim().is_empty() {
            return;
        }
        // Before the line's `\n`.
        self.out.pop();
        if !raw.starts_with([' ', '\t']) {
            self.out.push(' ');
        }
        self.out.push_str(raw);
        self.out.push('\n');
    }

    fn body(&mut self, body: &Body, depth: usize) -> Formatted<()> {
        let structures: Vec<&Structure> = body.iter().collect();
        let leading: Vec<Vec<Line>> = structures
            .iter()
            .map(|structure| lines(decor_text(structure.decor().prefix())))
            .collect();
        // Alignment runs: attributes not interrupted by a blank line, a
        // comment or a block.
        let mut widths = vec![0; structures.len()];
        let mut start = 0;
        for index in 0..=structures.len() {
            let breaks = match structures.get(index) {
                None => true,
                Some(Structure::Block(_)) => true,
                Some(Structure::Attribute(_)) => {
                    index > 0
                        && (!leading[index].is_empty()
                            || matches!(structures[index - 1], Structure::Block(_)))
                }
            };
            if breaks {
                let width = structures[start..index]
                    .iter()
                    .filter_map(|structure| structure.as_attribute())
                    .map(|attribute| attribute.key.as_str().len())
                    .max()
                    .unwrap_or(0);
                widths[start..index].fill(width);
                start = index;
            }
        }

        let mut pending_blank = false;
        let mut first = true;
        for (index, structure) in structures.iter().enumerate() {
            for line in &leading[index] {
                match line {
                    Line::Blank => pending_blank = !first,
                    Line::Comment(text) => {
                        if pending_blank {
                            self.out.push('\n');
                        }
                        pending_blank = false;
                        first = false;
                        self.line(depth, text);
                    }
                }
            }
            if pending_blank {
                self.out.push('\n');
            }
            pending_blank = false;
            first = false;
            match structure {
                Structure::Attribute(attribute) => {
                    self.plain(attribute.key.decor().suffix(), attribute.key.span())?;
                    self.plain(attribute.value.decor().prefix(), attribute.value.span())?;
                    let key = attribute.key.as_str();
                    let value = self.value(&attribute.value)?;
                    let padding = " ".repeat(widths[index].saturating_sub(key.len()));
                    self.line(depth, &format!("{key}{padding} = {value}"));
                }
                Structure::Block(block) => self.block(block, depth)?,
            }
            self.trailing(structure.decor().suffix());
        }
        // Comments after the last structure.
        for line in lines(decor_text(body.decor().suffix())) {
            match line {
                Line::Blank => pending_blank = !first,
                Line::Comment(text) => {
                    if pending_blank {
                        self.out.push('\n');
                    }
                    pending_blank = false;
                    first = false;
                    self.line(depth, text);
                }
            }
        }
        Ok(())
    }

    fn value(&self, expression: &Expression) -> Formatted<String> {
        let raw = self.raw(expression.span())?;
        let strips = matches!(expression, Expression::HeredocTemplate(heredoc) if heredoc.indent().is_some());
        if !strips {
            return Ok(raw.to_owned());
        }
        // Whitespace on a blank content line lowers the indentation `<<-`
        // strips, so it goes.
        let parts: Vec<&str> = raw.split_inclusive('\n').collect();
        Ok(parts
            .iter()
            .enumerate()
            .map(|(index, part)| {
                let content = index > 0 && index + 1 < parts.len();
                if content && part.trim().is_empty() {
                    "\n"
                } else {
                    part
                }
            })
            .collect())
    }

    fn block(&mut self, block: &Block, depth: usize) -> Formatted<()> {
        self.plain(block.ident.decor().suffix(), block.ident.span())?;
        let mut header = block.ident.as_str().to_owned();
        for label in &block.labels {
            self.plain(label.decor().prefix(), label.span())?;
            self.plain(label.decor().suffix(), label.span())?;
            header.push(' ');
            header.push_str(self.raw(label.span())?);
        }
        let body = &block.body;
        let opener = decor_text(body.decor().prefix()).trim();
        let closer = lines(decor_text(body.decor().suffix()));
        let commented = !opener.is_empty()
            || !closer.is_empty()
            || body.iter().any(|structure| {
                is_comment(decor_text(structure.decor().prefix()))
                    || is_comment(decor_text(structure.decor().suffix()))
            });
        if body.is_empty() && !commented {
            self.line(depth, &format!("{header} {{}}"));
            return Ok(());
        }
        let single = match body.iter().collect::<Vec<_>>().as_slice() {
            [Structure::Attribute(attribute)] if body.prefer_oneline() && !commented => {
                self.plain(attribute.key.decor().suffix(), attribute.key.span())?;
                self.plain(attribute.value.decor().prefix(), attribute.value.span())?;
                let value = self.value(&attribute.value)?;
                (!value.contains('\n')).then(|| format!("{} = {value}", attribute.key.as_str()))
            }
            _ => None,
        };
        if let Some(attribute) = single {
            self.line(depth, &format!("{header} {{ {attribute} }}"));
            return Ok(());
        }
        self.line(depth, &format!("{header} {{"));
        if !opener.is_empty() {
            self.trailing(body.decor().prefix());
        }
        self.body(body, depth + 1)?;
        self.line(depth, "}");
        Ok(())
    }
}

/// `text` laid out canonically, or the place and reason it cannot be.
pub fn format_hcl(path: &Path, text: &str) -> Result<String, Diagnostic> {
    let whole = |line: usize, column: usize, message: String| Diagnostic {
        path: path.to_owned(),
        line,
        column,
        message,
    };
    let body = hcl::edit::parser::parse_body(text).map_err(|error| {
        let location = error.location();
        whole(
            location.line(),
            location.column(),
            error.message().to_owned(),
        )
    })?;
    let mut printer = Printer {
        text,
        out: String::new(),
    };
    printer.body(&body, 0).map_err(|(span, message)| {
        let (line, column) = span.map_or((0, 0), |span| super::line_column(text, span.start));
        whole(line, column, message)
    })?;
    Ok(printer.out)
}

/// Formats every HCL file of the repository at `root` and returns the
/// repository-relative paths that changed (with `write`) or would change.
pub fn format_repository(root: &Path, write: bool) -> Result<Vec<PathBuf>, Vec<Diagnostic>> {
    let mut paths = vec![PathBuf::from("intar.hcl")];
    let sorted = |directory: &Path| -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = std::fs::read_dir(root.join(directory))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| directory.join(entry.file_name()))
                    .collect()
            })
            .unwrap_or_default();
        found.sort();
        found
    };
    paths.extend(
        sorted(Path::new("images"))
            .into_iter()
            .filter(|path| path.extension().is_some_and(|extension| extension == "hcl")),
    );
    paths.extend(
        sorted(Path::new("scenarios"))
            .into_iter()
            .map(|directory| directory.join("scenario.hcl")),
    );
    let mut changed = Vec::new();
    let mut problems = Vec::new();
    for path in paths {
        let full = root.join(&path);
        // Only plain files: the loader refuses symlinks too.
        if !std::fs::symlink_metadata(&full).is_ok_and(|metadata| metadata.is_file()) {
            continue;
        }
        let result = std::fs::read_to_string(&full)
            .map_err(|error| Diagnostic {
                path: path.clone(),
                line: 0,
                column: 0,
                message: error.to_string(),
            })
            .and_then(|text| Ok((format_hcl(&path, &text)?, text)));
        match result {
            Ok((formatted, text)) if formatted != text => {
                if write && let Err(error) = std::fs::write(&full, formatted) {
                    problems.push(Diagnostic {
                        path: path.clone(),
                        line: 0,
                        column: 0,
                        message: error.to_string(),
                    });
                }
                changed.push(path);
            }
            Ok(_) => {}
            Err(problem) => problems.push(problem),
        }
    }
    if problems.is_empty() {
        Ok(changed)
    } else {
        Err(problems)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format(text: &str) -> String {
        format_hcl(Path::new("scenario.hcl"), text).unwrap_or_else(|problem| panic!("{problem}"))
    }

    const MESSY: &str = "# The example.\n\n\nscenario \"a-b\" { # opener\ntitle = \"x\" # trailing\n  difficulty=\"easy\"\n\n\n    # about tags\n  tags = [\"a\",\n          \"b\"]\n  briefing = <<-MD\n    One.\n      \n    Two.\n  MD\n  machine \"m\" {\n  cpu = 1\n  }\n      check { service = \"nginx\" }\n  hint \"h\" {\n    body = \"b\"\n  }\n  empty {\n  }\n  # closing\n}\n";

    const CANONICAL: &str = "# The example.\n\nscenario \"a-b\" { # opener\n  title      = \"x\" # trailing\n  difficulty = \"easy\"\n\n  # about tags\n  tags     = [\"a\",\n          \"b\"]\n  briefing = <<-MD\n    One.\n\n    Two.\n  MD\n  machine \"m\" {\n    cpu = 1\n  }\n  check { service = \"nginx\" }\n  hint \"h\" {\n    body = \"b\"\n  }\n  empty {}\n  # closing\n}\n";

    #[test]
    fn lays_out_canonically_and_keeps_comments() {
        assert_eq!(format(MESSY), CANONICAL);
    }

    #[test]
    fn formatting_is_idempotent() {
        assert_eq!(format(CANONICAL), CANONICAL);
        let example = include_str!("../../../../content/scenarios/broken-nginx/scenario.hcl");
        assert_eq!(format(example), example);
    }

    #[test]
    fn heredocs_change_only_on_blank_lines() {
        let text = "a = <<-SH\n  keep\t \n   \n    x\n  SH\nb = <<SH\n   \nSH\n";
        assert_eq!(
            format(text),
            "a = <<-SH\n  keep\t \n\n    x\n  SH\nb = <<SH\n   \nSH\n"
        );
    }

    #[test]
    fn comments_without_a_place_are_refused() {
        let found = format_hcl(Path::new("s.hcl"), "a /* here */ = 1\n").err();
        assert!(
            found.is_some_and(|problem| problem.to_string().starts_with("s.hcl:1:1: fmt keeps"))
        );
    }

    #[test]
    fn a_repository_is_checked_and_written() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();
        std::fs::write(root.join("intar.hcl"), "repository {\n}\n").expect("write");
        std::fs::create_dir_all(root.join("scenarios/a-b")).expect("mkdir");
        std::fs::write(root.join("scenarios/a-b/scenario.hcl"), CANONICAL).expect("write");
        assert_eq!(
            format_repository(root, false),
            Ok(vec![PathBuf::from("intar.hcl")])
        );
        assert_eq!(
            format_repository(root, true),
            Ok(vec![PathBuf::from("intar.hcl")])
        );
        assert_eq!(format_repository(root, false), Ok(Vec::new()));
        assert_eq!(
            std::fs::read_to_string(root.join("intar.hcl"))
                .ok()
                .as_deref(),
            Some("repository {}\n")
        );
    }
}
