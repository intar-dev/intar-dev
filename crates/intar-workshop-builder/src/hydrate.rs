use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{Context as _, Result, bail};
use intar_workshop_manifest::{
    AgendaKind, ApplicationProtocol, ModuleTier, ProviderArchitecture, ReleaseMode,
    ResolvedRuntimeProfile, RuntimeProviderKind, SlideLayout, ValidatedWorkshop,
};

use crate::contracts::{
    CheckpointBuildResult, HydratedAgendaItem, HydratedAttribution, HydratedCheckpoint,
    HydratedGcpRootDiskType, HydratedHint, HydratedModule, HydratedPresentation,
    HydratedRuntimeArchitecture, HydratedRuntimeHardware, HydratedRuntimeProfile, HydratedSlide,
    HydratedVmImage, HydratedWorkshop, HydratedWorkshopManifestV2, HydratedWorkspace,
    HydratedWorkspaceApplication, HydratedWorkspaceVm,
};

pub fn hydrate_workshop_manifest(
    source_root: &Path,
    source: &ValidatedWorkshop,
    resolved_runtime_profiles: &[ResolvedRuntimeProfile],
    checkpoints: &[CheckpointBuildResult],
) -> Result<HydratedWorkshopManifestV2> {
    let manifest = &source.manifest;
    if resolved_runtime_profiles.len() != manifest.workspace.runtime_profiles.len()
        || resolved_runtime_profiles
            .iter()
            .zip(&manifest.workspace.runtime_profiles)
            .any(|(resolved, authored)| {
                resolved.id != authored.id
                    || resolved.provider != authored.provider
                    || resolved.vm_id != authored.vm_id
            })
    {
        bail!("resolved runtime profiles do not match the authored profile order and identity");
    }
    let module_by_slide = manifest
        .agenda
        .iter()
        .filter_map(|item| item.module.as_ref().map(|module| (module, &item.slides)))
        .flat_map(|(module, slides)| {
            slides
                .iter()
                .map(move |slide| (slide.clone(), module.clone()))
        })
        .collect::<BTreeMap<_, _>>();

    let modules = manifest
        .modules
        .iter()
        .map(|module| {
            let participant_markdown = read_source(source_root, &module.content)?;
            let hints = module
                .hints
                .iter()
                .enumerate()
                .map(|(index, path)| {
                    let body_markdown = read_source(source_root, path)?;
                    Ok(HydratedHint {
                        id: format!("{}-hint-{:02}", module.id, index + 1),
                        title: markdown_title(&body_markdown, &format!("Hint {}", index + 1)),
                        body_markdown,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(HydratedModule {
                id: module.id.clone(),
                title: markdown_title(&participant_markdown, &format!("Module {}", module.id)),
                tier: module_tier(module.tier).to_owned(),
                outcome: module.outcome.clone(),
                depends_on: module.depends_on.clone(),
                participant_markdown,
                facilitator_notes_markdown: read_source(source_root, &module.facilitator_notes)?,
                hints,
                solution_markdown: read_source(source_root, &module.solution)?,
                explain_back_prompt: (!module.explain_back.trim().is_empty())
                    .then(|| module.explain_back.trim().to_owned()),
                probe_ids: module.probes.clone(),
                catch_up_checkpoint_id: module.checkpoint.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let module_titles = modules
        .iter()
        .map(|module| (module.id.clone(), module.title.clone()))
        .collect::<BTreeMap<_, _>>();

    let slides = manifest
        .presentation
        .slides
        .iter()
        .map(|slide| {
            let body_markdown = read_source(source_root, &slide.content)?;
            let notes = read_source(source_root, &slide.presenter_notes)?;
            Ok(HydratedSlide {
                id: slide.id.clone(),
                layout: slide_layout(slide.layout).to_owned(),
                title: markdown_title(&body_markdown, &slide.id),
                body_markdown,
                notes_markdown: (!notes.trim().is_empty()).then_some(notes),
                module_id: module_by_slide.get(&slide.id).cloned(),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let agenda = manifest
        .agenda
        .iter()
        .map(|item| HydratedAgendaItem {
            id: item.id.clone(),
            kind: agenda_kind(item.kind).to_owned(),
            title: item
                .module
                .as_ref()
                .and_then(|module| module_titles.get(module))
                .cloned()
                .unwrap_or_else(|| agenda_title(item.kind).to_owned()),
            duration_minutes: item.duration_minutes,
            scheduled: item.scheduled,
            module_id: item.module.clone(),
            slide_ids: item.slides.clone(),
            release: release_mode(item.release).to_owned(),
        })
        .collect();

    let attribution_title = manifest.workshop.attribution.clone();
    let attribution = HydratedAttribution {
        url: first_http_url(&attribution_title).unwrap_or_default(),
        license: detected_license(&attribution_title)
            .unwrap_or_else(|| "See bundled LICENSE".to_owned()),
        title: attribution_title,
    };
    let workspace_vms = manifest
        .workspace
        .vms
        .iter()
        .map(|vm| {
            Ok(HydratedWorkspaceVm {
                id: vm.id.clone(),
                name: vm.id.clone(),
                cpu_millis: vm.cpu_millis,
                memory_mib: vm.memory_mib,
                disk_mib: vm.disk_mib,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(HydratedWorkshopManifestV2 {
        schema_version: 2,
        workshop: HydratedWorkshop {
            slug: manifest.workshop.id.clone(),
            title: manifest.workshop.title.clone(),
            summary: manifest.workshop.summary.clone(),
            prerequisites: manifest.workshop.prerequisites.clone(),
            attribution,
            default_lobby_minutes: manifest.workshop.default_lobby_minutes,
        },
        workspace: HydratedWorkspace {
            lease_grace_minutes: manifest.workspace.lease_grace_minutes,
            vms: workspace_vms,
            runtime_profiles: resolved_runtime_profiles
                .iter()
                .map(hydrate_runtime_profile)
                .collect::<Result<Vec<_>>>()?,
            checkpoints: checkpoints
                .iter()
                .map(|checkpoint| HydratedCheckpoint {
                    id: checkpoint.checkpoint_id.clone(),
                    label: checkpoint.checkpoint_id.clone(),
                    vm_images: checkpoint
                        .vm_images
                        .iter()
                        .map(HydratedVmImage::from)
                        .collect(),
                })
                .collect(),
            initial_checkpoint_id: manifest.workspace.initial_checkpoint.clone(),
            applications: manifest
                .workspace
                .applications
                .iter()
                .map(|application| HydratedWorkspaceApplication {
                    id: application.id.clone(),
                    label: application.label.clone(),
                    vm_id: application.vm.clone(),
                    port: application.port,
                    protocol: application_protocol(application.protocol).to_owned(),
                    upstream_host: application.upstream_host.clone(),
                    release_module_id: application.release_module.clone(),
                })
                .collect(),
        },
        modules,
        agenda,
        presentation: HydratedPresentation { slides },
        duration_minutes: source.scheduled_duration_minutes,
    })
}

fn hydrate_runtime_profile(profile: &ResolvedRuntimeProfile) -> Result<HydratedRuntimeProfile> {
    if profile.hardware.architecture != ProviderArchitecture::X86_64 {
        bail!(
            "resolved runtime profile '{}' cannot publish unsupported architecture",
            profile.id
        );
    }
    let hardware = HydratedRuntimeHardware {
        architecture: HydratedRuntimeArchitecture::X86_64,
        cpu_millis: profile.hardware.cpu_millis,
        provider_cpu_count: profile.hardware.provider_cpu_count,
        memory_mib: profile.hardware.memory_mib,
        disk_mib: profile.hardware.disk_mib,
    };
    match profile.provider {
        RuntimeProviderKind::AgentKvm => {
            if profile.machine_type.is_some()
                || profile.root_disk_type.is_some()
                || !profile.locations.is_empty()
                || profile.requested_system_image != profile.immutable_system_image
            {
                bail!(
                    "resolved agent_kvm runtime profile '{}' contains direct-cloud metadata",
                    profile.id
                );
            }
            Ok(HydratedRuntimeProfile::AgentKvm {
                id: profile.id.clone(),
                vm_id: profile.vm_id.clone(),
                requested_system_image: profile.requested_system_image.clone(),
                immutable_system_image: profile.immutable_system_image.clone(),
                locations: Vec::new(),
                hardware,
            })
        }
        RuntimeProviderKind::HetznerCloud => {
            let machine_type = required_machine_type(profile)?;
            if profile.root_disk_type.is_some() || profile.locations.is_empty() {
                bail!(
                    "resolved hetzner_cloud runtime profile '{}' has invalid disk or location metadata",
                    profile.id
                );
            }
            Ok(HydratedRuntimeProfile::HetznerCloud {
                id: profile.id.clone(),
                vm_id: profile.vm_id.clone(),
                machine_type,
                requested_system_image: profile.requested_system_image.clone(),
                immutable_system_image: profile.immutable_system_image.clone(),
                locations: profile.locations.clone(),
                hardware,
            })
        }
        RuntimeProviderKind::GcpCompute => {
            let machine_type = required_machine_type(profile)?;
            if profile.root_disk_type.as_deref() != Some("pd-balanced")
                || profile.locations.is_empty()
            {
                bail!(
                    "resolved gcp_compute runtime profile '{}' must use pd-balanced in at least one location",
                    profile.id
                );
            }
            Ok(HydratedRuntimeProfile::GcpCompute {
                id: profile.id.clone(),
                vm_id: profile.vm_id.clone(),
                machine_type,
                requested_system_image: profile.requested_system_image.clone(),
                immutable_system_image: profile.immutable_system_image.clone(),
                root_disk_type: HydratedGcpRootDiskType::PdBalanced,
                locations: profile.locations.clone(),
                hardware,
            })
        }
    }
}

fn required_machine_type(profile: &ResolvedRuntimeProfile) -> Result<String> {
    profile
        .machine_type
        .as_ref()
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "resolved {:?} runtime profile '{}' is missing machine_type",
                profile.provider,
                profile.id
            )
        })
}

fn read_source(root: &Path, relative: &str) -> Result<String> {
    fs::read_to_string(root.join(relative))
        .with_context(|| format!("failed to read hydrated workshop source '{relative}'"))
}

fn markdown_title(markdown: &str, fallback: &str) -> String {
    markdown
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            let heading = trimmed.trim_start_matches('#');
            (heading.len() < trimmed.len() && heading.starts_with(char::is_whitespace))
                .then(|| heading.trim().trim_end_matches('#').trim().to_owned())
        })
        .filter(|title| !title.is_empty())
        .map(|title| title.chars().take(120).collect())
        .unwrap_or_else(|| fallback.to_owned())
}

fn first_http_url(value: &str) -> Option<String> {
    value
        .split_whitespace()
        .find(|word| word.starts_with("https://") || word.starts_with("http://"))
        .map(|word| word.trim_end_matches([',', '.', ')', ']', ';']).to_owned())
}

fn detected_license(value: &str) -> Option<String> {
    [
        "Apache-2.0",
        "MIT",
        "BSD-3-Clause",
        "BSD-2-Clause",
        "MPL-2.0",
    ]
    .into_iter()
    .find(|license| {
        value
            .to_ascii_lowercase()
            .contains(&license.to_ascii_lowercase())
    })
    .map(str::to_owned)
}

const fn module_tier(value: ModuleTier) -> &'static str {
    match value {
        ModuleTier::Gate => "gate",
        ModuleTier::Core => "core",
        ModuleTier::Stretch => "stretch",
    }
}

const fn agenda_kind(value: AgendaKind) -> &'static str {
    match value {
        AgendaKind::Briefing => "briefing",
        AgendaKind::Lab => "lab",
        AgendaKind::Demo => "demo",
        AgendaKind::Break => "break",
        AgendaKind::ExplainBack => "explain_back",
        AgendaKind::Tinker => "tinker",
        AgendaKind::Retro => "retro",
    }
}

const fn agenda_title(value: AgendaKind) -> &'static str {
    match value {
        AgendaKind::Briefing => "Briefing",
        AgendaKind::Lab => "Lab",
        AgendaKind::Demo => "Demo",
        AgendaKind::Break => "Break",
        AgendaKind::ExplainBack => "Explain back",
        AgendaKind::Tinker => "Tinker",
        AgendaKind::Retro => "Closing reflection",
    }
}

const fn release_mode(value: ReleaseMode) -> &'static str {
    match value {
        ReleaseMode::Facilitator => "facilitator",
        ReleaseMode::Automatic => "automatic",
        ReleaseMode::Pool => "pool",
    }
}

const fn slide_layout(value: SlideLayout) -> &'static str {
    match value {
        SlideLayout::Cover | SlideLayout::Section | SlideLayout::Break | SlideLayout::Closing => {
            "title"
        }
        SlideLayout::Statement => "quote",
        SlideLayout::Default => "content",
    }
}

const fn application_protocol(value: ApplicationProtocol) -> &'static str {
    match value {
        ApplicationProtocol::Http => "http",
        ApplicationProtocol::Ws => "ws",
    }
}

#[cfg(test)]
pub(crate) fn resolved_profiles_for_hydration_test(
    source: &ValidatedWorkshop,
) -> Vec<ResolvedRuntimeProfile> {
    source
        .manifest
        .workspace
        .runtime_profiles
        .iter()
        .map(|profile| {
            let vm = source
                .manifest
                .workspace
                .vms
                .iter()
                .find(|vm| vm.id == profile.vm_id)
                .expect("validated profile references a VM");
            ResolvedRuntimeProfile {
                id: profile.id.clone(),
                provider: profile.provider,
                vm_id: profile.vm_id.clone(),
                machine_type: profile.machine_type.clone(),
                requested_system_image: profile.system_image.clone(),
                immutable_system_image: profile.system_image.clone(),
                root_disk_type: profile.root_disk_type.clone(),
                locations: match profile.provider {
                    RuntimeProviderKind::HetznerCloud => vec!["nbg1".to_owned()],
                    RuntimeProviderKind::AgentKvm | RuntimeProviderKind::GcpCompute => {
                        profile.locations.clone()
                    }
                },
                hardware: intar_workshop_manifest::ResolvedProviderHardware {
                    architecture: ProviderArchitecture::X86_64,
                    cpu_millis: vm.cpu_millis,
                    provider_cpu_count: vm.cpu_millis.div_ceil(1_000),
                    memory_mib: vm.memory_mib,
                    disk_mib: vm.disk_mib,
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use intar_workshop_manifest::load_and_validate;

    use super::{
        detected_license, first_http_url, hydrate_workshop_manifest, markdown_title,
        resolved_profiles_for_hydration_test,
    };

    #[test]
    fn derives_display_metadata_without_interpreting_markdown() {
        assert_eq!(
            markdown_title("text\n## A title ##\n", "fallback"),
            "A title"
        );
        assert_eq!(
            first_http_url("Adapted from https://example.com/source, Apache-2.0").as_deref(),
            Some("https://example.com/source")
        );
        assert_eq!(
            detected_license("upstream Apache-2.0 licensed").as_deref(),
            Some("Apache-2.0")
        );
    }

    #[test]
    fn hydrates_the_authored_default_lobby_minutes() -> anyhow::Result<()> {
        let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../intar-workshop-manifest/tests/fixtures/platform-engineering-workshop");
        let source = load_and_validate(&source_root)?;
        let profiles = resolved_profiles_for_hydration_test(&source);
        let hydrated = hydrate_workshop_manifest(&source_root, &source, &profiles, &[])?;

        assert_eq!(hydrated.workshop.default_lobby_minutes, 30);
        assert_eq!(
            serde_json::to_value(&hydrated)?["workshop"]["defaultLobbyMinutes"],
            30
        );
        Ok(())
    }
}
