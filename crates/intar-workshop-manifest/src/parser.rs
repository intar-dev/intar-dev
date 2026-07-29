use crate::error::{Result, WorkshopManifestError, invalid};
use crate::model::*;
use std::collections::HashSet;

pub(crate) fn parse_manifest(content: &str) -> Result<WorkshopManifest> {
    let body: hcl::Body =
        hcl::from_str(content).map_err(|error| WorkshopManifestError::Parse(error.to_string()))?;

    if let Some(attribute) = body.attributes().next() {
        return Err(invalid(format!(
            "root does not support attribute '{}'",
            attribute.key
        )));
    }

    let mut workshop = None;
    let mut workspace = None;
    let mut presentation = None;
    let mut modules = Vec::new();
    let mut agenda = Vec::new();

    for block in body.blocks() {
        match block.identifier.as_str() {
            "workshop" => set_once(&mut workshop, parse_workshop(block)?, "workshop")?,
            "workspace" => set_once(&mut workspace, parse_workspace(block)?, "workspace")?,
            "module" => modules.push(parse_module(block)?),
            "agenda" => agenda.push(parse_agenda(block)?),
            "presentation" => set_once(
                &mut presentation,
                parse_presentation(block)?,
                "presentation",
            )?,
            other => return Err(invalid(format!("root does not support block '{other}'"))),
        }
    }

    let (format_version, workshop) = workshop.ok_or_else(|| invalid("missing workshop block"))?;
    Ok(WorkshopManifest {
        format_version,
        workshop,
        workspace: workspace.ok_or_else(|| invalid("missing workspace block"))?,
        modules,
        agenda,
        presentation: presentation.ok_or_else(|| invalid("missing presentation block"))?,
    })
}

fn set_once<T>(target: &mut Option<T>, value: T, name: &str) -> Result<()> {
    if target.replace(value).is_some() {
        return Err(invalid(format!("only one {name} block is supported")));
    }
    Ok(())
}

fn parse_workshop(block: &hcl::Block) -> Result<(u8, Workshop)> {
    let id = single_label(block, "workshop")?;
    reject_nested(block, "workshop")?;
    reject_unknown_attrs(
        block,
        &[
            "format_version",
            "title",
            "summary",
            "prerequisites",
            "attribution",
            "default_lobby_minutes",
        ],
        "workshop",
    )?;
    let format_version = u8::try_from(required_u32(block, "format_version", "workshop")?)
        .map_err(|_| invalid("workshop format_version is out of range"))?;
    Ok((
        format_version,
        Workshop {
            id,
            title: required_string(block, "title", "workshop")?,
            summary: required_string(block, "summary", "workshop")?,
            prerequisites: optional_string_array(block, "prerequisites", "workshop")?
                .unwrap_or_default(),
            attribution: required_string(block, "attribution", "workshop")?,
            default_lobby_minutes: required_u32(block, "default_lobby_minutes", "workshop")?,
        },
    ))
}

fn parse_workspace(block: &hcl::Block) -> Result<Workspace> {
    reject_labels(block, "workspace")?;
    reject_unknown_attrs(
        block,
        &["lease_grace_minutes", "initial_checkpoint"],
        "workspace",
    )?;
    let mut vms = Vec::new();
    let mut provider = None;
    let mut applications = Vec::new();
    for nested in block.body.blocks() {
        match nested.identifier.as_str() {
            "vm" => vms.push(parse_vm(nested)?),
            "provider" => set_once(
                &mut provider,
                parse_workspace_provider(nested)?,
                "workspace provider",
            )?,
            "application" => applications.push(parse_application(nested)?),
            other => {
                return Err(invalid(format!(
                    "workspace does not support nested block '{other}'"
                )));
            }
        }
    }
    Ok(Workspace {
        lease_grace_minutes: required_u32(block, "lease_grace_minutes", "workspace")?,
        initial_checkpoint: required_string(block, "initial_checkpoint", "workspace")?,
        vms,
        provider,
        applications,
    })
}

