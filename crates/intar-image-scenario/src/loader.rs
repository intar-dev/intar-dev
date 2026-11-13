//! The loader of the new `scenario.hcl`, `images/<name>.hcl` and `intar.hcl`
//! (#308). It walks the parsed file against an allowlist, with no
//! evaluation: literals, heredocs, `file()` and `markdown()`. What it
//! produces are the lowered contract types of `intar_contracts::scenario`.

mod lower;
mod markdown;
mod repo;

#[cfg(test)]
mod tests;

pub use repo::{Repository, load_repository};

use hcl::edit::Span as _;
use hcl::edit::expr::{Expression, ObjectKey};
use hcl::edit::structure::{Block, BlockLabel, Body, Structure};
use hcl::edit::template::{Element, Template};
use std::collections::BTreeMap;
use std::fmt;
use std::ops::Range;
use std::path::{Path, PathBuf};

/// One problem, as `path:line:col: message`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    /// Repository-relative.
    pub path: PathBuf,
    /// 1-based; 0 when the problem is not at a place in a file.
    pub line: usize,
    pub column: usize,
    pub message: String,
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        let path = self.path.display();
        match self.line {
            0 => write!(out, "{path}: {}", self.message),
            line => write!(out, "{path}:{line}:{}: {}", self.column, self.message),
        }
    }
}

type Loaded<T> = Result<T, Diagnostic>;

const ESCAPE_HINT: &str =
    "write `$${` / `%%{` for a literal, or move the script into file() (markdown into markdown())";

/// One `.hcl` file being loaded.
struct Source<'a> {
    /// The repository root.
    root: &'a Path,
    /// Repository-relative path of the `.hcl` file.
    path: &'a Path,
    text: &'a str,
    /// Repository-relative directory `file()` and `markdown()` may read.
    files: PathBuf,
    /// Repository-relative paths the file's calls have read.
    referenced: std::cell::RefCell<Vec<PathBuf>>,
}

impl Source<'_> {
    fn at(&self, span: Option<Range<usize>>, message: impl Into<String>) -> Diagnostic {
        let (line, column) = span.map_or((0, 0), |span| line_column(self.text, span.start));
        Diagnostic {
            path: self.path.to_owned(),
            line,
            column,
            message: message.into(),
        }
    }

    fn parse(&self) -> Loaded<Body> {
        hcl::edit::parser::parse_body(self.text).map_err(|error| {
            let location = error.location();
            let mut message = error.message().to_owned();
            if has_template_start(self.text) {
                message = format!("{message} ({ESCAPE_HINT})");
            }
            Diagnostic {
                path: self.path.to_owned(),
                line: location.line(),
                column: location.column(),
                message,
            }
        })
    }

    /// The content of a `file()` or `markdown()` argument, by the path rules.
    fn read(&self, argument: &str, span: Option<Range<usize>>) -> Loaded<String> {
        let normal = !argument.is_empty()
            && argument.split('/').all(|segment| {
                !segment.is_empty()
                    && segment != ".."
                    && segment != "."
                    && segment
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            });
        if !normal {
            return Err(self.at(span, format!("`{argument}` is not a plain relative path")));
        }
        let relative = self.files.join(argument);
        // Every component, so a symlinked directory is refused too.
        let mut walked = self.root.to_owned();
        for component in relative.components() {
            walked.push(component);
            let kind = std::fs::symlink_metadata(&walked)
                .map_err(|error| self.at(span.clone(), format!("{}: {error}", relative.display())))?
                .file_type();
            if kind.is_symlink() || !(kind.is_dir() || kind.is_file()) {
                return Err(self.at(span, format!("{} is not a plain file", relative.display())));
            }
        }
        let content = std::fs::read_to_string(&walked)
            .map_err(|error| self.at(span.clone(), format!("{}: {error}", relative.display())))?;
        if content.starts_with("version https://git-lfs.github.com/spec/v1") {
            return Err(self.at(
                span,
                format!(
                    "lfs_unsupported: {} is a Git LFS pointer",
                    relative.display()
                ),
            ));
        }
        self.referenced.borrow_mut().push(relative);
        Ok(content)
    }
}

