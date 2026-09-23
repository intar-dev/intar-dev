/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { agentHosts, hostDesiredState, organization, user } from "@/db/schema";
import {
  admissionStatements,
  type AdmissionCommitInput,
} from "@/lib/scenario-runs/begin";
import {
  desiredVmFromRunVm,
  mutateDesiredState,
  upsertDesiredVm,
} from "@/lib/desired-state";
import { loadOrCreateHostDesiredState } from "@/lib/desired-state-store";
import { buildInitialVmState, type RunVmStateDocument } from "@/lib/run-state";
import {
  FIXTURE_ADMIN_ID,
  ensureFixtureMember,
  revokeFixtureAccount,
} from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { seedAdmissionGuardFixture } from "@/lib/scenario-runs/admission-test-fixtures";

/**
 * The account fence of the single admission batch. The old per-step API
 * (insertScenarioRunForAdmission, rollbackScenarioStartAfterFailure,
 * upsertRunVmsIntoDesiredState) is gone, so every refusal is proved against
 * the one transaction that now owns admission.
 */
describe("scenario start account fence", () => {
  beforeEach(resetD1Database);

  it("admits the control workload while its account and host placement are valid", async () => {
    const parts = await admissionInput();
    const results = await env.DB.batch(admissionStatements(parts).statements);
    expect(admissionWrites(results)).toBeGreaterThan(0);
    expect(await countRows("scenario_runs", "run_id")).toBe(1);
    expect(await countRows("runtime_executions", "id")).toBe(1);
  });

  it("cannot insert a run or SSH capability after revocation, including on a platform host", async () => {
    const parts = await admissionInput();
    await revokeFixtureAccount({ d1: env.DB, userId: "scenario-user" });

    // The statement batch writes nothing: every admission statement selects
    // through the owner's active account or the run it gates, so a revoked
    // account leaves the whole batch at zero rows. The refusal itself is
    // raised by the entry point (beginScenarioRun returns 403 access_revoked),
    // which the admission suite covers against the same fixture.
    const results = await env.DB.batch(admissionStatements(parts).statements);
    expect(admissionWrites(results)).toBe(0);

    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM scenario_runs WHERE run_id = 'admission-run'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM scenario_run_ssh_keys WHERE run_id = 'admission-run'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM runtime_executions WHERE id = 'admission-run'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM host_cpu_reservations WHERE run_id = 'admission-run'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM host_resource_reservations WHERE execution_id = 'admission-run'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare(
        "SELECT disabled FROM agent_hosts WHERE id = 'platform-host'",
      ).first(),
    ).resolves.toEqual({ disabled: 0 });
  });

  it("admits nothing when the run insert is refused but the account is active", async () => {
    const parts = await admissionInput();
    // Another writer publishes the host desired state after this request read
    // its version. The compare-and-set can no longer land, so the abort
    // sentinel rolls the whole admission back even though the account is
    // still active.
    await drizzle(env.DB)
      .update(hostDesiredState)
      .set({ version: parts.desired.expectedVersion + 1 })
      .where(eq(hostDesiredState.hostId, "platform-host"));
    const stale: AdmissionCommitInput = parts;

    await expect(
      env.DB.batch(admissionStatements(stale).statements),
    ).rejects.toThrow(/runtime_executions_generation_positive|CHECK/i);

    await expect(countRows("scenario_runs", "run_id")).resolves.toBe(0);
    await expect(countRows("scenario_run_ssh_keys", "run_id")).resolves.toBe(0);
    await expect(countRows("runtime_executions", "id")).resolves.toBe(0);
    await expect(countRows("host_cpu_reservations", "run_id")).resolves.toBe(0);
    await expect(
      countRows("host_resource_reservations", "execution_id"),
    ).resolves.toBe(0);
    await expect(
      drizzle(env.DB)
        .select({ version: hostDesiredState.version })
        .from(hostDesiredState)
        .where(eq(hostDesiredState.hostId, "platform-host")),
    ).resolves.toEqual([{ version: parts.desired.expectedVersion + 1 }]);
  });

  it("never dispatches desired VMs for an admission whose account was revoked in the commit window", async () => {
    const parts = await admissionInput();
    await revokeFixtureAccount({ d1: env.DB, userId: "scenario-user" });

    const results = await env.DB.batch(admissionStatements(parts).statements);
    expect(admissionWrites(results)).toBe(0);
    await expect(
      drizzle(env.DB)
        .select({ version: hostDesiredState.version })
        .from(hostDesiredState)
        .where(eq(hostDesiredState.hostId, "platform-host")),
    ).resolves.toEqual([{ version: parts.desired.expectedVersion }]);
  });
});

