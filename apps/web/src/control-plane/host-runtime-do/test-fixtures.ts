/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { expect, vi } from "vitest";
import {
  agentHosts,
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  courseCatalogs,
  scenarioRuns,
  runtimeVms,
  scenarios,
  user,
} from "@/db/schema";
import { ensureFixtureMember } from "@/test/account-fixtures";
import type {
  BridgeMessageV9,
  CachedImageStateV2,
  DesiredVmV3,
  HostDesiredStateV3,
  HostStateReportV3,
  VmPhaseV2,
  VmStateV3,
} from "@/generated/contracts/bridge-message-v9";
import {
  HOST_DESIRED_STATE_SCHEMA_VERSION_V3,
  mutateHostDesiredStateV3,
} from "@/lib/desired-state-store";
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
import { revisionVmId } from "@/lib/run-lifecycle";
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
  HOST_DESIRED_STATE_SCHEMA_VERSION_V3,
  mutateHostDesiredStateV3,
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
};
export type {
  BridgeMessageV9,
  CachedImageStateV2,
  DesiredVmV3,
  HostStateReportV3,
  VmPhaseV2,
  VmStateV3,
  RunStateDocument,
};

export async function resetHostRuntimeTestDatabase(): Promise<void> {
  await resetD1Database();
}

/** The scenario a seeded run starts. */
export const testScenarioId = "intar/broken-nginx";

/** Seeds an enabled scenario row with a live revision name, as content access reads it. */
export async function seedScenarioRow(
  db: DrizzleD1Database<Record<string, unknown>>,
  scenarioId: string,
  organizationId: string | null = null,
): Promise<void> {
  const [namespace, slug] = scenarioId.split("/") as [string, string];
  await db.insert(scenarios).values({
    id: scenarioId,
    namespace,
    slug,
    organizationId,
    scopeKey: organizationId ? `organization:${organizationId}` : "public",
    enabled: true,
    play: false,
    liveRev: "r1",
  }).onConflictDoNothing();
}

/** The run-state image key a seeded run records. */
export const testImageKey = {
  scenario: "broken-nginx",
  vm: "webserver",
  arch: "x86_64",
} as const;

/** The machine image, spec and Kino digests a seeded VM runs. */
export const testImageDigest = `sha256:${"2".repeat(64)}`;
export const testSpecDigest = `sha256:${"3".repeat(64)}`;
/** The pin vitest.workers.config.ts binds as KINO_PINS_JSON for contract 3. */
export const testKinoDigest = "sha256:ba84da6c273cceb718a63a6374ceeebc4ad862fd4098e570ed71937fe01b4639";

export const testHardware = {
  cloud_hypervisor_sha256: "4".repeat(64),
  kvm: true,
  vsock: true,
  reflink: true,
  landlock: true,
  cgroup_v2: true,
  hard_cpu_quota: true,
};

export function desiredRunningVm(
  runId: string,
  vmName: string,
  now: number,
): DesiredVmV3 {
  return {
    owner_user_id: "user-1",
    runtime_execution_id: runId,
    generation: 1,
    vm_id: revisionVmId(vmName, runId),
    run_id: runId,
    name: vmName,
    desired_phase: "running",
    image: testImageDigest,
    spec: testSpecDigest,
    kino: testKinoDigest,
    mode: "learn",
    cpu_millis: 1_000,
    memory_mib: 512,
    disk_mib: 4_096,
    egress: false,
    terminal: true,
    peers: [],
    ssh_authorized_keys: [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunkey user@example",
    ],
    lease_expires_at_unix_ms: now + 60_000,
  };
}

/** An empty bridge 9 desired state at version 0. */
export function emptyDesiredState(input: {
  ownerUserId: string;
  scope: HostDesiredStateV3["scope"];
  hostId: string;
  nowUnixMs: number;
}): HostDesiredStateV3 {
  return {
    scope: input.scope,
    owner_user_id: input.ownerUserId,
    schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION_V3,
    host_id: input.hostId,
    version: 0,
    generated_at_unix_ms: input.nowUnixMs,
    cached_images: [],
    vms: [],
    builds: [],
    source_compiles: [],
  };
}

/** Applies `mutator` to the host's stored desired state and returns the result. */
export async function mutateDesiredState(
  db: DrizzleD1Database,
  hostId: string,
  now: number,
  mutator: (draft: HostDesiredStateV3) => void,
): Promise<HostDesiredStateV3> {
  return (await mutateHostDesiredStateV3(db, hostId, now, mutator)).state;
}

/** Puts `vm` into `draft`, replacing one of the same run and name. */
export function upsertDesiredVm(draft: HostDesiredStateV3, vm: DesiredVmV3): void {
  draft.vms = [...draft.vms.filter((entry) => entry.run_id !== vm.run_id || entry.name !== vm.name), vm];
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
  messages: BridgeMessageV9[];
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
    "intar-bridge-protocol": "9",
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
  const messages: BridgeMessageV9[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      messages.push(JSON.parse(event.data) as BridgeMessageV9);
    }
  });
  ws.send(JSON.stringify(clientHello(hostId, options)));
  return { messages, stub, ws };
}