/// An unescaped `${` or `%{`, the usual cause of a confusing parse error.
fn has_template_start(text: &str) -> bool {
    [("${", '$'), ("%{", '%')]
        .into_iter()
        .any(|(start, sigil)| {
            text.match_indices(start)
                .any(|(at, _)| !text[..at].ends_with(sigil))
        })
}

fn line_column(text: &str, offset: usize) -> (usize, usize) {
    let before = &text[..offset.min(text.len())];
    let line = before.matches('\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(0, |last| last.chars().count())
        + 1;
    (line, column)
}

/// A value the allowlist accepts.
#[derive(Clone, Debug)]
enum Value {
    Text(String),
    /// `file("…")` or `markdown("…")` with its literal argument.
    Call(&'static str, String),
    Number(i64),
    Bool(bool),
    List(Vec<(Value, Option<Range<usize>>)>),
    Object(Vec<(String, Value)>),
}

fn literal(template: &Template) -> Option<String> {
    let mut text = String::new();
    for element in template.iter() {
        match element {
            Element::Literal(part) => text.push_str(part),
            Element::Interpolation(_) | Element::Directive(_) => return None,
        }
    }
    Some(text)
}

fn value(source: &Source, expression: &Expression) -> Loaded<Value> {
    let span = expression.span();
    let refuse = |what: &str| {
        Err(source.at(
            span.clone(),
            format!("{what} is not supported: only literals, heredocs, file() and markdown()"),
        ))
    };
    let template = |text: Option<String>| {
        text.map(Value::Text).ok_or_else(|| {
            source.at(
                span.clone(),
                format!("interpolation is not supported; {ESCAPE_HINT}"),
            )
        })
    };
    match expression {
        Expression::String(text) => Ok(Value::Text(text.value().clone())),
        Expression::StringTemplate(text) => template(literal(text)),
        Expression::HeredocTemplate(heredoc) => template(literal(&heredoc.template)),
        Expression::Bool(flag) => Ok(Value::Bool(*flag.value())),
        Expression::Number(number) => match number.value().as_i64() {
            Some(number) => Ok(Value::Number(number)),
            None => refuse("a number that is not an integer"),
        },
        Expression::Array(array) => array
            .iter()
            .map(|item| Ok((value(source, item)?, item.span())))
            .collect::<Loaded<_>>()
            .map(Value::List),
        Expression::Object(object) => object
            .iter()
            .map(|(key, item)| {
                let key = match key {
                    ObjectKey::Ident(ident) => ident.as_str().to_owned(),
                    ObjectKey::Expression(Expression::String(text)) => text.value().clone(),
                    ObjectKey::Expression(other) => {
                        return Err(
                            source.at(other.span(), "an object key must be a name or a string")
                        );
                    }
                };
                Ok((key, value(source, item.expr())?))
            })
            .collect::<Loaded<_>>()
            .map(Value::Object),
        Expression::FuncCall(call) => {
            let name = match (call.name.namespace.is_empty(), call.name.name.as_str()) {
                (true, "file") => "file",
                (true, "markdown") => "markdown",
                _ => return refuse("a function other than file() and markdown()"),
            };
            let mut arguments = call.args.iter();
            match (arguments.next(), arguments.next(), call.args.expand_final()) {
                (Some(Expression::String(path)), None, false) => {
                    Ok(Value::Call(name, path.value().clone()))
                }
                _ => Err(source.at(span, format!("{name}() takes exactly one plain string"))),
            }
        }
        Expression::Null(_) => refuse("null"),
        Expression::Variable(_) | Expression::Traversal(_) => refuse("a variable or reference"),
        Expression::Parenthesis(_)
        | Expression::Conditional(_)
        | Expression::UnaryOp(_)
        | Expression::BinaryOp(_)
        | Expression::ForExpr(_) => refuse("an expression"),
    }
}

/// One block: its attributes, taken one by one, and its child blocks in file
/// order. Whatever is left at [`Fields::done`] is an unknown field.
struct Fields<'a> {
    source: &'a Source<'a>,
    what: String,
    span: Option<Range<usize>>,
    attributes: BTreeMap<String, (Value, Option<Range<usize>>)>,
    blocks: Vec<&'a Block>,
}

fn label(source: &Source, block: &Block) -> Loaded<String> {
    match block.labels.as_slice() {
        [BlockLabel::String(text)] => Ok(text.value().clone()),
        [BlockLabel::Ident(ident)] => Ok(ident.as_str().to_owned()),
        _ => Err(source.at(
            block.span(),
            format!("`{}` takes exactly one label", block.ident.as_str()),
        )),
    }
}

impl<'a> Fields<'a> {
    fn new(
        source: &'a Source<'a>,
        what: String,
        body: &'a Body,
        span: Option<Range<usize>>,
    ) -> Loaded<Self> {
        let mut attributes = BTreeMap::new();
        let mut blocks = Vec::new();
        for structure in body.iter() {
            match structure {
                Structure::Attribute(attribute) => {
                    let found = (value(source, &attribute.value)?, attribute.span());
                    attributes.insert(attribute.key.as_str().to_owned(), found);
                }
                Structure::Block(block) => blocks.push(block),
            }
        }
        Ok(Self {
            source,
            what,
            span,
            attributes,
            blocks,
        })
    }

    fn of(source: &'a Source<'a>, block: &'a Block) -> Loaded<Self> {
        Self::new(
            source,
            format!("`{}`", block.ident.as_str()),
            &block.body,
            block.span(),
        )
    }

    fn error(&self, span: Option<Range<usize>>, message: impl fmt::Display) -> Diagnostic {
        self.source.at(
            span.or_else(|| self.span.clone()),
            format!("{}: {message}", self.what),
        )
    }

    fn take(&mut self, key: &str) -> Option<(Value, Option<Range<usize>>)> {
        self.attributes.remove(key)
    }

    fn need<T>(&self, key: &str, found: Option<T>) -> Loaded<T> {
        found.ok_or_else(|| self.error(None, format!("`{key}` is required")))
    }

    /// A plain string: no function call.
    fn text(&mut self, key: &str) -> Loaded<Option<String>> {
        match self.take(key) {
            None => Ok(None),
            Some((Value::Text(text), _)) => Ok(Some(text)),
            Some((_, span)) => Err(self.error(span, format!("`{key}` takes a string"))),
        }
    }

    /// A script or content field: a string, a heredoc or `file()`.
    fn script(&mut self, key: &str) -> Loaded<Option<String>> {
        match self.take(key) {
            None => Ok(None),
            Some((Value::Text(text), _)) => Ok(Some(text)),
            Some((Value::Call("file", path), span)) => self.source.read(&path, span).map(Some),
            Some((Value::Call(..), span)) => {
                Err(self.error(span, format!("`{key}` takes file(), not markdown()")))
            }
            Some((_, span)) => {
                Err(self.error(span, format!("`{key}` takes a string, a heredoc or file()")))
            }
        }
    }

    /// A markdown field: a string, a heredoc or `markdown()`, checked.
    fn markdown(&mut self, key: &str) -> Loaded<Option<String>> {
        let (text, span, file) = match self.take(key) {
            None => return Ok(None),
            Some((Value::Text(text), span)) => (text, span, None),
            Some((Value::Call("markdown", path), span)) => {
                if !path.ends_with(".md") {
                    return Err(self.error(span, "markdown() takes a .md file"));
                }
                (self.source.read(&path, span.clone())?, span, Some(path))
            }
            Some((Value::Call(..), span)) => {
                return Err(self.error(span, format!("`{key}` takes markdown(), not file()")));
            }
            Some((_, span)) => {
                return Err(self.error(
                    span,
                    format!("`{key}` takes a string, a heredoc or markdown()"),
                ));
            }
        };
        match markdown::check(&text) {
            None => Ok(Some(text)),
            // A file's problem is reported at its own line and column.
            Some((offset, problem)) => Err(match file {
                Some(path) => {
                    let (line, column) = line_column(&text, offset);
                    Diagnostic {
                        path: self.source.files.join(path),
                        line,
                        column,
                        message: problem.to_owned(),
                    }
                }
                None => self.error(span, format!("`{key}`: {problem}")),
            }),
        }
    }

    fn number(&mut self, key: &str) -> Loaded<Option<i64>> {
        match self.take(key) {
            None => Ok(None),
            Some((Value::Number(number), _)) => Ok(Some(number)),
            Some((_, span)) => Err(self.error(span, format!("`{key}` takes a number"))),
        }
    }

    fn flag(&mut self, key: &str, default: bool) -> Loaded<bool> {
        match self.take(key) {
            None => Ok(default),
            Some((Value::Bool(flag), _)) => Ok(flag),
            Some((_, span)) => Err(self.error(span, format!("`{key}` takes true or false"))),
        }
    }

    fn strings(&mut self, key: &str) -> Loaded<Vec<String>> {
        let Some((found, span)) = self.take(key) else {
            return Ok(Vec::new());
        };
        let Value::List(items) = found else {
            return Err(self.error(span, format!("`{key}` takes a list of strings")));
        };
        items
            .into_iter()
            .map(|(item, span)| match item {
                Value::Text(text) => Ok(text),
                _ => Err(self.error(span, format!("`{key}` takes a list of strings"))),
            })
            .collect()
    }

    fn string_map(&mut self, key: &str) -> Loaded<BTreeMap<String, String>> {
        let Some((found, span)) = self.take(key) else {
            return Ok(BTreeMap::new());
        };
        let Value::Object(items) = found else {
            return Err(self.error(span, format!("`{key}` takes an object of strings")));
        };
        let mut map = BTreeMap::new();
        for (name, item) in items {
            let Value::Text(text) = item else {
                return Err(self.error(span, format!("`{key}.{name}` takes a string")));
            };
            if map.insert(name.clone(), text).is_some() {
                return Err(self.error(span, format!("`{key}.{name}` is set twice")));
            }
        }
        Ok(map)
    }

    /// The child blocks named `ident`, each with its one label, in file
    /// order; a label used twice is an error.
    fn labelled(&mut self, ident: &str) -> Loaded<Vec<(String, &'a Block)>> {
        let mut found: Vec<(String, &'a Block)> = Vec::new();
        for block in self.children(ident) {
            let name = label(self.source, block)?;
            if found.iter().any(|(other, _)| *other == name) {
                return Err(self.error(block.span(), format!("{ident} `{name}` is declared twice")));
            }
            found.push((name, block));
        }
        Ok(found)
    }

    /// The child blocks named `ident`, in file order.
    fn children(&mut self, ident: &str) -> Vec<&'a Block> {
        let (taken, left) = std::mem::take(&mut self.blocks)
            .into_iter()
            .partition(|block| block.ident.as_str() == ident);
        self.blocks = left;
        taken
    }

    /// Every attribute and block must have been taken.
    fn done(self) -> Loaded<()> {
        self.unknown().map_or(Ok(()), Err)
    }

    /// The first attribute or block nothing has taken.
    fn unknown(&self) -> Option<Diagnostic> {
        if let Some((key, (_, span))) = self.attributes.iter().next() {
            return Some(self.error(span.clone(), format!("unknown field `{key}`")));
        }
        let block = self.blocks.first()?;
        Some(self.error(
            block.span(),
            format!("unknown block `{}`", block.ident.as_str()),
        ))
    }
}
