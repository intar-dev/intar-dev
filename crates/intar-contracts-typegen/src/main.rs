#![forbid(unsafe_code)]

use std::{fs, path::Path};

use anyhow::{Context as _, Result, anyhow};
use intar_contracts::{
    bridge::HOST_STATE_REPORT_SCHEMA_VERSION,
    catalog::CourseCatalogSnapshotV2,
    guest::{
        ENV_DNS_SERVERS, ENV_GATEWAY, ENV_GUEST_BOOTSTRAP_ABI, ENV_GUEST_IP_CIDR,
        ENV_KINO_HOST_READY_PORT, ENV_KINO_SHA256, ENV_KINO_VSOCK_CID, ENV_KINO_VSOCK_PORT,
        ENV_PEER_HOSTS_B64, ENV_SSH_AUTHORIZED_KEYS_B64, ENV_VM_HOSTNAME, GUEST_USERNAME,
        RECORDING_DISK_LABEL, RUNTIME_DISK_LABEL, RUNTIME_ENV_FILENAME, RuntimeEnv,
    },
    run_cli::{
        RUN_CLI_MAX_COMPLETION_ALIASES, RUN_CLI_MAX_FRAME_BYTES, RUN_CLI_MAX_HINT_ALIAS_BYTES,
        RUN_CLI_MAX_PROBE_ID_BYTES, RUN_CLI_MAX_PROBE_IDS, RUN_CLI_MAX_REQUEST_ID_BYTES,
        RUN_CLI_MAX_RETRY_SCOPE_BYTES, RUN_CLI_PROTOCOL_VERSION, RUN_CLI_SCHEMA_VERSION,
        RunCliProbeCheckEventV1, RunCliProbeCheckRequestV1, RunCliRequestV1, RunCliResponseV1,
    },
    source::{
        AGENT_SOURCES_PATH, SOURCE_BUNDLE_FIELD, SOURCE_BUNDLES_PATH, SOURCE_COMPILER_PATH,
        SOURCE_META_FIELD, SourceRefusalV1,
    },
    source::{
        MAX_SOURCE_BUNDLE_GZIP_BYTES, SOURCE_COMPILER_VERSION_V2, SourceBundleMetaV2,
        SourceBundleV2, source_compile_digest,
    },
    stargate::{
        ActivateTerminalTargetRequest, IssueTerminalSessionRequest, IssueTerminalSessionResponse,
        IssueWorkspaceAppSessionRequest, IssueWorkspaceAppSessionResponse, RunMirrorRequest,
        SHARE_ID_LEN, SHARE_INGEST_CLOSE_ENDED, SHARE_INGEST_CLOSE_LIMIT,
        SHARE_INGEST_CLOSE_STOPPED, SHARE_INGEST_PING, SHARE_INGEST_PONG, SHARE_WRITE_TOKEN_LEN,
        ShareIngestMessage, StageTerminalTargetRequest, StageTerminalTargetResponse,
    },
};
use intar_contracts::{
    oci::OciDigest,
    scenario::{
        HintV1, ImageV1, MAX_DISK_MIB, MAX_READY_PER_MACHINE, MAX_SCRIPT_BYTES,
        MAX_TASKS_PER_MACHINE, ScenarioRevisionV1, ScriptV1, SpecMode, build_keys, canonical_json,
    },
    source::validate_bundle,
};
use intar_image_scenario::loader::compile;
use schemars::schema_for;
use sha2::{Digest as _, Sha256};