export function clientHello(
  hostId: string,
  options?: { lastAppliedDesiredVersion?: number | null },
): Extract<BridgeMessageV9, { type: "client_hello" }> {
  const message: Extract<BridgeMessageV9, { type: "client_hello" }> = {
    type: "client_hello",
    protocol_version: 9,
    host_id: hostId,
    agent_version: "1.0.0",
    role: "agent",
    guest_contract: 3,
    hardware: { ...testHardware },
  };
  if (options && "lastAppliedDesiredVersion" in options) {
    message.last_applied_desired_version =
      options.lastAppliedDesiredVersion ?? null;
  }
  return message;
}

export function sendBridge(ws: WebSocket, message: BridgeMessageV9): void {
  ws.send(JSON.stringify(message));
}

export async function waitForBridgeMessage(
  messages: BridgeMessageV9[],
  predicate: (message: BridgeMessageV9) => boolean,
  timeoutMs = 1_000,
): Promise<BridgeMessageV9> {
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
  messages: BridgeMessageV9[],
  predicate: (message: BridgeMessageV9) => boolean,
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

/**
 * Waits until every host runtime object has seen the close of each socket a
 * test opened, so no close handler is still running when the next test resets
 * storage or the file ends.
 */
export async function settleHostRuntimeSockets(): Promise<void> {
  for (const id of await listDurableObjectIds(env.HOST_RUNTIME)) {
    const stub = env.HOST_RUNTIME.get(id);
    const deadline = Date.now() + 2_000;
    while (await runInDurableObject(stub, (_instance, state) => state.getWebSockets().length) > 0 && Date.now() < deadline) {
      await sleep(10);
    }
  }
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
      // A bridge 9 host names a VM by its machine name; the run keeps it with the run id.
      runtimeVmName: revisionVmId(input.runtimeVmName ?? "runtime-web", input.runId),
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
    scenarioId: testScenarioId,
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
      imageDigest: testImageDigest, specDigest: testSpecDigest, kinoDigest: testKinoDigest,
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
                scenarioId: testScenarioId,
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
  await seedScenarioRow(db, testScenarioId);
}

export function stateReport(
  hostId: string,
  input: {
    observedAt: number;
    appliedDesiredVersion: number;
    cachedImages?: CachedImageStateV2[];
    vms?: VmStateV3[];
    schedulableCpuMillis?: number;
  },
): Extract<BridgeMessageV9, { type: "state_report" }> {
  return {
    type: "state_report",
    protocol_version: 9,
    host_id: hostId,
    report: {
      relay_connected: true,
      schema_version: 8,
      host_id: hostId,
      observed_at_unix_ms: input.observedAt,
      applied_desired_version: input.appliedDesiredVersion,
      guest_contract: 3,
      hardware: { ...testHardware },
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
      cached_images: input.cachedImages ?? [],
      vms: input.vms ?? [],
    },
  };
}

export function actualVm(
  runId: string,
  vmName: string,
  observedAt: number,
): VmStateV3 {
  return {
    owner_user_id: "user-1",
    runtime_execution_id: runId,
    generation: 1,
    run_id: runId,
    name: vmName,
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
    updated_at_unix_ms: observedAt,
  };
}

export function vmReport(
  hostId: string,
  runId: string,
  vmName: string,
  phase: VmPhaseV2,
  observedAt: number,
  sshHostPort: number,
  guestIp: string,
): Extract<BridgeMessageV9, { type: "vm_report" }> {
  const terminalReady = phase === "ready";
  const terminalFailed = phase === "failed";
  return {
    type: "vm_report",
    protocol_version: 9,
    host_id: hostId,
    report: {
      schema_version: 7,
      host_id: hostId,
      observed_at_unix_ms: observedAt,
      vm: {
        owner_user_id: "user-1",
        runtime_execution_id: runId,
        generation: 1,
        desired_version: 1,
        run_id: runId,
        name: vmName,
        phase,
        updated_at_unix_ms: observedAt,
        network: {
          bridge_name: "intar-run-test",
          guest_ip: guestIp,
          guest_cidr: `${guestIp}/28`,
          gateway: "10.77.0.1",
          ssh_host: "203.0.113.9",
          ssh_host_port: sshHostPort,
        },
        terminal: terminalReady
          ? {
              state: "ready",
              observed_at_unix_ms: observedAt,
              target: { host: "203.0.113.9", port: sshHostPort, username: "user", checked_at_unix_ms: observedAt },
            }
          : { state: terminalFailed ? "failed" : "pending", observed_at_unix_ms: observedAt },
        runtime_constraints: {
          generation: `generation-${vmName}`,
          cpu_millis: 1_000,
          ...(terminalReady ? { quota_verified_at_unix_ms: observedAt - 1 } : {}),
        },
        ssh_host_keys_openssh: [`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${vmName} host-key`],
        archive: { phase: "none", artifact_count: 0 },
        ...(terminalReady
          ? { lab: { state: "ready" as const, kino_version: "run-test", ready: [], tasks: [], timings_ms: {} } }
          : {}),
      },
    },
  };
}
