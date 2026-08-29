use super::*;
use flate2::read::GzDecoder;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/platform-engineering-workshop")
}

fn copy_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn editable_fixture() -> std::io::Result<TempDir> {
    let temporary = tempfile::tempdir()?;
    copy_tree(&fixture(), temporary.path())?;
    Ok(temporary)
}

fn replace_manifest(root: &Path, from: &str, to: &str) -> std::io::Result<()> {
    let path = root.join("workshop.hcl");
    let content = fs::read_to_string(&path)?;
    let replaced = content.replacen(from, to, 1);
    assert_ne!(
        content, replaced,
        "test replacement must change the fixture"
    );
    fs::write(path, replaced)
}

fn assert_invalid(result: Result<ValidatedWorkshop, WorkshopManifestError>, needle: &str) {
    let Err(error) = result else {
        panic!("expected validation to fail with {needle:?}");
    };
    let message = error.to_string();
    assert!(
        message.contains(needle),
        "expected {message:?} to contain {needle:?}"
    );
}

fn write_lab(root: &Path, markdown: &str) -> std::io::Result<()> {
    fs::write(root.join("content/lab.md"), markdown)
}

fn assert_lab_invalid(markdown: &str, needle: &str) -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    write_lab(root.path(), markdown)?;
    assert_invalid(load_and_validate(root.path()), needle);
    Ok(())
}

#[derive(Clone)]
struct FakeRuntimeProfileResolver {
    hetzner: std::result::Result<RuntimeProfileObservation, &'static str>,
    gcp: std::result::Result<RuntimeProfileObservation, &'static str>,
}

impl RuntimeProfileResolver for FakeRuntimeProfileResolver {
    type Error = &'static str;

    fn resolve_profile(
        &self,
        request: RuntimeProfileResolutionRequest<'_>,
    ) -> std::result::Result<RuntimeProfileObservation, Self::Error> {
        match request.profile.provider {
            RuntimeProviderKind::AgentKvm => Err("agent_kvm must not call the catalog resolver"),
            RuntimeProviderKind::HetznerCloud => self.hetzner.clone(),
            RuntimeProviderKind::GcpCompute => self.gcp.clone(),
        }
    }
}

fn cpx42_observation() -> RuntimeProfileObservation {
    RuntimeProfileObservation {
        provider: RuntimeProviderKind::HetznerCloud,
        machine_type: "cpx42".to_owned(),
        resolved_system_image: "hetzner/image/123456/debian-13".to_owned(),
        system_image_is_immutable: true,
        architecture: ProviderArchitecture::X86_64,
        cores: 8,
        memory_mib: 16_384,
        disk_mib: 160 * 1_024,
        deprecated: false,
        available_locations: vec!["nbg1".to_owned(), "fsn1".to_owned(), "hel1".to_owned()],
    }
}

fn gcp_observation() -> RuntimeProfileObservation {
    RuntimeProfileObservation {
        provider: RuntimeProviderKind::GcpCompute,
        machine_type: "e2-standard-4".to_owned(),
        resolved_system_image: "projects/debian-cloud/global/images/debian-13-20260715".to_owned(),
        system_image_is_immutable: true,
        architecture: ProviderArchitecture::X86_64,
        cores: 4,
        memory_mib: 16_384,
        disk_mib: 32 * 1_024,
        deprecated: false,
        available_locations: vec![
            "europe-west3-a".to_owned(),
            "europe-west3-b".to_owned(),
            "europe-west3-c".to_owned(),
        ],
    }
}

fn resolver() -> FakeRuntimeProfileResolver {
    FakeRuntimeProfileResolver {
        hetzner: Ok(cpx42_observation()),
        gcp: Ok(gcp_observation()),
    }
}

