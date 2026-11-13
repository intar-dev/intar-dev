//! Lowering to bash: check bodies (the sugar and `run`), solves and setup
//! stages. A value never becomes script text: it is set as a shell variable
//! through [`shell_quote`] and fixed code reads it.

use super::{Fields, Loaded};
use hcl::edit::Span as _;
use hcl::edit::structure::Block;

/// What every check and solve starts with.
pub(super) const PRELUDE: &str = "fail() { echo \"FAIL: $*\"; exit 1; }\n";
const NOT_DONE: &str = "Not done yet.";

/// One single-quoted shell word holding `value` byte for byte.
pub(super) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The check bodies of one task, or the one body of a `ready` block, as one
/// script. Each body runs in its own `bash -euo pipefail -c`, so errexit
/// holds inside it although it stands left of `||`.
pub(super) fn checks(source: &super::Source, blocks: &[&Block]) -> Loaded<String> {
    let mut script = PRELUDE.to_owned();
    for block in blocks {
        let mut fields = Fields::of(source, block)?;
        let author = fields.text("fail")?;
        let (body, sugar) = check_body(&mut fields)?;
        fields.done()?;
        // The first `FAIL:` line is the learner's message. A `run` script's
        // own line and a sugar's specific default come first and win; an
        // author's `fail` on a sugar replaces them, so they are silenced.
        let silence = if sugar && author.is_some() {
            " >/dev/null"
        } else {
            ""
        };
        script.push_str(&format!(
            "bash -euo pipefail -c {}{silence} || fail {}\n",
            shell_quote(&format!("{PRELUDE}{body}")),
            shell_quote(author.as_deref().unwrap_or(NOT_DONE)),
        ));
    }
    Ok(script)
}

/// The script of one check body and whether it is sugar. Exactly one of
/// `run`, `service`, `port`, `file` and `http` is set.
fn check_body(fields: &mut Fields) -> Loaded<(String, bool)> {
    let mut found = Vec::new();
    if let Some(run) = fields.script("run")? {
        found.push((run, false));
    }
    if let Some(unit) = fields.text("service")? {
        let valid = !unit.starts_with('-')
            && !unit.is_empty()
            && unit
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b":_.@-".contains(&byte));
        if !valid {
            return Err(fields.error(None, "`service` is not a unit name"));
        }
        let test = match fields.text("state")?.as_deref() {
            None | Some("running") => {
                "systemctl is-active --quiet -- \"$u\" || fail \"$u is not running.\""
            }
            Some("enabled") => {
                "[ \"$(systemctl is-enabled -- \"$u\" 2>/dev/null)\" = enabled ] || fail \"$u is not enabled.\""
            }
            Some(_) => return Err(fields.error(None, "`state` is `running` or `enabled`")),
        };
        found.push((format!("u={}\n{test}\n", shell_quote(&unit)), true));
    }
    if let Some(port) = fields.number("port")? {
        if !(1..=65535).contains(&port) {
            return Err(fields.error(None, "`port` is 1 to 65535"));
        }
        let host = fields
            .text("host")?
            .unwrap_or_else(|| "127.0.0.1".to_owned());
        if !is_host(&host) {
            return Err(fields.error(None, "`host` is a hostname or an IP address"));
        }
        found.push((
            format!(
                "h={}; p={port}\ntimeout 2 bash -c 'exec 3<>\"/dev/tcp/$1/$2\"' _ \"$h\" \"$p\" 2>/dev/null || fail \"Nothing is listening on $h:$p.\"\n",
                shell_quote(&host)
            ),
            true,
        ));
    }
    if let Some(path) = fields.text("file")? {
        let mut body = format!(
            "f={}\ntest -e \"$f\" || fail \"$f does not exist.\"\n",
            shell_quote(&path)
        );
        if let Some(contains) = contains(fields)? {
            body.push_str(&format!(
                "c={}\ngrep -Fq -- \"$c\" \"$f\" || fail \"$f does not contain the expected text.\"\n",
                shell_quote(&contains)
            ));
        }
        found.push((body, true));
    }
    if let Some(url) = fields.text("http")? {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(fields.error(None, "`http` starts with http:// or https://"));
        }
        let status = fields.number("status")?.unwrap_or(200);
        if !(100..=599).contains(&status) {
            return Err(fields.error(None, "`status` is 100 to 599"));
        }
        // The explicit `|| fail`: under errexit a bare `code=$(curl …)`
        // would exit with curl's status and print no `FAIL:` line.
        let mut body = format!(
            "u={}; want={status}\nb=$(mktemp)\ncode=$(curl -sS --max-time 2 -o \"$b\" -w '%{{http_code}}' --url \"$u\" 2>/dev/null) || fail \"$u is not reachable.\"\n[ \"$code\" = \"$want\" ] || fail \"$u answered $code.\"\n",
            shell_quote(&url)
        );
        if let Some(contains) = contains(fields)? {
            body.push_str(&format!(
                "c={}\ngrep -Fq -- \"$c\" \"$b\" || fail \"$u answered without the expected text.\"\n",
                shell_quote(&contains)
            ));
        }
        found.push((body, true));
    }
    let mut found = found.into_iter();
    match (found.next(), found.next()) {
        (Some(body), None) => Ok(body),
        // A misspelt field is the likelier cause than a missing one.
        _ => Err(fields.unknown().unwrap_or_else(|| {
            fields.error(
                None,
                "takes exactly one of `run`, `service`, `port`, `file` and `http`",
            )
        })),
    }
}

