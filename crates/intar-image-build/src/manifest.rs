use anyhow::{Context as _, Result, bail};
use intar_contracts::catalog::{
    ImageArchitecture, ImageFormat, ImageKey, Mib, ProbePhase as CatalogProbePhase,
    ScenarioDifficulty as CatalogScenarioDifficulty, ScenarioHintManifestV2, ScenarioManifestV2,
    ScenarioProbeManifestV2, ScenarioVmBootManifestV2, ScenarioVmManifestV2,
};
use intar_image_scenario::{
    ScenarioDifficulty as SourceScenarioDifficulty, ScenarioHint, VmDefinition,
};

use crate::direct::RenderedDirectBuild;
use crate::qemu::PUBLISHED_BOOT_CMDLINE;

/// Build the v2 catalog manifest for a direct raw-zstd VM build.
///
/// # Errors
/// Returns an error if scenario-derived probe metadata or architecture conversion fails.
pub fn build_direct_manifest_json(
    rendered: &RenderedDirectBuild,
    image_sha256: &str,
    kernel_sha256: &str,
    initrd_sha256: &str,
) -> Result<ScenarioManifestV2> {
    build_manifest(ManifestInput {
        scenario: &rendered.scenario,
        scenario_name: &rendered.scenario_name,
        scenario_description: &rendered.scenario_description,
        target_arch: &rendered.target_arch,
        vm: &rendered.vm,
        image_sha256,
        image_virtual_size_bytes: rendered.disk.virtual_size_bytes,
        kernel_sha256,
        initrd_sha256,
        boot_cmdline: PUBLISHED_BOOT_CMDLINE,
    })
}

/// Combine per-VM manifests for the same scenario into one publish manifest.
///
/// # Errors
/// Returns an error when the input set is empty or when any non-VM manifest field
/// differs between inputs.
pub fn combine_scenario_manifests<'a>(
    manifests: impl IntoIterator<Item = &'a ScenarioManifestV2>,
) -> Result<ScenarioManifestV2> {
    let mut manifests = manifests.into_iter();
    let Some(first) = manifests.next() else {
        bail!("cannot combine an empty manifest set");
    };
    let mut combined = first.clone();
    combined.vms.clear();

    append_manifest_if_header_matches(&mut combined, first)?;
    for manifest in manifests {
        append_manifest_if_header_matches(&mut combined, manifest)?;
    }

    Ok(combined)
}

fn append_manifest_if_header_matches(
    combined: &mut ScenarioManifestV2,
    manifest: &ScenarioManifestV2,
) -> Result<()> {
    let mut header = manifest.clone();
    header.vms.clear();
    let mut combined_header = combined.clone();
    combined_header.vms.clear();
    if header != combined_header {
        bail!("cannot combine manifests from different scenarios");
    }
    combined.vms.extend(manifest.vms.clone());
    Ok(())
}

struct ManifestInput<'a> {
    scenario: &'a intar_image_scenario::Scenario,
    scenario_name: &'a str,
    scenario_description: &'a str,
    target_arch: &'a str,
    vm: &'a VmDefinition,
    image_sha256: &'a str,
    image_virtual_size_bytes: u64,
    kernel_sha256: &'a str,
    initrd_sha256: &'a str,
    boot_cmdline: &'a str,
}

