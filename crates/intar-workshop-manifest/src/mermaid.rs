use crate::error::{Result, invalid};
use std::collections::HashMap;

const SUPPORTED_DIRECTIONS: [&str; 2] = ["LR", "TD"];

pub(crate) fn validate_markdown_mermaid(context: &str, markdown: &str) -> Result<()> {
    let mut active_fence: Option<ActiveFence> = None;

    for (index, line) in markdown.lines().enumerate() {
        let line_number = index + 1;
        match active_fence.as_mut() {
            Some(fence) if is_closing_fence(line, fence.marker, fence.length) => {
                let completed = active_fence.take().expect("active fence must exist");
                if let FenceContent::Mermaid(source) = completed.content {
                    validate_flowchart(context, completed.opening_line, &source)?;
                }
            }
            Some(ActiveFence {
                content: FenceContent::Mermaid(source),
                ..
            }) => {
                source.push_str(line);
                source.push('\n');
            }
            Some(_) => {}
            None => {
                let Some(opening) = opening_fence(line) else {
                    continue;
                };
                let info = opening.info.trim();
                let first_info_word = info.split_ascii_whitespace().next();
                let content =
                    if first_info_word.is_some_and(|word| word.eq_ignore_ascii_case("mermaid")) {
                        if info != "mermaid" {
                            return Err(mermaid_error(
                                context,
                                line_number,
                                "the fence info string must be exactly 'mermaid'",
                            ));
                        }
                        FenceContent::Mermaid(String::new())
                    } else {
                        FenceContent::Ordinary
                    };
                active_fence = Some(ActiveFence {
                    marker: opening.marker,
                    length: opening.length,
                    opening_line: line_number,
                    content,
                });
            }
        }
    }

    if let Some(ActiveFence {
        opening_line,
        content: FenceContent::Mermaid(_),
        ..
    }) = active_fence
    {
        return Err(mermaid_error(
            context,
            opening_line,
            "the Mermaid fence is unterminated",
        ));
    }
    Ok(())
}

struct ActiveFence {
    marker: u8,
    length: usize,
    opening_line: usize,
    content: FenceContent,
}

enum FenceContent {
    Ordinary,
    Mermaid(String),
}

struct OpeningFence<'a> {
    marker: u8,
    length: usize,
    info: &'a str,
}

fn opening_fence(line: &str) -> Option<OpeningFence<'_>> {
    let bytes = line.as_bytes();
    let mut offset = 0;
    while offset < bytes.len() && bytes[offset] == b' ' && offset < 4 {
        offset += 1;
    }
    if offset > 3 {
        return None;
    }
    let marker = *bytes.get(offset)?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let start = offset;
    while bytes.get(offset) == Some(&marker) {
        offset += 1;
    }
    let length = offset - start;
    if length < 3 {
        return None;
    }
    let info = &line[offset..];
    if marker == b'`' && info.contains('`') {
        return None;
    }
    Some(OpeningFence {
        marker,
        length,
        info,
    })
}

fn is_closing_fence(line: &str, marker: u8, minimum_length: usize) -> bool {
    let bytes = line.as_bytes();
    let mut offset = 0;
    while offset < bytes.len() && bytes[offset] == b' ' && offset < 4 {
        offset += 1;
    }
    if offset > 3 {
        return false;
    }
    let start = offset;
    while bytes.get(offset) == Some(&marker) {
        offset += 1;
    }
    offset - start >= minimum_length && line[offset..].trim().is_empty()
}

