use crate::error::{Result, WorkshopManifestError, invalid};
use crate::mermaid::validate_markdown_mermaid;
use crate::model::*;
use crate::parser::parse_manifest;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

const MANIFEST_PATH: &str = "workshop.hcl";
const MAX_SOURCE_FILE_BYTES: u64 = 8 * 1024 * 1024;

pub fn load_and_validate(root: impl AsRef<Path>) -> Result<ValidatedWorkshop> {
    let root = root.as_ref();
    let metadata = fs::metadata(root).map_err(|source| WorkshopManifestError::Read {
        path: root.to_path_buf(),
        source,
    })?;
    if !metadata.is_dir() {
        return Err(invalid(format!(
            "workshop root '{}' is not a directory",
            root.display()
        )));
    }
    let root = fs::canonicalize(root).map_err(|source| WorkshopManifestError::Read {
        path: root.to_path_buf(),
        source,
    })?;
    let manifest_path = root.join(MANIFEST_PATH);
    let content = read_regular_source(&root, MANIFEST_PATH)?;
    let content = String::from_utf8(content).map_err(|_| {
        invalid(format!(
            "{} must contain valid UTF-8",
            manifest_path.display()
        ))
    })?;
    let manifest = parse_manifest(&content)?;
    validate_manifest(&root, manifest)
}

fn validate_manifest(root: &Path, manifest: WorkshopManifest) -> Result<ValidatedWorkshop> {
    if manifest.format_version != 1 {
        return Err(invalid(format!(
            "unsupported format_version {} (expected 1)",
            manifest.format_version
        )));
    }
    validate_id("workshop id", &manifest.workshop.id)?;
    nonempty("workshop title", &manifest.workshop.title)?;
    nonempty("workshop summary", &manifest.workshop.summary)?;
    nonempty("workshop attribution", &manifest.workshop.attribution)?;
    if manifest.workshop.default_lobby_minutes > 1440 {
        return Err(invalid(
            "workshop default_lobby_minutes must be between 0 and 1440",
        ));
    }
    for prerequisite in &manifest.workshop.prerequisites {
        nonempty("workshop prerequisite", prerequisite)?;
    }

    let mut source_files = BTreeSet::from([MANIFEST_PATH.to_string()]);
    include_optional_license(root, &mut source_files)?;
    validate_workspace(&manifest, &mut source_files, root)?;
    let module_index = validate_modules(&manifest, &mut source_files, root)?;
    if !manifest
        .modules
        .iter()
        .any(|module| module.checkpoint == manifest.workspace.initial_checkpoint)
    {
        return Err(invalid(format!(
            "workspace initial checkpoint '{}' is not published by any module",
            manifest.workspace.initial_checkpoint
        )));
    }
    let slide_ids = validate_presentation(&manifest, &mut source_files, root)?;
    let scheduled_duration_minutes = validate_agenda(&manifest, &module_index, &slide_ids)?;

    Ok(ValidatedWorkshop {
        manifest,
        scheduled_duration_minutes,
        source_files: source_files.into_iter().collect(),
    })
}

fn include_optional_license(root: &Path, source_files: &mut BTreeSet<String>) -> Result<()> {
    match fs::symlink_metadata(root.join("LICENSE")) {
        Ok(_) => {
            let _ = read_regular_source(root, "LICENSE")?;
            source_files.insert("LICENSE".to_owned());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(WorkshopManifestError::Read {
                path: root.join("LICENSE"),
                source,
            });
        }
    }
    Ok(())
}

