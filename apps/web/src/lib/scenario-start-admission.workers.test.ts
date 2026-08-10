/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import {
  accessAllowlist,
  agentHosts,
  hostDesiredState,
  organization,
  runtimeExecutions,
  scenarioRunSshKeys,
  scenarioRuns,
  user,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import { revokeBetaUser } from "@/lib/access-invites";
import { buildInitialVmState, type RunVmStateDocument } from "@/lib/run-state";
import {
  insertScenarioRunForAdmission,
  rollbackScenarioStartAfterFailure,
  upsertRunVmsIntoDesiredState,
} from "@/lib/scenario-runs/start";
import {
  FIXTURE_BETA_ADMIN_ID,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

describe("scenario start beta-admission fence", () => {
  beforeEach(resetD1Database);

  it("cannot insert a run or SSH capability after revocation, including on an organization runner", async () => {
    const admission = await seedScenarioStartFixture();
    await revokeBetaUser({
      d1: env.DB,
      userId: "scenario-user",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "scenario_start_race",
      now: 20_000,
    });

    await expect(
      insertScenarioRunForAdmission({
        row: scenarioRunRow("stale-run"),
        sshKeyRows: [scenarioSshKeyRow("stale-run")],
        betaAdmission: admission,
      }),
    ).rejects.toMatchObject({ code: "beta_access_revoked" });

    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM scenario_runs WHERE run_id = 'stale-run'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM scenario_run_ssh_keys WHERE run_id = 'stale-run'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare(
        "SELECT disabled FROM agent_hosts WHERE id = 'organization-runner'",
      ).first(),
    ).resolves.toEqual({ disabled: 0 });
  });

  it("cannot dispatch desired VM state after the admission is blocked", async () => {
    const admission = await seedScenarioStartFixture();
    await insertScenarioRunForAdmission({
      row: scenarioRunRow("allocated-run"),
      sshKeyRows: [scenarioSshKeyRow("allocated-run")],
      betaAdmission: admission,
    });
    await revokeBetaUser({
      d1: env.DB,
      userId: "scenario-user",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "scenario_dispatch_race",
      now: 30_000,
    });

    const vm = scenarioVm("allocated-run");
    await expect(
      upsertRunVmsIntoDesiredState({
        hostId: "organization-runner",
        runId: "allocated-run",
        userId: "scenario-user",
        betaAdmission: admission,
        vms: [vm],
        nowUnixMs: 30_001,
        sshAuthorizedKeysByVmId: new Map([
          [vm.id, ["ssh-ed25519 AAAAC3Nza stale-start"]],
        ]),
      }),
    ).rejects.toMatchObject({ code: "beta_access_revoked" });

    const desired = await drizzle(env.DB)
      .select({ doc: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "organization-runner"))
      .limit(1);
    expect(JSON.stringify(desired[0]?.doc ?? {})).not.toContain("allocated-run");
  });

  it("does not attach SSH keys to a colliding run when the conditional insert loses admission", async () => {
    const admission = await seedScenarioStartFixture();
    await insertScenarioRunForAdmission({
      row: scenarioRunRow("colliding-run"),
      sshKeyRows: [scenarioSshKeyRow("colliding-run")],
      betaAdmission: admission,
    });
    await revokeBetaUser({
      d1: env.DB,
      userId: "scenario-user",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "scenario_key_batch_race",
      now: 40_000,
    });

    await expect(
      insertScenarioRunForAdmission({
        row: scenarioRunRow("colliding-run"),
        sshKeyRows: [scenarioSshKeyRow("colliding-run", "-stale")],
        betaAdmission: admission,
      }),
    ).rejects.toMatchObject({ code: "beta_access_revoked" });

    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM scenario_run_ssh_keys WHERE run_id = 'colliding-run'",
      ).first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("preserves the run and runtime when desired-state rollback fails", async () => {
    const admission = await seedScenarioStartFixture();
    const db = drizzle(env.DB);
    await db.insert(runtimeExecutions).values({
      id: "rollback-run",
      userId: "scenario-user",
      organizationId: "scenario-organization",
      hostId: "organization-runner",
      providerKind: "agent_kvm",
      providerConnectionId: null,
      domainKind: "scenario",
      domainId: "rollback-run",
      generation: 1,
      sourceExecutionId: null,
      checkpointId: null,
      state: "provisioning",
      leaseExpiresAt: null,
      archiveRequestedAt: null,
      endedAt: null,
      createdAt: 50_000,
      updatedAt: 50_000,
    });
    await insertScenarioRunForAdmission({
      row: scenarioRunRow("rollback-run", "rollback-run"),
      sshKeyRows: [scenarioSshKeyRow("rollback-run")],
      betaAdmission: admission,
    });

    await expect(
      rollbackScenarioStartAfterFailure(
        {
          hostId: "organization-runner",
          runId: "rollback-run",
          userId: "scenario-user",
          betaAdmission: admission,
          vms: [scenarioVm("rollback-run")],
          runInserted: true,
          runtimeCreated: true,
        },
        {
          markVmsAbsent: async () => {
            throw new Error("injected desired-state failure");
          },
        },
      ),
    ).resolves.toEqual({ durableStatePreserved: true });

    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM scenario_runs WHERE run_id = 'rollback-run'",
      ).first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM runtime_executions WHERE id = 'rollback-run'",
      ).first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("preserves a snapshotted run after revocation even when desired-state rollback succeeds", async () => {
    const admission = await seedScenarioStartFixture();
    const db = drizzle(env.DB);
    await db.insert(runtimeExecutions).values({
      id: "revoked-rollback-run",
      userId: "scenario-user",
      organizationId: "scenario-organization",
      hostId: "organization-runner",
      providerKind: "agent_kvm",
      providerConnectionId: null,
      domainKind: "scenario",
      domainId: "revoked-rollback-run",
      generation: 1,
      sourceExecutionId: null,
      checkpointId: null,
      state: "provisioning",
      leaseExpiresAt: null,
      archiveRequestedAt: null,
      endedAt: null,
      createdAt: 60_000,
      updatedAt: 60_000,
    });
    await insertScenarioRunForAdmission({
      row: scenarioRunRow("revoked-rollback-run", "revoked-rollback-run"),
      sshKeyRows: [scenarioSshKeyRow("revoked-rollback-run")],
      betaAdmission: admission,
    });
    await revokeBetaUser({
      d1: env.DB,
      userId: "scenario-user",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "scenario_snapshot_race",
      now: 60_001,
    });

    await expect(
      rollbackScenarioStartAfterFailure(
        {
          hostId: "organization-runner",
          runId: "revoked-rollback-run",
          userId: "scenario-user",
          betaAdmission: admission,
          vms: [scenarioVm("revoked-rollback-run")],
          runInserted: true,
          runtimeCreated: true,
        },
        {
          markVmsAbsent: async () => undefined,
          rollbackCpu: async () => undefined,
        },
      ),
    ).resolves.toEqual({ durableStatePreserved: true });

    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM scenario_runs WHERE run_id = 'revoked-rollback-run'",
      ).first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM runtime_executions WHERE id = 'revoked-rollback-run'",
      ).first(),
    ).resolves.toEqual({ count: 1 });
  });
});

