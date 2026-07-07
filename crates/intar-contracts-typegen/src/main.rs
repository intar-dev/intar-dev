#![forbid(unsafe_code)]

use std::{fs, path::Path};

use anyhow::{Context as _, Result};
use intar_contracts::{
    bridge::{
        BRIDGE_PROTOCOL_VERSION, BUILD_REPORT_SCHEMA_VERSION, BridgeMessageV5, BuildReportV1,
        DesiredBuildV1, HOST_DESIRED_STATE_SCHEMA_VERSION, HOST_STATE_REPORT_SCHEMA_VERSION,
        HostDesiredStateV1, HostStateReportV1, VM_REPORT_SCHEMA_VERSION, VmReportV1,
    },
    catalog::ScenarioManifestV2,
    guest::{
        ENV_DNS_SERVERS, ENV_GATEWAY, ENV_GUEST_IP_CIDR, ENV_KINO_HOST_READY_PORT,
        ENV_KINO_VSOCK_CID, ENV_KINO_VSOCK_PORT, ENV_SSH_AUTHORIZED_KEYS_B64, ENV_VM_HOSTNAME,
        GUEST_USERNAME, RECORDING_DISK_LABEL, RUNTIME_DISK_LABEL, RUNTIME_ENV_FILENAME, RuntimeEnv,
    },
    stargate::{IssueTerminalSessionRequest, IssueTerminalSessionResponse},
};
use schemars::schema_for;