fn validate_workspace(
    manifest: &WorkshopManifest,
    _source_files: &mut BTreeSet<String>,
    _root: &Path,
) -> Result<()> {
    let workspace = &manifest.workspace;
    if !(1..=1440).contains(&workspace.lease_grace_minutes) {
        return Err(invalid(
            "workspace lease_grace_minutes must be between 1 and 1440",
        ));
    }
    validate_id(
        "workspace initial checkpoint",
        &workspace.initial_checkpoint,
    )?;
    if workspace.vms.is_empty() {
        return Err(invalid("workspace must contain at least one vm block"));
    }
    if workspace.vms.len() > 8 {
        return Err(invalid("workspace may contain at most 8 vm blocks"));
    }

    let mut vm_ids = HashSet::new();
    for vm in &workspace.vms {
        validate_id("workspace vm id", &vm.id)?;
        if !vm_ids.insert(vm.id.as_str()) {
            return Err(invalid(format!("duplicate workspace vm '{}'", vm.id)));
        }
        validate_id("workspace vm image", &vm.image)?;
        if !(250..=32_000).contains(&vm.vcpu_millis) || vm.vcpu_millis % 250 != 0 {
            return Err(invalid(format!(
                "vm '{}' vcpu_millis must be between 250 and 32000 in increments of 250",
                vm.id
            )));
        }
        if !(256..=262_144).contains(&vm.memory_mib) || vm.memory_mib % 256 != 0 {
            return Err(invalid(format!(
                "vm '{}' memory_mib must be between 256 and 262144 in increments of 256",
                vm.id
            )));
        }
        if !(1..=2048).contains(&vm.disk_gib) {
            return Err(invalid(format!(
                "vm '{}' disk_gib must be between 1 and 2048",
                vm.id
            )));
        }
    }

    let module_ids: HashSet<_> = manifest
        .modules
        .iter()
        .map(|module| module.id.as_str())
        .collect();
    let mut application_ids = HashSet::new();
    let mut endpoints = HashSet::new();
    for application in &workspace.applications {
        validate_id("workspace application id", &application.id)?;
        if !application_ids.insert(application.id.as_str()) {
            return Err(invalid(format!(
                "duplicate workspace application '{}'",
                application.id
            )));
        }
        nonempty("workspace application label", &application.label)?;
        if !vm_ids.contains(application.vm.as_str()) {
            return Err(invalid(format!(
                "application '{}' references unknown vm '{}'",
                application.id, application.vm
            )));
        }
        if application.port == 0 {
            return Err(invalid(format!(
                "application '{}' port must be between 1 and 65535",
                application.id
            )));
        }
        if !endpoints.insert((application.vm.as_str(), application.port)) {
            return Err(invalid(format!(
                "multiple applications declare {}:{}",
                application.vm, application.port
            )));
        }
        if !module_ids.contains(application.release_module.as_str()) {
            return Err(invalid(format!(
                "application '{}' references unknown release module '{}'",
                application.id, application.release_module
            )));
        }
    }
    Ok(())
}

fn validate_modules<'a>(
    manifest: &'a WorkshopManifest,
    source_files: &mut BTreeSet<String>,
    root: &Path,
) -> Result<HashMap<&'a str, &'a Module>> {
    if manifest.modules.is_empty() {
        return Err(invalid("workshop must contain at least one module block"));
    }
    let mut modules = HashMap::new();
    let mut checkpoints = HashSet::new();
    let mut probes = HashSet::new();
    for module in &manifest.modules {
        validate_id("module id", &module.id)?;
        if modules.insert(module.id.as_str(), module).is_some() {
            return Err(invalid(format!("duplicate module '{}'", module.id)));
        }
        nonempty(&format!("module '{}' outcome", module.id), &module.outcome)?;
        nonempty(
            &format!("module '{}' explain_back", module.id),
            &module.explain_back,
        )?;
        reject_markup(
            &format!("module '{}' explain_back", module.id),
            &module.explain_back,
        )?;
        validate_id("module checkpoint", &module.checkpoint)?;
        if !checkpoints.insert(module.checkpoint.as_str()) {
            return Err(invalid(format!(
                "multiple modules publish checkpoint '{}'",
                module.checkpoint
            )));
        }
        if module.hints.is_empty() {
            return Err(invalid(format!(
                "module '{}' must declare at least one hint path",
                module.id
            )));
        }
        if module.probes.is_empty() {
            return Err(invalid(format!(
                "module '{}' must declare at least one probe",
                module.id
            )));
        }
        let mut module_probe_ids = HashSet::new();
        for probe in &module.probes {
            validate_id("module probe id", probe)?;
            if !module_probe_ids.insert(probe.as_str()) {
                return Err(invalid(format!(
                    "module '{}' declares probe '{}' more than once",
                    module.id, probe
                )));
            }
            if !probes.insert(probe.as_str()) {
                return Err(invalid(format!(
                    "probe '{}' belongs to more than one module",
                    probe
                )));
            }
        }

        validate_markdown(root, &module.content, source_files)?;
        validate_markdown(root, &module.facilitator_notes, source_files)?;
        for hint in &module.hints {
            validate_markdown(root, hint, source_files)?;
        }
        validate_markdown(root, &module.solution, source_files)?;
        validate_script(root, &module.verify_script, source_files)?;
        validate_script(root, &module.catch_up_script, source_files)?;
    }

    for module in &manifest.modules {
        let mut dependencies = HashSet::new();
        for dependency in &module.depends_on {
            validate_id("module dependency", dependency)?;
            if !dependencies.insert(dependency.as_str()) {
                return Err(invalid(format!(
                    "module '{}' declares dependency '{}' more than once",
                    module.id, dependency
                )));
            }
            let dependency_module = modules.get(dependency.as_str()).ok_or_else(|| {
                invalid(format!(
                    "module '{}' references unknown dependency '{}'",
                    module.id, dependency
                ))
            })?;
            if dependency == &module.id {
                return Err(invalid(format!(
                    "module '{}' cannot depend on itself",
                    module.id
                )));
            }
            if tier_rank(dependency_module.tier) > tier_rank(module.tier) {
                return Err(invalid(format!(
                    "module '{}' cannot depend on later-tier module '{}'",
                    module.id, dependency
                )));
            }
        }
    }
    validate_acyclic(&modules)?;
    Ok(modules)
}