#[test]
fn reference_workshop_has_eleven_modules_and_a_derived_four_hour_agenda()
-> Result<(), Box<dyn std::error::Error>> {
    let workshop = load_and_validate(fixture())?;
    assert_eq!(
        workshop.manifest.workshop.id,
        "platform-engineering-workshop"
    );
    assert_eq!(workshop.manifest.modules.len(), 11);
    assert_eq!(workshop.scheduled_duration_minutes, 240);
    assert_eq!(workshop.manifest.workshop.default_lobby_minutes, 30);
    assert_eq!(
        workshop.manifest.workspace.runtime_profiles,
        vec![
            RuntimeProfile {
                id: "hetzner-cpx42".to_owned(),
                provider: RuntimeProviderKind::HetznerCloud,
                vm_id: "workspace".to_owned(),
                machine_type: Some("cpx42".to_owned()),
                system_image: "debian-13".to_owned(),
                root_disk_type: None,
                locations: Vec::new(),
            },
            RuntimeProfile {
                id: "gcp-e2-standard-4".to_owned(),
                provider: RuntimeProviderKind::GcpCompute,
                vm_id: "workspace".to_owned(),
                machine_type: Some("e2-standard-4".to_owned()),
                system_image: "projects/debian-cloud/global/images/family/debian-13".to_owned(),
                root_disk_type: Some("pd-balanced".to_owned()),
                locations: vec![
                    "europe-west3-a".to_owned(),
                    "europe-west3-b".to_owned(),
                    "europe-west3-c".to_owned(),
                ],
            },
        ]
    );
    assert_eq!(workshop.manifest.workspace.vms[0].disk_mib, 32_768);
    assert!(
        workshop
            .source_files
            .windows(2)
            .all(|pair| pair[0] < pair[1])
    );
    assert!(
        workshop
            .source_files
            .iter()
            .any(|path| path == "runtime/runtime.json")
    );
    assert!(
        workshop
            .source_files
            .iter()
            .any(|path| path == "runtime/source/fixture.txt")
    );
    Ok(())
}

#[test]
fn rejects_format_v1_and_missing_runtime_profiles() -> Result<(), Box<dyn std::error::Error>> {
    let v1 = editable_fixture()?;
    replace_manifest(v1.path(), "format_version = 2", "format_version = 1")?;
    assert_invalid(load_and_validate(v1.path()), "expected 2");

    let missing = editable_fixture()?;
    let path = missing.path().join("workshop.hcl");
    let source = fs::read_to_string(&path)?;
    let start = source
        .find("  runtime_profile \"hetzner-cpx42\"")
        .expect("fixture must contain the Hetzner runtime profile");
    let end = source
        .find("  application \"gitea\"")
        .expect("fixture must contain the first workspace application");
    let mut result = source.clone();
    result.replace_range(start..end, "");
    fs::write(path, result)?;
    assert_invalid(
        load_and_validate(missing.path()),
        "at least one runtime_profile block",
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_in_direct_cloud_runtime_source() -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::symlink;

    let root = editable_fixture()?;
    symlink(
        root.path().join("content/lab.md"),
        root.path().join("runtime/source/leak"),
    )?;
    assert_invalid(load_and_validate(root.path()), "runtime source path");
    Ok(())
}

#[test]
fn rejects_mismatched_direct_cloud_runtime_image_locks() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    fs::write(
        root.path().join("runtime/source/scripts/images.lock"),
        "registry.example.invalid/intar/other@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
    )?;
    assert_invalid(
        load_and_validate(root.path()),
        "runtime/images.lock must exactly match runtime/source/scripts/images.lock",
    );
    Ok(())
}

#[test]
fn validates_runtime_profile_authoring_contract() -> Result<(), Box<dyn std::error::Error>> {
    let missing = editable_fixture()?;
    replace_manifest(missing.path(), "    machine_type  = \"cpx42\"\n", "")?;
    assert_invalid(
        load_and_validate(missing.path()),
        "missing required attribute 'machine_type'",
    );

    let duplicate = editable_fixture()?;
    replace_manifest(
        duplicate.path(),
        "  application \"gitea\" {",
        "  runtime_profile \"hetzner-cpx42\" {\n    provider = \"hetzner_cloud\"\n    vm_id = \"workspace\"\n    machine_type = \"cpx42\"\n    system_image = \"debian-13\"\n  }\n\n  application \"gitea\" {",
    )?;
    assert_invalid(
        load_and_validate(duplicate.path()),
        "duplicate workspace runtime profile 'hetzner-cpx42'",
    );

    let bad_reference = editable_fixture()?;
    replace_manifest(
        bad_reference.path(),
        "    vm_id         = \"workspace\"",
        "    vm_id         = \"missing\"",
    )?;
    assert_invalid(
        load_and_validate(bad_reference.path()),
        "references unknown vm 'missing'",
    );

    let multiple_vms = editable_fixture()?;
    replace_manifest(
        multiple_vms.path(),
        "  runtime_profile \"hetzner-cpx42\" {",
        "  vm \"second\" {\n    cpu_millis = 1000\n    memory_mib = 1024\n    disk_mib = 10240\n  }\n\n  runtime_profile \"hetzner-cpx42\" {",
    )?;
    assert_invalid(
        load_and_validate(multiple_vms.path()),
        "requires exactly one vm block",
    );
    Ok(())
}

