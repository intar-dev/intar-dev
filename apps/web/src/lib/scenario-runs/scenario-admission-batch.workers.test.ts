/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accessAllowlist,
  agentHosts,
  hostCpuReservations,
  hostDesiredState,
  organization,
  runtimeExecutions,
  runtimeVms,
  runtimeVmAccessKeys,
  runtimeOperationGates,
  scenarioRuns,
  user,
} from "@/db/schema";
import {
  desiredVmFromRunVm,
  mutateDesiredState,
  upsertDesiredVm,
} from "@/lib/desired-state";
import { loadOrCreateHostDesiredState } from "@/lib/desired-state-store";
import { buildInitialVmState, type RunVmStateDocument } from "@/lib/run-state";
import {
  admissionStatements,
  assertAdmissionRefusalPriority,
  type AdmissionCommitInput,
} from "@/lib/scenario-runs/begin";
import { revokeBetaUser } from "@/lib/beta-access-revocation-store";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import {
  FIXTURE_BETA_ADMIN_ID,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const USER_ID = "admission-user";
const HOST_ID = "admission-host";
const ORG_ID = "admission-organization";
const RUN_ID = "admission-run";
const VM_ID = "admission-vm";
const NOW = 20_000;

const guestTools = {
  tools_disk_sha256: "a".repeat(64),
  tools_disk_size_bytes: 64 * 1024 * 1024,
  kino_sha256: "b".repeat(64),
  bootstrap_abi: 1,
} as const;

describe("admission batch", () => {
  beforeEach(resetD1Database);

  it("admits one run in a single D1 batch", async () => {
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: USER_ID,
      name: "Admission User",
      email: "admission@example.test",
      emailVerified: true,
      username: USER_ID,
      role: "user",
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
    await grantFixtureBetaAccess({
      d1: env.DB,
      userId: USER_ID,
      githubAccountId: "admission-github",
      githubUsername: USER_ID,
      now: NOW,
    });
    await db.insert(organization).values({
      id: ORG_ID,
      name: "Admission Org",
      slug: "admission-org",
      createdAt: new Date(NOW),
    });
    await db.insert(agentHosts).values({
      id: HOST_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      name: "Admission host",
      role: "agent",
      scenarioEnabled: true,
      disabled: false,
      connected: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const [admission] = await db
      .select({
        sourceInviteId: accessAllowlist.sourceInviteId,
        sourceLeaseId: accessAllowlist.sourceLeaseId,
        grantedAt: accessAllowlist.grantedAt,
      })
      .from(accessAllowlist)
      .where(eq(accessAllowlist.userId, USER_ID))
      .limit(1);
    if (!admission) throw new Error("fixture admission missing");
    const current = await loadOrCreateHostDesiredState(db, HOST_ID, NOW);
    const desiredVm = desiredVmFromRunVm({
      runId: RUN_ID,
      vm: admissionVm(),
      nowUnixMs: NOW,
      sshAuthorizedKeysOpenssh: ["ssh-ed25519 AAAAC3Nza admission"],
      guestTools,
    });
    if (!desiredVm) throw new Error("desired vm");
    const next = mutateDesiredState(
      current,
      (draft) => {
        upsertDesiredVm(draft, desiredVm);
      },
      { nowUnixMs: NOW },
    );

    const batch = admissionStatements({
      run: {
        runId: RUN_ID,
        userId: USER_ID,
        organizationId: ORG_ID,
        runtimeExecutionId: RUN_ID,
        hostId: HOST_ID,
        scenarioId: "scenario-one",
        scenarioName: "scenario-one",
        title: "Title",
        tagline: "Tagline",
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
        activeKey: USER_ID,
        requestIdempotencyKey: "key-abcdefgh",
        requestScopeJson: {
          scenarioId: "scenario-one",
          organizationId: ORG_ID,
          hostId: null,
          candidateRevision: null,
          candidateBuildId: null,
          allowDrainedAdminProof: false,
          allowSequenceBypass: false,
        },
        stateJson: JSON.stringify({ vms: [{ runtimeVmName: VM_ID }] }),
        createdAt: NOW,
        updatedAt: NOW,
      },
      sshKeyRows: [
        {
          id: "admission-ssh-key",
          runId: RUN_ID,
          vmId: VM_ID,
          runtimeVmName: VM_ID,
          publicKeyOpenssh: "ssh-ed25519 AAAAC3Nza admission",
          privateKeyCiphertextB64: "ciphertext",
          privateKeyIvB64: "iv",
          createdAt: NOW,
        },
      ],
      runtimeVms: [
        {
          vmId: VM_ID,
          ordinal: 0,
          runtimeVmName: VM_ID,
          imageKey: { scenario: "scenario-one", vm: "web", arch: "x86_64" },
          imageSha256: "2".repeat(64),
          cpuMillis: 1_000,
          memoryMib: 512,
          diskMib: 4_096,
          runtimeVmId: "admission-runtime-vm",
        },
      ],
      accessKeys: [{ ciphertextB64: "ciphertext", ivB64: "iv" }],
      desiredVms: [desiredVm],
      desired: {
        hostId: HOST_ID,
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
      leaseExpiresAt: NOW + 3_600_000,
      betaAdmission: admission,
      now: NOW,
    });
    const results = await env.DB.batch(batch.statements);
    expect(results.length).toBeGreaterThan(0);
    expect(batch.runGateIndex).toBe(1);
    await expect(
      db.select({ runId: scenarioRuns.runId }).from(scenarioRuns),
    ).resolves.toEqual([{ runId: RUN_ID }]);
    await expect(
      db
        .select({ id: runtimeVmAccessKeys.runtimeVmId })
        .from(runtimeVmAccessKeys),
    ).resolves.toEqual([{ id: "admission-runtime-vm" }]);
    await expect(
      db
        .select({ version: hostDesiredState.version })
        .from(hostDesiredState)
        .where(eq(hostDesiredState.hostId, HOST_ID)),
    ).resolves.toEqual([{ version: next.version }]);
  });

  it("aborts the whole batch when the desired-state compare-and-set is lost", async () => {
    const db = await seedAdmissionFixture();
    const parts = await admissionInput();
    const stale = {
      ...parts,
      desired: { ...parts.desired, expectedVersion: parts.desired.expectedVersion - 1 },
    };
    await expect(env.DB.batch(admissionStatements(stale).statements)).rejects.toThrow(
      /runtime_executions_generation_positive|UNIQUE|CHECK/i,
    );
    await expect(count(db, scenarioRuns)).resolves.toBe(0);
    await expect(count(db, runtimeExecutions)).resolves.toBe(0);
    await expect(count(db, runtimeVms)).resolves.toBe(0);
    await expect(count(db, hostCpuReservations)).resolves.toBe(0);
  });

  it("aborts the whole batch on a duplicate idempotency key", async () => {
    const db = await seedAdmissionFixture();
    const parts = await admissionInput();
    const batch = admissionStatements(parts);
    await env.DB.batch(batch.statements);
    const second = {
      ...parts,
      run: { ...parts.run, runId: "admission-run-2", runtimeExecutionId: "admission-run-2" },
    };
    await expect(
      env.DB.batch(admissionStatements(second).statements),
    ).rejects.toThrow(/scenario_runs_request_idempotency_uidx|UNIQUE/i);
    await expect(count(db, scenarioRuns)).resolves.toBe(1);
  });


  it("refuses the batch when the cut-over gate is drained and admits an administrative proof", async () => {
    const db = await seedAdmissionFixture();
    const parts = await admissionInput();
    await db.insert(runtimeOperationGates).values({
      key: IMAGE_CUTOVER_GATE,
      state: "drained",
      updatedAt: NOW,
    });

    await expect(
      env.DB.batch(admissionStatements(parts).statements),
    ).rejects.toThrow();
    // The run insert is the gate, so a refused admission leaves no partial
    // run, key, reservation, or desired-state change behind.
    await expect(count(db, scenarioRuns)).resolves.toBe(0);

    const proof = await env.DB.batch(
      admissionStatements({
        ...parts,
        allowDrainedAdminProof: true,
      }).statements,
    );
    expect(proof.length).toBeGreaterThan(0);
    await expect(count(db, scenarioRuns)).resolves.toBe(1);
  });

  it("keeps the drain fence inside the insert so a drain in the commit window refuses", async () => {
    const db = await seedAdmissionFixture();
    const parts = await admissionInput();
    // The gate flips after the caller's entry check and after its capacity
    // read. The insert still carries the fence, so nothing is admitted.
    await db.insert(runtimeOperationGates).values({
      key: IMAGE_CUTOVER_GATE,
      state: "drained",
      updatedAt: NOW,
    });
    const batch = admissionStatements(parts);
    // A drained gate refuses the run insert, and the abort sentinel rolls the
    // whole transaction back, so the rejection is a D1 constraint failure on
    // the sentinel rather than a partial admission.
    await expect(env.DB.batch(batch.statements)).rejects.toThrow(
      /runtime_executions_generation_positive|CHECK/i,
    );
    await expect(count(db, scenarioRuns)).resolves.toBe(0);
    await expect(
      db
        .select({ version: hostDesiredState.version })
        .from(hostDesiredState)
        .where(eq(hostDesiredState.hostId, HOST_ID)),
    ).resolves.toEqual([{ version: parts.desired.expectedVersion }]);
  });

  it("persists the immutable course and lecture snapshot with the admitted run", async () => {
    const db = await seedAdmissionFixture();
    const parts = await admissionInput();
    const results = await env.DB.batch(
      admissionStatements({
        ...parts,
        run: {
          ...parts.run,
          courseScopeKey: "organization:" + ORG_ID,
          courseId: "linux-operations",
          courseTitle: "Linux operations",
          lectureId: "01-repair-nginx",
          lectureTitle: "Repair nginx",
          lectureSummary: "Learn the nginx service model.",
          lectureBodyMarkdown: "# Theory",
          lectureOrdinal: 1,
          lectureCount: 3,
        },
      }).statements,
    );
    expect(results.length).toBeGreaterThan(0);
    const [stored] = await db
      .select({
        courseScopeKey: scenarioRuns.courseScopeKey,
        courseId: scenarioRuns.courseId,
        courseTitle: scenarioRuns.courseTitle,
        lectureId: scenarioRuns.lectureId,
        lectureTitle: scenarioRuns.lectureTitle,
        lectureSummary: scenarioRuns.lectureSummary,
        lectureBodyMarkdown: scenarioRuns.lectureBodyMarkdown,
        lectureOrdinal: scenarioRuns.lectureOrdinal,
        lectureCount: scenarioRuns.lectureCount,
      })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, RUN_ID));
    expect(stored).toEqual({
      courseScopeKey: "organization:" + ORG_ID,
      courseId: "linux-operations",
      courseTitle: "Linux operations",
      lectureId: "01-repair-nginx",
      lectureTitle: "Repair nginx",
      lectureSummary: "Learn the nginx service model.",
      lectureBodyMarkdown: "# Theory",
      lectureOrdinal: 1,
      lectureCount: 3,
    });
  });

  it("raises the drain refusal over the retryable capacity conflict", async () => {
    const db = await seedAdmissionFixture();
    const parts = await admissionInput();
    // The gate can flip after a failed attempt: the run insert passed while
    // the gate was open and the compare-and-set was lost. The retry decision
    // must answer with the drain (final) instead of the contention
    // (retryable), including on the final attempt where no retry follows.
    await db.insert(runtimeOperationGates).values({
      key: IMAGE_CUTOVER_GATE,
      state: "drained",
      updatedAt: NOW,
    });

    await expect(
      assertAdmissionRefusalPriority({
        userId: USER_ID,
        betaAdmission: parts.betaAdmission,
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "runtime_cutover_drained",
    });
    // The priority check is read only.
    await expect(count(db, scenarioRuns)).resolves.toBe(0);
  });

  it("keeps the retryable conflict for an administrative proof start", async () => {
    const db = await seedAdmissionFixture();
    const parts = await admissionInput();
    await db.insert(runtimeOperationGates).values({
      key: IMAGE_CUTOVER_GATE,
      state: "drained",
      updatedAt: NOW,
    });

    // A proof start is allowed through a drained gate, so the drain must not
    // replace its contention result with a 503.
    await expect(
      assertAdmissionRefusalPriority({
        userId: USER_ID,
        betaAdmission: parts.betaAdmission,
        allowDrainedAdminProof: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("raises a revoked admission over the retryable capacity conflict", async () => {
    const db = await seedAdmissionFixture();
    const parts = await admissionInput();
    await revokeBetaUser({
      d1: env.DB,
      userId: USER_ID,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "admission_retry_priority",
      now: NOW + 1,
    });

    await expect(
      assertAdmissionRefusalPriority({
        userId: USER_ID,
        betaAdmission: parts.betaAdmission,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "beta_access_revoked",
    });
    await expect(count(db, scenarioRuns)).resolves.toBe(0);
  });
});

function admissionVm(): RunVmStateDocument {
  const vm = buildInitialVmState({
    id: VM_ID,
    ordinal: 0,
    scenarioVmId: "web",
    scenarioVmName: "Web",
    runtimeVmName: VM_ID,
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


async function seedAdmissionFixture() {
  const db = drizzle(env.DB);
  await db.insert(user).values({
    id: USER_ID,
    name: "Admission User",
    email: "admission@example.test",
    emailVerified: true,
    username: USER_ID,
    role: "user",
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  });
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId: USER_ID,
    githubAccountId: "admission-github",
    githubUsername: USER_ID,
    now: NOW,
  });
  await db.insert(organization).values({
    id: ORG_ID,
    name: "Admission Org",
    slug: "admission-org",
    createdAt: new Date(NOW),
  });
  await db.insert(agentHosts).values({
    id: HOST_ID,
    userId: USER_ID,
    organizationId: ORG_ID,
    name: "Admission host",
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
    connected: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

async function admissionInput(): Promise<AdmissionCommitInput> {
  const db = drizzle(env.DB);
  const [admission] = await db
    .select({
      sourceInviteId: accessAllowlist.sourceInviteId,
      sourceLeaseId: accessAllowlist.sourceLeaseId,
      grantedAt: accessAllowlist.grantedAt,
    })
    .from(accessAllowlist)
      .where(eq(accessAllowlist.userId, USER_ID))
      .limit(1);
  if (!admission) throw new Error("fixture admission missing");
  const current = await loadOrCreateHostDesiredState(db, HOST_ID, NOW);
  const desiredVm = desiredVmFromRunVm({
    runId: RUN_ID,
    vm: admissionVm(),
    nowUnixMs: NOW,
    sshAuthorizedKeysOpenssh: ["ssh-ed25519 AAAAC3Nza admission"],
    guestTools,
  });
  if (!desiredVm) throw new Error("desired vm");
  const next = mutateDesiredState(
    current,
    (draft) => {
      upsertDesiredVm(draft, desiredVm);
    },
    { nowUnixMs: NOW },
  );
  return {
    run: {
      runId: RUN_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      runtimeExecutionId: RUN_ID,
      hostId: HOST_ID,
      scenarioId: "scenario-one",
      scenarioName: "scenario-one",
      title: "Title",
      tagline: "Tagline",
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
      activeKey: USER_ID,
      requestIdempotencyKey: "key-abcdefgh",
      requestScopeJson: {
        scenarioId: "scenario-one",
        organizationId: ORG_ID,
        hostId: null,
        candidateRevision: null,
        candidateBuildId: null,
        allowDrainedAdminProof: false,
        allowSequenceBypass: false,
      },
      stateJson: JSON.stringify({ vms: [{ runtimeVmName: VM_ID }] }),
      createdAt: NOW,
      updatedAt: NOW,
    },
    sshKeyRows: [
      {
        id: "admission-ssh-key",
        runId: RUN_ID,
        vmId: VM_ID,
        runtimeVmName: VM_ID,
        publicKeyOpenssh: "ssh-ed25519 AAAAC3Nza admission",
        privateKeyCiphertextB64: "ciphertext",
        privateKeyIvB64: "iv",
        createdAt: NOW,
      },
    ],
    runtimeVms: [
      {
        vmId: VM_ID,
        ordinal: 0,
        runtimeVmName: VM_ID,
        imageKey: { scenario: "scenario-one", vm: "web", arch: "x86_64" },
        imageSha256: "2".repeat(64),
        cpuMillis: 1_000,
        memoryMib: 512,
        diskMib: 4_096,
        runtimeVmId: "admission-runtime-vm",
      },
    ],
    accessKeys: [{ ciphertextB64: "ciphertext", ivB64: "iv" }],
    desiredVms: [desiredVm],
    desired: {
      hostId: HOST_ID,
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
    leaseExpiresAt: NOW + 3_600_000,
    betaAdmission: admission,
    now: NOW,
  } satisfies AdmissionCommitInput;
}

async function count(
  db: ReturnType<typeof drizzle>,
  table: Parameters<ReturnType<typeof drizzle>["select"]>[0] extends never
    ? never
    : any,
): Promise<number> {
  const rows = await db.select().from(table);
  return rows.length;
}