fn validate_acyclic(modules: &HashMap<&str, &Module>) -> Result<()> {
    fn visit<'a>(
        id: &'a str,
        modules: &HashMap<&'a str, &'a Module>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
        stack: &mut Vec<&'a str>,
    ) -> Result<()> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            let start = stack
                .iter()
                .position(|candidate| *candidate == id)
                .unwrap_or(0);
            let mut cycle = stack[start..].to_vec();
            cycle.push(id);
            return Err(invalid(format!(
                "module dependency cycle: {}",
                cycle.join(" -> ")
            )));
        }
        stack.push(id);
        let module = modules
            .get(id)
            .ok_or_else(|| invalid(format!("unknown module '{id}' during dependency walk")))?;
        for dependency in &module.depends_on {
            visit(dependency, modules, visiting, visited, stack)?;
        }
        let popped = stack.pop();
        debug_assert_eq!(popped, Some(id));
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }

    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    let mut stack = Vec::new();
    let mut ids: Vec<_> = modules.keys().copied().collect();
    ids.sort_unstable();
    for id in ids {
        visit(id, modules, &mut visiting, &mut visited, &mut stack)?;
    }
    Ok(())
}

fn validate_presentation(
    manifest: &WorkshopManifest,
    source_files: &mut BTreeSet<String>,
    root: &Path,
) -> Result<HashSet<String>> {
    if manifest.presentation.slides.is_empty() {
        return Err(invalid(
            "presentation must contain at least one slide block",
        ));
    }
    let mut slide_ids = HashSet::new();
    for slide in &manifest.presentation.slides {
        validate_id("presentation slide id", &slide.id)?;
        if !slide_ids.insert(slide.id.clone()) {
            return Err(invalid(format!(
                "duplicate presentation slide '{}'",
                slide.id
            )));
        }
        validate_markdown(root, &slide.content, source_files)?;
        validate_markdown(root, &slide.presenter_notes, source_files)?;
    }
    for asset in &manifest.presentation.assets {
        validate_asset(root, asset, source_files)?;
    }
    Ok(slide_ids)
}