fn build_manifest(input: ManifestInput<'_>) -> Result<ScenarioManifestV2> {
    let derived = input
        .scenario
        .derive_kino_config_for_vm(&input.vm.name)
        .with_context(|| {
            format!(
                "failed to derive manifest probes for {}:{}",
                input.scenario_name, input.vm.name
            )
        })?;
    let arch = image_architecture(input.target_arch)?;
    let probes = derived
        .probe_descriptors
        .into_iter()
        .map(|probe| {
            let source_probe = input
                .scenario
                .kino
                .probes
                .get(&probe.source_probe)
                .with_context(|| format!("missing source probe '{}'", probe.source_probe))?;
            Ok(ScenarioProbeManifestV2 {
                id: probe.id,
                phase: catalog_probe_phase(probe.phase),
                kind: probe.kind.as_str().to_string(),
                display_name: probe.label,
                title: source_probe.title.clone(),
                body_markdown: source_probe.body.clone(),
                hints: catalog_hints(&source_probe.hints),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(ScenarioManifestV2 {
        schema_version: 2,
        scenario_id: input.scenario_name.to_string(),
        name: input.scenario_name.to_string(),
        title: input.scenario.title.clone(),
        description: input.scenario_description.to_string(),
        difficulty: catalog_difficulty(
            input
                .scenario
                .difficulty
                .context("scenario difficulty must be validated before manifest generation")?,
        ),
        estimated_minutes: input
            .scenario
            .estimated_minutes
            .context("scenario estimated_minutes must be validated before manifest generation")?,
        tags: input.scenario.tags.clone(),
        briefing_markdown: input.scenario.briefing.clone(),
        solution_markdown: input
            .scenario
            .solution
            .as_ref()
            .context("scenario solution must be validated before manifest generation")?
            .body
            .clone(),
        hints: catalog_hints(&input.scenario.hints),
        vms: vec![ScenarioVmManifestV2 {
            name: input.vm.name.clone(),
            image_key: ImageKey {
                scenario: input.scenario_name.to_string(),
                vm: input.vm.name.clone(),
                arch,
            },
            image_sha256: input.image_sha256.to_string(),
            image_format: ImageFormat::RawZstd,
            image_virtual_size_bytes: input.image_virtual_size_bytes,
            boot: ScenarioVmBootManifestV2 {
                kernel_sha256: input.kernel_sha256.to_string(),
                initrd_sha256: input.initrd_sha256.to_string(),
                cmdline: input.boot_cmdline.to_string(),
            },
            cpu_count: u16::try_from(input.vm.cpu)
                .context("vm cpu count does not fit manifest u16")?,
            memory_mib: Mib(input.vm.memory),
            disk_mib: Mib(input.vm.disk * 1024),
            probes,
        }],
    })
}

fn image_architecture(target_arch: &str) -> Result<ImageArchitecture> {
    match target_arch {
        "amd64" | "x86_64" => Ok(ImageArchitecture::X86_64),
        "arm64" | "aarch64" => Ok(ImageArchitecture::Aarch64),
        other => bail!("unsupported target architecture '{other}'"),
    }
}

fn catalog_probe_phase(phase: intar_image_scenario::ProbePhase) -> CatalogProbePhase {
    match phase {
        intar_image_scenario::ProbePhase::Boot => CatalogProbePhase::Boot,
        intar_image_scenario::ProbePhase::Scenario => CatalogProbePhase::Scenario,
    }
}

fn catalog_difficulty(difficulty: SourceScenarioDifficulty) -> CatalogScenarioDifficulty {
    match difficulty {
        SourceScenarioDifficulty::Easy => CatalogScenarioDifficulty::Easy,
        SourceScenarioDifficulty::Medium => CatalogScenarioDifficulty::Medium,
        SourceScenarioDifficulty::Hard => CatalogScenarioDifficulty::Hard,
    }
}

fn catalog_hints(hints: &[ScenarioHint]) -> Vec<ScenarioHintManifestV2> {
    hints
        .iter()
        .map(|hint| ScenarioHintManifestV2 {
            id: hint.id.clone(),
            title: hint.title.clone(),
            body_markdown: hint.body.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use tempfile::tempdir;

    use super::{build_direct_manifest_json, combine_scenario_manifests};
    use crate::config::QemuBuildConfig;
    use crate::direct::{DirectBuildRequest, render_direct_build};
    use crate::kino::KinoArtifact;
    use crate::qemu::PUBLISHED_BOOT_CMDLINE;

    #[test]
    fn direct_manifest_uses_raw_zstd_and_real_boot_hashes() {
        let directory = tempdir().unwrap();
        let scenario = intar_image_scenario::Scenario::parse(
            r#"
scenario "broken-nginx" {
  title = "Broken Nginx"
  category = "web"
  tags = ["nginx"]
  difficulty = "easy"
  estimated_minutes = 15
  description = "Fix nginx"
  briefing = "Restore nginx service availability."
  solution { body = "Start nginx." }

  image "debian-13-minimal" {
    base = "trixie"
  }

  kino {
    probe "svc" {
      kind = "service"
      service = "nginx"
      state = "running"
      description = "Nginx"
    }
  }

  vm "web" {
    image = "debian-13-minimal"
    probes = ["svc"]
    disk = 6
  }
}
"#,
        )
        .unwrap();
        let catalog = intar_image_scenario::BaseImageCatalog::parse(
            r#"
base_image "trixie" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages       = ["openssh-server", "ca-certificates", "sudo", "zstd"]
}
"#,
        )
        .unwrap();
        let rendered = render_direct_build(&DirectBuildRequest {
            scenario_path: "scenarios/broken-nginx/scenario.hcl".into(),
            scenario,
            vm_name: "web".to_string(),
            config: QemuBuildConfig {
                output_root: directory.path().join("dist"),
                work_root: directory.path().join(".work"),
                ..QemuBuildConfig::default()
            },
            base_image: catalog.base_image_by_name("trixie").unwrap().clone(),
            kino: KinoArtifact {
                binary_path: "/tmp/kino".into(),
                version: "0.1.24".to_string(),
            },
        })
        .unwrap();

        let manifest = build_direct_manifest_json(
            &rendered,
            &"a".repeat(64),
            &"b".repeat(64),
            &"c".repeat(64),
        )
        .unwrap();

        let vm = &manifest.vms[0];
        assert_eq!(vm.image_sha256, "a".repeat(64));
        assert_eq!(
            vm.image_format,
            intar_contracts::catalog::ImageFormat::RawZstd
        );
        assert_eq!(vm.image_virtual_size_bytes, 6 * 1024 * 1024 * 1024);
        assert_eq!(vm.boot.kernel_sha256, "b".repeat(64));
        assert_eq!(vm.boot.initrd_sha256, "c".repeat(64));
        assert_eq!(vm.boot.cmdline, PUBLISHED_BOOT_CMDLINE);
    }

    #[test]
    fn combines_vm_manifests_when_headers_match() {
        let first = manifest_fixture("web", "a");
        let second = manifest_fixture("db", "b");

        let combined = combine_scenario_manifests([&first, &second]).unwrap();

        assert_eq!(combined.scenario_id, "broken-nginx");
        assert_eq!(combined.vms.len(), 2);
        assert_eq!(combined.vms[0].name, "web");
        assert_eq!(combined.vms[1].name, "db");
    }

    #[test]
    fn rejects_combining_manifests_with_different_headers() {
        let first = manifest_fixture("web", "a");
        let mut second = manifest_fixture("db", "b");
        second.solution_markdown = "Different solution.".to_string();

        let error = combine_scenario_manifests([&first, &second]).unwrap_err();

        assert!(format!("{error:#}").contains("different scenarios"));
    }

    fn manifest_fixture(
        vm_name: &str,
        image_sha: &str,
    ) -> intar_contracts::catalog::ScenarioManifestV2 {
        intar_contracts::catalog::ScenarioManifestV2 {
            schema_version: 2,
            scenario_id: "broken-nginx".to_string(),
            name: "broken-nginx".to_string(),
            title: "Broken Nginx".to_string(),
            description: "Fix nginx".to_string(),
            difficulty: intar_contracts::catalog::ScenarioDifficulty::Easy,
            estimated_minutes: 15,
            tags: vec!["nginx".to_string()],
            briefing_markdown: "Restore nginx.".to_string(),
            solution_markdown: "Start nginx.".to_string(),
            hints: Vec::new(),
            vms: vec![intar_contracts::catalog::ScenarioVmManifestV2 {
                name: vm_name.to_string(),
                image_key: intar_contracts::catalog::ImageKey {
                    scenario: "broken-nginx".to_string(),
                    vm: vm_name.to_string(),
                    arch: intar_contracts::catalog::ImageArchitecture::X86_64,
                },
                image_sha256: image_sha.repeat(64),
                image_format: intar_contracts::catalog::ImageFormat::RawZstd,
                image_virtual_size_bytes: 1024,
                boot: intar_contracts::catalog::ScenarioVmBootManifestV2 {
                    kernel_sha256: "k".repeat(64),
                    initrd_sha256: "i".repeat(64),
                    cmdline: PUBLISHED_BOOT_CMDLINE.to_string(),
                },
                cpu_count: 1,
                memory_mib: intar_contracts::catalog::Mib(512),
                disk_mib: intar_contracts::catalog::Mib(2048),
                probes: Vec::new(),
            }],
        }
    }
}