fn parse_workspace_provider(block: &hcl::Block) -> Result<WorkspaceProvider> {
    let kind = single_label(block, "workspace provider")?;
    reject_nested(block, "workspace provider")?;
    match kind.as_str() {
        "hetzner_cloud" => {
            reject_unknown_attrs(
                block,
                &["vm_id", "server_type", "system_image"],
                "workspace provider 'hetzner_cloud'",
            )?;
            Ok(WorkspaceProvider::HetznerCloud {
                vm_id: required_string(block, "vm_id", "workspace provider 'hetzner_cloud'")?,
                server_type: required_string(
                    block,
                    "server_type",
                    "workspace provider 'hetzner_cloud'",
                )?,
                system_image: required_string(
                    block,
                    "system_image",
                    "workspace provider 'hetzner_cloud'",
                )?,
            })
        }
        other => Err(invalid(format!(
            "workspace provider '{other}' is unsupported"
        ))),
    }
}

fn parse_vm(block: &hcl::Block) -> Result<WorkspaceVm> {
    let id = single_label(block, "workspace vm")?;
    reject_nested(block, "workspace vm")?;
    reject_unknown_attrs(
        block,
        &[
            "image",
            "cpu_millis",
            "vcpu_millis",
            "memory_mib",
            "disk_mib",
            "disk_gib",
        ],
        "workspace vm",
    )?;
    let vcpu_millis = required_aliased_u32(block, "cpu_millis", "vcpu_millis", "workspace vm")?;
    let disk_gib = match (
        optional_u32(block, "disk_mib", "workspace vm")?,
        optional_u32(block, "disk_gib", "workspace vm")?,
    ) {
        (Some(_), Some(_)) => {
            return Err(invalid(
                "workspace vm must not declare both 'disk_mib' and legacy 'disk_gib'",
            ));
        }
        (Some(disk_mib), None) if disk_mib % 1_024 == 0 => disk_mib / 1_024,
        (Some(_), None) => {
            return Err(invalid(
                "workspace vm attribute 'disk_mib' must be a whole number of GiB",
            ));
        }
        (None, Some(disk_gib)) => disk_gib,
        (None, None) => {
            return Err(invalid(
                "workspace vm is missing required attribute 'disk_mib'",
            ));
        }
    };
    Ok(WorkspaceVm {
        id,
        image: required_string(block, "image", "workspace vm")?,
        vcpu_millis,
        memory_mib: required_u32(block, "memory_mib", "workspace vm")?,
        disk_gib,
    })
}

fn parse_application(block: &hcl::Block) -> Result<WorkspaceApplication> {
    let id = single_label(block, "workspace application")?;
    reject_nested(block, "workspace application")?;
    reject_unknown_attrs(
        block,
        &[
            "label",
            "vm",
            "port",
            "protocol",
            "upstream_host",
            "release_module",
        ],
        "workspace application",
    )?;
    let port = u16::try_from(required_u32(block, "port", "workspace application")?)
        .map_err(|_| invalid(format!("application '{id}' port is out of range")))?;
    let protocol = match required_string(block, "protocol", "workspace application")?.as_str() {
        "http" => ApplicationProtocol::Http,
        "ws" => ApplicationProtocol::Ws,
        other => {
            return Err(invalid(format!(
                "application '{id}' has unsupported protocol '{other}'"
            )));
        }
    };
    Ok(WorkspaceApplication {
        id,
        label: required_string(block, "label", "workspace application")?,
        vm: required_string(block, "vm", "workspace application")?,
        port,
        protocol,
        upstream_host: optional_string(block, "upstream_host", "workspace application")?,
        release_module: required_string(block, "release_module", "workspace application")?,
    })
}

fn parse_module(block: &hcl::Block) -> Result<Module> {
    let id = single_label(block, "module")?;
    reject_nested(block, "module")?;
    reject_unknown_attrs(
        block,
        &[
            "tier",
            "outcome",
            "depends_on",
            "content",
            "facilitator_notes",
            "hints",
            "solution",
            "explain_back",
            "verify_script",
            "catch_up_script",
            "checkpoint",
            "probes",
        ],
        "module",
    )?;
    let tier = match required_string(block, "tier", "module")?.as_str() {
        "gate" => ModuleTier::Gate,
        "core" => ModuleTier::Core,
        "stretch" => ModuleTier::Stretch,
        other => {
            return Err(invalid(format!(
                "module '{id}' has unsupported tier '{other}'"
            )));
        }
    };
    Ok(Module {
        id,
        tier,
        outcome: required_string(block, "outcome", "module")?,
        depends_on: optional_string_array(block, "depends_on", "module")?.unwrap_or_default(),
        content: required_string(block, "content", "module")?,
        facilitator_notes: required_string(block, "facilitator_notes", "module")?,
        hints: required_string_array(block, "hints", "module")?,
        solution: required_string(block, "solution", "module")?,
        explain_back: required_string(block, "explain_back", "module")?,
        verify_script: required_string(block, "verify_script", "module")?,
        catch_up_script: required_string(block, "catch_up_script", "module")?,
        checkpoint: required_string(block, "checkpoint", "module")?,
        probes: required_string_array(block, "probes", "module")?,
    })
}