fn validate_agenda(
    manifest: &WorkshopManifest,
    modules: &HashMap<&str, &Module>,
    slide_ids: &HashSet<String>,
) -> Result<u32> {
    if manifest.agenda.is_empty() {
        return Err(invalid("workshop must contain at least one agenda block"));
    }
    let mut agenda_ids = HashSet::new();
    let mut represented_modules = HashSet::new();
    let mut duration = 0_u32;
    for item in &manifest.agenda {
        validate_id("agenda id", &item.id)?;
        if !agenda_ids.insert(item.id.as_str()) {
            return Err(invalid(format!("duplicate agenda item '{}'", item.id)));
        }
        if item.scheduled && item.duration_minutes == 0 {
            return Err(invalid(format!(
                "scheduled agenda item '{}' must have a positive duration",
                item.id
            )));
        }
        if item.duration_minutes > 480 {
            return Err(invalid(format!(
                "agenda item '{}' duration may not exceed 480 minutes",
                item.id
            )));
        }
        if item.scheduled {
            duration = duration
                .checked_add(item.duration_minutes)
                .ok_or_else(|| invalid("scheduled agenda duration exceeds the supported range"))?;
        }
        match (&item.kind, item.module.as_deref()) {
            (AgendaKind::Lab | AgendaKind::ExplainBack, None) => {
                return Err(invalid(format!(
                    "agenda item '{}' of this kind requires a module",
                    item.id
                )));
            }
            (AgendaKind::Break, Some(_)) => {
                return Err(invalid(format!(
                    "break agenda item '{}' may not reference a module",
                    item.id
                )));
            }
            (_, Some(module_id)) => {
                let module = modules.get(module_id).ok_or_else(|| {
                    invalid(format!(
                        "agenda item '{}' references unknown module '{}'",
                        item.id, module_id
                    ))
                })?;
                represented_modules.insert(module_id);
                if item.release == ReleaseMode::Pool && module.tier != ModuleTier::Stretch {
                    return Err(invalid(format!(
                        "agenda item '{}' uses pool release for non-stretch module '{}'",
                        item.id, module_id
                    )));
                }
            }
            (_, None) => {
                if item.release == ReleaseMode::Pool {
                    return Err(invalid(format!(
                        "agenda item '{}' uses pool release without a module",
                        item.id
                    )));
                }
            }
        }
        for slide in &item.slides {
            if !slide_ids.contains(slide) {
                return Err(invalid(format!(
                    "agenda item '{}' references unknown slide '{}'",
                    item.id, slide
                )));
            }
        }
    }
    for module_id in modules.keys() {
        if !represented_modules.contains(module_id) {
            return Err(invalid(format!(
                "module '{module_id}' is not represented in the agenda"
            )));
        }
    }
    if duration == 0 {
        return Err(invalid(
            "scheduled agenda duration must be greater than zero",
        ));
    }
    Ok(duration)
}

fn tier_rank(tier: ModuleTier) -> u8 {
    match tier {
        ModuleTier::Gate => 0,
        ModuleTier::Core => 1,
        ModuleTier::Stretch => 2,
    }
}

fn validate_id(context: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 64 {
        return Err(invalid(format!(
            "{context} must contain between 1 and 64 characters"
        )));
    }
    let mut bytes = value.bytes();
    let first = bytes
        .next()
        .ok_or_else(|| invalid(format!("{context} is empty")))?;
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(invalid(format!(
            "{context} '{value}' must start with a lowercase ASCII letter or digit"
        )));
    }
    if bytes.any(|byte| !byte.is_ascii_lowercase() && !byte.is_ascii_digit() && byte != b'-') {
        return Err(invalid(format!(
            "{context} '{value}' may contain only lowercase ASCII letters, digits, and hyphens"
        )));
    }
    Ok(())
}

fn nonempty(context: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(invalid(format!("{context} may not be empty")))
    } else {
        Ok(())
    }
}

fn validate_markdown(
    root: &Path,
    relative: &str,
    source_files: &mut BTreeSet<String>,
) -> Result<()> {
    require_extension(relative, &["md"], "Markdown")?;
    let content = read_regular_source(root, relative)?;
    let content = String::from_utf8(content).map_err(|_| {
        invalid(format!(
            "Markdown source '{relative}' must contain valid UTF-8"
        ))
    })?;
    validate_markdown_mermaid(relative, &content)?;
    reject_markup(relative, &content)?;
    source_files.insert(relative.to_string());
    Ok(())
}

fn reject_markup(context: &str, content: &str) -> Result<()> {
    let lower = content.to_ascii_lowercase();
    if lower.contains("javascript:") || lower.contains("data:text/html") {
        return Err(invalid(format!("{context} contains an unsafe URL scheme")));
    }
    let bytes = content.as_bytes();
    for window in bytes.windows(2) {
        if window[0] == b'<'
            && (window[1].is_ascii_alphabetic() || matches!(window[1], b'/' | b'!' | b'?'))
        {
            return Err(invalid(format!(
                "{context} contains raw HTML; workshop Markdown must use supported native constructs"
            )));
        }
    }
    reject_remote_markdown_images(context, content)?;
    Ok(())
}