async function countRows(table: string, column: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM " + table + " WHERE " + column + " = 'admission-run'",
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

/** Total rows written by an admission batch. */
function admissionWrites(results: D1Result<unknown>[]): number {
  return results.reduce(
    (total, result) => total + (result.meta.changes ?? 0),
    0,
  );
}

async function admissionInput(): Promise<AdmissionCommitInput> {
  const db = drizzle(env.DB);
  const now = 10_000;
  await db.insert(user).values({
    id: "scenario-user",
    name: "Scenario User",
    email: "scenario-user@example.test",
    emailVerified: true,
    username: "scenario-user",
    role: "user",
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await ensureFixtureMember({
    d1: env.DB,
    userId: "scenario-user",
    githubAccountId: "scenario-user-github",
    now,
  });
  await db.insert(organization).values({
    id: "scenario-organization",
    name: "Scenario Organization",
    slug: "scenario-organization",
    createdAt: new Date(now),
  });
  await db.insert(agentHosts).values({
    scope: "platform",
    credentialGeneration: 1,
    id: "platform-host",
    userId: FIXTURE_ADMIN_ID,
    name: "Platform host",
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
    connected: true,
    createdAt: now,
    updatedAt: now,
  });
  const readiness = await seedAdmissionGuardFixture({
    userId: "scenario-user", organizationId: "scenario-organization", hostId: "platform-host",
  });
  const vmState = scenarioVm("admission-run");
  const current = await loadOrCreateHostDesiredState(
    db,
    "platform-host",
    now,
  );
  const desiredVm = desiredVmFromRunVm({ ownerUserId: "scenario-user", runtimeExecutionId: "admission-run", generation: 1,
    runId: "admission-run",
    vm: vmState,
    nowUnixMs: now,
    sshAuthorizedKeysOpenssh: ["ssh-ed25519 AAAAC3Nza admission"],
    guestTools,
  });
  if (!desiredVm) throw new Error("desired vm");
  const next = mutateDesiredState(
    current,
    (draft) => {
      upsertDesiredVm(draft, desiredVm);
    },
    { nowUnixMs: now },
  );
  return {
    run: {
      runId: "admission-run",
      userId: "scenario-user",
      organizationId: "scenario-organization",
      runtimeExecutionId: "admission-run",
      hostId: "platform-host",
      scenarioId: "scenario-one",
      scenarioName: "scenario-one",
      courseScopeKey: "organization:scenario-organization",
      courseId: "linux-operations",
      lectureId: "01-repair-nginx",
      title: "Scenario one",
      tagline: "A scenario",
      briefingMarkdown: "Briefing",
      objectivesJson: "[]",
      difficulty: "beginner",
      estimatedMinutes: 30,
      tagsJson: [],
      hintsJson: [],
      solutionMarkdown: "Solution",
      revealedHintsJson: [],
      solutionAssisted: false,
      vmCount: 1,
      state: "provisioning",
      stateRank: 1,
      activeKey: "scenario-user",
      requestIdempotencyKey: "key-abcdefgh",
      requestScopeJson: {
        scenarioId: "scenario-one",
        organizationId: "scenario-organization",
        hostId: null,
        candidateRevision: null,
        candidateBuildId: null,
        allowDrainedAdminProof: false,
        allowSequenceBypass: false,
      },
      stateJson: JSON.stringify({ vms: [{ runtimeVmName: "admission-run-vm" }] }),
      createdAt: now,
      updatedAt: now,
    },
    sshKeyRows: [
      {
        id: "admission-run-ssh-key",
        runId: "admission-run",
        vmId: "admission-run-vm",
        runtimeVmName: "admission-run-vm",
        publicKeyOpenssh: "ssh-ed25519 AAAAC3Nza admission",
        privateKeyCiphertextB64: "ciphertext",
        privateKeyIvB64: "iv",
        createdAt: now,
      },
    ],
    runtimeVms: [
      {
        vmId: "admission-run-vm",
        ordinal: 0,
        runtimeVmName: "admission-run-vm",
        imageKey: { scenario: "scenario-one", vm: "web", arch: "x86_64" },
        imageSha256: "2".repeat(64),
        cpuMillis: 1_000,
        memoryMib: 512,
        diskMib: 4_096,
        runtimeVmId: "admission-run-runtime-vm",
      },
    ],
    accessKeys: [{ ciphertextB64: "ciphertext", ivB64: "iv" }],
    desiredVms: [desiredVm],
    desired: {
      hostId: "platform-host",
      readiness,
      expectedVersion: current.version,
      nextVersion: next.version,
      nextDocJson: JSON.stringify(next),
    },
    cpuMillis: 1_000,
    reservationResources: {
      cpuMillis: 2_000,
      memoryMib: 512,
      worstCaseDiskMib: 4_096,
    },
    leaseExpiresAt: now + 3_600_000,
    now,
  } satisfies AdmissionCommitInput;
}

/** The guest bootstrap ABI the release set ships. ABI 1 is refused. */
const guestTools = {
  tools_disk_sha256: "a".repeat(64),
  tools_disk_size_bytes: 64 * 1024 * 1024,
  kino_sha256: "b".repeat(64),
  bootstrap_abi: 2,
} as const;

function scenarioVm(runId: string): RunVmStateDocument {
  const vm = buildInitialVmState({
    id: `${runId}-vm`,
    ordinal: 0,
    scenarioVmId: "web",
    scenarioVmName: "Web",
    runtimeVmName: `${runId}-vm`,
    hostname: "web",
    launchSummary: {
      scenarioVmName: "Web",
      hostname: "web",
      probePhaseMap: {},
      probeDescriptors: [],
    },
  });
  return {
    ...vm,
    provisioning: {
      ...vm.provisioning,
      image: "ghcr.io/intar/scenario@sha256:fixture",
      imageKey: { scenario: "scenario-one", vm: "web", arch: "x86_64" },
      imageSha256: "2".repeat(64),
      resources: {
        cpuMillis: 1_000,
        memoryMib: 512,
        diskMib: 4_096,
      },
      leaseDurationSeconds: 3_600,
      status: "queued",
    },
  };
}