#[test]
fn explicit_agent_kvm_profile_resolves_without_catalog_access()
-> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    let path = root.path().join("workshop.hcl");
    let source = fs::read_to_string(&path)?;
    let start = source
        .find("  runtime_profile \"hetzner-cpx42\"")
        .expect("fixture must contain the Hetzner runtime profile");
    let end = source
        .find("  application \"gitea\"")
        .expect("fixture must contain the first workspace application");
    let mut result = source.clone();
    result.replace_range(
        start..end,
        "  runtime_profile \"agent-kvm\" {\n    provider = \"agent_kvm\"\n    vm_id = \"workspace\"\n    system_image = \"platform-workshop-debian13\"\n  }\n\n",
    );
    fs::write(path, result)?;
    let workshop = load_and_validate(root.path())?;
    let profiles = resolve_runtime_profiles(
        &workshop,
        &FakeRuntimeProfileResolver {
            hetzner: Err("must not be called"),
            gcp: Err("must not be called"),
        },
    )?;
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].provider, RuntimeProviderKind::AgentKvm);
    assert_eq!(profiles[0].hardware.disk_mib, 32_768);
    Ok(())
}

#[test]
fn rejects_noncanonical_provider_profile_values() -> Result<(), Box<dyn std::error::Error>> {
    for (source, replacement, needle) in [
        (
            "    machine_type  = \"cpx42\"",
            "    machine_type  = \"CPX42\"",
            "must start with a lowercase",
        ),
        (
            "    system_image  = \"debian-13\"",
            "    system_image  = \"debian_13\"",
            "may contain only lowercase",
        ),
        (
            "    root_disk_type = \"pd-balanced\"",
            "    root_disk_type = \"PD-BALANCED\"",
            "must start with a lowercase",
        ),
        (
            "    root_disk_type = \"pd-balanced\"",
            "    root_disk_type = \"pd-ssd\"",
            "must be 'pd-balanced'",
        ),
        (
            "projects/debian-cloud/global/images/family/debian-13",
            "debian-13",
            "must start with 'projects/<project>/global/images/'",
        ),
    ] {
        let root = editable_fixture()?;
        replace_manifest(root.path(), source, replacement)?;
        assert_invalid(load_and_validate(root.path()), needle);
    }
    Ok(())
}

#[test]
fn resolves_and_serializes_immutable_multi_cloud_profiles() -> Result<(), Box<dyn std::error::Error>>
{
    let workshop = load_and_validate(fixture())?;
    let resolved = resolve_runtime_profiles(&workshop, &resolver())?;
    assert_eq!(resolved.len(), 2);
    assert_eq!(
        serde_json::to_value(&resolved)?,
        serde_json::json!([
            {
                "id": "hetzner-cpx42",
                "provider": "hetzner_cloud",
                "vmId": "workspace",
                "machineType": "cpx42",
                "requestedSystemImage": "debian-13",
                "immutableSystemImage": "hetzner/image/123456/debian-13",
                "locations": ["nbg1", "fsn1", "hel1"],
                "hardware": {
                    "architecture": "x86_64",
                    "cpuMillis": 8000,
                    "providerCpuCount": 8,
                    "memoryMib": 16384,
                    "diskMib": 163840
                }
            },
            {
                "id": "gcp-e2-standard-4",
                "provider": "gcp_compute",
                "vmId": "workspace",
                "machineType": "e2-standard-4",
                "requestedSystemImage": "projects/debian-cloud/global/images/family/debian-13",
                "immutableSystemImage": "projects/debian-cloud/global/images/debian-13-20260715",
                "rootDiskType": "pd-balanced",
                "locations": ["europe-west3-a", "europe-west3-b", "europe-west3-c"],
                "hardware": {
                    "architecture": "x86_64",
                    "cpuMillis": 4000,
                    "providerCpuCount": 4,
                    "memoryMib": 16384,
                    "diskMib": 32768
                }
            }
        ])
    );
    Ok(())
}