fn main() -> Result<()> {
    let out_dir = Path::new("website/src/generated");
    let schema_dir = out_dir.join("schemas");
    let fixture_dir = out_dir.join("fixtures");
    fs::create_dir_all(&schema_dir).context("create schema output directory")?;
    fs::create_dir_all(fixture_dir.join("stargate"))
        .context("create stargate fixture directory")?;
    fs::create_dir_all(fixture_dir.join("catalog")).context("create catalog fixture directory")?;
    fs::create_dir_all(fixture_dir.join("bridge")).context("create bridge fixture directory")?;

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
        &schema_dir.join("catalog-scenario-manifest-v2.schema.json"),
        &schema_for!(ScenarioManifestV2),
    )?;
    write_schema(
        &schema_dir.join("bridge-host-desired-state-v1.schema.json"),
        &schema_for!(HostDesiredStateV1),
    )?;
    write_schema(
        &schema_dir.join("bridge-host-state-report-v1.schema.json"),
        &schema_for!(HostStateReportV1),
    )?;
    write_schema(
        &schema_dir.join("bridge-vm-report-v1.schema.json"),
        &schema_for!(VmReportV1),
    )?;
    write_schema(
        &schema_dir.join("bridge-desired-build-v1.schema.json"),
        &schema_for!(DesiredBuildV1),
    )?;
    write_schema(
        &schema_dir.join("bridge-build-report-v1.schema.json"),
        &schema_for!(BuildReportV1),
    )?;
    write_schema(
        &schema_dir.join("bridge-message-v5.schema.json"),
        &schema_for!(BridgeMessageV5),
    )?;

    fs::write(out_dir.join("constants.ts"), constants_ts()).context("write constants.ts")?;
    fs::write(out_dir.join("stargate.ts"), stargate_ts()).context("write stargate.ts")?;
    fs::write(out_dir.join("catalog.ts"), catalog_ts()).context("write catalog.ts")?;
    fs::write(out_dir.join("bridge.ts"), bridge_ts()).context("write bridge.ts")?;

    copy_fixture(
        "crates/intar-contracts/fixtures/stargate/issue-terminal-session-request.json",
        &fixture_dir.join("stargate/issue-terminal-session-request.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/stargate/issue-terminal-session-response.json",
        &fixture_dir.join("stargate/issue-terminal-session-response.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/catalog/scenario-manifest-v2.json",
        &fixture_dir.join("catalog/scenario-manifest-v2.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/bridge/host-desired-state-v1.json",
        &fixture_dir.join("bridge/host-desired-state-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/bridge/host-state-report-v1.json",
        &fixture_dir.join("bridge/host-state-report-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/bridge/vm-report-v1.json",
        &fixture_dir.join("bridge/vm-report-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/bridge/desired-build-v1.json",
        &fixture_dir.join("bridge/desired-build-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/bridge/build-report-v1.json",
        &fixture_dir.join("bridge/build-report-v1.json"),
    )?;
    copy_fixture(
        "crates/intar-contracts/fixtures/bridge/sync-request-v5.json",
        &fixture_dir.join("bridge/sync-request-v5.json"),
    )?;

    Ok(())
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

fn constants_ts() -> String {
    format!(
        r#"// Generated by `cargo run -p intar-contracts-typegen`.
export const RUNTIME_DISK_LABEL = "{}";
export const RECORDING_DISK_LABEL = "{}";
export const RUNTIME_ENV_FILENAME = "{}";
export const GUEST_USERNAME = "{}";
export const BRIDGE_PROTOCOL_VERSION = {};
export const HOST_DESIRED_STATE_SCHEMA_VERSION = {};
export const HOST_STATE_REPORT_SCHEMA_VERSION = {};
export const BUILD_REPORT_SCHEMA_VERSION = {};
export const VM_REPORT_SCHEMA_VERSION = {};

export const runtimeEnvKeys = {{
  sshAuthorizedKeysB64: "{}",
  kinoVsockCid: "{}",
  kinoVsockPort: "{}",
  kinoHostReadyPort: "{}",
  vmHostname: "{}",
  guestIpCidr: "{}",
  gateway: "{}",
  dnsServers: "{}",
}} as const;
"#,
        label_to_string(RUNTIME_DISK_LABEL),
        label_to_string(RECORDING_DISK_LABEL),
        RUNTIME_ENV_FILENAME,
        GUEST_USERNAME,
        BRIDGE_PROTOCOL_VERSION,
        HOST_DESIRED_STATE_SCHEMA_VERSION,
        HOST_STATE_REPORT_SCHEMA_VERSION,
        BUILD_REPORT_SCHEMA_VERSION,
        VM_REPORT_SCHEMA_VERSION,
        ENV_SSH_AUTHORIZED_KEYS_B64,
        ENV_KINO_VSOCK_CID,
        ENV_KINO_VSOCK_PORT,
        ENV_KINO_HOST_READY_PORT,
        ENV_VM_HOSTNAME,
        ENV_GUEST_IP_CIDR,
        ENV_GATEWAY,
        ENV_DNS_SERVERS,
    )
}

fn stargate_ts() -> &'static str {
    r#"// Generated by `cargo run -p intar-contracts-typegen`.
export type TerminalSessionMode = "browser" | "native";
export type NativeTerminalAuthMode = "profile_keys";

export interface RouteMetadata {
  host_id?: string | null;
  run_id?: string | null;
  vm_id?: string | null;
  user_id?: string | null;
}

export interface IssueTerminalSessionRequest {
  route_username: string;
  target_username: string;
  target_ip: string;
  target_port: number;
  target_host_key_openssh: string;
  target_private_key_openssh: string;
  authorized_client_public_keys_openssh?: string[];
  route_expires_at: number;
  mode: TerminalSessionMode;
  metadata?: RouteMetadata;
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
"#
}

fn catalog_ts() -> &'static str {
    r#"// Generated by `cargo run -p intar-contracts-typegen`.
export type ImageArchitecture = "x86_64" | "aarch64";
export type ProbePhase = "boot" | "scenario";
export type ScenarioDifficulty = "easy" | "medium" | "hard";
export type ImageFormat = "raw_zstd";

export interface ImageKey {
  scenario: string;
  vm: string;
  arch: ImageArchitecture;
}

export type Mib = number;

export interface ScenarioHintManifestV2 {
  id: string;
  title?: string | null;
  body_markdown: string;
}

export interface ScenarioProbeManifestV2 {
  id: string;
  phase: ProbePhase;
  kind: string;
  display_name: string;
  title?: string | null;
  body_markdown?: string | null;
  hints: ScenarioHintManifestV2[];
}

export interface ScenarioVmBootManifestV2 {
  kernel_sha256: string;
  initrd_sha256: string;
  cmdline: string;
}

export interface ScenarioVmManifestV2 {
  name: string;
  image_key: ImageKey;
  image_sha256: string;
  image_format: ImageFormat;
  image_virtual_size_bytes: number;
  boot: ScenarioVmBootManifestV2;
  cpu_count: number;
  memory_mib: Mib;
  disk_mib: Mib;
  probes: ScenarioProbeManifestV2[];
}

export interface ScenarioManifestV2 {
  schema_version: number;
  scenario_id: string;
  name: string;
  title: string;
  description: string;
  difficulty: ScenarioDifficulty;
  estimated_minutes: number;
  tags: string[];
  briefing_markdown: string;
  solution_markdown: string;
  hints: ScenarioHintManifestV2[];
  vms: ScenarioVmManifestV2[];
}
"#
}

fn bridge_ts() -> &'static str {
    r#"// Generated by `cargo run -p intar-contracts-typegen`.
import type { ImageArchitecture, ImageKey, Mib, ProbePhase } from "./catalog";

export type SyncRequestReason =
  | "connect"
  | "reconnect"
  | "desired_version_lag"
  | "operator_requested";

export type HostRoleV1 = "agent" | "builder";

export interface ClientHelloV5 {
  protocol_version: number;
  host_id: string;
  agent_version: string;
  role: HostRoleV1;
  last_applied_desired_version?: number | null;
  capabilities: HostCapabilitiesV1;
}

export interface ServerHelloV5 {
  protocol_version: number;
  host_id: string;
  desired_version: number;
}

export interface DesiredStateV5 {
  protocol_version: number;
  host_id: string;
  desired_state: HostDesiredStateV1;
}

export interface StateReportV5 {
  protocol_version: number;
  host_id: string;
  report: HostStateReportV1;
}

export interface VmReportV5 {
  protocol_version: number;
  host_id: string;
  report: VmReportV1;
}

export interface BuildReportV5 {
  protocol_version: number;
  host_id: string;
  report: BuildReportV1;
}

export interface SyncRequestV5 {
  protocol_version: number;
  host_id: string;
  reason: SyncRequestReason;
}

export type BridgeMessageV5 =
  | ({ type: "client_hello" } & ClientHelloV5)
  | ({ type: "server_hello" } & ServerHelloV5)
  | ({ type: "desired_state" } & DesiredStateV5)
  | ({ type: "state_report" } & StateReportV5)
  | ({ type: "vm_report" } & VmReportV5)
  | ({ type: "build_report" } & BuildReportV5)
  | ({ type: "sync_request" } & SyncRequestV5);

export interface HostDesiredStateV1 {
  schema_version: number;
  host_id: string;
  version: number;
  generated_at_unix_ms: number;
  cached_images: DesiredCachedImageV1[];
  vms: DesiredVmV1[];
  builds: DesiredBuildV1[];
}

export interface DesiredCachedImageV1 {
  image_key: ImageKey;
  image_sha256: string;
}

export interface DesiredBuildV1 {
  build_id: string;
  scenario_id: string;
  arch: ImageArchitecture;
  rev: string;
  content_hash: string;
  bundle_ref: string;
  kino_version: string;
}

export type DesiredVmPhase = "running" | "absent";

export interface DesiredVmV1 {
  run_id: string;
  vm_name: string;
  desired_phase: DesiredVmPhase;
  image_key: ImageKey;
  image_sha256: string;
  resources: VmResourcesV1;
  ssh_authorized_keys_openssh: string[];
  lease_expires_at_unix_ms: number;
}

export interface VmResourcesV1 {
  cpu_count: number;
  memory_mib: Mib;
  disk_mib: Mib;
}

export interface HostStateReportV1 {
  schema_version: number;
  host_id: string;
  observed_at_unix_ms: number;
  applied_desired_version: number;
  capacity: HostCapacityV1;
  capabilities: HostCapabilitiesV1;
  cached_images: CachedImageStateV1[];
  vms: VmActualStateV1[];
  builds: BuildReportV1[];
}

export interface HostCapacityV1 {
  cpu_count: number;
  memory_total_mib: Mib;
  memory_available_mib: Mib;
  disk_total_mib: Mib;
  disk_available_mib: Mib;
}

export interface HostCapabilitiesV1 {
  arch: ImageArchitecture;
  supports_kvm: boolean;
  supports_vsock: boolean;
  supports_reflink: boolean;
  supports_nftables: boolean;
}

export type ImageCachePhase =
  | "missing"
  | "queued"
  | "downloading"
  | "ready"
  | "failed";

export interface CachedImageStateV1 {
  image_key: ImageKey;
  image_sha256: string;
  phase: ImageCachePhase;
  bytes_on_disk?: number | null;
  error?: string | null;
  updated_at_unix_ms: number;
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

export interface VmActualStateV1 {
  run_id: string;
  vm_name: string;
  desired_version?: number | null;
  phase: VmPhase;
  image_key?: ImageKey | null;
  image_sha256?: string | null;
  network?: VmNetworkStateV1 | null;
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

export interface VmReportV1 {
  schema_version: number;
  host_id: string;
  run_id: string;
  vm_name: string;
  desired_version?: number | null;
  observed_at_unix_ms: number;
  phase: VmPhase;
  network?: VmNetworkStateV1 | null;
  ssh_host_keys_openssh: string[];
  probes: VmProbeSnapshotV1[];
  archive?: VmArchiveStateV1 | null;
  error?: string | null;
}

export type BuildPhase =
  | "queued"
  | "fetching_sources"
  | "building_base"
  | "building"
  | "publishing"
  | "uploading_logs"
  | "succeeded"
  | "failed";

export interface BuildReportV1 {
  schema_version: number;
  host_id: string;
  build_id: string;
  scenario_id: string;
  content_hash: string;
  observed_at_unix_ms: number;
  phase: BuildPhase;
  current_vm?: string | null;
  started_at_unix_ms?: number | null;
  finished_at_unix_ms?: number | null;
  attempt: number;
  error?: string | null;
}
"#
}

fn label_to_string(label: [u8; 11]) -> String {
    String::from_utf8_lossy(&label).trim_end().to_owned()
}
