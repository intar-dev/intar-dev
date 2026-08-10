/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { expect } from "vitest";
import {
  accessAllowlist,
  agentHosts,
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  scenarioRuns,
  user,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import type {
  BridgeMessageV6,
  DesiredVmV2,
  HostStateReportV2,
  VmActualStateV2,
  VmPhase,
  VmReportV2,
} from "@/generated/bridge";
import type { ImageKey } from "@/generated/catalog";
import { HOST_STATE_REPORT_SCHEMA_VERSION } from "@/generated/constants";
import { upsertDesiredCachedImage, upsertDesiredVm } from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";
import { startScenarioRunForUser } from "@/lib/scenario-runs";
import { resetD1Database } from "@/test/d1-migrations";

export {
  env,
  runDurableObjectAlarm,
  eq,
  drizzle,
  agentHosts,
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  scenarioRuns,
  user,
  vmScenarioVms,
  vmScenarios,
  HOST_STATE_REPORT_SCHEMA_VERSION,
  upsertDesiredCachedImage,
  upsertDesiredVm,
  mutateStoredHostDesiredState,
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
  startScenarioRunForUser,
};
export type {
  BridgeMessageV6,
  DesiredVmV2,
  HostStateReportV2,
  VmActualStateV2,
  VmPhase,
  VmReportV2,
  ImageKey,
  RunStateDocument,
};

export async function resetHostRuntimeTestDatabase(): Promise<void> {
  await resetD1Database();
}

export const testImageKey = {
  scenario: "broken-nginx",
  vm: "webserver",
  arch: "x86_64",
} satisfies ImageKey;

export function desiredRunningVm(
  runId: string,
  vmName: string,
  now: number,
): DesiredVmV2 {
  return {
    run_id: runId,
    vm_name: vmName,
    desired_phase: "running",
    image_key: testImageKey,
    image_sha256: "2".repeat(64),
    resources: {
      cpu_millis: 1_000,
      vcpu_count: 1,
      memory_mib: 512,
      disk_mib: 4_096,
    },
    ssh_authorized_keys_openssh: [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunkey user@example",
    ],
    lease_expires_at_unix_ms: now + 60_000,
  };
}

export async function seedHost(hostId: string): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db
    .insert(user)
    .values({
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .onConflictDoNothing();
  await grantActiveBetaAccessForHostFixture("user-1", now);
  await db.insert(agentHosts).values({
    id: hostId,
    userId: "user-1",
    name: hostId,
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
    connected: false,
    createdAt: now,
    updatedAt: now,
  });
}

export async function connectHost(
  hostId: string,
  options?: { lastAppliedDesiredVersion?: number | null },
): Promise<{
  messages: BridgeMessageV6[];
  stub: DurableObjectStub;
  ws: WebSocket;
}> {
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
  const admission = await env.DB.prepare(
    `SELECT host.organization_id,
            access.source_invite_id,
            access.source_lease_id,
            access.granted_at
     FROM agent_hosts host
     LEFT JOIN access_allowlist access
       ON access.user_id = host.user_id AND access.state = 'active'
     WHERE host.id = ?1`,
  )
    .bind(hostId)
    .first<{
      organization_id: string | null;
      source_invite_id: string | null;
      source_lease_id: string | null;
      granted_at: number | null;
    }>();
  if (!admission) throw new Error(`host fixture is missing: ${hostId}`);
  if (
    admission.organization_id === null &&
    (!admission.source_invite_id ||
      !admission.source_lease_id ||
      admission.granted_at === null)
  ) {
    throw new Error(`personal host fixture lacks beta access: ${hostId}`);
  }
  const headers = new Headers({
    upgrade: "websocket",
    "x-agent-host-id": hostId,
  });
  if (admission.granted_at !== null) {
    headers.set(
      "x-agent-beta-source-invite-id",
      admission.source_invite_id!,
    );
    headers.set(
      "x-agent-beta-source-lease-id",
      admission.source_lease_id!,
    );
    headers.set(
      "x-agent-beta-admission-granted-at",
      String(admission.granted_at),
    );
  }
  const response = await stub.fetch("http://host-runtime/connect", {
    headers,
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  expect(ws).not.toBeNull();
  if (!ws) {
    throw new Error("missing websocket");
  }
  const messages: BridgeMessageV6[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      messages.push(JSON.parse(event.data) as BridgeMessageV6);
    }
  });
  ws.send(JSON.stringify(clientHello(hostId, options)));
  return { messages, stub, ws };
}

export async function grantActiveBetaAccessForHostFixture(
  userId: string,
  now: number,
): Promise<void> {
  const existing = await drizzle(env.DB)
    .select({ userId: accessAllowlist.userId })
    .from(accessAllowlist)
    .where(eq(accessAllowlist.userId, userId))
    .limit(1);
  if (existing.length) return;
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId,
    githubAccountId: `host-runtime-github-${userId}`,
    githubUsername: userId,
    now,
  });
}