#[test]
fn rejects_unresolvable_deprecated_arm_substituted_and_undersized_profiles()
-> Result<(), Box<dyn std::error::Error>> {
    let workshop = load_and_validate(fixture())?;
    let cases = [
        (
            Err("not found"),
            "failed to resolve hetzner_cloud runtime profile 'hetzner-cpx42': not found",
        ),
        (
            Ok(RuntimeProfileObservation {
                deprecated: true,
                ..cpx42_observation()
            }),
            "machine_type 'cpx42' is deprecated",
        ),
        (
            Ok(RuntimeProfileObservation {
                architecture: ProviderArchitecture::Arm64,
                ..cpx42_observation()
            }),
            "must use x86_64 architecture",
        ),
        (
            Ok(RuntimeProfileObservation {
                machine_type: "cpx52".to_owned(),
                ..cpx42_observation()
            }),
            "instead of exact requested type 'cpx42'",
        ),
        (
            Ok(RuntimeProfileObservation {
                cores: 2,
                memory_mib: 8_192,
                disk_mib: 16 * 1_024,
                ..cpx42_observation()
            }),
            "is undersized: CPU 2000m < required 4000m, memory 8192 MiB < required 16384 MiB, disk 16384 MiB < required 32768 MiB",
        ),
    ];
    for (hetzner, needle) in cases {
        let result = resolve_runtime_profiles(
            &workshop,
            &FakeRuntimeProfileResolver {
                hetzner,
                gcp: Ok(gcp_observation()),
            },
        );
        let Err(error) = result else {
            panic!("expected provider resolution to fail with {needle:?}");
        };
        assert!(
            error.to_string().contains(needle),
            "expected {error:?} to contain {needle:?}"
        );
    }
    Ok(())
}

#[test]
fn rejects_mutable_gcp_images_and_unavailable_locations() -> Result<(), Box<dyn std::error::Error>>
{
    let workshop = load_and_validate(fixture())?;
    let cases = [
        (
            RuntimeProfileObservation {
                system_image_is_immutable: false,
                ..gcp_observation()
            },
            "did not resolve to an immutable identity",
        ),
        (
            RuntimeProfileObservation {
                available_locations: vec!["europe-west3-a".to_owned(), "europe-west3-b".to_owned()],
                ..gcp_observation()
            },
            "unavailable in requested locations: europe-west3-c",
        ),
    ];
    for (gcp, needle) in cases {
        let result = resolve_runtime_profiles(
            &workshop,
            &FakeRuntimeProfileResolver {
                hetzner: Ok(cpx42_observation()),
                gcp: Ok(gcp),
            },
        );
        let Err(error) = result else {
            panic!("expected provider resolution to fail with {needle:?}");
        };
        assert!(error.to_string().contains(needle));
    }
    Ok(())
}

#[test]
fn validates_default_lobby_minutes() -> Result<(), Box<dyn std::error::Error>> {
    let zero = editable_fixture()?;
    replace_manifest(
        zero.path(),
        "default_lobby_minutes = 30",
        "default_lobby_minutes = 0",
    )?;
    assert_eq!(
        load_and_validate(zero.path())?
            .manifest
            .workshop
            .default_lobby_minutes,
        0
    );

    let too_large = editable_fixture()?;
    replace_manifest(
        too_large.path(),
        "default_lobby_minutes = 30",
        "default_lobby_minutes = 1441",
    )?;
    assert_invalid(
        load_and_validate(too_large.path()),
        "default_lobby_minutes must be between 0 and 1440",
    );

    let missing = editable_fixture()?;
    replace_manifest(missing.path(), "  default_lobby_minutes = 30\n", "")?;
    assert_invalid(
        load_and_validate(missing.path()),
        "missing required attribute 'default_lobby_minutes'",
    );
    Ok(())
}

