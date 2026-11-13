//! The repository walk: `intar.hcl`, `images/<name>.hcl` and
//! `scenarios/<slug>/scenario.hcl`, each loaded and lowered, then checked by
//! `intar_contracts::scenario::validate`.

use super::{Diagnostic, Fields, Loaded, Source, label, lower};
use hcl::edit::Span as _;
use hcl::edit::structure::{Block, Structure};
use intar_contracts::scenario::{
    Difficulty, HintV1, ImageV1, MachineV1, ScenarioV1, ScriptV1, TaskV1, validate,
};
use std::path::{Path, PathBuf};

const RETIRED: &str = "retired scenario format; see docs/scenarios";

/// Everything a repository declares, lowered.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Repository {
    pub images: Vec<ImageV1>,
    pub scenarios: Vec<ScenarioV1>,
}

/// Load the repository at `root`, or every problem found.
pub fn load_repository(root: &Path) -> Result<Repository, Vec<Diagnostic>> {
    let mut problems = Vec::new();
    let mut repository = Repository::default();
    let whole = |path: &str, message: &str| Diagnostic {
        path: path.into(),
        line: 0,
        column: 0,
        message: message.to_owned(),
    };

    if root.join("intar.yaml").exists() {
        problems.push(whole("intar.yaml", "intar.yaml is retired; add intar.hcl"));
    }
    match std::fs::read_to_string(root.join("intar.hcl")) {
        Ok(text) => {
            let source = source(root, Path::new("intar.hcl"), &text, PathBuf::new());
            if let Err(problem) = repository_file(&source) {
                problems.push(problem);
            }
        }
        Err(error) => problems.push(whole("intar.hcl", &error.to_string())),
    }

    for path in files(root, Path::new(""), &mut problems) {
        let parts: Vec<&str> = path.iter().filter_map(|part| part.to_str()).collect();
        let hcl = path.extension().is_some_and(|extension| extension == "hcl");
        match parts.as_slice() {
            ["intar.hcl"] => {}
            ["images", file] if hcl => {
                let name = file.trim_end_matches(".hcl");
                let files = Path::new("images").join(name);
                match load(root, &path, files, |source, block| {
                    image(source, block, name)
                }) {
                    Ok(image) => repository.images.push(image),
                    Err(problem) => problems.push(problem),
                }
            }
            ["scenarios", slug, "scenario.hcl"] => {
                let files = Path::new("scenarios").join(slug);
                match load(root, &path, files, |source, block| {
                    scenario(source, block, slug)
                }) {
                    Ok(scenario) => repository.scenarios.push(scenario),
                    Err(problem) => problems.push(problem),
                }
            }
            // Today's files live elsewhere, e.g. under courses/.
            _ if hcl => problems.push(whole(&path.to_string_lossy(), RETIRED)),
            _ => {}
        }
    }

    for scenario in &repository.scenarios {
        if let Err(found) = validate(scenario, &repository.images) {
            let path = format!("scenarios/{}/scenario.hcl", scenario.slug);
            problems.extend(found.iter().map(|message| whole(&path, message)));
        }
    }
    if problems.is_empty() {
        Ok(repository)
    } else {
        Err(problems)
    }
}

fn source<'a>(root: &'a Path, path: &'a Path, text: &'a str, files: PathBuf) -> Source<'a> {
    Source {
        root,
        path,
        text,
        files,
        referenced: std::cell::RefCell::default(),
    }
}

/// Every plain file under `root/directory`, repository-relative and sorted.
/// Dot entries are skipped; a symlink or special entry is a problem.
fn files(root: &Path, directory: &Path, problems: &mut Vec<Diagnostic>) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root.join(directory)) else {
        return found;
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = directory.join(&name);
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => found.extend(files(root, &path, problems)),
            Ok(kind) if kind.is_file() => found.push(path),
            _ => problems.push(Diagnostic {
                path,
                line: 0,
                column: 0,
                message: "symlinks and special files are not supported".to_owned(),
            }),
        }
    }
    found
}