export async function betaAdmissionForHostFixture(
  userId: string,
): Promise<BetaAdmissionEpoch> {
  const [access] = await drizzle(env.DB)
    .select({
      sourceInviteId: accessAllowlist.sourceInviteId,
      sourceLeaseId: accessAllowlist.sourceLeaseId,
      grantedAt: accessAllowlist.grantedAt,
    })
    .from(accessAllowlist)
    .where(eq(accessAllowlist.userId, userId))
    .limit(1);
  if (!access) throw new Error(`beta access fixture is missing: ${userId}`);
  return access;
}

export function clientHello(
  hostId: string,
  options?: { lastAppliedDesiredVersion?: number | null },
): Extract<BridgeMessageV6, { type: "client_hello" }> {
  const message: Extract<BridgeMessageV6, { type: "client_hello" }> = {
    type: "client_hello",
    protocol_version: 6,
    host_id: hostId,
    agent_version: "test-agent",
    role: "agent",
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256:
        "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
      boot_cpu_millis: 2_000,
      boot_cpu_lease_ms: 45_000,
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v2: true,
      supports_boot_cpu_lease: true,
      supports_template_backed_launch: true,
      fast_template_store: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
    },
  };
  if (options && "lastAppliedDesiredVersion" in options) {
    message.last_applied_desired_version =
      options.lastAppliedDesiredVersion ?? null;
  }
  return message;
}

export function sendBridge(ws: WebSocket, message: BridgeMessageV6): void {
  ws.send(JSON.stringify(message));
}

export async function waitForBridgeMessage(
  messages: BridgeMessageV6[],
  predicate: (message: BridgeMessageV6) => boolean,
  timeoutMs = 1_000,
): Promise<BridgeMessageV6> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const match = messages.find(predicate);
    if (match) {
      return match;
    }
    await sleep(10);
  }
  throw new Error(
    `timed out waiting for bridge message; got ${JSON.stringify(messages)}`,
  );
}

export async function runNextScheduledAlarm(
  stub: DurableObjectStub,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await runDurableObjectAlarm(stub)) {
      return;
    }
    await sleep(10);
  }
  throw new Error("timed out waiting for Durable Object alarm");
}

export async function waitForMessageCount(
  messages: BridgeMessageV6[],
  predicate: (message: BridgeMessageV6) => boolean,
  expected: number,
  timeoutMs = 1_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const count = messages.filter(predicate).length;
    if (count >= expected) {
      return count;
    }
    await sleep(10);
  }
  throw new Error(
    `timed out waiting for ${expected} bridge messages; got ${JSON.stringify(messages)}`,
  );
}