#[test]
fn accepts_supported_mermaid_flowcharts_and_ignores_ordinary_code_fences()
-> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    write_lab(
        root.path(),
        r#"# Supported diagrams

```mermaid
flowchart LR
  Git --> Reconcile --> Verify
```

```mermaid
flowchart TD
  source["Source
repository"] -->|"build"| build["Build"]
  build -.-> verify["Verify"]
```

The following is an ordinary code example, not a diagram:

```text
sequenceDiagram
  Browser->>Server: this remains ordinary code
```
"#,
    )?;
    load_and_validate(root.path())?;
    Ok(())
}

#[test]
fn rejects_unterminated_or_non_exact_mermaid_fences() -> Result<(), Box<dyn std::error::Error>> {
    assert_lab_invalid(
        "# Broken\n\n```mermaid\nflowchart LR\n  A --> B\n",
        "Mermaid fence is unterminated",
    )?;
    assert_lab_invalid(
        "# Broken\n\n```Mermaid\nflowchart LR\n  A --> B\n```\n",
        "fence info string must be exactly 'mermaid'",
    )?;
    assert_lab_invalid(
        "# Broken\n\n```mermaid title=bad\nflowchart LR\n  A --> B\n```\n",
        "fence info string must be exactly 'mermaid'",
    )?;
    Ok(())
}

#[test]
fn rejects_unsupported_mermaid_kinds_and_directions() -> Result<(), Box<dyn std::error::Error>> {
    for (diagram, needle) in [
        (
            "sequenceDiagram\n  Browser ->> Server: request",
            "unsupported diagram kind 'sequenceDiagram'",
        ),
        ("graph LR\n  A --> B", "unsupported diagram kind 'graph'"),
        (
            "flowchart RL\n  A --> B",
            "unsupported flowchart direction 'RL'",
        ),
        (
            "flowchart tb\n  A --> B",
            "unsupported flowchart direction 'tb'",
        ),
    ] {
        assert_lab_invalid(&format!("# Broken\n\n```mermaid\n{diagram}\n```\n"), needle)?;
    }
    Ok(())
}

#[test]
fn rejects_unsafe_html_and_javascript_in_mermaid() -> Result<(), Box<dyn std::error::Error>> {
    for diagram in [
        "flowchart LR\n  A[\"<script>alert(1)</script>\"] --> B",
        "flowchart LR\n  A[\"javascript:alert(1)\"] --> B",
        "flowchart LR\n  A[\"onload = alert(1)\"] --> B",
    ] {
        assert_lab_invalid(
            &format!("# Broken\n\n```mermaid\n{diagram}\n```\n"),
            "unsafe HTML or JavaScript",
        )?;
    }
    Ok(())
}

#[test]
fn rejects_empty_and_malformed_mermaid_diagrams() -> Result<(), Box<dyn std::error::Error>> {
    for (diagram, needle) in [
        ("", "diagram is empty"),
        (
            "flowchart LR",
            "flowchart must contain at least one statement",
        ),
        ("flowchart LR\n  A -->", "expected a node after the edge"),
        (
            "flowchart LR\n  A[unquoted] --> B",
            "node labels must use the form",
        ),
        (
            "flowchart LR\n  A[\"unterminated] --> B",
            "quoted label is unterminated",
        ),
        (
            "flowchart LR extra\n  A --> B",
            "flowchart header must contain only",
        ),
    ] {
        assert_lab_invalid(&format!("# Broken\n\n```mermaid\n{diagram}\n```\n"), needle)?;
    }
    Ok(())
}

#[test]
fn rejects_unsupported_mermaid_statements() -> Result<(), Box<dyn std::error::Error>> {
    for statement in [
        "subgraph platform",
        "style A fill:red",
        "classDef warning fill:red",
        "click A \"https://example.test\"",
        "A --- B",
        "A --> B; C --> D",
    ] {
        assert_lab_invalid(
            &format!("# Broken\n\n```mermaid\nflowchart LR\n  {statement}\n```\n"),
            "unsupported Mermaid statement",
        )?;
    }
    assert_lab_invalid(
        "# Broken\n\n```mermaid\nflowchart LR\n  %% no directives\n  A --> B\n```\n",
        "comments and directives are unsupported",
    )?;
    Ok(())
}

#[test]
fn rejects_duplicate_module_ids() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(root.path(), "module \"01\"", "module \"00\"")?;
    assert_invalid(load_and_validate(root.path()), "duplicate module '00'");
    Ok(())
}