fn validate_flowchart(context: &str, opening_line: usize, source: &str) -> Result<()> {
    reject_unsafe_content(context, opening_line, source)?;

    let lines: Vec<_> = source.lines().collect();
    let Some((header_index, header)) = lines
        .iter()
        .enumerate()
        .find(|(_, line)| !line.trim().is_empty())
    else {
        return Err(mermaid_error(context, opening_line, "the diagram is empty"));
    };
    let header_line = opening_line + header_index + 1;
    let mut header_parts = header.split_ascii_whitespace();
    let kind = header_parts.next().unwrap_or_default();
    if kind != "flowchart" {
        return Err(mermaid_error(
            context,
            header_line,
            format!("unsupported diagram kind '{kind}'; expected 'flowchart'"),
        ));
    }
    let direction = header_parts.next().unwrap_or_default();
    if !SUPPORTED_DIRECTIONS.contains(&direction) {
        return Err(mermaid_error(
            context,
            header_line,
            format!("unsupported flowchart direction '{direction}'; expected LR or TD"),
        ));
    }
    if header_parts.next().is_some() {
        return Err(mermaid_error(
            context,
            header_line,
            "the flowchart header must contain only its kind and direction",
        ));
    }

    let statements = logical_statements(
        context,
        opening_line + header_index + 2,
        &lines[header_index + 1..],
    )?;
    if statements.is_empty() {
        return Err(mermaid_error(
            context,
            header_line,
            "the flowchart must contain at least one statement",
        ));
    }

    let mut declared_labels: HashMap<String, String> = HashMap::new();
    for statement in statements {
        if statement.source.trim_start().starts_with("%%") {
            return Err(mermaid_error(
                context,
                statement.line,
                "Mermaid comments and directives are unsupported",
            ));
        }
        let nodes = StatementParser::new(context, statement.line, &statement.source).parse()?;
        for node in nodes {
            let Some(label) = node.label else {
                continue;
            };
            if let Some(existing) = declared_labels.get(&node.id) {
                if existing != &label {
                    return Err(mermaid_error(
                        context,
                        statement.line,
                        format!("node '{}' declares conflicting labels", node.id),
                    ));
                }
            } else {
                declared_labels.insert(node.id, label);
            }
        }
    }
    Ok(())
}

struct LogicalStatement {
    line: usize,
    source: String,
}

fn logical_statements(
    context: &str,
    first_line: usize,
    lines: &[&str],
) -> Result<Vec<LogicalStatement>> {
    let mut statements = Vec::new();
    let mut current: Option<LogicalStatement> = None;
    let mut quoted = false;

    for (index, line) in lines.iter().enumerate() {
        let line_number = first_line + index;
        if current.is_none() && line.trim().is_empty() {
            continue;
        }
        let statement = current.get_or_insert_with(|| LogicalStatement {
            line: line_number,
            source: String::new(),
        });
        if !statement.source.is_empty() {
            statement.source.push('\n');
        }
        statement.source.push_str(line);
        update_quote_state(context, statement.line, line, &mut quoted)?;
        if !quoted {
            statements.push(current.take().expect("logical statement must exist"));
        }
    }

    if let Some(statement) = current {
        return Err(mermaid_error(
            context,
            statement.line,
            "a quoted label is unterminated",
        ));
    }
    Ok(statements)
}

fn update_quote_state(context: &str, line: usize, source: &str, quoted: &mut bool) -> Result<()> {
    for character in source.chars() {
        if character == '\\' {
            return Err(mermaid_error(
                context,
                line,
                "escape sequences are unsupported in Mermaid labels",
            ));
        }
        if character == '"' {
            *quoted = !*quoted;
        }
    }
    Ok(())
}

struct ParsedNode {
    id: String,
    label: Option<String>,
}

struct StatementParser<'a> {
    context: &'a str,
    line: usize,
    source: &'a str,
    offset: usize,
}

impl<'a> StatementParser<'a> {
    fn new(context: &'a str, line: usize, source: &'a str) -> Self {
        Self {
            context,
            line,
            source,
            offset: 0,
        }
    }

    fn parse(mut self) -> Result<Vec<ParsedNode>> {
        self.skip_whitespace();
        let mut nodes = vec![self.parse_node()?];
        loop {
            self.skip_whitespace();
            if self.is_finished() {
                return Ok(nodes);
            }
            self.parse_edge()?;
            self.skip_whitespace();
            nodes.push(self.parse_node()?);
        }
    }