fn reject_remote_markdown_images(context: &str, content: &str) -> Result<()> {
    let mut fenced = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        for (index, segment) in line.split('`').enumerate() {
            if index % 2 == 1 {
                continue;
            }
            let lower = segment.to_ascii_lowercase();
            let mut remaining = lower.as_str();
            while let Some(image_start) = remaining.find("![") {
                if image_start > 0
                    && remaining.as_bytes()[..image_start]
                        .iter()
                        .rev()
                        .take_while(|byte| **byte == b'\\')
                        .count()
                        % 2
                        == 1
                {
                    remaining = &remaining[image_start + 2..];
                    continue;
                }
                let image = &remaining[image_start + 2..];
                let Some(alt_end) = image.find(']') else {
                    break;
                };
                let trailing = image[alt_end + 1..].trim_start();
                if !trailing.starts_with('(') {
                    return Err(invalid(format!(
                        "{context} contains a reference-style Markdown image; workshop images must use bundled inline targets"
                    )));
                }
                let destination = trailing[1..].trim_start().trim_start_matches('<');
                if destination.starts_with("http://") || destination.starts_with("https://") {
                    return Err(invalid(format!(
                        "{context} contains a remote Markdown image; workshop images must be bundled"
                    )));
                }
                remaining = &trailing[1..];
            }
        }
    }
    Ok(())
}

fn validate_script(root: &Path, relative: &str, source_files: &mut BTreeSet<String>) -> Result<()> {
    require_extension(relative, &["sh"], "script")?;
    let content = read_regular_source(root, relative)?;
    if content.is_empty() {
        return Err(invalid(format!("script source '{relative}' is empty")));
    }
    source_files.insert(relative.to_string());
    Ok(())
}

fn validate_asset(root: &Path, relative: &str, source_files: &mut BTreeSet<String>) -> Result<()> {
    require_extension(
        relative,
        &["png", "jpg", "jpeg", "gif", "webp", "svg"],
        "presentation asset",
    )?;
    let content = read_regular_source(root, relative)?;
    if relative.to_ascii_lowercase().ends_with(".svg") {
        let content = String::from_utf8(content).map_err(|_| {
            invalid(format!(
                "SVG presentation asset '{relative}' must contain valid UTF-8"
            ))
        })?;
        let lower = content.to_ascii_lowercase();
        if lower.contains("<script")
            || lower.contains("javascript:")
            || lower.contains("onload=")
            || lower.contains("onclick=")
            || lower.contains("<foreignobject")
        {
            return Err(invalid(format!(
                "SVG presentation asset '{relative}' contains active content"
            )));
        }
    }
    source_files.insert(relative.to_string());
    Ok(())
}

fn require_extension(relative: &str, allowed: &[&str], context: &str) -> Result<()> {
    let extension = Path::new(relative)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    if extension
        .as_deref()
        .is_none_or(|extension| !allowed.contains(&extension))
    {
        return Err(invalid(format!(
            "{context} path '{relative}' has an unsupported file extension"
        )));
    }
    Ok(())
}

pub(crate) fn read_regular_source(root: &Path, relative: &str) -> Result<Vec<u8>> {
    validate_relative_path(relative)?;
    let mut candidate = PathBuf::from(root);
    for component in Path::new(relative).components() {
        let Component::Normal(component) = component else {
            return Err(invalid(format!(
                "source path '{relative}' must be a normalized relative path"
            )));
        };
        candidate.push(component);
        let metadata =
            fs::symlink_metadata(&candidate).map_err(|source| WorkshopManifestError::Read {
                path: candidate.clone(),
                source,
            })?;
        if metadata.file_type().is_symlink() {
            return Err(invalid(format!(
                "source path '{relative}' traverses a symlink"
            )));
        }
    }
    let metadata = fs::metadata(&candidate).map_err(|source| WorkshopManifestError::Read {
        path: candidate.clone(),
        source,
    })?;
    if !metadata.is_file() {
        return Err(invalid(format!(
            "source path '{relative}' is not a regular file"
        )));
    }
    if metadata.len() > MAX_SOURCE_FILE_BYTES {
        return Err(invalid(format!(
            "source path '{relative}' exceeds the {} byte limit",
            MAX_SOURCE_FILE_BYTES
        )));
    }
    fs::read(&candidate).map_err(|source| WorkshopManifestError::Read {
        path: candidate,
        source,
    })
}

fn validate_relative_path(relative: &str) -> Result<()> {
    if relative.is_empty() || relative.contains('\\') {
        return Err(invalid(format!(
            "source path '{relative}' must be a non-empty portable relative path"
        )));
    }
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid(format!(
            "source path '{relative}' must be a normalized relative path"
        )));
    }
    Ok(())
}
