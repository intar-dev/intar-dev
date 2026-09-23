/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { expect, vi } from "vitest";
import {
  agentHosts,
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  courseCatalogs,
  scenarioRuns,
  runtimeVms,
  user,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import { ensureFixtureMember } from "@/test/account-fixtures";
import type {
  BridgeMessageV8,
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
  drizzleQueryToD1Statement,
  executeScenarioRunRuntimeProjection,
} from "@/lib/runtime-executions";
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
  courseCatalogs,
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
  BridgeMessageV8,
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

export const testGuestTools = {
  tools_disk_sha256: "1".repeat(64),
  tools_disk_size_bytes: 64 * 1024 * 1024,
  kino_sha256: "2".repeat(64),
  bootstrap_abi: 2,
} as const;

export function desiredRunningVm(
  runId: string,
  vmName: string,
  now: number,
): DesiredVmV2 {
  return { owner_user_id: "user-1", runtime_execution_id: runId, generation: 1, vm_id: "vm-1",
    run_id: runId,
    vm_name: vmName,
    desired_phase: "running",
    image_key: testImageKey,
    image_id: "2".repeat(64),
    guest_tools: testGuestTools,
    resources: {
      cpu_millis: 1_000,
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
      metalPlacement: "personal",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .onConflictDoNothing();
  await ensureFixtureMember({
    d1: env.DB,
    userId: "user-1",
    githubAccountId: "host-runtime-github-user-1",
    now,
  });
  await db.insert(agentHosts).values({
    id: hostId,
    userId: "user-1",
    name: hostId,
    scope: "personal",
    credentialGeneration: 1,
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
  messages: BridgeMessageV8[];
  stub: DurableObjectStub;
  ws: WebSocket;
}> {
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
  const admission = await env.DB.prepare(
    `SELECT host.scope, host.organization_id, host.credential_generation
     FROM agent_hosts host
     WHERE host.id = ?1`,
  )
    .bind(hostId)
    .first<{
      scope: "personal" | "platform" | "organization";
      organization_id: string | null;
      credential_generation: number;
    }>();
  if (!admission) throw new Error(`host fixture is missing: ${hostId}`);
  const headers = new Headers({
    upgrade: "websocket",
    "x-agent-host-id": hostId,
    "x-agent-credential-generation": String(admission.credential_generation),
  });
  if (admission.scope === "organization") headers.set("x-agent-organization-id", admission.organization_id!);
  const response = await stub.fetch("http://host-runtime/connect", {
    headers,
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  expect(ws).not.toBeNull();
  if (!ws) {
    throw new Error("missing websocket");
  }
  const messages: BridgeMessageV8[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      messages.push(JSON.parse(event.data) as BridgeMessageV8);
    }
  });
  ws.send(JSON.stringify(clientHello(hostId, options)));
  return { messages, stub, ws };
}

export function clientHello(
  hostId: string,
  options?: { lastAppliedDesiredVersion?: number | null },
): Extract<BridgeMessageV8, { type: "client_hello" }> {
  const message: Extract<BridgeMessageV8, { type: "client_hello" }> = {
    type: "client_hello",
    protocol_version: 8,
    host_id: hostId,
    agent_version: "test-agent",
    role: "agent",
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256:
        "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v2: true,
      supports_jailer_v3: true,
      supports_raw_chunks_v1: true,
      supports_scenario_guest_tools_v1: true,
      supports_template_backed_launch: true,
      fast_template_store: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
      supports_run_cli_v1: true,
      supports_run_cli_completion_v1: true,
    },
  };
  if (options && "lastAppliedDesiredVersion" in options) {
    message.last_applied_desired_version =
      options.lastAppliedDesiredVersion ?? null;
  }
  return message;
}

export function sendBridge(ws: WebSocket, message: BridgeMessageV8): void {
  ws.send(JSON.stringify(message));
}

export async function waitForBridgeMessage(
  messages: BridgeMessageV8[],
  predicate: (message: BridgeMessageV8) => boolean,
  timeoutMs = 1_000,
): Promise<BridgeMessageV8> {
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
    const scheduled = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    if (scheduled !== null) {
      // The test API fires early. Observe the scheduled time so the DO can
      // distinguish socket expiry from runtime maintenance on its shared alarm.
      const clock = vi.spyOn(Date, "now").mockReturnValue(Math.max(Date.now(), scheduled));
      try {
        if (await runDurableObjectAlarm(stub)) return;
      } finally {
        clock.mockRestore();
      }
    }
    await sleep(10);
  }
  throw new Error("timed out waiting for Durable Object alarm");
}

export async function waitForMessageCount(
  messages: BridgeMessageV8[],
  predicate: (message: BridgeMessageV8) => boolean,
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
  seedRuntimeVms?: boolean;
  vms?: Array<{
    id: string;
    ordinal?: number;
    scenarioVmId: string;
    scenarioVmName: string;
    runtimeVmName: string;
    hostname: string;
  }>;
}): Promise<void> {
  await seedEnabledScenario(input.db, input.now);
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

  const mutation = input.db.insert(scenarioRuns).values({
    runId: input.runId,
    userId: "user-1",
    hostId: input.hostId,
    scenarioId: "broken-nginx",
    courseScopeKey: "public",
    courseId: "linux-operations",
    lectureId: "01-broken-nginx",
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
  await executeScenarioRunRuntimeProjection({
    d1: env.DB,
    runId: input.runId,
    statements: [drizzleQueryToD1Statement(env.DB, mutation)],
    mode: "create",
  });
  if (input.seedRuntimeVms !== false) {
    await input.db.insert(runtimeVms).values(vms.map((vm, index) => ({
      id: `${input.runId}:${vm.id}`, executionId: input.runId, vmId: vm.id,
      ordinal: vm.ordinal ?? index, runtimeVmName: vm.runtimeVmName,
      imageKeyJson: testImageKey, imageSha256: "2".repeat(64),
      cpuMillis: 1_000, memoryMib: 512, diskMib: 4_096,
      createdAt: input.now, updatedAt: input.now,
    })));
  }
}

export async function seedEnabledScenario(
  db: ReturnType<typeof drizzle>,
  now: number,
): Promise<void> {
  await db
    .insert(courseCatalogs)
    .values({
      scopeKey: "public",
      organizationId: null,
      catalogJson: {
        version: 2,
        courses: [
          {
            courseId: "linux-operations",
            title: "Linux operations",
            summary: "Repair common Linux service failures.",
            bodyMarkdown: "Learn the service model before the repair.",
            sequential: true,
            lectures: [
              {
                lectureId: "01-broken-nginx",
                title: "Broken Nginx",
                summary: "Diagnose and repair the web server.",
                bodyMarkdown: "Learn how systemd and Nginx sites work.",
                category: "web",
                tags: ["nginx"],
                difficulty: "easy",
                estimatedMinutes: 1,
                scenarioId: "broken-nginx",
              },
            ],
          },
        ],
      },
      sourceRevision: "fixture",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
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
  }).onConflictDoNothing();
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
    memoryMib: 512,
    diskMib: 4096,
  }).onConflictDoNothing();
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
): BridgeMessageV8 {
  return {
    type: "state_report",
    protocol_version: 8,
    host_id: hostId,
    report: { relay_connected: true,
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
        supports_kvm: true,
        supports_vsock: true,
        supports_reflink: true,
        supports_nftables: true,
        supports_jailer_v2: true,
        supports_jailer_v3: true,
        supports_raw_chunks_v1: true,
        supports_scenario_guest_tools_v1: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_hard_cpu_quota: true,
        supports_landlock: true,
        supports_cgroup_v2: true,
        supports_run_cli_v1: true,
        supports_run_cli_completion_v1: true,
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
  return { owner_user_id: "user-1", runtime_execution_id: runId, generation: 1,
    run_id: runId,
    vm_name: vmName,
    phase: "running",
    terminal: {
      state: "pending",
      observed_at_unix_ms: observedAt,
    },
    runtime_constraints: {
      generation: `generation-${vmName}`,
      cpu_millis: 1_000,
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
): BridgeMessageV8 {
  const terminalReady = phase === "ready" || phase === "solved";
  const terminalFailed = phase === "failed";
  return {
    type: "vm_report",
    protocol_version: 8,
    host_id: hostId,
    report: { owner_user_id: "user-1", runtime_execution_id: runId, generation: 1,
      schema_version: 6,
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
        cpu_millis: 1_000,
        ...(terminalReady
          ? { quota_verified_at_unix_ms: observedAt - 1 }
          : {}),
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
