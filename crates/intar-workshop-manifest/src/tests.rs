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
struct FakeHetznerResolver(std::result::Result<HetznerServerTypeObservation, &'static str>);

impl HetznerServerTypeResolver for FakeHetznerResolver {
    type Error = &'static str;

    fn resolve_server_type(
        &self,
        _exact_name: &str,
    ) -> std::result::Result<HetznerServerTypeObservation, Self::Error> {
        self.0.clone()
    }
}

fn cx43_observation() -> HetznerServerTypeObservation {
    HetznerServerTypeObservation {
        name: "cx43".to_owned(),
        architecture: ProviderArchitecture::X86,
        cores: 8,
        memory_mib: 16_384,
        disk_mib: 160 * 1_024,
        deprecated: false,
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
        workshop.manifest.workspace.provider,
        Some(WorkspaceProvider::HetznerCloud {
            vm_id: "workspace".to_owned(),
            server_type: "cx43".to_owned(),
            system_image: "debian-13".to_owned(),
        })
    );
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

#[cfg(unix)]
#[test]
fn rejects_symlinks_in_hetzner_runtime_source() -> Result<(), Box<dyn std::error::Error>> {
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
fn validates_hetzner_provider_authoring_contract() -> Result<(), Box<dyn std::error::Error>> {
    let missing = editable_fixture()?;
    replace_manifest(missing.path(), "    server_type  = \"cx43\"\n", "")?;
    assert_invalid(
        load_and_validate(missing.path()),
        "missing required attribute 'server_type'",
    );

    let duplicate = editable_fixture()?;
    replace_manifest(
        duplicate.path(),
        "  application \"gitea\" {",
        "  provider \"hetzner_cloud\" {\n    vm_id = \"workspace\"\n    server_type = \"cx43\"\n    system_image = \"debian-13\"\n  }\n\n  application \"gitea\" {",
    )?;
    assert_invalid(
        load_and_validate(duplicate.path()),
        "only one workspace provider block is supported",
    );

    let bad_reference = editable_fixture()?;
    replace_manifest(
        bad_reference.path(),
        "    vm_id        = \"workspace\"",
        "    vm_id        = \"missing\"",
    )?;
    assert_invalid(
        load_and_validate(bad_reference.path()),
        "references unknown vm 'missing'",
    );

    let multiple_vms = editable_fixture()?;
    replace_manifest(
        multiple_vms.path(),
        "  provider \"hetzner_cloud\" {",
        "  vm \"second\" {\n    image = \"debian13\"\n    vcpu_millis = 1000\n    memory_mib = 1024\n    disk_gib = 10\n  }\n\n  provider \"hetzner_cloud\" {",
    )?;
    assert_invalid(
        load_and_validate(multiple_vms.path()),
        "requires exactly one vm block",
    );
    Ok(())
}

#[test]
fn omitted_provider_retains_agent_kvm_without_catalog_resolution()
-> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(
        root.path(),
        "  provider \"hetzner_cloud\" {\n    vm_id        = \"workspace\"\n    server_type  = \"cx43\"\n    system_image = \"debian-13\"\n  }\n\n",
        "",
    )?;
    let workshop = load_and_validate(root.path())?;
    assert_eq!(workshop.manifest.workspace.provider, None);
    assert_eq!(
        resolve_workspace_provider(&workshop, &FakeHetznerResolver(Err("must not be called")))?,
        ResolvedWorkspaceProvider::AgentKvm
    );
    Ok(())
}

#[test]
fn rejects_noncanonical_hetzner_provider_names() -> Result<(), Box<dyn std::error::Error>> {
    for (source, replacement, needle) in [
        (
            "    server_type  = \"cx43\"",
            "    server_type  = \"CX43\"",
            "must start with a lowercase",
        ),
        (
            "    server_type  = \"cx43\"",
            "    server_type  = \"cx43-\"",
            "must end with a lowercase",
        ),
        (
            "    system_image = \"debian-13\"",
            "    system_image = \"debian_13\"",
            "may contain only lowercase",
        ),
    ] {
        let root = editable_fixture()?;
        replace_manifest(root.path(), source, replacement)?;
        assert_invalid(load_and_validate(root.path()), needle);
    }
    Ok(())
}

#[test]
fn resolves_and_serializes_immutable_hetzner_hardware() -> Result<(), Box<dyn std::error::Error>> {
    let workshop = load_and_validate(fixture())?;
    let resolved =
        resolve_workspace_provider(&workshop, &FakeHetznerResolver(Ok(cx43_observation())))?;
    assert_eq!(
        serde_json::to_value(resolved)?,
        serde_json::json!({
            "kind": "hetzner_cloud",
            "vmId": "workspace",
            "serverType": "cx43",
            "systemImage": "debian-13",
            "hardware": {
                "architecture": "x86",
                "cores": 8,
                "memoryMib": 16384,
                "diskMib": 163840
            },
            "compatible": true
        })
    );
    Ok(())
}

#[test]
fn rejects_unresolvable_deprecated_arm_substituted_and_undersized_types()
-> Result<(), Box<dyn std::error::Error>> {
    let workshop = load_and_validate(fixture())?;
    let cases = [
        (
            FakeHetznerResolver(Err("not found")),
            "failed to resolve Hetzner server_type 'cx43': not found",
        ),
        (
            FakeHetznerResolver(Ok(HetznerServerTypeObservation {
                deprecated: true,
                ..cx43_observation()
            })),
            "is deprecated",
        ),
        (
            FakeHetznerResolver(Ok(HetznerServerTypeObservation {
                architecture: ProviderArchitecture::Arm,
                ..cx43_observation()
            })),
            "must use x86 architecture",
        ),
        (
            FakeHetznerResolver(Ok(HetznerServerTypeObservation {
                name: "cx53".to_owned(),
                ..cx43_observation()
            })),
            "instead of exact requested type 'cx43'",
        ),
        (
            FakeHetznerResolver(Ok(HetznerServerTypeObservation {
                cores: 2,
                memory_mib: 8_192,
                disk_mib: 50 * 1_024,
                ..cx43_observation()
            })),
            "is undersized: CPU 2000m < required 4000m, memory 8192 MiB < required 16384 MiB, disk 51200 MiB < required 65536 MiB",
        ),
    ];
    for (resolver, needle) in cases {
        let result = resolve_workspace_provider(&workshop, &resolver);
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
fn rejects_invalid_resource_increments() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(root.path(), "cpu_millis  = 4000", "cpu_millis  = 4100")?;
    assert_invalid(load_and_validate(root.path()), "increments of 250");
    Ok(())
}

#[test]
fn accepts_legacy_workspace_resource_aliases() -> Result<(), Box<dyn std::error::Error>> {
    let root = editable_fixture()?;
    replace_manifest(root.path(), "cpu_millis  = 4000", "vcpu_millis = 4000")?;
    replace_manifest(root.path(), "disk_mib     = 65536", "disk_gib     = 64")?;

    let workshop = load_and_validate(root.path())?;
    let workspace = workshop
        .manifest
        .workspace
        .vms
        .iter()
        .find(|vm| vm.id == "workspace")
        .expect("workspace VM");
    assert_eq!(workspace.vcpu_millis, 4_000);
    assert_eq!(workspace.disk_gib, 64);
    Ok(())
}

#[test]
fn rejects_duplicate_and_lossy_workspace_resource_aliases() -> Result<(), Box<dyn std::error::Error>>
{
    let duplicate_cpu = editable_fixture()?;
    replace_manifest(
        duplicate_cpu.path(),
        "cpu_millis  = 4000",
        "cpu_millis  = 4000\n    vcpu_millis = 4000",
    )?;
    assert_invalid(
        load_and_validate(duplicate_cpu.path()),
        "must not declare both 'cpu_millis' and legacy 'vcpu_millis'",
    );

    let duplicate_disk = editable_fixture()?;
    replace_manifest(
        duplicate_disk.path(),
        "disk_mib     = 65536",
        "disk_mib     = 65536\n    disk_gib     = 64",
    )?;
    assert_invalid(
        load_and_validate(duplicate_disk.path()),
        "must not declare both 'disk_mib' and legacy 'disk_gib'",
    );

    let lossy_disk = editable_fixture()?;
    replace_manifest(
        lossy_disk.path(),
        "disk_mib     = 65536",
        "disk_mib     = 65535",
    )?;
    assert_invalid(
        load_and_validate(lossy_disk.path()),
        "'disk_mib' must be a whole number of GiB",
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
    assert_eq!(
        compiled["manifest"]["workshop"]["default_lobby_minutes"],
        30
    );
    assert_eq!(
        compiled["manifest"]["workspace"]["provider"],
        serde_json::json!({
            "kind": "hetzner_cloud",
            "vm_id": "workspace",
            "server_type": "cx43",
            "system_image": "debian-13"
        })
    );
    assert_eq!(
        compiled["manifest"]["modules"].as_array().map(Vec::len),
        Some(11)
    );
    Ok(())
}