#[test]
fn rejects_unknown_dependencies() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(
        root.path(),
        "depends_on        = [\"09\"]",
        "depends_on        = [\"missing\"]",
    )?;
    assert_invalid(
        load_and_validate(root.path()),
        "unknown dependency 'missing'",
    );
    Ok(())
}

#[test]
fn rejects_dependency_cycles() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(
        root.path(),
        "depends_on        = [\"05\"]",
        "depends_on        = [\"07\"]",
    )?;
    assert_invalid(load_and_validate(root.path()), "module dependency cycle");
    Ok(())
}

#[test]
fn rejects_unknown_slide_references() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(
        root.path(),
        "slides           = [\"module-01\"]",
        "slides           = [\"missing-slide\"]",
    )?;
    assert_invalid(
        load_and_validate(root.path()),
        "unknown slide 'missing-slide'",
    );
    Ok(())
}

#[test]
fn rejects_unknown_initial_checkpoint() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(
        root.path(),
        "initial_checkpoint  = \"checkpoint-00\"",
        "initial_checkpoint  = \"missing\"",
    )?;
    assert_invalid(
        load_and_validate(root.path()),
        "initial checkpoint 'missing' is not published by any module",
    );
    Ok(())
}

#[test]
fn rejects_source_path_traversal() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(
        root.path(),
        "content           = \"content/lab.md\"",
        "content           = \"../lab.md\"",
    )?;
    assert_invalid(load_and_validate(root.path()), "normalized relative path");
    Ok(())
}

#[test]
fn rejects_raw_html_in_markdown() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    fs::write(
        root.path().join("content/lab.md"),
        "# Lab\n\n<script>alert('unsafe')</script>\n",
    )?;
    assert_invalid(load_and_validate(root.path()), "contains raw HTML");
    Ok(())
}

#[test]
fn rejects_remote_markdown_images_but_allows_links() -> Result<(), Box<dyn std::error::Error>> {
    for scheme in ["http", "https"] {
        assert_lab_invalid(
            &format!(
                "# Lab\n\n[Attribution]({scheme}://example.test/source)\n\n![tracking]({scheme}://example.test/pixel.png)\n"
            ),
            "remote Markdown image",
        )?;
    }
    assert_lab_invalid(
        "# Lab\n\n[Attribution](https://example.test/source)\n\n![tracking][pixel]\n\n[pixel]: https://example.test/pixel.png\n",
        "reference-style Markdown image",
    )?;
    assert_lab_invalid(
        "# Lab\n\n![tracking]\n\n[tracking]: https://example.test/pixel.png\n",
        "reference-style Markdown image",
    )?;
    Ok(())
}

#[test]
fn accepts_declared_bundled_markdown_images() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    fs::create_dir_all(root.path().join("assets"))?;
    fs::write(
        root.path().join("assets/flow.svg"),
        r#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>"#,
    )?;
    replace_manifest(root.path(), "assets = []", "assets = [\"assets/flow.svg\"]")?;
    fs::write(
        root.path().join("slides/shared.md"),
        "# Shared\n\n![Flow](../assets/flow.svg)\n",
    )?;
    assert!(load_and_validate(root.path()).is_ok());
    Ok(())
}

#[test]
fn rejects_duplicate_application_ports() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(
        root.path(),
        "port           = 3001",
        "port           = 3000",
    )?;
    assert_invalid(
        load_and_validate(root.path()),
        "multiple applications declare workspace:3000",
    );
    Ok(())
}

#[test]
fn rejects_application_protocols_without_a_runtime_transport()
-> Result<(), Box<dyn std::error::Error>> {
    for protocol in ["https", "wss"] {
        let root = editable_fixture()?;
        replace_manifest(
            root.path(),
            "protocol       = \"http\"",
            &format!("protocol       = \"{protocol}\""),
        )?;
        assert_invalid(load_and_validate(root.path()), "unsupported protocol");
    }
    Ok(())
}

#[test]
fn accepts_a_canonical_application_upstream_host() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(
        root.path(),
        "port           = 8081",
        "port           = 8081\n    upstream_host  = \"hello.demo.127.0.0.1.sslip.io\"",
    )?;
    let workshop = load_and_validate(root.path())?;
    let application = workshop
        .manifest
        .workspace
        .applications
        .iter()
        .find(|application| application.id == "knative")
        .expect("knative application");
    assert_eq!(
        application.upstream_host.as_deref(),
        Some("hello.demo.127.0.0.1.sslip.io")
    );
    Ok(())
}