/// `grep -F` treats each line as its own pattern, so a newline would OR.
fn contains(fields: &mut Fields) -> Loaded<Option<String>> {
    match fields.text("contains")? {
        Some(text) if text.is_empty() || text.contains('\n') => {
            Err(fields.error(None, "`contains` is non-empty and has no newline"))
        }
        other => Ok(other),
    }
}

fn is_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-:".contains(&byte))
}

/// A `solve` block: the script verbatim behind the prelude.
pub(super) fn solve(source: &super::Source, block: &Block) -> Loaded<String> {
    let mut fields = Fields::of(source, block)?;
    let run = fields.script("run")?;
    let run = fields.need("run", run)?;
    fields.done()?;
    Ok(format!("{PRELUDE}{run}"))
}

/// The `packages` attribute as the first setup stage's script.
pub(super) fn packages(fields: &Fields, names: &[String]) -> Loaded<String> {
    let valid = |name: &String| {
        !name.is_empty()
            && !name.starts_with('-')
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"+.-:=~".contains(&byte))
    };
    if !names.iter().all(valid) {
        return Err(fields.error(None, "`packages` holds Debian package names"));
    }
    let quoted: Vec<String> = names.iter().map(|name| shell_quote(name)).collect();
    Ok(format!(
        "apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends {}\n",
        quoted.join(" ")
    ))
}

/// A `setup` block: exactly one of `run`, a `file` block and `k8s_apply`.
pub(super) fn setup(source: &super::Source, block: &Block) -> Loaded<String> {
    let mut fields = Fields::of(source, block)?;
    let mut found = Vec::new();
    if let Some(run) = fields.script("run")? {
        found.push(run);
    }
    if let Some(manifest) = fields.script("k8s_apply")? {
        found.push(format!(
            "printf '%s' {} | kubectl apply -f -\n",
            shell_quote(&manifest)
        ));
    }
    for file in fields.children("file") {
        let mut file = Fields::of(source, file)?;
        let path = file.text("path")?;
        let path = file.need("path", path)?;
        let content = file.script("content")?;
        let content = file.need("content", content)?;
        if !path.starts_with('/') {
            return Err(file.error(None, "`path` is absolute"));
        }
        // `printf` is a builtin, so the content has no ARG_MAX limit, and
        // unlike a heredoc it adds no newline.
        let mut script = format!(
            "printf '%s' {} > {}\n",
            shell_quote(&content),
            shell_quote(&path)
        );
        if let Some(mode) = file.text("mode")? {
            let octal = mode.len() == 4
                && mode.starts_with('0')
                && mode.bytes().all(|byte| (b'0'..=b'7').contains(&byte));
            if !octal {
                return Err(file.error(None, "`mode` is like \"0644\""));
            }
            script.push_str(&format!("chmod {mode} {}\n", shell_quote(&path)));
        }
        if let Some(owner) = file.text("owner")? {
            let name = |name: &str| {
                name.starts_with(|first: char| first.is_ascii_lowercase() || first == '_')
                    && name.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte)
                    })
            };
            let (user, group) = owner.split_once(':').unwrap_or((&owner, "root"));
            if !name(user) || !name(group) || owner.matches(':').count() > 1 {
                return Err(file.error(None, "`owner` is `user` or `user:group`"));
            }
            script.push_str(&format!("chown {owner} {}\n", shell_quote(&path)));
        }
        file.done()?;
        found.push(script);
    }
    let span = block.span();
    fields.done()?;
    let mut found = found.into_iter();
    match (found.next(), found.next()) {
        (Some(script), None) => Ok(script),
        _ => Err(source.at(
            span,
            "`setup` takes exactly one of `run`, a `file` block and `k8s_apply`",
        )),
    }
}