fn parse_agenda(block: &hcl::Block) -> Result<AgendaItem> {
    let id = single_label(block, "agenda")?;
    reject_nested(block, "agenda")?;
    reject_unknown_attrs(
        block,
        &[
            "kind",
            "duration_minutes",
            "scheduled",
            "module",
            "slides",
            "release",
        ],
        "agenda",
    )?;
    let kind = match required_string(block, "kind", "agenda")?.as_str() {
        "briefing" => AgendaKind::Briefing,
        "lab" => AgendaKind::Lab,
        "demo" => AgendaKind::Demo,
        "break" => AgendaKind::Break,
        "explain_back" => AgendaKind::ExplainBack,
        "tinker" => AgendaKind::Tinker,
        "retro" => AgendaKind::Retro,
        other => {
            return Err(invalid(format!(
                "agenda '{id}' has unsupported kind '{other}'"
            )));
        }
    };
    let release = match optional_string(block, "release", "agenda")?
        .unwrap_or_else(|| "facilitator".to_string())
        .as_str()
    {
        "facilitator" => ReleaseMode::Facilitator,
        "automatic" => ReleaseMode::Automatic,
        "pool" => ReleaseMode::Pool,
        other => {
            return Err(invalid(format!(
                "agenda '{id}' has unsupported release mode '{other}'"
            )));
        }
    };
    Ok(AgendaItem {
        id,
        kind,
        duration_minutes: required_u32(block, "duration_minutes", "agenda")?,
        scheduled: optional_bool(block, "scheduled", "agenda")?.unwrap_or(true),
        module: optional_string(block, "module", "agenda")?,
        slides: optional_string_array(block, "slides", "agenda")?.unwrap_or_default(),
        release,
    })
}

fn parse_presentation(block: &hcl::Block) -> Result<Presentation> {
    reject_labels(block, "presentation")?;
    reject_unknown_attrs(block, &["assets"], "presentation")?;
    let mut slides = Vec::new();
    for nested in block.body.blocks() {
        if nested.identifier.as_str() != "slide" {
            return Err(invalid(format!(
                "presentation does not support nested block '{}'",
                nested.identifier
            )));
        }
        slides.push(parse_slide(nested)?);
    }
    Ok(Presentation {
        slides,
        assets: optional_string_array(block, "assets", "presentation")?.unwrap_or_default(),
    })
}

fn parse_slide(block: &hcl::Block) -> Result<PresentationSlide> {
    let id = single_label(block, "presentation slide")?;
    reject_nested(block, "presentation slide")?;
    reject_unknown_attrs(
        block,
        &["content", "presenter_notes", "layout"],
        "presentation slide",
    )?;
    let layout = match optional_string(block, "layout", "presentation slide")?
        .unwrap_or_else(|| "default".to_string())
        .as_str()
    {
        "cover" => SlideLayout::Cover,
        "default" => SlideLayout::Default,
        "section" => SlideLayout::Section,
        "statement" => SlideLayout::Statement,
        "break" => SlideLayout::Break,
        "closing" => SlideLayout::Closing,
        other => {
            return Err(invalid(format!(
                "slide '{id}' has unsupported layout '{other}'"
            )));
        }
    };
    Ok(PresentationSlide {
        id,
        content: required_string(block, "content", "presentation slide")?,
        presenter_notes: required_string(block, "presenter_notes", "presentation slide")?,
        layout,
    })
}

fn single_label(block: &hcl::Block, context: &str) -> Result<String> {
    match block.labels.as_slice() {
        [label] => Ok(label.as_str().to_owned()),
        [] => Err(invalid(format!("{context} block is missing its id label"))),
        _ => Err(invalid(format!(
            "{context} block expects exactly one id label"
        ))),
    }
}

fn reject_labels(block: &hcl::Block, context: &str) -> Result<()> {
    if block.labels.is_empty() {
        Ok(())
    } else {
        Err(invalid(format!("{context} block does not support labels")))
    }
}