/// Parse one file that holds exactly one block, build its value, and
/// require every file beside it to be read by a `file()` or `markdown()`.
fn load<T>(
    root: &Path,
    path: &Path,
    files_directory: PathBuf,
    build: impl FnOnce(&Source, &Block) -> Loaded<T>,
) -> Loaded<T> {
    let whole = |message: String| Diagnostic {
        path: path.to_owned(),
        line: 0,
        column: 0,
        message,
    };
    let text =
        std::fs::read_to_string(root.join(path)).map_err(|error| whole(error.to_string()))?;
    let source = source(root, path, &text, files_directory);
    let body = source.parse()?;
    let mut structures = body.iter();
    let (Some(Structure::Block(block)), None) = (structures.next(), structures.next()) else {
        return Err(whole("holds exactly one block".to_owned()));
    };
    let built = build(&source, block)?;
    let referenced = source.referenced.borrow();
    let mut ignored = Vec::new();
    for file in files(root, &source.files, &mut ignored) {
        let name = file
            .file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default();
        let exempt = file == path || name == "README.md" || name.contains("LICENSE");
        if !exempt && !referenced.contains(&file) {
            return Err(Diagnostic {
                path: file,
                line: 0,
                column: 0,
                message: "no file() or markdown() reads this file".to_owned(),
            });
        }
    }
    Ok(built)
}

/// `intar.hcl`: one empty `repository {}` block. The namespace comes from
/// the repository's binding, never from the repository.
fn repository_file(source: &Source) -> Loaded<()> {
    let body = source.parse()?;
    let mut top = Fields::new(source, "intar.hcl".to_owned(), &body, None)?;
    let blocks = top.children("repository");
    top.done()?;
    match blocks.as_slice() {
        [block] if block.labels.is_empty() => Fields::of(source, block)?.done(),
        _ => Err(source.at(None, "intar.hcl holds exactly one `repository {}` block")),
    }
}

/// `"3Gi"` or `"512Mi"` in MiB.
fn mib(fields: &Fields, key: &str, text: Option<String>) -> Loaded<Option<u32>> {
    let Some(text) = text else {
        return Ok(None);
    };
    let parsed = if let Some(number) = text.strip_suffix("Gi") {
        number
            .parse::<u32>()
            .ok()
            .and_then(|number| number.checked_mul(1024))
    } else {
        text.strip_suffix("Mi")
            .and_then(|number| number.parse().ok())
    };
    parsed
        .map(Some)
        .ok_or_else(|| fields.error(None, format!("`{key}` is a size like \"3Gi\" or \"512Mi\"")))
}

fn stages(source: &Source, fields: &mut Fields) -> Loaded<Vec<ScriptV1>> {
    let mut stages = Vec::new();
    let packages = fields.strings("packages")?;
    if !packages.is_empty() {
        let script = lower::packages(fields, &packages)?;
        stages.push(ScriptV1 {
            name: "packages".to_owned(),
            script,
        });
    }
    for (name, block) in fields.labelled("setup")? {
        stages.push(ScriptV1 {
            name,
            script: lower::setup(source, block)?,
        });
    }
    Ok(stages)
}

fn image(source: &Source, block: &Block, file_name: &str) -> Loaded<ImageV1> {
    if block.ident.as_str() != "image" {
        return Err(source.at(
            block.span(),
            "an image file holds one `image \"<name>\"` block",
        ));
    }
    let name = label(source, block)?;
    if name != file_name {
        return Err(source.at(
            block.span(),
            format!("image `{name}` must be in images/{name}.hcl"),
        ));
    }
    let mut fields = Fields::of(source, block)?;
    let from = fields.text("from")?;
    let disk = fields.text("disk")?;
    let image = ImageV1 {
        name,
        from: fields.need("from", from)?,
        disk_mib: mib(&fields, "disk", disk)?,
        defer: fields.strings("defer")?,
        setup: stages(source, &mut fields)?,
    };
    fields.done()?;
    Ok(image)
}

fn hints(source: &Source, fields: &mut Fields) -> Loaded<Vec<HintV1>> {
    fields
        .labelled("hint")?
        .into_iter()
        .map(|(id, block)| {
            let mut hint = Fields::of(source, block)?;
            let title = hint.text("title")?;
            let body = hint.markdown("body")?;
            let body = hint.need("body", body)?;
            hint.done()?;
            Ok(HintV1 { id, title, body })
        })
        .collect()
}

