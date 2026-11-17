//! Warnings on lowered scripts: `| grep -q` under `pipefail`, and
//! `shellcheck` when it is installed. Warnings never fail `validate`.

use super::{Diagnostic, LoweredScript};
use std::io::Write as _;
use std::process::{Command, Stdio};

/// Every warning on `scripts`, each at the block its script came from.
pub fn warnings(scripts: &[LoweredScript]) -> Vec<Diagnostic> {
    let mut found = Vec::new();
    let mut shellcheck_missing = false;
    for lowered in scripts {
        let warn = |message: String| Diagnostic {
            message: format!("warning: {} {message}", lowered.at.message),
            ..lowered.at.clone()
        };
        for line in grep_q_lines(&lowered.script) {
            found.push(warn(format!(
                "lowered line {line}: `| grep -q` can fail under pipefail when the producer dies of SIGPIPE; use `grep … >/dev/null`"
            )));
        }
        if shellcheck_missing {
            continue;
        }
        match shellcheck(&lowered.script) {
            Some(lines) => found.extend(lines.into_iter().map(warn)),
            None => shellcheck_missing = true,
        }
    }
    found
}

/// The 1-based lines that pipe into a quiet `grep`.
fn grep_q_lines(script: &str) -> Vec<usize> {
    script
        .lines()
        .enumerate()
        .filter(|(_, line)| pipes_into_grep_q(line))
        .map(|(index, _)| index + 1)
        .collect()
}

fn pipes_into_grep_q(line: &str) -> bool {
    let bytes = line.as_bytes();
    (0..bytes.len())
        .filter(|&at| {
            // A pipe, not `||`.
            bytes[at] == b'|'
                && bytes.get(at + 1) != Some(&b'|')
                && (at == 0 || bytes[at - 1] != b'|')
        })
        .any(|at| {
            let command = line[at + 1..]
                .split(['|', ';', '&', ')'])
                .next()
                .unwrap_or_default();
            let mut words = command.split_whitespace();
            matches!(words.next(), Some("grep" | "egrep" | "fgrep"))
                && words.any(|word| {
                    matches!(word, "--quiet" | "--silent")
                        || (word.starts_with('-') && !word.starts_with("--") && word.contains('q'))
                })
        })
}

/// shellcheck's findings on `script` as `lowered line N:…` messages, or
/// `None` when shellcheck cannot run.
fn shellcheck(script: &str) -> Option<Vec<String>> {
    let mut child = Command::new("shellcheck")
        .args(["--shell=bash", "--format=gcc", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        // A failed write shows as a failed check below.
        let _ = stdin.write_all(script.as_bytes());
    }
    let output = child.wait_with_output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Some(
        stdout
            .lines()
            .filter_map(|line| {
                // `-:<line>:<column>: <level>: <message> [SC<n>]`
                let rest = line.strip_prefix("-:")?;
                let (place, message) = rest.split_once(": ")?;
                let line = place.split(':').next()?;
                Some(format!("lowered line {line}: shellcheck {message}"))
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_quiet_greps_behind_a_pipe() {
        for (line, expected) in [
            ("kubectl get pods | grep -q Running", true),
            ("journalctl -u x |grep -Fq ready", true),
            ("ps aux | egrep --quiet nginx", true),
            ("kubectl get pods | grep Running >/dev/null", false),
            ("grep -q x file", false),
            ("test -f x || grep -q y z", false),
            ("a | grep -v q", false),
            ("a | sort | grep -qE 'x|y'", true),
        ] {
            assert_eq!(pipes_into_grep_q(line), expected, "{line}");
        }
        assert_eq!(grep_q_lines("true\nx | grep -q y\n"), [2]);
    }

    #[test]
    fn warnings_name_the_block_and_the_line() {
        let script = LoweredScript {
            at: Diagnostic {
                path: "scenarios/a-b/scenario.hcl".into(),
                line: 7,
                column: 5,
                message: "`check`".to_owned(),
            },
            script: "fail() { echo \"FAIL: $*\"; exit 1; }\nps | grep -q x\n".to_owned(),
        };
        let found = warnings(&[script]);
        assert!(
            found[0].to_string().starts_with(
                "scenarios/a-b/scenario.hcl:7:5: warning: `check` lowered line 2: `| grep -q`"
            ),
            "{found:?}"
        );
    }
}