async function seedScenarioStartFixture(): Promise<BetaAdmissionEpoch> {
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
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId: "scenario-user",
    githubAccountId: "scenario-user-github",
    githubUsername: "scenario-user",
    now,
  });
  await db.insert(organization).values({
    id: "scenario-organization",
    name: "Scenario Organization",
    slug: "scenario-organization",
    createdAt: new Date(now),
  });
  await db.insert(agentHosts).values({
    id: "organization-runner",
    userId: FIXTURE_BETA_ADMIN_ID,
    organizationId: "scenario-organization",
    name: "Organization runner",
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
    connected: true,
    createdAt: now,
    updatedAt: now,
  });
  const [access] = await db
    .select({
      sourceInviteId: accessAllowlist.sourceInviteId,
      sourceLeaseId: accessAllowlist.sourceLeaseId,
      grantedAt: accessAllowlist.grantedAt,
    })
    .from(accessAllowlist)
    .where(eq(accessAllowlist.userId, "scenario-user"))
    .limit(1);
  if (!access) throw new Error("fixture admission missing");
  return access;
}

function scenarioRunRow(
  runId: string,
  runtimeExecutionId: string | null = null,
): typeof scenarioRuns.$inferInsert {
  return {
    runId,
    userId: "scenario-user",
    organizationId: "scenario-organization",
    runtimeExecutionId,
    hostId: "organization-runner",
    scenarioId: "scenario-one",
    scenarioName: "scenario-one",
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
    solutionRevealedAt: null,
    solutionAssisted: false,
    vmCount: 1,
    state: "provisioning",
    stateRank: 1,
    activeKey: "scenario-user",
    stateJson: "{}",
    deleteRequestedAt: null,
    solvedAt: null,
    completedAt: null,
    failedAt: null,
    hiddenAt: null,
    createdAt: 10_100,
    updatedAt: 10_100,
  };
}

function scenarioSshKeyRow(
  runId: string,
  suffix = "",
): typeof scenarioRunSshKeys.$inferInsert {
  return {
    id: `${runId}-ssh-key${suffix}`,
    runId,
    vmId: `${runId}-vm${suffix}`,
    runtimeVmName: `${runId}-runtime-vm${suffix}`,
    publicKeyOpenssh: "ssh-ed25519 AAAAC3Nza scenario-start",
    privateKeyCiphertextB64: "ciphertext",
    privateKeyIvB64: "initialization-vector",
    createdAt: 10_100,
  };
}

function scenarioVm(runId: string): RunVmStateDocument {
  const vm = buildInitialVmState({
    id: `${runId}-vm`,
    ordinal: 0,
    scenarioVmId: "web",
    scenarioVmName: "Web",
    runtimeVmName: `${runId}-runtime-vm`,
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
        vcpuCount: 1,
        memoryMib: 512,
        diskMib: 4_096,
      },
      leaseDurationSeconds: 3_600,
      status: "queued",
    },
  };
}
