use anyhow::{Context as _, Result, bail};
use intar_contracts::catalog::{
    CourseCatalogLectureV2, GUEST_BOOTSTRAP_ABI_V1, ImageArchitecture, ImageFormat, ImageKey, Mib,
    ProbePhase as CatalogProbePhase, ScenarioHintManifestV3, ScenarioManifestV4,
    ScenarioProbeManifestV3, ScenarioVmBootManifestV4, ScenarioVmManifestV4,
};
use intar_image_scenario::{ScenarioHint, VmDefinition};

use crate::direct::RenderedDirectBuild;
use crate::qemu::PUBLISHED_BOOT_CMDLINE;

/// Build the v4 catalog manifest for a direct chunked-raw VM build.
///
/// # Errors
/// Returns an error if scenario-derived probe metadata or architecture conversion fails.
pub fn build_direct_manifest_json(
    rendered: &RenderedDirectBuild,
    image_id: &str,
    chunk_manifest_sha256: &str,
    kernel_sha256: &str,
    initrd_sha256: &str,
) -> Result<ScenarioManifestV4> {
    build_manifest(ManifestInput {
        scenario: &rendered.scenario,
        scenario_name: &rendered.scenario_name,
        lecture: &rendered.lecture,
        target_arch: &rendered.target_arch,
        vm: &rendered.vm,
        image_id,
        chunk_manifest_sha256,
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
    manifests: impl IntoIterator<Item = &'a ScenarioManifestV4>,
) -> Result<ScenarioManifestV4> {
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
    combined: &mut ScenarioManifestV4,
    manifest: &ScenarioManifestV4,
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
    lecture: &'a CourseCatalogLectureV2,
    target_arch: &'a str,
    vm: &'a VmDefinition,
    image_id: &'a str,
    chunk_manifest_sha256: &'a str,
    image_virtual_size_bytes: u64,
    kernel_sha256: &'a str,
    initrd_sha256: &'a str,
    boot_cmdline: &'a str,
}

fn build_manifest(input: ManifestInput<'_>) -> Result<ScenarioManifestV4> {
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
            Ok(ScenarioProbeManifestV3 {
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

    Ok(ScenarioManifestV4 {
        schema_version: 4,
        scenario_id: input.scenario_name.to_string(),
        name: input.scenario_name.to_string(),
        title: input.lecture.title.clone(),
        category: input.lecture.category.clone(),
        description: input.lecture.summary.clone(),
        difficulty: input
            .lecture
            .difficulty
            .clone()
            .context("lecture difficulty must be validated before manifest generation")?,
        estimated_minutes: input.lecture.estimated_minutes,
        tags: input.lecture.tags.clone(),
        briefing_markdown: input.lecture.body_markdown.clone(),
        solution_markdown: input
            .scenario
            .solution
            .as_ref()
            .context("scenario solution must be validated before manifest generation")?
            .body
            .clone(),
        hints: catalog_hints(&input.scenario.hints),
        vms: vec![ScenarioVmManifestV4 {
            name: input.vm.name.clone(),
            image_key: ImageKey {
                scenario: input.scenario_name.to_string(),
                vm: input.vm.name.clone(),
                arch,
            },
            image_id: input.image_id.to_string(),
            image_format: ImageFormat::RawChunksV1,
            image_virtual_size_bytes: input.image_virtual_size_bytes,
            chunk_manifest_sha256: input.chunk_manifest_sha256.to_string(),
            guest_bootstrap_abi: GUEST_BOOTSTRAP_ABI_V1,
            boot: ScenarioVmBootManifestV4 {
                kernel_sha256: input.kernel_sha256.to_string(),
                initrd_sha256: input.initrd_sha256.to_string(),
                cmdline: input.boot_cmdline.to_string(),
            },
            cpu_millis: input.vm.cpu_millis,
            vcpu_count: input.vm.vcpu_count,
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

fn catalog_hints(hints: &[ScenarioHint]) -> Vec<ScenarioHintManifestV3> {
    hints
        .iter()
        .map(|hint| ScenarioHintManifestV3 {
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
    use crate::qemu::PUBLISHED_BOOT_CMDLINE;

    #[test]
    fn direct_manifest_uses_raw_chunks_and_real_boot_hashes() {
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
            lecture: lecture_fixture(),
            vm_name: "web".to_string(),
            config: QemuBuildConfig {
                output_root: directory.path().join("dist"),
                work_root: directory.path().join(".work"),
                ..QemuBuildConfig::default()
            },
            base_image: catalog.base_image_by_name("trixie").unwrap().clone(),
        })
        .unwrap();

        let manifest = build_direct_manifest_json(
            &rendered,
            &"a".repeat(64),
            &"b".repeat(64),
            &"c".repeat(64),
            &"d".repeat(64),
        )
        .unwrap();

        let vm = &manifest.vms[0];
        assert_eq!(vm.image_id, "a".repeat(64));
        assert_eq!(vm.chunk_manifest_sha256, "b".repeat(64));
        assert_eq!(
            vm.image_format,
            intar_contracts::catalog::ImageFormat::RawChunksV1
        );
        assert_eq!(vm.image_virtual_size_bytes, 6 * 1024 * 1024 * 1024);
        assert_eq!(vm.boot.kernel_sha256, "c".repeat(64));
        assert_eq!(vm.boot.initrd_sha256, "d".repeat(64));
        assert_eq!(vm.boot.cmdline, PUBLISHED_BOOT_CMDLINE);
        assert_eq!(manifest.schema_version, 4);
        assert_eq!(manifest.title, "Lecture title");
        assert_eq!(manifest.description, "Lecture summary");
        assert_eq!(manifest.category, "lecture-category");
        assert_eq!(manifest.tags, ["lecture-tag"]);
        assert_eq!(manifest.briefing_markdown, "Lecture theory.");
        assert_eq!(
            vm.guest_bootstrap_abi,
            intar_contracts::catalog::GUEST_BOOTSTRAP_ABI_V1
        );
        assert_eq!(vm.cpu_millis, 1_000);
        assert_eq!(vm.vcpu_count, 1);
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
    ) -> intar_contracts::catalog::ScenarioManifestV4 {
        intar_contracts::catalog::ScenarioManifestV4 {
            schema_version: 4,
            scenario_id: "broken-nginx".to_string(),
            name: "broken-nginx".to_string(),
            title: "Broken Nginx".to_string(),
            category: "web".to_string(),
            description: "Fix nginx".to_string(),
            difficulty: intar_contracts::catalog::ScenarioDifficulty::Easy,
            estimated_minutes: 15,
            tags: vec!["nginx".to_string()],
            briefing_markdown: "Restore nginx.".to_string(),
            solution_markdown: "Start nginx.".to_string(),
            hints: Vec::new(),
            vms: vec![intar_contracts::catalog::ScenarioVmManifestV4 {
                name: vm_name.to_string(),
                image_key: intar_contracts::catalog::ImageKey {
                    scenario: "broken-nginx".to_string(),
                    vm: vm_name.to_string(),
                    arch: intar_contracts::catalog::ImageArchitecture::X86_64,
                },
                image_id: image_sha.repeat(64),
                image_format: intar_contracts::catalog::ImageFormat::RawChunksV1,
                image_virtual_size_bytes: 1024,
                chunk_manifest_sha256: "c".repeat(64),
                guest_bootstrap_abi: intar_contracts::catalog::GUEST_BOOTSTRAP_ABI_V1,
                boot: intar_contracts::catalog::ScenarioVmBootManifestV4 {
                    kernel_sha256: "k".repeat(64),
                    initrd_sha256: "i".repeat(64),
                    cmdline: PUBLISHED_BOOT_CMDLINE.to_string(),
                },
                cpu_millis: 1_000,
                vcpu_count: 1,
                memory_mib: intar_contracts::catalog::Mib(512),
                disk_mib: intar_contracts::catalog::Mib(2048),
                probes: Vec::new(),
            }],
        }
    }

    fn lecture_fixture() -> intar_contracts::catalog::CourseCatalogLectureV2 {
        intar_contracts::catalog::CourseCatalogLectureV2 {
            lecture_id: "01-nginx".to_string(),
            title: "Lecture title".to_string(),
            summary: "Lecture summary".to_string(),
            body_markdown: "Lecture theory.".to_string(),
            category: "lecture-category".to_string(),
            tags: vec!["lecture-tag".to_string()],
            difficulty: Some(intar_contracts::catalog::ScenarioDifficulty::Easy),
            estimated_minutes: 15,
            scenario_id: Some("broken-nginx".to_string()),
        }
    }
}