export async function waitForRunState(
  db: ReturnType<typeof drizzle>,
  runId: string,
  predicate: (state: RunStateDocument) => boolean,
  timeoutMs = 1_000,
): Promise<RunStateDocument> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const [row] = await db
      .select({ stateJson: scenarioRuns.stateJson })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, runId));
    if (row) {
      const state = JSON.parse(row.stateJson) as RunStateDocument;
      if (predicate(state)) {
        return state;
      }
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for run state ${runId}`);
}

export async function waitForHostActualState(
  db: ReturnType<typeof drizzle>,
  hostId: string,
  predicate: (row: typeof hostActualState.$inferSelect) => boolean,
  timeoutMs = 1_000,
): Promise<typeof hostActualState.$inferSelect> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const [row] = await db
      .select()
      .from(hostActualState)
      .where(eq(hostActualState.hostId, hostId));
    if (row && predicate(row)) {
      return row;
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for actual state ${hostId}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function seedRun(input: {
  db: ReturnType<typeof drizzle>;
  hostId: string;
  runId: string;
  runtimeVmName?: string;
  now: number;
  vms?: Array<{
    id: string;
    ordinal?: number;
    scenarioVmId: string;
    scenarioVmName: string;
    runtimeVmName: string;
    hostname: string;
  }>;
}): Promise<void> {
  const vms = input.vms ?? [
    {
      id: "vm-1",
      ordinal: 0,
      scenarioVmId: "scenario-vm-web",
      scenarioVmName: "webserver",
      runtimeVmName: input.runtimeVmName ?? "runtime-web",
      hostname: "webserver",
    },
  ];
  const initial = buildInitialRunState({
    vms: vms.map((vm, index) => ({
      id: vm.id,
      ordinal: vm.ordinal ?? index,
      scenarioVmId: vm.scenarioVmId,
      scenarioVmName: vm.scenarioVmName,
      runtimeVmName: vm.runtimeVmName,
      hostname: vm.hostname,
      launchSummary: {
        scenarioVmName: vm.scenarioVmName,
        hostname: vm.hostname,
        probePhaseMap: {},
        probeDescriptors: [],
      },
    })),
  });
  const state = recomputeRunState({
    ...initial,
    vms: initial.vms.map((vm) => ({
      ...vm,
      phase: "booting",
      provisioning: {
        image: `broken-nginx-${vm.scenarioVmName}-x86_64`,
        imageKey: testImageKey,
        imageSha256: "2".repeat(64),
        resources: {
          cpuMillis: 1_000,
          vcpuCount: 1,
          memoryMib: 512,
          diskMib: 4096,
        },
        leaseDurationSeconds: 1,
        groupName: null,
        groupId: null,
        setupKeyId: null,
        status: "queued",
        error: null,
      },
    })),
  });

  await input.db.insert(scenarioRuns).values({
    runId: input.runId,
    userId: "user-1",
    hostId: input.hostId,
    scenarioId: "broken-nginx",
    scenarioName: "broken-nginx",
    title: "Broken Nginx",
    tagline: "",
    briefingMarkdown: "",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    vmCount: vms.length,
    state: state.phase,
    stateRank: RUN_PHASE_ORDER[state.phase],
    activeKey: "user-1",
    stateJson: JSON.stringify(state),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export async function seedEnabledScenario(
  db: ReturnType<typeof drizzle>,
  now: number,
): Promise<void> {
  await db.insert(vmScenarios).values({
    scenarioId: "broken-nginx",
    title: "Broken Nginx",
    description: "Repair nginx.",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    briefingMarkdown: "Repair nginx.",
    solutionMarkdown: "Start nginx.",
    hintsJson: [],
    enabled: true,
    enabledAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(vmScenarioVms).values({
    id: "scenario-vm-web",
    scenarioId: "broken-nginx",
    ordinal: 0,
    vmName: "webserver",
    image: "debian-13-generic",
    imageKeyJson: testImageKey,
    imageSha256: "2".repeat(64),
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 1_073_741_824,
    kernelSha256: "a".repeat(64),
    initrdSha256: "b".repeat(64),
    bootCmdline: "root=/dev/vda rw",
    cpuMillis: 125,
    vcpuCount: 1,
    memoryMib: 512,
    diskMib: 4096,
  });
}

export function stateReport(
  hostId: string,
  input: {
    observedAt: number;
    appliedDesiredVersion: number;
    cachedImages?: HostStateReportV2["cached_images"];
    vms?: HostStateReportV2["vms"];
    schedulableCpuMillis?: number;
  },
): BridgeMessageV6 {
  return {
    type: "state_report",
    protocol_version: 6,
    host_id: hostId,
    report: {
      schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
      host_id: hostId,
      observed_at_unix_ms: input.observedAt,
      applied_desired_version: input.appliedDesiredVersion,
      capacity: {
        total_cpu_millis: (input.schedulableCpuMillis ?? 4_000) + 1_000,
        reserved_cpu_millis: 1_000,
        schedulable_cpu_millis: input.schedulableCpuMillis ?? 4_000,
        committed_cpu_millis: 0,
        memory_total_mib: 8192,
        memory_available_mib: 4096,
        disk_probe_path: "/var/lib/intar-agent",
        disk_total_mib: 100_000,
        disk_available_mib: 80_000,
      },
      capabilities: {
        arch: "x86_64",
        cloud_hypervisor_sha256:
          "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
        boot_cpu_millis: 2_000,
        boot_cpu_lease_ms: 45_000,
        supports_kvm: true,
        supports_vsock: true,
        supports_reflink: true,
        supports_nftables: true,
        supports_jailer_v2: true,
        supports_boot_cpu_lease: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_hard_cpu_quota: true,
        supports_landlock: true,
        supports_cgroup_v2: true,
      },
      cached_images: input.cachedImages ?? [],
      vms: input.vms ?? [],
      builds: [],
    },
  };
}

export function actualVm(
  runId: string,
  vmName: string,
  observedAt: number,
): VmActualStateV2 {
  return {
    run_id: runId,
    vm_name: vmName,
    phase: "running",
    terminal: {
      state: "pending",
      observed_at_unix_ms: observedAt,
    },
    runtime_constraints: {
      generation: `generation-${vmName}`,
      phase: "steady",
      steady_cpu_millis: 1_000,
      effective_cpu_millis: 1_000,
      quota_verified_at_unix_ms: observedAt,
    },
    ssh_host_keys_openssh: [],
    probes: [],
    updated_at_unix_ms: observedAt,
  };
}

export function vmReport(
  hostId: string,
  runId: string,
  vmName: string,
  phase: VmPhase,
  observedAt: number,
  sshHostPort: number,
  guestIp: string,
): BridgeMessageV6 {
  const terminalReady = phase === "ready" || phase === "solved";
  const terminalFailed = phase === "failed";
  return {
    type: "vm_report",
    protocol_version: 6,
    host_id: hostId,
    report: {
      schema_version: 3,
      host_id: hostId,
      run_id: runId,
      vm_name: vmName,
      desired_version: 1,
      observed_at_unix_ms: observedAt,
      phase,
      network: {
        bridge_name: "intar-run-test",
        guest_ip: guestIp,
        guest_cidr: `${guestIp}/28`,
        gateway: "10.77.0.1",
        ssh_host: "203.0.113.9",
        ssh_host_port: sshHostPort,
      },
      terminal: {
        state: terminalReady ? "ready" : terminalFailed ? "failed" : "pending",
        ...(terminalReady
          ? {
              target: {
                host: "203.0.113.9",
                port: sshHostPort,
                username: "ubuntu",
                checked_at_unix_ms: observedAt,
              },
            }
          : {}),
        observed_at_unix_ms: observedAt,
      },
      runtime_constraints: {
        generation: `generation-${vmName}`,
        phase: terminalReady ? "steady" : "boot_burst",
        steady_cpu_millis: 1_000,
        effective_cpu_millis: terminalReady ? 1_000 : 2_000,
        ...(terminalReady
          ? { quota_verified_at_unix_ms: observedAt - 1 }
          : { lease_expires_at_unix_ms: observedAt + 45_000 }),
      },
      ssh_host_keys_openssh: [
        `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${vmName} host-key`,
      ],
      probes: [],
      archive: {
        phase: "none",
        artifact_count: 0,
      },
    } satisfies VmReportV2,
  };
}