#[test]
fn rejects_unsafe_application_upstream_hosts() -> Result<(), Box<dyn std::error::Error>> {
    for upstream_host in [
        "Knative.internal",
        "knative.internal.",
        "https://knative.internal",
        "knative.internal:8080",
        "*.internal",
        "knative..internal",
    ] {
        let root = editable_fixture()?;
        replace_manifest(
            root.path(),
            "port           = 8081",
            &format!("port           = 8081\n    upstream_host  = \"{upstream_host}\""),
        )?;
        assert_invalid(load_and_validate(root.path()), "upstream_host");
    }
    Ok(())
}

#[test]
fn rejects_invalid_resource_increments() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(root.path(), "cpu_millis  = 4000", "cpu_millis  = 4100")?;
    assert_invalid(load_and_validate(root.path()), "increments of 250");
    Ok(())
}

#[test]
fn rejects_v1_workspace_resource_aliases_and_lossy_disk_sizes()
-> Result<(), Box<dyn std::error::Error>> {
    let legacy_cpu = editable_fixture()?;
    replace_manifest(
        legacy_cpu.path(),
        "cpu_millis  = 4000",
        "vcpu_millis = 4000",
    )?;
    assert_invalid(
        load_and_validate(legacy_cpu.path()),
        "does not support attribute 'vcpu_millis'",
    );

    let legacy_disk = editable_fixture()?;
    replace_manifest(
        legacy_disk.path(),
        "disk_mib     = 32768",
        "disk_gib     = 32",
    )?;
    assert_invalid(
        load_and_validate(legacy_disk.path()),
        "does not support attribute 'disk_gib'",
    );

    let lossy_disk = editable_fixture()?;
    replace_manifest(
        lossy_disk.path(),
        "disk_mib     = 32768",
        "disk_mib     = 32767",
    )?;
    assert_invalid(
        load_and_validate(lossy_disk.path()),
        "in increments of 1024",
    );
    Ok(())
}

#[test]
fn includes_a_root_license_in_the_validated_source_set() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    fs::write(root.path().join("LICENSE"), "Apache License 2.0\n")?;
    let workshop = load_and_validate(root.path())?;
    assert!(workshop.source_files.iter().any(|path| path == "LICENSE"));
    Ok(())
}

#[test]
fn bundles_are_byte_for_byte_deterministic() -> Result<(), Box<dyn std::error::Error>> {
    let first = build_bundle(fixture())?;
    let second = build_bundle(fixture())?;
    assert_eq!(first.sha256, second.sha256);
    assert_eq!(first.bytes, second.bytes);

    let decoder = GzDecoder::new(first.bytes.as_slice());
    let mut archive = tar::Archive::new(decoder);
    let mut paths = Vec::new();
    let mut compiled = None;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_string_lossy().into_owned();
        assert_eq!(entry.header().uid()?, 0);
        assert_eq!(entry.header().gid()?, 0);
        assert_eq!(entry.header().mtime()?, 0);
        if path == COMPILED_MANIFEST_PATH {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            compiled = Some(bytes);
        }
        paths.push(path);
    }
    assert!(paths.windows(2).all(|pair| pair[0] < pair[1]));
    let Some(compiled) = compiled else {
        panic!("bundle is missing {COMPILED_MANIFEST_PATH}");
    };
    let compiled: serde_json::Value = serde_json::from_slice(&compiled)?;
    assert_eq!(compiled["scheduled_duration_minutes"], 240);
    assert_eq!(compiled["format_version"], 2);
    assert_eq!(compiled["runtime_tool_format_version"], 1);
    assert_eq!(
        compiled["manifest"]["workshop"]["default_lobby_minutes"],
        30
    );
    assert_eq!(
        compiled["manifest"]["workspace"]["runtime_profiles"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );
    assert_eq!(
        compiled["manifest"]["workspace"]["runtime_profiles"][1]["provider"],
        "gcp_compute"
    );
    assert_eq!(
        compiled["manifest"]["modules"].as_array().map(Vec::len),
        Some(11)
    );
    Ok(())
}