fn reject_nested(block: &hcl::Block, context: &str) -> Result<()> {
    if let Some(nested) = block.body.blocks().next() {
        Err(invalid(format!(
            "{context} does not support nested block '{}'",
            nested.identifier
        )))
    } else {
        Ok(())
    }
}

fn reject_unknown_attrs(block: &hcl::Block, allowed: &[&str], context: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for attribute in block.body.attributes() {
        if !seen.insert(attribute.key.as_str()) {
            return Err(invalid(format!(
                "{context} has duplicate attribute '{}'",
                attribute.key
            )));
        }
        if !allowed.contains(&attribute.key.as_str()) {
            return Err(invalid(format!(
                "{context} does not support attribute '{}'",
                attribute.key
            )));
        }
    }
    Ok(())
}

fn attribute<'a>(
    block: &'a hcl::Block,
    key: &str,
    context: &str,
) -> Result<Option<&'a hcl::Expression>> {
    let mut values = block
        .body
        .attributes()
        .filter(|attribute| attribute.key.as_str() == key);
    let value = values.next().map(|attribute| &attribute.expr);
    if values.next().is_some() {
        return Err(invalid(format!(
            "{context} has duplicate attribute '{key}'"
        )));
    }
    Ok(value)
}

fn required_string(block: &hcl::Block, key: &str, context: &str) -> Result<String> {
    optional_string(block, key, context)?
        .ok_or_else(|| invalid(format!("{context} is missing required attribute '{key}'")))
}

fn optional_string(block: &hcl::Block, key: &str, context: &str) -> Result<Option<String>> {
    attribute(block, key, context)?
        .map(|expression| match expression {
            hcl::Expression::String(value) => Ok(value.clone()),
            other => Err(invalid(format!(
                "{context} attribute '{key}' must be a literal string, got {other:?}"
            ))),
        })
        .transpose()
}

fn required_u32(block: &hcl::Block, key: &str, context: &str) -> Result<u32> {
    optional_u32(block, key, context)?
        .ok_or_else(|| invalid(format!("{context} is missing required attribute '{key}'")))
}

fn optional_u32(block: &hcl::Block, key: &str, context: &str) -> Result<Option<u32>> {
    attribute(block, key, context)?
        .map(|expression| match expression {
            hcl::Expression::Number(number) => number
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| invalid(format!("{context} attribute '{key}' must be a u32"))),
            other => Err(invalid(format!(
                "{context} attribute '{key}' must be a number, got {other:?}"
            ))),
        })
        .transpose()
}

fn required_aliased_u32(
    block: &hcl::Block,
    key: &str,
    legacy_key: &str,
    context: &str,
) -> Result<u32> {
    match (
        optional_u32(block, key, context)?,
        optional_u32(block, legacy_key, context)?,
    ) {
        (Some(_), Some(_)) => Err(invalid(format!(
            "{context} must not declare both '{key}' and legacy '{legacy_key}'"
        ))),
        (Some(value), None) | (None, Some(value)) => Ok(value),
        (None, None) => Err(invalid(format!(
            "{context} is missing required attribute '{key}'"
        ))),
    }
}

fn optional_bool(block: &hcl::Block, key: &str, context: &str) -> Result<Option<bool>> {
    attribute(block, key, context)?
        .map(|expression| match expression {
            hcl::Expression::Bool(value) => Ok(*value),
            other => Err(invalid(format!(
                "{context} attribute '{key}' must be a boolean, got {other:?}"
            ))),
        })
        .transpose()
}

fn required_string_array(block: &hcl::Block, key: &str, context: &str) -> Result<Vec<String>> {
    optional_string_array(block, key, context)?
        .ok_or_else(|| invalid(format!("{context} is missing required attribute '{key}'")))
}

fn optional_string_array(
    block: &hcl::Block,
    key: &str,
    context: &str,
) -> Result<Option<Vec<String>>> {
    attribute(block, key, context)?
        .map(|expression| match expression {
            hcl::Expression::Array(values) => values
                .iter()
                .map(|value| match value {
                    hcl::Expression::String(value) => Ok(value.clone()),
                    other => Err(invalid(format!(
                        "{context} attribute '{key}' must contain only literal strings, got {other:?}"
                    ))),
                })
                .collect(),
            other => Err(invalid(format!(
                "{context} attribute '{key}' must be an array, got {other:?}"
            ))),
        })
        .transpose()
}
