import type {
  ScenarioManifestV3,
  ScenarioVmManifestV3,
} from "../../src/generated/catalog";
import type { DashboardArchivedRun } from "../../src/lib/dashboard-host";
import type { ScenarioRunRecord } from "../../src/lib/scenario-runs";

export interface Options {
  baseUrl: string;
  cookie: string;
  scenarioId: string;
  hostId: string | null;
  buildRev: string | null;
  publishToken: string | null;
  manifestPaths: string[];
  imagePathsByVmName: Map<string, string>;
  artifactPathsBySha: Map<string, string>;
  skipPublish: boolean;
  skipTeardown: boolean;
  skipTerminalProbe: boolean;
  allowNoArtifacts: boolean;
  waitCacheMs: number;
  waitBuildMs: number;
  waitReadyMs: number;
  waitCompleteMs: number;
  pollMs: number;
  warmStartBudgetMs: number;
  terminalProbeTimeoutMs: number;
  forbiddenIps: string[];
}

export interface LoadedManifest {
  path: string;
  manifest: ScenarioManifestV3;
}

export interface RequiredImage {
  image_key: ScenarioVmManifestV3["image_key"];
  image_sha256: string;
}

export interface HostSummary {
  id: string;
  disabled: boolean;
  scenarioEnabled: boolean;
  status: {
    connected: boolean;
    lastHeartbeatAt: string | null;
  };
  actualState: {
    appliedDesiredVersion: number;
    observedAt: number;
    capabilities: {
      supports_kvm: boolean;
      supports_vsock: boolean;
      supports_reflink: boolean;
      supports_nftables: boolean;
      supports_jailer_v2: boolean;
      supports_boot_cpu_lease: boolean;
      supports_template_backed_launch: boolean;
      fast_template_store: boolean;
      supports_hard_cpu_quota: boolean;
      supports_landlock: boolean;
      supports_cgroup_v2: boolean;
      boot_cpu_millis: number | null;
      boot_cpu_lease_ms: number | null;
      cloud_hypervisor_sha256: string | null;
      arch: string;
    };
    cachedImages: Array<{
      image_key: ScenarioVmManifestV3["image_key"];
      image_sha256: string;
      phase: string;
      error?: string | null;
    }>;
  } | null;
}

export interface HostsResponse {
  hosts: HostSummary[];
}

export interface HostResponse {
  host: HostSummary;
}

export interface HostRunsResponse {
  liveVms: Array<{
    name: string;
    run_id: string | null;
    details: {
      guest_ip: string | null;
      ssh_authorized_key_openssh?: string | null;
    } | null;
  }>;
  archivedRuns: DashboardArchivedRun[];
}

export interface AdminBuildsResponse {
  builds: AdminBuildSummary[];
}

export interface AdminBuildSummary {
  id: string;
  scenarioId: string;
  arch: RequiredImage["image_key"]["arch"];
  rev: string;
  contentHash: string;
  hostId: string | null;
  status: string;
  phase: string;
  attempt: number;
  error: string | null;
  updatedAt: number;
}

export interface AdminScenarioResponse {
  scenario: {
    vms: Array<{
      imageKey: ScenarioVmManifestV3["image_key"] | null;
      imageSha256: string | null;
      imageFormat: string;
      imageVirtualSizeBytes: number;
      kernelSha256: string;
      initrdSha256: string;
      bootCmdline: string;
    }>;
  };
}

export interface StartRunResponse {
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}

export interface RunResponse {
  run: ScenarioRun;
}

export type ScenarioRun = ScenarioRunRecord;
export type RunVm = ScenarioRun["vms"][number];
export type RunArtifact = ScenarioRun["replayArtifacts"][number];

export interface BrowserTerminalSessionResponse {
  routeUsername: string;
  expiresAt: number;
  browser?: {
    websocketUrl: string;
  };
}

export interface VerifiedTerminalSession {
  runId: string;
  vmId: string;
  runtimeVmName: string;
  websocketUrl: string;
  probeMarker: string | null;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