fn machine(source: &Source, name: String, block: &Block) -> Loaded<MachineV1> {
    let mut fields = Fields::of(source, block)?;
    // `cpu = 2` is vCPUs, `cpu = "500m"` millicores.
    let cpu_millis = match fields.take("cpu") {
        Some((super::Value::Number(cpus), _)) => u32::try_from(cpus)
            .ok()
            .and_then(|cpus| cpus.checked_mul(1000)),
        Some((super::Value::Text(text), _)) => text
            .strip_suffix('m')
            .and_then(|millis| millis.parse().ok()),
        _ => None,
    };
    let cpu_millis = cpu_millis
        .ok_or_else(|| fields.error(None, "`cpu` is a number of vCPUs or like \"500m\""))?;
    let (memory, disk, from) = (
        fields.text("memory")?,
        fields.text("disk")?,
        fields.text("from")?,
    );
    let memory = mib(&fields, "memory", memory)?;
    let disk = mib(&fields, "disk", disk)?;
    let ready = fields
        .labelled("ready")?
        .into_iter()
        .map(|(name, block)| {
            Ok(ScriptV1 {
                name,
                script: lower::checks(source, &[block])?,
            })
        })
        .collect::<Loaded<_>>()?;
    let machine = MachineV1 {
        name,
        cpu_millis,
        memory_mib: fields.need("memory", memory)?,
        disk_mib: fields.need("disk", disk)?,
        from: fields.need("from", from)?,
        defer: fields.strings("defer")?,
        terminal: fields.flag("terminal", true)?,
        egress: fields.flag("egress", false)?,
        env: fields.string_map("env")?,
        setup: stages(source, &mut fields)?,
        ready,
    };
    fields.done()?;
    Ok(machine)
}

fn task(source: &Source, id: String, block: &Block, machines: &[MachineV1]) -> Loaded<TaskV1> {
    let mut fields = Fields::of(source, block)?;
    let title = fields.text("title")?;
    // Required exactly when there is more than one machine.
    let machine = match (fields.text("machine")?, machines) {
        (Some(machine), _) => machine,
        (None, [only]) => only.name.clone(),
        (None, _) => {
            return Err(fields.error(None, "`machine` is required with more than one machine"));
        }
    };
    let checks = fields.children("check");
    if checks.is_empty() {
        return Err(fields.error(None, "needs at least one `check` block"));
    }
    let solve = match fields.children("solve").as_slice() {
        [] => None,
        [block] => Some(lower::solve(source, block)?),
        _ => return Err(fields.error(None, "takes at most one `solve` block")),
    };
    let task = TaskV1 {
        id,
        title: fields.need("title", title)?,
        body: fields.markdown("body")?,
        machine,
        needs: fields.strings("needs")?,
        optional: fields.flag("optional", false)?,
        check: lower::checks(source, &checks)?,
        solve,
        hints: hints(source, &mut fields)?,
    };
    fields.done()?;
    Ok(task)
}

fn scenario(source: &Source, block: &Block, directory: &str) -> Loaded<ScenarioV1> {
    if block.ident.as_str() != "scenario" {
        return Err(source.at(
            block.span(),
            "a scenario file holds one `scenario \"<slug>\"` block",
        ));
    }
    // Today's schema has the same top block; its children give it away.
    let retired = block.body.iter().any(|structure| match structure {
        Structure::Block(child) => {
            matches!(child.ident.as_str(), "vm" | "kino" | "image" | "solution")
        }
        Structure::Attribute(_) => false,
    });
    if retired {
        return Err(source.at(block.span(), RETIRED));
    }
    let slug = label(source, block)?;
    if slug != directory {
        return Err(source.at(
            block.span(),
            format!("scenario `{slug}` must be in scenarios/{slug}/"),
        ));
    }
    let mut fields = Fields::of(source, block)?;
    let (title, summary) = (fields.text("title")?, fields.text("summary")?);
    let difficulty = match fields.text("difficulty")?.as_deref() {
        Some("easy") => Difficulty::Easy,
        Some("medium") => Difficulty::Medium,
        Some("hard") => Difficulty::Hard,
        _ => return Err(fields.error(None, "`difficulty` is `easy`, `medium` or `hard`")),
    };
    let minutes = fields
        .number("minutes")?
        .and_then(|minutes| u32::try_from(minutes).ok());
    let (briefing, solution) = (fields.markdown("briefing")?, fields.markdown("solution")?);
    let machines = fields
        .labelled("machine")?
        .into_iter()
        .map(|(name, block)| machine(source, name, block))
        .collect::<Loaded<Vec<_>>>()?;
    let tasks = fields
        .labelled("task")?
        .into_iter()
        .map(|(id, block)| task(source, id, block, &machines))
        .collect::<Loaded<_>>()?;
    let scenario = ScenarioV1 {
        slug,
        title: fields.need("title", title)?,
        summary: fields.need("summary", summary)?,
        difficulty,
        minutes: fields.need("minutes", minutes)?,
        tags: fields.strings("tags")?,
        credit: fields.markdown("credit")?,
        play: fields.flag("play", false)?,
        briefing: fields.need("briefing", briefing)?,
        solution: fields.need("solution", solution)?,
        hints: hints(source, &mut fields)?,
        machines,
        tasks,
    };
    fields.done()?;
    Ok(scenario)
}