    fn parse_node(&mut self) -> Result<ParsedNode> {
        let id = self.parse_identifier()?;
        let label = if self.consume("[") {
            if !self.consume("\"") {
                return Err(self.error("node labels must use the form id[\"label\"]"));
            }
            let label = self.parse_quoted_text("node label")?;
            if !self.consume("]") {
                return Err(self.error("a node label is missing its closing ']'"));
            }
            Some(label)
        } else {
            None
        };
        Ok(ParsedNode { id, label })
    }

    fn parse_identifier(&mut self) -> Result<String> {
        let start = self.offset;
        let Some(first) = self.remaining().bytes().next() else {
            return Err(self.error("expected a node after the edge"));
        };
        if !first.is_ascii_alphabetic() {
            return Err(self.error(
                "node IDs must start with an ASCII letter and contain only letters, digits, '_' or '-'",
            ));
        }
        self.offset += 1;
        while let Some(byte) = self.remaining().bytes().next() {
            if self.remaining().starts_with("-->") || self.remaining().starts_with("-.->") {
                break;
            }
            if !byte.is_ascii_alphanumeric() && !matches!(byte, b'_' | b'-') {
                break;
            }
            self.offset += 1;
        }
        Ok(self.source[start..self.offset].to_owned())
    }

    fn parse_edge(&mut self) -> Result<()> {
        if !self.consume("-->") && !self.consume("-.->") {
            return Err(self.error(
                "unsupported Mermaid statement; only '-->' and '-.->' flowchart edges are allowed",
            ));
        }
        self.skip_whitespace();
        if self.consume("|") {
            if !self.consume("\"") {
                return Err(self.error("edge labels must use the form |\"label\"|"));
            }
            let _ = self.parse_quoted_text("edge label")?;
            if !self.consume("|") {
                return Err(self.error("an edge label is missing its closing '|'"));
            }
        }
        Ok(())
    }

    fn parse_quoted_text(&mut self, kind: &str) -> Result<String> {
        let start = self.offset;
        let Some(relative_end) = self.remaining().find('"') else {
            return Err(self.error(format!("the {kind} is unterminated")));
        };
        let end = start + relative_end;
        let value = &self.source[start..end];
        self.offset = end + 1;
        if value.trim().is_empty() {
            return Err(self.error(format!("the {kind} may not be empty")));
        }
        reject_unsafe_content(self.context, self.line, value)?;
        Ok(value.to_owned())
    }

    fn skip_whitespace(&mut self) {
        while let Some(character) = self.remaining().chars().next() {
            if !character.is_whitespace() {
                break;
            }
            self.offset += character.len_utf8();
        }
    }

    fn consume(&mut self, expected: &str) -> bool {
        if !self.remaining().starts_with(expected) {
            return false;
        }
        self.offset += expected.len();
        true
    }

    fn remaining(&self) -> &str {
        &self.source[self.offset..]
    }

    fn is_finished(&self) -> bool {
        self.offset == self.source.len()
    }

    fn error(&self, message: impl Into<String>) -> crate::WorkshopManifestError {
        mermaid_error(self.context, self.line, message)
    }
}

fn reject_unsafe_content(context: &str, line: usize, source: &str) -> Result<()> {
    let lower = source.to_ascii_lowercase();
    let compact: String = lower
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect();
    if source.contains('<')
        || compact.contains("javascript:")
        || compact.contains("data:text/html")
        || ["onload=", "onclick=", "onerror=", "onmouseover="]
            .iter()
            .any(|event| compact.contains(event))
    {
        return Err(mermaid_error(
            context,
            line,
            "the diagram contains unsafe HTML or JavaScript",
        ));
    }
    Ok(())
}

fn mermaid_error(
    context: &str,
    line: usize,
    message: impl Into<String>,
) -> crate::WorkshopManifestError {
    invalid(format!(
        "Markdown source '{context}' Mermaid block at line {line}: {}",
        message.into()
    ))
}