fn main() -> Result<()> {
    let out_dir = Path::new("apps/web/src/generated");
    let schema_dir = out_dir.join("schemas");
    let fixture_dir = out_dir.join("fixtures");
    fs::create_dir_all(&schema_dir).context("create schema output directory")?;
    fs::create_dir_all(fixture_dir.join("stargate"))
        .context("create stargate fixture directory")?;
    fs::create_dir_all(fixture_dir.join("run-cli")).context("create run CLI fixture directory")?;
    fs::create_dir_all(fixture_dir.join("source")).context("create source fixture directory")?;
    fs::create_dir_all(fixture_dir.join("scenario"))
        .context("create scenario fixture directory")?;

    for obsolete in [
        "schemas/catalog-scenario-manifest-v5.schema.json",
        "schemas/bridge-host-desired-state-v2.schema.json",
        "schemas/bridge-host-state-report-v2.schema.json",
        "schemas/bridge-vm-report-v2.schema.json",
        "schemas/bridge-desired-build-v1.schema.json",
        "schemas/bridge-desired-source-compile-v1.schema.json",
        "schemas/bridge-build-report-v1.schema.json",
        "schemas/bridge-message-v8.schema.json",
        "fixtures/catalog/scenario-manifest-v5.json",
        "fixtures/bridge/host-desired-state-v2.json",
        "fixtures/bridge/host-state-report-v2.json",
        "fixtures/bridge/vm-report-v2.json",
        "fixtures/bridge/desired-build-v1.json",
        "fixtures/bridge/desired-source-compile-v1.json",
        "fixtures/bridge/build-report-v1.json",
        "fixtures/bridge/sync-request-v8.json",
        "fixtures/source/compile-digest.json",
        "schemas/catalog-scenario-manifest-v4.schema.json",
        "fixtures/catalog/scenario-manifest-v4.json",
        "schemas/bridge-message-v7.schema.json",
        "schemas/catalog-scenario-manifest-v2.schema.json",
        "schemas/catalog-scenario-manifest-v3.schema.json",
        "schemas/bridge-host-desired-state-v1.schema.json",
        "schemas/bridge-host-state-report-v1.schema.json",
        "schemas/bridge-vm-report-v1.schema.json",
        "schemas/bridge-message-v5.schema.json",
        "schemas/bridge-message-v6.schema.json",
        "schemas/run-cli-probe-check-response-v1.schema.json",
        "schemas/stargate-attach-terminal-target-request.schema.json",
        "fixtures/stargate/attach-terminal-target-request.json",
        "fixtures/catalog/scenario-manifest-v2.json",
        "fixtures/catalog/scenario-manifest-v3.json",
        "fixtures/bridge/host-desired-state-v1.json",
        "fixtures/bridge/host-state-report-v1.json",
        "fixtures/bridge/vm-report-v1.json",
        "fixtures/bridge/sync-request-v5.json",
        "fixtures/bridge/sync-request-v6.json",
        "fixtures/run-cli/probe-check-response-v1.json",
    ] {
        remove_file_if_exists(&out_dir.join(obsolete))?;
    }

    write_schema(
        &schema_dir.join("runtime-env.schema.json"),
        &schema_for!(RuntimeEnv),
    )?;
    write_schema(
        &schema_dir.join("stargate-issue-terminal-session-request.schema.json"),
        &schema_for!(IssueTerminalSessionRequest),
    )?;
    write_schema(
        &schema_dir.join("stargate-issue-terminal-session-response.schema.json"),
        &schema_for!(IssueTerminalSessionResponse),
    )?;
    write_schema(
        &schema_dir.join("stargate-issue-workspace-app-session-request.schema.json"),
        &schema_for!(IssueWorkspaceAppSessionRequest),
    )?;
    write_schema(
        &schema_dir.join("stargate-stage-terminal-target-request.schema.json"),
        &schema_for!(StageTerminalTargetRequest),
    )?;
    write_schema(
        &schema_dir.join("stargate-stage-terminal-target-response.schema.json"),
        &schema_for!(StageTerminalTargetResponse),
    )?;
    write_schema(
        &schema_dir.join("stargate-activate-terminal-target-request.schema.json"),
        &schema_for!(ActivateTerminalTargetRequest),
    )?;
    write_schema(
        &schema_dir.join("stargate-issue-workspace-app-session-response.schema.json"),
        &schema_for!(IssueWorkspaceAppSessionResponse),
    )?;
    write_schema(
        &schema_dir.join("stargate-run-mirror-request.schema.json"),
        &schema_for!(RunMirrorRequest),
    )?;
    write_schema(
        &schema_dir.join("stargate-share-ingest-message.schema.json"),
        &schema_for!(ShareIngestMessage),
    )?;
    write_schema(
        &schema_dir.join("catalog-course-catalog-v2.schema.json"),
        &schema_for!(CourseCatalogSnapshotV2),
    )?;
    write_schema(
        &schema_dir.join("source-refusal-v1.schema.json"),
        &schema_for!(SourceRefusalV1),
    )?;
    write_schema(
        &schema_dir.join("source-bundle-v2.schema.json"),
        &schema_for!(SourceBundleV2),
    )?;
    write_schema(
        &schema_dir.join("source-bundle-meta-v2.schema.json"),
        &schema_for!(SourceBundleMetaV2),
    )?;
    write_schema(
        &schema_dir.join("bridge-message-v9.schema.json"),
        &schema_for!(intar_contracts::bridge_v9::BridgeMessageV9),
    )?;
    write_schema(
        &schema_dir.join("guest-boot-v3.schema.json"),
        &schema_for!(intar_contracts::guest::GuestBootV3),
    )?;
    write_schema(
        &schema_dir.join("scenario-v1.schema.json"),
        &schema_for!(intar_contracts::scenario::ScenarioV1),
    )?;
    write_schema(
        &schema_dir.join("scenario-image-v1.schema.json"),
        &schema_for!(intar_contracts::scenario::ImageV1),
    )?;
    write_schema(
        &schema_dir.join("machine-spec-v1.schema.json"),
        &schema_for!(intar_contracts::scenario::MachineSpecV1),
    )?;
    write_schema(
        &schema_dir.join("oci-machine-config-v1.schema.json"),
        &schema_for!(intar_contracts::oci::MachineConfigV1),
    )?;
    write_schema(
        &schema_dir.join("oci-kino-config-v1.schema.json"),
        &schema_for!(intar_contracts::oci::KinoConfigV1),
    )?;
    write_schema(
        &schema_dir.join("oci-manifest-v1.schema.json"),
        &schema_for!(intar_contracts::oci::OciManifestV1),
    )?;
    write_schema(
        &schema_dir.join("scenario-revision-v1.schema.json"),
        &schema_for!(ScenarioRevisionV1),
    )?;
    write_schema(
        &schema_dir.join("run-cli-request-v1.schema.json"),
        &schema_for!(RunCliRequestV1),
    )?;
    write_schema(
        &schema_dir.join("run-cli-response-v1.schema.json"),
        &schema_for!(RunCliResponseV1),
    )?;
    write_schema(
        &schema_dir.join("run-cli-probe-check-request-v1.schema.json"),
        &schema_for!(RunCliProbeCheckRequestV1),
    )?;
    write_schema(
        &schema_dir.join("run-cli-probe-check-event-v1.schema.json"),
        &schema_for!(RunCliProbeCheckEventV1),
    )?;

    fs::write(out_dir.join("constants.ts"), constants_ts()).context("write constants.ts")?;
    fs::write(out_dir.join("stargate.ts"), stargate_ts()).context("write stargate.ts")?;
    fs::write(out_dir.join("catalog.ts"), catalog_ts()).context("write catalog.ts")?;
    fs::write(out_dir.join("bridge.ts"), bridge_ts()).context("write bridge.ts")?;
    fs::write(out_dir.join("run-cli.ts"), run_cli_ts()).context("write run-cli.ts")?;

    copy_fixture(
        "crates/intar-contracts/fixtures/stargate/issue-terminal-session-request.json",
        &fixture_dir.join("stargate/issue-terminal-session-request.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/stargate/issue-terminal-session-response.json",
        &fixture_dir.join("stargate/issue-terminal-session-response.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/stargate/issue-workspace-app-session-request.json",
        &fixture_dir.join("stargate/issue-workspace-app-session-request.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/stargate/stage-terminal-target-request.json",
        &fixture_dir.join("stargate/stage-terminal-target-request.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/stargate/stage-terminal-target-response.json",
        &fixture_dir.join("stargate/stage-terminal-target-response.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/stargate/activate-terminal-target-request.json",
        &fixture_dir.join("stargate/activate-terminal-target-request.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/stargate/issue-workspace-app-session-response.json",
        &fixture_dir.join("stargate/issue-workspace-app-session-response.json"),
    )?;
    for fixture in [
        "run-mirror-request.json",
        "share-ingest-start.json",
        "share-ingest-events.json",
    ] {
        copy_fixture(
            &format!("crates/intar-contracts/fixtures/stargate/{fixture}"),
            &fixture_dir.join("stargate").join(fixture),
        )?;
    }
    copy_fixture(
        "crates/intar-contracts/fixtures/source/source-refusal-v1.json",
        &fixture_dir.join("source/source-refusal-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/run-cli/request-v1.json",
        &fixture_dir.join("run-cli/request-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/run-cli/response-v1.json",
        &fixture_dir.join("run-cli/response-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/run-cli/probe-check-request-v1.json",
        &fixture_dir.join("run-cli/probe-check-request-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/run-cli/probe-check-event-v1.json",
        &fixture_dir.join("run-cli/probe-check-event-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/run-cli/probe-check-complete-v1.json",
        &fixture_dir.join("run-cli/probe-check-complete-v1.json"),
    )?;
    write_compile_digest_v2_fixture(&fixture_dir.join("source/compile-digest-v2.json"))?;
    copy_fixture(
        "crates/intar-contracts/fixtures/scenario/build-keys.json",
        &fixture_dir.join("scenario/build-keys.json"),
    )?;
    write_scenario_fixtures(&fixture_dir.join("scenario"))?;

    Ok(())
}

/// The in-repository content compiled as the Worker receives it, what the
/// Worker stores from it, and broken variants of it with the problems
/// `validate_bundle` lists for each, so the Worker's port can be held to
/// the same bytes and the same refusals.
fn write_scenario_fixtures(dir: &Path) -> Result<()> {
    let (bundle, _) = compile(Path::new("content")).map_err(|problems| {
        let problems: Vec<String> = problems.iter().map(ToString::to_string).collect();
        anyhow!("compile content: {}", problems.join("; "))
    })?;
    write_json(&dir.join("broken-nginx-bundle.json"), &bundle)?;

    let id = "intar/broken-nginx";
    let scenario = bundle
        .scenarios
        .iter()
        .find(|scenario| scenario.slug == "broken-nginx")
        .context("content has no broken-nginx")?;
    let keys = build_keys(scenario, &bundle.images).map_err(|problem| anyhow!(problem))?;
    let revision =
        ScenarioRevisionV1::new(scenario, id, &keys).map_err(|problem| anyhow!(problem))?;
    let mut specs = serde_json::Map::new();
    for machine in &scenario.machines {
        let mut modes = serde_json::Map::new();
        for (label, mode) in [("learn", SpecMode::Learn), ("verify", SpecMode::Verify)] {
            let spec = scenario
                .machine_spec(id, &machine.name, mode)
                .context("spec of a declared machine")?;
            let (bytes, digest) = spec.blob();
            modes.insert(label.to_owned(), blob_json(bytes, &digest)?);
        }
        specs.insert(machine.name.clone(), modes.into());
    }
    let revision_json = canonical_json(&revision).context("serialize revision")?;
    let content_digest = OciDigest::from_sha256(&Sha256::digest(&revision_json).into());
    write_json(
        &dir.join("broken-nginx-revision.json"),
        &serde_json::json!({
            "scenario_id": id,
            "revision": blob_json(revision_json, &content_digest)?,
            "specs": specs,
        }),
    )?;

    let refusals = refusal_cases()
        .into_iter()
        .map(|(name, mutate)| {
            let mut broken = bundle.clone();
            mutate(&mut broken);
            let problems = validate_bundle(&broken).err().unwrap_or_default();
            anyhow::ensure!(!problems.is_empty(), "refusal `{name}` is not refused");
            let case = serde_json::json!({"name": name, "bundle": broken, "problems": problems});
            serde_json::to_string(&case).context("serialize refusal")
        })
        .collect::<Result<Vec<_>>>()?;
    // One case per line: the bundles are large and alike.
    let path = dir.join("bundle-refusals.json");
    fs::write(&path, format!("[\n{}\n]\n", refusals.join(",\n")))
        .with_context(|| format!("write {}", path.display()))
}

fn blob_json(bytes: Vec<u8>, digest: &OciDigest) -> Result<serde_json::Value> {
    Ok(serde_json::json!({
        "json": String::from_utf8(bytes).context("canonical JSON is UTF-8")?,
        "digest": digest,
    }))
}

type Mutation = fn(&mut SourceBundleV2);

/// One broken bundle per rule of `validate_bundle`, from the compiled
/// content. Each stays within the bundle schema, so only the rules refuse it.
fn refusal_cases() -> Vec<(&'static str, Mutation)> {
    fn image(name: &str, from: &str, disk_mib: Option<u32>) -> ImageV1 {
        ImageV1 {
            name: name.to_owned(),
            from: from.to_owned(),
            disk_mib,
            defer: Vec::new(),
            setup: Vec::new(),
            wake: false,
        }
    }
    fn script(name: &str, script: String) -> ScriptV1 {
        ScriptV1 {
            name: name.to_owned(),
            script,
        }
    }
    vec![
        ("compiler", |b| {
            b.compiler = "intar-source-compiler-v1".to_owned()
        }),
        ("image-format", |b| {
            b.image_format = "intar-image-2".to_owned()
        }),
        ("scenario-twice", |b| {
            b.scenarios.push(b.scenarios[0].clone())
        }),
        ("slug", |b| b.scenarios[0].slug = "Broken".to_owned()),
        ("hint-twice", |b| {
            let hints = &mut b.scenarios[0].tasks[0].hints;
            hints.push(hints[0].clone());
        }),
        ("hint-id", |b| {
            b.scenarios[0].hints.push(HintV1 {
                id: "-x".to_owned(),
                title: None,
                body: String::new(),
            })
        }),
        ("no-machines", |b| b.scenarios[0].machines.clear()),
        ("machine-twice", |b| {
            let machines = &mut b.scenarios[0].machines;
            machines.push(machines[0].clone());
        }),
        ("machine-name-over-limit", |b| {
            let name = "w".repeat(intar_contracts::scenario::MAX_MACHINE_NAME_LEN + 1);
            let old = std::mem::replace(&mut b.scenarios[0].machines[0].name, name.clone());
            for task in &mut b.scenarios[0].tasks {
                if task.machine == old {
                    task.machine.clone_from(&name);
                }
            }
        }),
        ("unknown-from", |b| {
            b.scenarios[0].machines[0].from = "nope".to_owned()
        }),
        ("disk-below-image", |b| {
            b.images.push(image("web-base", "trixie", Some(8192)));
            b.scenarios[0].machines[0].from = "web-base".to_owned();
        }),
        ("machine-disk-over-limit", |b| {
            b.scenarios[0].machines[0].disk_mib = MAX_DISK_MIB + 1;
        }),
        ("ready-blocks", |b| {
            b.scenarios[0].machines[0].ready = (0..=MAX_READY_PER_MACHINE)
                .map(|n| script(&format!("ready-{n:02}"), "true".to_owned()))
                .collect();
        }),
        ("setup-name", |b| {
            b.scenarios[0].machines[0].setup[1].name = "Break".to_owned();
        }),
        ("setup-twice", |b| {
            let setup = &mut b.scenarios[0].machines[0].setup;
            setup.push(setup[1].clone());
        }),
        ("too-many-tasks", |b| {
            let task = b.scenarios[0].tasks[0].clone();
            b.scenarios[0].tasks = (0..=MAX_TASKS_PER_MACHINE)
                .map(|n| {
                    let mut task = task.clone();
                    task.id = format!("task-{n:02}");
                    task
                })
                .collect();
        }),
        ("task-twice", |b| {
            let tasks = &mut b.scenarios[0].tasks;
            tasks.push(tasks[0].clone());
        }),
        ("task-machine", |b| {
            b.scenarios[0].tasks[0].machine = "nope".to_owned()
        }),
        ("empty-check", |b| {
            b.scenarios[0].tasks[0].check = " ".to_owned()
        }),
        ("unverifiable", |b| b.scenarios[0].tasks[0].solve = None),
        ("unknown-need", |b| {
            b.scenarios[0].tasks[2].needs = vec!["nope".to_owned()]
        }),
        ("need-cycle", |b| {
            b.scenarios[0].tasks[0].needs = vec!["site-reachable".to_owned()];
        }),
        // Over the limit in UTF-8 bytes, under it in UTF-16 code units.
        ("check-over-limit", |b| {
            b.scenarios[0].tasks[0].check = "\u{e9}".repeat(MAX_SCRIPT_BYTES / 2 + 1);
        }),
        ("image-name", |b| {
            b.images.push(image("trixie", "trixie", Some(4096)))
        }),
        ("image-twice", |b| {
            b.images = vec![image("base", "trixie", Some(4096)); 2];
        }),
        ("image-disk-rule", |b| {
            b.images.push(image("base", "trixie", None))
        }),
        ("image-disk-over-limit", |b| {
            b.images
                .push(image("base", "trixie", Some(MAX_DISK_MIB + 1)));
        }),
        ("image-unknown-from", |b| {
            b.images.push(image("base", "nope", None))
        }),
        ("image-cycle", |b| {
            b.images = vec![image("one", "two", None), image("two", "one", None)];
        }),
        ("wake-packages", |b| {
            let mut base = image("web-base", "trixie", Some(4096));
            base.wake = true;
            b.images.push(base);
            b.scenarios[0].machines[0].from = "web-base".to_owned();
        }),
        ("wake-chain", |b| {
            let mut base = image("web-base", "trixie", Some(4096));
            base.wake = true;
            b.images = vec![base, image("child", "web-base", None)];
        }),
        ("course-twice", |b| {
            let courses = &mut b.course_catalog.courses;
            courses.push(courses[0].clone());
        }),
        ("lecture-twice", |b| {
            let lectures = &mut b.course_catalog.courses[0].lectures;
            lectures.push(lectures[0].clone());
        }),
        ("lecture-scenario", |b| {
            for lecture in &mut b.course_catalog.courses[0].lectures {
                lecture.scenario_id = Some("elsewhere".to_owned());
            }
        }),
    ]
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    let body = serde_json::to_string_pretty(value).context("serialize fixture")?;
    fs::write(path, format!("{body}\n")).with_context(|| format!("write {}", path.display()))
}

/// A fixed vector for the source compile digest formula, so the Worker and
/// the compilers can each assert that they derive the same value.
fn write_compile_digest_v2_fixture(path: &Path) -> Result<()> {
    let image_format = intar_contracts::oci::IMAGE_FORMAT;
    let fixture = serde_json::json!({
        "image_format": image_format,
        "compiler_version": SOURCE_COMPILER_VERSION_V2,
        "digest": source_compile_digest(image_format, SOURCE_COMPILER_VERSION_V2),
    });
    let body = serde_json::to_string_pretty(&fixture).context("serialize compile digest")?;
    fs::write(path, format!("{body}\n")).with_context(|| format!("write {}", path.display()))
}

fn write_schema(path: &Path, schema: &schemars::Schema) -> Result<()> {
    let body = serde_json::to_string_pretty(schema).context("serialize schema")?;
    fs::write(path, format!("{body}\n")).with_context(|| format!("write {}", path.display()))
}

fn copy_fixture(source: &str, dest: &Path) -> Result<()> {
    fs::copy(source, dest)
        .with_context(|| format!("copy fixture {source} to {}", dest.display()))?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove obsolete {}", path.display())),
    }
}

fn constants_ts() -> String {
    format!(
        r#"// Generated by `cargo run -p intar-contracts-typegen`.
export const RUNTIME_DISK_LABEL = "{}";
export const RECORDING_DISK_LABEL = "{}";
export const RUNTIME_ENV_FILENAME = "{}";
export const GUEST_USERNAME = "{}";
export const HOST_STATE_REPORT_SCHEMA_VERSION = {};
export const SOURCE_COMPILER_VERSION_V2 = "{}";
export const MAX_SOURCE_BUNDLE_GZIP_BYTES = {};
export const SOURCE_BUNDLES_PATH = "{}";
export const SOURCE_COMPILER_PATH = "{}";
/**
 * `GET <prefix>/<compile_id>?attempt=<n>` returns the snapshot, and
 * `POST <prefix>/<compile_id>/result?attempt=<n>` takes a multipart success
 * or a JSON `SourceCompileFailureV1`, told apart by `Content-Type`.
 */
export const AGENT_SOURCES_PATH = "{}";
export const SOURCE_META_FIELD = "{}";
export const SOURCE_BUNDLE_FIELD = "{}";
export const SHARE_ID_LEN = {};
export const SHARE_WRITE_TOKEN_LEN = {};
export const SHARE_INGEST_PING = "{}";
export const SHARE_INGEST_PONG = "{}";
export const SHARE_INGEST_CLOSE_ENDED = {};
export const SHARE_INGEST_CLOSE_LIMIT = {};
export const SHARE_INGEST_CLOSE_STOPPED = {};
export const BRIDGE_PROTOCOL_VERSION_9 = {};
export const GUEST_CONTRACT = {};
export const GUEST_REPORT_PORT = {};
export const GUEST_RUN_CLI_PORT = {};
export const IMAGE_FORMAT = "{}";
export const MACHINE_ARTIFACT_TYPE = "{}";
export const MACHINE_CONFIG_MEDIA_TYPE = "{}";
export const KERNEL_MEDIA_TYPE = "{}";
export const INITRD_MEDIA_TYPE = "{}";
export const DISK_CHUNK_MEDIA_TYPE = "{}";
export const KINO_ARTIFACT_TYPE = "{}";
export const MACHINE_SPEC_MEDIA_TYPE = "{}";
export const WAKE_RAM_CHUNK_MEDIA_TYPE = "{}";
export const WAKE_DELTA_MEDIA_TYPE = "{}";
export const WAKE_STUB_MEDIA_TYPE = "{}";
export const WAKE_CPU_PROFILE_MEDIA_TYPE = "{}";
export const PLATFORM_BASE_IMAGE = "{}";
export const MAX_MACHINES = {};
export const MAX_MACHINE_NAME_LEN = {};
export const MAX_TASKS_PER_MACHINE = {};
export const MAX_READY_PER_MACHINE = {};
export const MAX_SCRIPT_BYTES = {};
export const MAX_MARKDOWN_BYTES = {};
export const MAX_MACHINE_SPEC_BYTES = {};
export const MAX_DISK_MIB = {};

export const runtimeEnvKeys = {{
  sshAuthorizedKeysB64: "{}",
  kinoVsockCid: "{}",
  kinoVsockPort: "{}",
  kinoHostReadyPort: "{}",
  kinoSha256: "{}",
  guestBootstrapAbi: "{}",
  vmHostname: "{}",
  guestIpCidr: "{}",
  gateway: "{}",
  dnsServers: "{}",
  peerHostsB64: "{}",
}} as const;
"#,
        label_to_string(RUNTIME_DISK_LABEL),
        label_to_string(RECORDING_DISK_LABEL),
        RUNTIME_ENV_FILENAME,
        GUEST_USERNAME,
        HOST_STATE_REPORT_SCHEMA_VERSION,
        SOURCE_COMPILER_VERSION_V2,
        MAX_SOURCE_BUNDLE_GZIP_BYTES,
        SOURCE_BUNDLES_PATH,
        SOURCE_COMPILER_PATH,
        AGENT_SOURCES_PATH,
        SOURCE_META_FIELD,
        SOURCE_BUNDLE_FIELD,
        SHARE_ID_LEN,
        SHARE_WRITE_TOKEN_LEN,
        SHARE_INGEST_PING,
        SHARE_INGEST_PONG,
        SHARE_INGEST_CLOSE_ENDED,
        SHARE_INGEST_CLOSE_LIMIT,
        SHARE_INGEST_CLOSE_STOPPED,
        intar_contracts::bridge_v9::BRIDGE_PROTOCOL_VERSION_9,
        intar_contracts::guest::GUEST_CONTRACT,
        intar_contracts::guest::REPORT_PORT,
        intar_contracts::guest::RUN_CLI_PORT,
        intar_contracts::oci::IMAGE_FORMAT,
        intar_contracts::oci::MACHINE_ARTIFACT_TYPE,
        intar_contracts::oci::MACHINE_CONFIG_MEDIA_TYPE,
        intar_contracts::oci::KERNEL_MEDIA_TYPE,
        intar_contracts::oci::INITRD_MEDIA_TYPE,
        intar_contracts::oci::DISK_CHUNK_MEDIA_TYPE,
        intar_contracts::oci::KINO_ARTIFACT_TYPE,
        intar_contracts::oci::MACHINE_SPEC_MEDIA_TYPE,
        intar_contracts::oci::WAKE_RAM_CHUNK_MEDIA_TYPE,
        intar_contracts::oci::WAKE_DELTA_MEDIA_TYPE,
        intar_contracts::oci::WAKE_STUB_MEDIA_TYPE,
        intar_contracts::oci::WAKE_CPU_PROFILE_MEDIA_TYPE,
        intar_contracts::scenario::PLATFORM_BASE_IMAGE,
        intar_contracts::scenario::MAX_MACHINES,
        intar_contracts::scenario::MAX_MACHINE_NAME_LEN,
        MAX_TASKS_PER_MACHINE,
        MAX_READY_PER_MACHINE,
        MAX_SCRIPT_BYTES,
        intar_contracts::scenario::MAX_MARKDOWN_BYTES,
        intar_contracts::scenario::MAX_MACHINE_SPEC_BYTES,
        MAX_DISK_MIB,
        ENV_SSH_AUTHORIZED_KEYS_B64,
        ENV_KINO_VSOCK_CID,
        ENV_KINO_VSOCK_PORT,
        ENV_KINO_HOST_READY_PORT,
        ENV_KINO_SHA256,
        ENV_GUEST_BOOTSTRAP_ABI,
        ENV_VM_HOSTNAME,
        ENV_GUEST_IP_CIDR,
        ENV_GATEWAY,
        ENV_DNS_SERVERS,
        ENV_PEER_HOSTS_B64,
    )
}

fn stargate_ts() -> &'static str {
    r#"// Generated by `cargo run -p intar-contracts-typegen`.
export type TerminalSessionMode = "browser" | "native";
export type NativeTerminalAuthMode = "profile_keys";

/** Every field is mandatory and non-empty for a terminal route. */
export interface RouteMetadata {
  host_id: string;
  run_id: string;
  vm_id: string;
  user_id: string;
}

/** Workspace app routes carry no terminal identity, so their metadata stays
 * optional. */
export interface WorkspaceAppMetadata {
  host_id?: string | null;
  run_id?: string | null;
  vm_id?: string | null;
  user_id?: string | null;
}

/** The complete SSH endpoint of one scenario VM terminal. Only the admin API
 * carries this value: the guest private key never reaches a browser. */
export interface HostRelayIdentity {
  host_id: string;
  session_id: string;
  credential_generation: number;
}
export type RelayService = "ssh";
export interface RelayTarget {
  host: HostRelayIdentity;
  owner_id: string;
  execution_id: string;
  execution_generation: number;
  vm_id: string;
  service: RelayService;
}
export type SshTargetTransport =
  | { kind: "direct"; host: string; port: number }
  | { kind: "relay"; target: RelayTarget };

export interface TerminalTarget {
  username: string;
  transport: SshTargetTransport;
  host_key_openssh: string;
  private_key_openssh: string;
  authorized_client_public_keys_openssh: string[];
}

/** A browser route starts pending. An admin attach moves it to ready. */
export type TerminalTargetState =
  | { state: "pending" }
  | ({ state: "ready" } & TerminalTarget);

export interface IssueTerminalSessionRequest {
  route_username: string;
  /** Opaque generation. An attach call must repeat this exact string. */
  generation: string;
  /** `pending` for a browser route, `ready` for a native route. */
  target: TerminalTargetState;
  route_expires_at: number;
  mode: TerminalSessionMode;
  metadata: RouteMetadata;
}

/** Stage the ready target on a pending route. The route is NOT ready after
 * this call: no waiter wakes and no socket dials, so the SSH shift can not
 * start before the control plane activates the attachment. */
export interface StageTerminalTargetRequest {
  run_id: string;
  vm_id: string;
  user_id: string;
  generation: string;
  target: TerminalTarget;
}

/** One staged target. An identical repeat of a stage call returns the same
 * value, so a lost answer is safe to retry. */
export interface StageTerminalTargetResponse {
  attachment_id: string;
}

/** Activate exactly the staged attachment that the control plane names. Only
 * this call makes the route ready and wakes the waiting browser socket. */
export interface ActivateTerminalTargetRequest {
  run_id: string;
  vm_id: string;
  user_id: string;
  generation: string;
  attachment_id: string;
}

export interface BrowserTerminalSession {
  websocket_url: string;
}

export interface NativeTerminalSession {
  auth_mode: NativeTerminalAuthMode;
  authorized_key_count: number;
  ssh_host: string;
  ssh_port: number;
  username: string;
  public_host_key_openssh: string;
  public_host_key_fingerprint_sha256: string;
  known_hosts_line: string;
  command: string;
}

export interface IssueTerminalSessionResponse {
  route_username: string;
  expires_at: number;
  browser?: BrowserTerminalSession;
  native?: NativeTerminalSession;
}

export type WorkspaceAppProtocol = "http";

export interface IssueWorkspaceAppSessionRequest {
  route_id: string;
  create_only?: boolean;
  target_username: string;
  transport: SshTargetTransport;
  target_host_key_openssh: string;
  target_private_key_openssh: string;
  target_app_port: number;
  protocol: WorkspaceAppProtocol;
  upstream_host?: string;
  route_expires_at: number;
  metadata?: WorkspaceAppMetadata;
}

export interface IssueWorkspaceAppSessionResponse {
  route_id: string;
  url: string;
  bootstrap_expires_at: number;
  expires_at: number;
}

/** `PUT /v1/run-mirrors/{run_id}`: stream every PTY session of the run to the
 * share. A PUT whose `claimed_at_ms` is older than the stored mirror's answers
 * 409. `DELETE /v1/run-mirrors/{run_id}?share_id=` stops it, and answers 409
 * when the run streams to a different share. */
export interface RunMirrorRequest {
  share_id: string;
  write_token: string;
  /** Unix milliseconds when the control plane claimed the share. */
  claimed_at_ms: number;
}

/** `[milliseconds since the PTY started, code, data]`, the asciicast v2
 * event shape. Resize data is `"COLSxROWS"`. */
export type ShareEventCode = "o" | "r";
export type ShareEvent = [number, ShareEventCode, string];

/** One text frame on the share ingest socket: one socket per PTY session,
 * output only. A repeated `start` with the same `session` resumes it. */
export type ShareIngestMessage =
  | {
      type: "start";
      session: string;
      vm_id: string;
      mode: TerminalSessionMode;
      cols: number;
      rows: number;
      at_ms: number;
      mid_session: boolean;
    }
  | { type: "events"; events: ShareEvent[] }
  | { type: "gap"; bytes: number };
"#
}

fn catalog_ts() -> &'static str {
    r#"// Generated by `cargo run -p intar-contracts-typegen`.
export type ProbePhase = "boot" | "scenario";
export type ScenarioDifficulty = "easy" | "medium" | "hard";

export type Mib = number;

export interface CourseCatalogSnapshotV2 {
  version: number;
  courses: CourseCatalogCourseV2[];
}

export interface CourseCatalogCourseV2 {
  course_id: string;
  title: string;
  summary: string;
  body_markdown: string;
  sequential: boolean;
  lectures: CourseCatalogLectureV2[];
}

export interface CourseCatalogLectureV2 {
  lecture_id: string;
  title: string;
  summary: string;
  body_markdown: string;
  category: string;
  tags: string[];
  difficulty?: ScenarioDifficulty | null;
  estimated_minutes: number;
  scenario_id?: string | null;
}

export type SourceRefusalCode =
  | "compiler_outdated"
  | "superseded"
  | "fenced"
  | "binding_inactive"
  | "issuer_unsupported";

export type SourceCompileErrorCode =
  | "manifest_missing"
  | "manifest_invalid"
  | "courses_root_missing"
  | "submodule_unsupported"
  | "lfs_unsupported"
  | "bundle_too_large"
  | "meta_too_large"
  | "too_many_scenarios"
  | "compile_failed";
"#
}

fn bridge_ts() -> &'static str {
    r#"// Generated by `cargo run -p intar-contracts-typegen`.
import type {
  Mib,
  ProbePhase,
  SourceCompileErrorCode,
} from "./catalog";

export interface HostRelayCredentials {
  websocket_url: string;
  token: string;
  gateway_host_key_openssh: string;
  identity: import("./stargate").HostRelayIdentity;
  expires_at_unix_ms: number;
}

export interface SourceCompileErrorV1 {
  /** Repository-relative path. */
  path?: string;
  line?: number;
  code: SourceCompileErrorCode;
  message: string;
}

export interface HostCapacityV2 {
  total_cpu_millis: number;
  reserved_cpu_millis: number;
  schedulable_cpu_millis: number;
  committed_cpu_millis: number;
  memory_total_mib: Mib;
  memory_available_mib: Mib;
  disk_probe_path: string;
  disk_total_mib: Mib;
  disk_available_mib: Mib;
  load_avg_1m?: number | null;
  load_avg_5m?: number | null;
  load_avg_15m?: number | null;
  primary_ipv4?: string | null;
  primary_ipv6?: string | null;
}

export interface VmResourceStateV3 {
  cpu_millis: number;
  cpu_quota_us: number;
  cpu_period_us: number;
  cpu_usage_usec: number;
  cpu_user_usec: number;
  cpu_system_usec: number;
  cpu_nr_periods: number;
  cpu_nr_throttled: number;
  cpu_throttled_usec: number;
}

export interface VmSandboxStateV1 {
  healthy: boolean;
  generation: string;
  systemd_unit: string;
  cgroup_path: string;
  seccomp_enabled: boolean;
  landlock_enabled: boolean;
  no_new_privs: boolean;
}

export type VmPhase =
  | "pending"
  | "pulling_image"
  | "creating_disks"
  | "booting"
  | "running"
  | "ready"
  | "solved"
  | "stopping"
  | "stopped"
  | "failed"
  | "absent";

export interface VmActualStateV2 {
  owner_user_id: string;
  runtime_execution_id: string;
  generation: number;
  run_id: string;
  vm_name: string;
  desired_version?: number | null;
  phase: VmPhase;
  image_id?: string | null;
  network?: VmNetworkStateV1 | null;
  terminal: VmTerminalStateV1;
  runtime_constraints?: VmRuntimeConstraintsV2 | null;
  resource_state?: VmResourceStateV3 | null;
  sandbox?: VmSandboxStateV1 | null;
  ssh_host_keys_openssh: string[];
  probes: VmProbeSnapshotV1[];
  archive?: VmArchiveStateV1 | null;
  error?: string | null;
  updated_at_unix_ms: number;
}

export interface VmNetworkStateV1 {
  bridge_name: string;
  guest_ip: string;
  guest_cidr: string;
  gateway: string;
  ssh_host?: string | null;
  ssh_host_port?: number | null;
}

export type VmTerminalStateKindV1 = "pending" | "ready" | "failed";

export interface VmTerminalTargetV1 {
  host: string;
  port: number;
  username: string;
  checked_at_unix_ms: number;
}

export interface VmTerminalStateV1 {
  state: VmTerminalStateKindV1;
  target?: VmTerminalTargetV1 | null;
  reason?: string | null;
  observed_at_unix_ms: number;
}


export interface VmRuntimeConstraintsV2 {
  generation: string;
  cpu_millis: number;
  quota_verified_at_unix_ms?: number | null;
}

export type VmProbeStatus = "unknown" | "pass" | "fail";

export interface VmProbeSnapshotV1 {
  id: string;
  phase: ProbePhase;
  status: VmProbeStatus;
  checked_at_unix_ms: number;
  message?: string | null;
  value?: unknown;
}

export type VmArchivePhase =
  | "none"
  | "pending"
  | "uploading"
  | "complete"
  | "failed";

export interface VmArchiveStateV1 {
  phase: VmArchivePhase;
  artifact_count: number;
  error?: string | null;
}

export interface VmReportV2 {
  owner_user_id: string;
  runtime_execution_id: string;
  generation: number;
  schema_version: number;
  host_id: string;
  run_id: string;
  vm_name: string;
  desired_version?: number | null;
  observed_at_unix_ms: number;
  phase: VmPhase;
  network?: VmNetworkStateV1 | null;
  terminal: VmTerminalStateV1;
  runtime_constraints?: VmRuntimeConstraintsV2 | null;
  resource_state?: VmResourceStateV3 | null;
  sandbox?: VmSandboxStateV1 | null;
  ssh_host_keys_openssh: string[];
  probes: VmProbeSnapshotV1[];
  archive?: VmArchiveStateV1 | null;
  error?: string | null;
}"#
}

fn run_cli_ts() -> String {
    let header = format!(
        "// Generated by `cargo run -p intar-contracts-typegen`.\n\
export const RUN_CLI_PROTOCOL_VERSION = {RUN_CLI_PROTOCOL_VERSION};\n\
export const RUN_CLI_SCHEMA_VERSION = {RUN_CLI_SCHEMA_VERSION};\n\
export const RUN_CLI_MAX_FRAME_BYTES = {RUN_CLI_MAX_FRAME_BYTES};\n\
export const RUN_CLI_MAX_REQUEST_ID_BYTES = {RUN_CLI_MAX_REQUEST_ID_BYTES};\n\
export const RUN_CLI_MAX_RETRY_SCOPE_BYTES = {RUN_CLI_MAX_RETRY_SCOPE_BYTES};\n\
export const RUN_CLI_MAX_HINT_ALIAS_BYTES = {RUN_CLI_MAX_HINT_ALIAS_BYTES};\n\
export const RUN_CLI_MAX_COMPLETION_ALIASES = {RUN_CLI_MAX_COMPLETION_ALIASES};\n\
export const RUN_CLI_MAX_PROBE_IDS = {RUN_CLI_MAX_PROBE_IDS};\n\
export const RUN_CLI_MAX_PROBE_ID_BYTES = {RUN_CLI_MAX_PROBE_ID_BYTES};\n\n"
    );
    format!(
        "{header}{}",
        r#"export type RunCliActionV1 =
  | { kind: "completion" }
  | { kind: "status" }
  | { kind: "hints" }
  | { kind: "hint_reveal"; alias: string; expected_ordinal: number }
  | { kind: "solution" }
  | { kind: "solution_reveal" }
  | { kind: "check_sync" };

export interface RunCliRequestV1 {
  protocol_version: number;
  request_id: string;
  action: RunCliActionV1;
}

export type RunCliResultV1 =
  | { kind: "ok"; view: RunCliViewV1 }
  | { kind: "completion"; aliases: string[] }
  | { kind: "error"; error: RunCliErrorV1 };

export interface RunCliResponseV1 {
  protocol_version: number;
  request_id: string;
  result: RunCliResultV1;
}

export interface RunCliViewV1 {
  /** Opaque fenced scope for local retry state. Never render or log it. */
  retry_scope: string;
  run: RunCliRunV1;
  checks: RunCliCheckV1[];
  hint_groups: RunCliHintGroupV1[];
  solution: RunCliSolutionV1;
}

export interface RunCliRunV1 {
  kind: RunCliRunKindV1;
  title: string;
  context?: string;
}

export type RunCliRunKindV1 = "scenario";

/** `probe_id` is for the private broker only. The learner CLI must not render it. */
export interface RunCliCheckV1 {
  probe_id: string;
  alias: string;
  label: string;
  status: RunCliCheckStatusV1;
}

export type RunCliCheckStatusV1 = "pass" | "fail" | "unknown";

export interface RunCliHintGroupV1 {
  alias: string;
  label: string;
  revealed_count: number;
  total_count: number;
  can_reveal: boolean;
  entries: RunCliHintEntryV1[];
}

/** `title` and `body_markdown` are present only for revealed hints. */
export interface RunCliHintEntryV1 {
  ordinal: number;
  state: RunCliHintStateV1;
  title?: string;
  body_markdown?: string;
}

export type RunCliHintStateV1 = "revealed" | "ready" | "locked";

export interface RunCliSolutionV1 {
  state: RunCliSolutionStateV1;
  assisted: boolean;
  body_markdown?: string;
}

export type RunCliSolutionStateV1 =
  | "sealed"
  | "revealed"
  | "unavailable";

export interface RunCliErrorV1 {
  code: RunCliErrorCodeV1;
  message: string;
  retryable: boolean;
}

export type RunCliErrorCodeV1 =
  | "invalid_request"
  | "locked"
  | "unavailable"
  | "conflict"
  | "unauthorized"
  | "protocol_mismatch"
  | "frame_too_large"
  | "internal";

export interface RunCliProbeCheckRequestV1 {
  protocol_version: number;
  request_id: string;
  probe_ids: string[];
}

export interface RunCliProbeCheckEventV1 {
  protocol_version: number;
  request_id: string;
  event: RunCliProbeCheckEventKindV1;
}

export type RunCliProbeCheckEventKindV1 =
  | { kind: "probe"; check: RunCliProbeCheckResultV1 }
  | { kind: "complete"; completed_count: number };

/** `probe_id` is for the private Kino/broker protocol only. */
export interface RunCliProbeCheckResultV1 {
  probe_id: string;
  status: RunCliCheckStatusV1;
  duration_ms: number;
}
"#
    )
}

fn label_to_string(label: [u8; 11]) -> String {
    String::from_utf8_lossy(&label).trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::{catalog_ts, stargate_ts};
    use intar_contracts::source::{SourceCompileErrorCode, SourceRefusalCode};
    use schemars::schema_for;

    /// The hand-written source code unions must list exactly the Rust enum
    /// values, or a CLI or builder could send a code the Worker cannot name.
    #[test]
    fn emitted_source_code_unions_match_the_rust_enums() {
        let ts = catalog_ts();
        for (name, schema) in [
            ("SourceRefusalCode", schema_for!(SourceRefusalCode)),
            (
                "SourceCompileErrorCode",
                schema_for!(SourceCompileErrorCode),
            ),
        ] {
            let header = format!("export type {name} =");
            let start = ts.find(&header).expect("the emitter kept this union");
            let rest = &ts[start + header.len()..];
            let union = &rest[..rest.find(';').expect("the union ends")];
            let mut emitted: Vec<&str> = union
                .split('|')
                .map(|value| value.trim().trim_matches('"'))
                .filter(|value| !value.is_empty())
                .collect();
            let mut expected: Vec<&str> = schema
                .get("enum")
                .and_then(|values| values.as_array())
                .expect("a unit enum schema")
                .iter()
                .filter_map(|value| value.as_str())
                .collect();
            emitted.sort_unstable();
            expected.sort_unstable();
            assert_eq!(emitted, expected, "{name} drifted from the Rust enum");
        }

    }

    /// One emitted interface block, so a check names the type it means. The
    /// workspace app request legitimately keeps `target_username`, and the
    /// terminal route request must not.
    fn block<'a>(ts: &'a str, name: &str) -> &'a str {
        let header = format!("export interface {name} {{");
        let start = ts.find(&header).expect("the emitter kept this interface");
        let rest = &ts[start + header.len()..];
        let end = rest.find("\n}").expect("the interface closes");
        &rest[..end]
    }

    /// The emitted TypeScript is the contract the web app compiles against.
    /// Hold it to the fields the Rust types carry, so a type change that the
    /// emitter does not follow fails here instead of in the web build.
    #[test]
    fn emitted_stargate_typescript_carries_the_terminal_route_contract() {
        let ts = stargate_ts();

        for required in [
            "generation: string;",
            "target: TerminalTargetState;",
            "export type TerminalTargetState =",
            "{ state: \"pending\" }",
            "({ state: \"ready\" } & TerminalTarget)",
            "export interface StageTerminalTargetRequest {",
            "export interface StageTerminalTargetResponse {",
            "attachment_id: string;",
            "export interface ActivateTerminalTargetRequest {",
            "private_key_openssh: string;",
            "host_key_openssh: string;",
            "authorized_client_public_keys_openssh: string[];",
            "export interface WorkspaceAppMetadata {",
        ] {
            assert!(ts.contains(required), "the emitter dropped {required:?}");
        }

        // A terminal route identity is mandatory; only the workspace app route
        // keeps optional metadata. The old flat browser shape must be gone.
        assert!(ts.contains("host_id: string;"));
        assert!(ts.contains("metadata: RouteMetadata;"));
        assert!(ts.contains("metadata?: WorkspaceAppMetadata;"));
        assert!(
            block(ts, "StageTerminalTargetRequest").contains("target: TerminalTarget;"),
            "the stage request must carry the ready target"
        );
        for absent in ["target_username", "target_ip", "target_port", "state"] {
            assert!(
                !block(ts, "StageTerminalTargetRequest").contains(absent),
                "the stage request must not carry {absent:?}"
            );
        }
        for absent in [
            "target_username",
            "target_ip",
            "target_host_key_openssh",
            "private_key_openssh",
        ] {
            assert!(
                !block(ts, "IssueTerminalSessionRequest").contains(absent),
                "the create request must not carry {absent:?} at the top level"
            );
        }
        for required in [
            "export interface RunMirrorRequest {",
            "write_token: string;",
            "claimed_at_ms: number;",
            "export type ShareEvent = [number, ShareEventCode, string];",
            "| { type: \"events\"; events: ShareEvent[] }",
            "| { type: \"gap\"; bytes: number };",
            "mid_session: boolean;",
        ] {
            assert!(ts.contains(required), "the emitter dropped {required:?}");
        }
        assert!(!ts.contains("TerminalTargetView"));
        assert!(
            !ts.contains("AttachTerminalTargetRequest"),
            "the replaced attach type must not remain in the emitted contract"
        );
    }
}
