/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Behavioural tests for the single-batch scenario admission.
 *
 * The test client wraps env.DB.batch so a test can inject one deterministic
 * event between the capacity read and the commit, or directly after the
 * commit. The wrapper finds the admission batch by its own SQL, so it never
 * depends on how many read batches the caller makes.
 *
 * These tests use the real D1 schema, the real admission code, and the real
 * host runtime wake path. Only the pure candidate catalog read is replaced,
 * because candidate rows belong to the image build area.
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CourseCatalogSnapshotV2,
  CourseCatalogLectureV2,
} from "@/db/schema";
import {
  accessAllowlist,
  activeRuntimeSlots,
  agentHosts,
  hostActualState,
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
  member,
  organization,
  runtimeExecutions,
  scenarioCatalogCandidates,
  scenarioRuns,
  user,
  vmScenarios,
  vmScenarioVms,
  runtimeOperationGates,
} from "@/db/schema";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { revokeBetaUser } from "@/lib/beta-access-revocation-store";
import { syncCourseCatalogSnapshot } from "@/lib/course-catalogs";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  acquireRegistrySweep,
  admitInternalRegistryOperation,
  finishRegistrySweep,
} from "@/lib/image-registry-admission";
import { HOST_STATE_REPORT_SCHEMA_VERSION } from "@/generated/constants";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import { candidateScenarioId } from "@/lib/scenario-catalog-candidates";
import { beginScenarioRun, type BeginScenarioRunInput } from "@/lib/scenario-runs/begin";
import {
  FIXTURE_BETA_ADMIN_ID,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";
import { applyD1Migrations, reset } from "cloudflare:test";
import { d1Migrations } from "@/test/d1-migrations";

const admissionHarness = vi.hoisted(() => {
  interface State {
    before: Array<() => unknown>;
    after: Array<() => unknown>;
    events: string[];
    batchCalls: number;
    admissionBatches: number;
    realDb: D1Database;
    /** Written-row counts of the admission batches, in commit order. */
    admissionChanges: number[][];
  }
  const state: State = {
    before: [],
    after: [],
    events: [],
    batchCalls: 0,
    admissionBatches: 0,
    realDb: null as unknown as D1Database,
    admissionChanges: [],
  };
  return {
    state,
    armBeforeAdmissionBatch(hook: () => unknown) {
      state.before.push(hook);
    },
    armAfterAdmissionBatch(hook: () => unknown) {
      state.after.push(hook);
    },
    reset() {
      state.before = [];
      state.after = [];
      state.events = [];
      state.batchCalls = 0;
      state.admissionBatches = 0;
      state.admissionChanges = [];
    },
    eventIndex(event: string) {
      return state.events.indexOf(event);
    },
  };
});

vi.mock("cloudflare:workers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cloudflare:workers")>();
  const state = admissionHarness.state;
  const realDb = actual.env.DB;
  state.realDb = realDb;

  const statementSql = (statement: D1PreparedStatement): string => {
    const sql = (statement as unknown as { statement?: unknown }).statement;
    return typeof sql === "string" ? sql : "";
  };
  const isAdmissionBatch = (statements: D1PreparedStatement[]): boolean =>
    statements.some((statement) =>
      statementSql(statement).includes("INSERT INTO scenario_runs"),
    );

  const runBatch = async (statements: D1PreparedStatement[]) => {
      const admission = isAdmissionBatch(statements);
      state.batchCalls += 1;
      state.events.push(admission ? "admission-batch" : "read-batch");
      if (!admission) {
        return realDb.batch(statements);
      }
      state.admissionBatches += 1;
      for (const hook of state.before.splice(0)) {
        await hook();
      }
      const results = await realDb.batch(statements);
      state.admissionChanges.push(
        results.map((result) => Number(result.meta?.changes ?? -1)),
      );
      for (const hook of state.after.splice(0)) {
        await hook();
      }
      return results;
  };
  // The facade stays a real D1Database binding: the test helpers of the
  // workers pool accept only that type.
  const facadeDb = new Proxy(
    realDb as unknown as Record<string | symbol, unknown>,
    {
      get(target, property) {
        if (property === "batch") {
          return runBatch;
        }
        const value = Reflect.get(target, property);
        if (typeof value === "function") {
          return (...args: unknown[]) =>
            (value as (...args: unknown[]) => unknown).apply(target, args);
        }
        return value;
      },
    },
  );

  const facadeEnv = new Proxy(
    actual.env as unknown as Record<string | symbol, unknown>,
    {
      get(target, property) {
        if (property === "DB") {
          return facadeDb;
        }
        if (property === "HOST_RUNTIME") {
          const namespace = Reflect.get(target, property) as DurableObjectNamespace;
          return new Proxy(namespace as unknown as Record<string | symbol, unknown>, {
            get(namespaceTarget, namespaceProperty) {
              const value = Reflect.get(namespaceTarget, namespaceProperty);
              if (typeof value !== "function") {
                return value;
              }
              const call = (...args: unknown[]) => {
                if (namespaceProperty === "idFromName") {
                  state.events.push(`host-runtime-id:${String(args[0])}`);
                } else if (
                  namespaceProperty === "get" ||
                  namespaceProperty === "getByName"
                ) {
                  state.events.push("host-runtime-stub");
                }
                return (value as (...args: unknown[]) => unknown).apply(
                  namespaceTarget,
                  args,
                );
              };
              return call;
            },
          });
        }
        return Reflect.get(target, property);
      },
    },
  ) as unknown as typeof actual.env;

  return { ...actual, env: facadeEnv };
});

vi.mock("@/lib/scenario-runs/candidate", async () => {
  const { loadEnabledScenarioRows } = await import(
    "@/lib/scenario-runs/storage"
  );
  return {
    loadCandidateScenarioRunSource: async (
      db: never,
      input: {
        revision: string;
        buildId: string;
        scenarioId: string;
        organizationId: string | null;
      },
    ) => {
      void db;
      const [scenario] = await loadEnabledScenarioRows(
        input.scenarioId,
        input.organizationId,
      );
      if (!scenario) {
        return null;
      }
      // The read returns the staged text as the commit fingerprint, so the mock
      // takes it from the same row the commit anchor compares.
      const staged = await env.DB.prepare(
        "SELECT manifest_json AS manifestText FROM scenario_catalog_candidates" +
          " WHERE id = ?1",
      )
        .bind(
          candidateScenarioId(
            input.organizationId,
            input.revision,
            input.scenarioId,
          ),
        )
        .first<{ manifestText: string }>();
      if (!staged) {
        return null;
      }
      return {
        ...scenario,
        candidateSource: {
          revision: input.revision,
          buildId: input.buildId,
        },
        candidateManifestText: staged.manifestText,
      };
    },
  };
});

const HOST_ID = "admission-runner";
const SCENARIO_ID = "scenario-one";
const SECOND_SCENARIO_ID = "scenario-two";
const THIRD_SCENARIO_ID = "scenario-three";
const RUNNER_USER_ID = "admission-user";
const FIRST_VM_CPU_MILLIS = 1_000;
const VM_MEMORY_MIB = 512;
const VM_DISK_MIB = 4_096;
const HOST_CPU_MILLIS = 8_000;
const IMAGE_SHA_ONE = "2".repeat(64);
/** The direct-boot ABI that a launchable scenario image must declare. */
const SCENARIO_VM_GUEST_BOOTSTRAP_ABI = 2;
/** The artifact identity every seeded scenario VM publishes. */
const SCENARIO_VM_CHUNK_MANIFEST_SHA = "d".repeat(64);
const SCENARIO_VM_KERNEL_SHA = "a".repeat(64);
const SCENARIO_VM_INITRD_SHA = "b".repeat(64);
/** The seeded VM row id of the first scenario VM. */
const SEEDED_VM_ROW_ID = `${SCENARIO_ID}:webserver`;
const CANDIDATE_REVISION_A = "candidate-rev-a";
const CANDIDATE_BUILD_A = "candidate-build-a";
const CANDIDATE_REVISION_B = "candidate-rev-b";
const CANDIDATE_BUILD_B = "candidate-build-b";
/** The content hash of the seeded candidate build. */
const CANDIDATE_CONTENT_HASH = "c".repeat(64);
/** The content hash of the second seeded candidate build. */
const SECOND_CANDIDATE_CONTENT_HASH = "e".repeat(64);

describe("scenario admission batch", () => {
  beforeEach(async () => {
    admissionHarness.reset();
    // The application under test sees the recording DB facade, so the D1
    // schema is reset through the real binding that the facade wraps. The
    // workers test helper accepts only the real binding.
    await reset();
    await applyD1Migrations(admissionHarness.state.realDb, d1Migrations);
  });

  it("rejects a missing or malformed idempotency key before any write", async () => {
    const fixture = await seedAdmissionFixture();

    for (const key of [
      "",
      "   ",
      "short",
      "a".repeat(201),
      "key with space",
      "key\twith-tab",
      "ключ-unicode-key",
    ]) {
      await expect(
        beginScenarioRun(fixture.input(RUNNER_USER_ID, { idempotencyKey: key })),
        `key ${JSON.stringify(key)}`,
      ).rejects.toMatchObject({
        status: 400,
        code: "idempotency_key_required",
      });
    }

    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
    expect(admissionHarness.state.admissionBatches).toBe(0);
    // A rejected request never touches the registry gate either: the writer is
    // opened after the key and candidate-proof validation.
    await expect(openWriterRows()).resolves.toBe(0);
  });

  it("admits one run in one D1 batch and wakes the host after the commit", async () => {
    const fixture = await seedAdmissionFixture();

    const result = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await result.deliveryHint;

    expect(result).toMatchObject({
      accepted: true,
      reused: false,
      hostId: HOST_ID,
      scenarioId: SCENARIO_ID,
    });
    await expect(admissionSnapshot()).resolves.toMatchObject({
      runs: 1,
      sshKeys: 1,
      runtimeExecutions: 1,
      runtimeVms: 1,
      accessKeys: 1,
      cpuReservations: 1,
      cpuMillis: FIRST_VM_CPU_MILLIS,
      resourceReservations: 1,
      activeSlots: 1,
      desiredVersion: 1,
    });
    expect(await loadRunRow(result.runId)).toMatchObject({
      userId: RUNNER_USER_ID,
      hostId: HOST_ID,
      scenarioId: SCENARIO_ID,
      state: "provisioning",
      activeKey: RUNNER_USER_ID,
      requestIdempotencyKey: fixture.keyFor(RUNNER_USER_ID),
    });
    const desired = await desiredDocument();
    expect(desired.vms).toHaveLength(1);
    expect(desired.vms[0]).toMatchObject({
      run_id: result.runId,
      desired_phase: "running",
      image_id: IMAGE_SHA_ONE,
    });

    // One admission batch, and no host runtime hop before it.
    expect(admissionHarness.state.admissionBatches).toBe(1);
    const commit = admissionHarness.eventIndex("admission-batch");
    const wake = admissionHarness.eventIndex(`host-runtime-id:${HOST_ID}`);
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(wake).toBeGreaterThan(commit);
  });

  it("refuses a new key while the user has an active run instead of answering with it", async () => {
    const fixture = await seedAdmissionFixture();
    const first = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await first.deliveryHint;

    await expect(
      beginScenarioRun(
        fixture.input(RUNNER_USER_ID, { idempotencyKey: "second-start-key" }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_run_active_conflict",
    });

    // The refusal is not an alias: no second run, no second admission batch,
    // and the first run's admission stays exactly as it was.
    expect(admissionHarness.state.admissionBatches).toBe(1);
    await expect(admissionSnapshot()).resolves.toMatchObject({
      runs: 1,
      cpuReservations: 1,
      desiredVersion: 1,
    });
  });

  it("keeps one active run when one user starts twice at the same time", async () => {
    const fixture = await seedAdmissionFixture();

    const results = await Promise.allSettled([
      beginScenarioRun(fixture.input(RUNNER_USER_ID, { idempotencyKey: "race-key-one" })),
      beginScenarioRun(fixture.input(RUNNER_USER_ID, { idempotencyKey: "race-key-two" })),
    ]);
    await settleDeliveryHints(results);

    const accepted = results.filter((entry) => entry.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    const rejected = results.filter((entry) => entry.status === "rejected");
    assertRejected(rejected, [409]);
    await expect(admissionSnapshot()).resolves.toMatchObject({
      runs: 1,
      sshKeys: 1,
      runtimeExecutions: 1,
      runtimeVms: 1,
      cpuReservations: 1,
      cpuMillis: FIRST_VM_CPU_MILLIS,
      resourceReservations: 1,
      activeSlots: 1,
      desiredVersion: 1,
    });
  });

  it("does not oversubscribe one host when four users start at the same time", async () => {
    const userIds = ["race-user-1", "race-user-2", "race-user-3", "race-user-4"];
    const fixture = await seedAdmissionFixture({ userIds });

    const results = await Promise.allSettled(
      userIds.map((userId) => beginScenarioRun(fixture.input(userId))),
    );
    await settleDeliveryHints(results);

    const accepted = results.filter(
      (entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof beginScenarioRun>>> =>
        entry.status === "fulfilled",
    );
    const rejected = results.filter((entry) => entry.status === "rejected");
    assertRejected(rejected, [409], [
      "scenario_host_unavailable",
      "scenario_host_capacity_contended",
    ]);

    // The capacity fence holds: the reserved CPU never passes the reported
    // schedulable CPU, and every admitted run has its own user.
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThanOrEqual(4);
    const snapshot = await admissionSnapshot();
    expect(snapshot.cpuMillis).toBe(accepted.length * FIRST_VM_CPU_MILLIS);
    expect(snapshot.cpuMillis).toBeLessThanOrEqual(HOST_CPU_MILLIS);
    // Every admitted run must own a desired VM. A run that commits without
    // publishing its VM never launches, and its CPU quota stays charged.
    const desired = await desiredDocument();
    const published = desired.vms.filter(
      (vm) => vm.desired_phase === "running",
    ).length;
    expect(
      published,
      `${String(published)} published VMs for ${String(accepted.length)} admitted runs; ` +
        `desired version ${String(desired.version)}; ` +
        `written rows per admission batch ${JSON.stringify(admissionHarness.state.admissionChanges)}; ` +
        "a batch whose desired-state update wrote 0 rows must not commit",
    ).toBe(accepted.length);
    expect(snapshot).toMatchObject({
      runs: accepted.length,
      sshKeys: accepted.length,
      runtimeExecutions: accepted.length,
      runtimeVms: accepted.length,
      cpuReservations: accepted.length,
      resourceReservations: accepted.length,
      activeSlots: accepted.length,
      desiredVersion: accepted.length,
    });
    const storedRuns = await storedRunRows();
    expect(accepted.map((entry) => entry.value.runId).sort()).toEqual(
      storedRuns.map((run) => run.runId).sort(),
    );
    const runUsers = storedRuns.map((run) => run.userId);
    expect(new Set(runUsers).size).toBe(runUsers.length);
    expect((await desiredDocument()).vms).toHaveLength(accepted.length);
  });

  it("admits two half-CPU VMs into one CPU from startup", async () => {
    const fixture = await seedAdmissionFixture({ userIds: ["half-a", "half-b"], hostCpuMillis: 1000 });
    await drizzle(env.DB).update(vmScenarioVms).set({ cpuMillis: 500 })
      .where(eq(vmScenarioVms.scenarioId, SCENARIO_ID));
    for (const userId of ["half-a", "half-b"]) {
      const result = await beginScenarioRun(fixture.input(userId));
      await result.deliveryHint;
    }
    await expect(admissionSnapshot()).resolves.toMatchObject({ runs: 2, cpuReservations: 2, cpuMillis: 1000 });
    const overflow = await fixture.addUser("half-c");
    await expect(beginScenarioRun(overflow)).rejects.toMatchObject({ code: "scenario_host_unavailable" });
    await expect(admissionSnapshot()).resolves.toMatchObject({ runs: 2, cpuReservations: 2, cpuMillis: 1000 });
  });

  it("fills the host capacity exactly and then rejects the next start", async () => {
    const userIds = ["fill-user-1", "fill-user-2", "fill-user-3", "fill-user-4"];
    const fixture = await seedAdmissionFixture({ userIds, hostCpuMillis: 4 * FIRST_VM_CPU_MILLIS });

    for (const userId of userIds) {
      const result = await beginScenarioRun(fixture.input(userId));
      await result.deliveryHint;
    }
    await expect(admissionSnapshot()).resolves.toMatchObject({
      runs: 4,
      cpuReservations: 4,
      cpuMillis: 4 * FIRST_VM_CPU_MILLIS,
      desiredVersion: 4,
    });

    const overflow = await fixture.addUser("fill-user-5");
    await expect(beginScenarioRun(overflow)).rejects.toMatchObject({
      code: "scenario_host_unavailable",
    });
    await expect(admissionSnapshot()).resolves.toMatchObject({
      runs: 4,
      sshKeys: 4,
      runtimeExecutions: 4,
      runtimeVms: 4,
      cpuReservations: 4,
      cpuMillis: 4 * FIRST_VM_CPU_MILLIS,
      resourceReservations: 4,
      activeSlots: 4,
      desiredVersion: 4,
    });
  });

  it("returns the same run for the same key and writes nothing again", async () => {
    const fixture = await seedAdmissionFixture();
    const first = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await first.deliveryHint;
    const versionAfterFirst = (await admissionSnapshot()).desiredVersion;
    const storedAfterFirst = await loadRunRow(first.runId);

    // The retry happens measurably later than the admission it repeats, so a
    // timestamp taken from the retry would be distinguishable from the
    // original acceptance time.
    await delay(5);
    const replay = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await replay.deliveryHint;

    expect(replay.runId).toBe(first.runId);
    expect(replay.reused).toBe(true);
    // The replay reports the stored run's own acceptance, never the retry.
    expect(first.acceptedAt).toBe(storedAfterFirst?.createdAt);
    expect(replay.acceptedAt).toBe(first.acceptedAt);
    expect(replay.acceptedAt).toBeLessThan(Date.now());
    expect(admissionHarness.state.admissionBatches).toBe(1);
    await expect(admissionSnapshot()).resolves.toMatchObject({
      runs: 1,
      sshKeys: 1,
      runtimeExecutions: 1,
      runtimeVms: 1,
      cpuReservations: 1,
      activeSlots: 1,
      desiredVersion: versionAfterFirst,
    });
  });

  it("returns the original acceptance time to the loser of a concurrent duplicate-key race", async () => {
    const fixture = await seedAdmissionFixture();
    let releaseHeldBatch: () => void = () => {};
    const heldBatch = new Promise<void>((resolve) => {
      releaseHeldBatch = resolve;
    });
    admissionHarness.armBeforeAdmissionBatch(() => heldBatch);

    // The held request reads its key, finds nothing, and stops inside its
    // admission batch. The second request enters the same window and commits
    // first, so the held request loses the race on one key.
    const held = beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await vi.waitFor(() =>
      expect(admissionHarness.state.admissionBatches).toBe(1),
    );
    const winner = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await winner.deliveryHint;
    releaseHeldBatch();
    const loser = await held;
    await loser.deliveryHint;

    // Both requests reached the admission batch: the loser did not short
    // circuit through the stored-key pre-check, it lost on the unique key.
    expect(admissionHarness.state.admissionBatches).toBe(2);
    expect(winner.reused).toBe(false);
    expect(loser.reused).toBe(true);
    expect(loser.runId).toBe(winner.runId);
    expect(loser.acceptedAt).toBe(winner.acceptedAt);
    const stored = await loadRunRow(winner.runId);
    expect(stored?.createdAt).toBe(winner.acceptedAt);
    await expect(admissionSnapshot()).resolves.toMatchObject({
      runs: 1,
      sshKeys: 1,
      runtimeExecutions: 1,
      runtimeVms: 1,
      cpuReservations: 1,
      activeSlots: 1,
      desiredVersion: 1,
    });
  });

  it("returns the ended run for the same key and starts no new VM set", async () => {
    const fixture = await seedAdmissionFixture();
    const first = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await first.deliveryHint;
    await drizzle(env.DB)
      .update(scenarioRuns)
      .set({ state: "completed", stateRank: 8, activeKey: null })
      .where(eq(scenarioRuns.runId, first.runId));
    await env.DB.prepare("DELETE FROM active_runtime_slots WHERE user_id = ?1")
      .bind(RUNNER_USER_ID)
      .run();
    const before = await admissionSnapshot();

    const replay = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await replay.deliveryHint;

    expect(replay.runId).toBe(first.runId);
    expect(replay.reused).toBe(true);
    expect(replay.acceptedAt).toBe(first.acceptedAt);
    expect(admissionHarness.state.admissionBatches).toBe(1);
    await expect(admissionSnapshot()).resolves.toEqual(before);
    expect((await desiredDocument()).vms).toHaveLength(1);
  });

  it("rejects the same key with different parameters and writes nothing", async () => {
    const fixture = await seedAdmissionFixture({ withSecondScenario: true });
    await seedCandidateProof({
      revision: CANDIDATE_REVISION_A,
      buildId: CANDIDATE_BUILD_A,
      scenarioId: SCENARIO_ID,
      organizationId: fixture.organizationId,
      imageSha256: IMAGE_SHA_ONE,
    });
    // The second candidate is staged too, because a candidate start reads its
    // row before it can reach the idempotency replay that this test checks.
    await seedCandidateProof({
      revision: CANDIDATE_REVISION_B,
      buildId: CANDIDATE_BUILD_B,
      scenarioId: SCENARIO_ID,
      organizationId: fixture.organizationId,
      imageSha256: IMAGE_SHA_ONE,
      // One content hash belongs to one build row, so the second candidate
      // stages its own build.
      contentHash: SECOND_CANDIDATE_CONTENT_HASH,
    });
    const first = await beginScenarioRun(
      fixture.input(RUNNER_USER_ID, {
        candidateRevision: CANDIDATE_REVISION_A,
        candidateBuildId: CANDIDATE_BUILD_A,
        allowDrainedAdminProof: true,
      }),
    );
    await first.deliveryHint;
    const before = await admissionSnapshot();

    const variants: Array<{ name: string; input: BeginScenarioRunInput }> = [
      {
        name: "host",
        input: fixture.input(RUNNER_USER_ID, { hostId: "other-runner" }),
      },
      {
        name: "scenario",
        input: fixture.input(RUNNER_USER_ID, { scenarioId: SECOND_SCENARIO_ID }),
      },
      {
        name: "candidate revision",
        input: fixture.input(RUNNER_USER_ID, {
          candidateRevision: CANDIDATE_REVISION_B,
          candidateBuildId: CANDIDATE_BUILD_B,
          allowDrainedAdminProof: true,
        }),
      },
      {
        name: "sequence bypass flag",
        input: fixture.input(RUNNER_USER_ID, { allowSequenceBypass: true }),
      },
      {
        name: "organization",
        input: fixture.input(RUNNER_USER_ID, { organizationId: null }),
      },
    ];

    for (const variant of variants) {
      await expect(
        beginScenarioRun(variant.input),
        `variant ${variant.name}`,
      ).rejects.toMatchObject({
        status: 409,
        code: "idempotency_key_conflict",
      });
    }
    expect(admissionHarness.state.admissionBatches).toBe(1);
    await expect(admissionSnapshot()).resolves.toEqual(before);
  });

  it("leaves no rows when the epoch is revoked before the commit", async () => {
    const fixture = await seedAdmissionFixture();
    admissionHarness.armBeforeAdmissionBatch(async () => {
      await revokeBetaUser({
        d1: env.DB,
        userId: RUNNER_USER_ID,
        actorUserId: FIXTURE_BETA_ADMIN_ID,
        reason: "admission_test_revoked_before_commit",
        now: Date.now(),
      });
    });

    await expect(
      beginScenarioRun(fixture.input(RUNNER_USER_ID)),
    ).rejects.toMatchObject({ status: 403, code: "beta_access_revoked" });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
  });

  it("stops a start when the drain gate closes after the selection", async () => {
    const fixture = await seedAdmissionFixture();
    admissionHarness.armBeforeAdmissionBatch(async () => {
      await env.DB.prepare(
        "INSERT INTO runtime_operation_gates (key, state, updated_at)" +
          " VALUES (?1, 'drained', ?2)" +
          " ON CONFLICT(key) DO UPDATE SET state = 'drained', updated_at = ?2",
      )
        .bind(IMAGE_CUTOVER_GATE, Date.now())
        .run();
    });

    await expect(
      beginScenarioRun(fixture.input(RUNNER_USER_ID)),
    ).rejects.toMatchObject({ status: 503, code: "runtime_cutover_drained" });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
    await expect(
      drizzle(env.DB)
        .select({ key: runtimeOperationGates.key })
        .from(runtimeOperationGates)
        .where(eq(runtimeOperationGates.key, IMAGE_CUTOVER_GATE)),
    ).resolves.toHaveLength(1);
  });

  it("retries the whole operation after a lost desired-state CAS", async () => {
    const fixture = await seedAdmissionFixture();
    let lostCas = 0;
    admissionHarness.armBeforeAdmissionBatch(async () => {
      lostCas += 1;
      const row = await env.DB.prepare(
        "SELECT version, doc_json FROM host_desired_state WHERE host_id = ?1",
      )
        .bind(HOST_ID)
        .first<{ version: number; doc_json: string }>();
      const document = JSON.parse(row?.doc_json ?? "{}") as { version: number };
      // A competing admission published a newer document, so this attempt
      // built its draft from a version that is already gone. The jump is
      // larger than one because the sentinel that detects the lost
      // compare-and-set only trips when the committed version is not exactly
      // the version this attempt would have written.
      const competedVersion = (row?.version ?? 0) + 2;
      await env.DB.prepare(
        "UPDATE host_desired_state SET version = ?1, doc_json = ?2" +
          " WHERE host_id = ?3 AND version = ?4",
      )
        .bind(
          competedVersion,
          JSON.stringify({ ...document, version: competedVersion }),
          HOST_ID,
          row?.version ?? 0,
        )
        .run();
    });

    const result = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await result.deliveryHint;

    expect(lostCas).toBe(1);
    expect(admissionHarness.state.admissionBatches).toBe(2);
    await expect(admissionSnapshot()).resolves.toMatchObject({
      runs: 1,
      sshKeys: 1,
      runtimeExecutions: 1,
      runtimeVms: 1,
      cpuReservations: 1,
      cpuMillis: FIRST_VM_CPU_MILLIS,
      resourceReservations: 1,
      activeSlots: 1,
      desiredVersion: 3,
    });
    expect(await loadRunRow(result.runId)).toMatchObject({
      runId: result.runId,
      hostId: HOST_ID,
      state: "provisioning",
    });
    expect((await desiredDocument()).vms).toHaveLength(1);
  });

  it("leaves no partial rows when the batch fails in the middle", async () => {
    const fixture = await seedAdmissionFixture();
    await seedForeignActiveSlot(RUNNER_USER_ID);

    await expect(
      beginScenarioRun(fixture.input(RUNNER_USER_ID)),
    ).rejects.toMatchObject({ status: 409, code: "scenario_run_active_conflict" });
    await expect(admissionSnapshot()).resolves.toMatchObject({
      runs: 0,
      sshKeys: 0,
      runtimeExecutions: 1,
      runtimeVms: 0,
      accessKeys: 0,
      cpuReservations: 0,
      resourceReservations: 0,
      activeSlots: 1,
      desiredVersion: 0,
    });
    expect((await desiredDocument()).vms).toHaveLength(0);
  });

  it("refuses an explicitly requested host with too little CPU and writes no rows", async () => {
    // A requested host skips the ranked selection, so this is the path where a
    // start could otherwise commit a run that no host can hold. The refusal
    // must be the resource error and must leave no row behind.
    const fixture = await seedAdmissionFixture({
      hostCpuMillis: FIRST_VM_CPU_MILLIS - 1,
    });
    await expect(
      beginScenarioRun(fixture.input(RUNNER_USER_ID, { hostId: HOST_ID })),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_host_unavailable",
    });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
  });
  it("leaves no rows when memory is over the limit", async () => {
    const fixture = await seedAdmissionFixture({
      userIds: ["memory-user"],
      memoryAvailableMib: VM_MEMORY_MIB - 1,
    });
    await expect(
      beginScenarioRun(fixture.input("memory-user")),
    ).rejects.toMatchObject({ code: "scenario_host_unavailable" });
    // The requested host path makes the same decision without the selection.
    await expect(
      beginScenarioRun(fixture.input("memory-user", { hostId: HOST_ID })),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_host_unavailable",
    });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
  });

  it("leaves no rows when disk is over the limit", async () => {
    const fixture = await seedAdmissionFixture({
      userIds: ["disk-user"],
      diskAvailableMib: VM_DISK_MIB - 1,
    });
    await expect(
      beginScenarioRun(fixture.input("disk-user")),
    ).rejects.toMatchObject({ code: "scenario_host_unavailable" });
    // The requested host path makes the same decision without the selection.
    await expect(
      beginScenarioRun(fixture.input("disk-user", { hostId: HOST_ID })),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_host_unavailable",
    });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
  });

  it("cancels the run and clears the desired VM when the post-commit fence fails", async () => {
    const fixture = await seedAdmissionFixture();
    admissionHarness.armAfterAdmissionBatch(async () => {
      await revokeBetaUser({
        d1: env.DB,
        userId: RUNNER_USER_ID,
        actorUserId: FIXTURE_BETA_ADMIN_ID,
        reason: "admission_test_revoked_after_commit",
        now: Date.now(),
      });
    });

    await expect(
      beginScenarioRun(fixture.input(RUNNER_USER_ID)),
    ).rejects.toMatchObject({ status: 403, code: "beta_access_revoked" });

    const rows = await drizzle(env.DB)
      .select({
        runId: scenarioRuns.runId,
        state: scenarioRuns.state,
        deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      })
      .from(scenarioRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "teardown_requested" });
    expect(rows[0]?.deleteRequestedAt).not.toBeNull();
    const desired = await desiredDocument();
    expect(desired.version).toBe(2);
    expect(desired.vms).toHaveLength(1);
    expect(desired.vms[0]).toMatchObject({ desired_phase: "absent" });
  });

  describe("run start against the image collector", () => {
    it("holds the registry writer from the scenario read to the commit", async () => {
      const fixture = await seedAdmissionFixture();
      let releaseHeldBatch: () => void = () => {};
      const heldBatch = new Promise<void>((resolve) => {
        releaseHeldBatch = resolve;
      });
      let sweepInWindow: {
        ok: boolean;
        code?: string;
        pendingWriters?: number;
      } | null = null;
      admissionHarness.armBeforeAdmissionBatch(async () => {
        const attempt = await acquireRegistrySweep(env, {
          owner: "window-test-collector",
        });
        sweepInWindow = attempt.ok
          ? { ok: true }
          : {
              ok: false,
              code: attempt.code,
              pendingWriters: attempt.counts.pendingWriters,
            };
        await heldBatch;
      });

      // The start stops inside its admission batch, so it is past the scenario
      // source read and before the commit that publishes the run and its VMs.
      const held = beginScenarioRun(fixture.input(RUNNER_USER_ID));
      await vi.waitFor(() =>
        expect(admissionHarness.state.admissionBatches).toBe(1),
      );
      await expect(openWriterRows()).resolves.toBe(1);

      // A collector that tried to sweep in that window must not acquire: the
      // image reference of this run is not committed yet, so a sweep could
      // retire the candidate and delete the image the run is about to point at.
      expect(sweepInWindow).toEqual({
        ok: false,
        code: "registry_admission_busy",
        pendingWriters: 1,
      });

      releaseHeldBatch();
      const result = await held;
      await result.deliveryHint;
      expect(result.reused).toBe(false);
      await expect(admissionSnapshot()).resolves.toMatchObject({
        runs: 1,
        runtimeVms: 1,
        desiredVersion: 1,
      });
      // The release runs in the finally of the start, so the collector is free
      // again as soon as the batch has settled.
      await expect(openWriterRows()).resolves.toBe(0);
      const sweep = await acquireRegistrySweep(env, {
        owner: "window-test-collector",
      });
      expect(sweep.ok).toBe(true);
    });

    it("refuses a start while the collector holds the sweep", async () => {
      const sweep = await acquireRegistrySweep(env, {
        owner: "busy-test-collector",
      });
      if (!sweep.ok) {
        throw new Error(`the test sweep did not acquire: ${sweep.code}`);
      }
      const fixture = await seedAdmissionFixture();

      // A closed gate is a retryable busy, not a 500: the collector finishes
      // its bounded pass and the same idempotency key starts the run after it.
      await expect(
        beginScenarioRun(fixture.input(RUNNER_USER_ID)),
      ).rejects.toMatchObject({ status: 503, code: "registry_busy" });
      await expect(admissionSnapshot()).resolves.toEqual(
        emptyAdmissionSnapshot(),
      );
      expect(admissionHarness.state.admissionBatches).toBe(0);

      await finishRegistrySweep(env, {
        sweepToken: sweep.lease.sweepToken,
        outcome: "completed",
      });
      const admitted = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
      await admitted.deliveryHint;
      await expect(admissionSnapshot()).resolves.toMatchObject({
        runs: 1,
        desiredVersion: 1,
      });
    });

    it("names why the gate refused the internal writer", async () => {
      const sweep = await acquireRegistrySweep(env, {
        owner: "reason-test-collector",
      });
      if (!sweep.ok) {
        throw new Error(`the test sweep did not acquire: ${sweep.code}`);
      }
      await expect(
        admitInternalRegistryOperation(env, {
          operation: "run_start",
          owner: { kind: "system", id: "reason-test-user" },
        }),
      ).resolves.toEqual({ ok: false, reason: "registry_sweep_active" });

      await finishRegistrySweep(env, {
        sweepToken: sweep.lease.sweepToken,
        outcome: "completed",
      });
      const admitted = await admitInternalRegistryOperation(env, {
        operation: "run_start",
        owner: { kind: "system", id: "reason-test-user" },
      });
      if (!admitted.ok) {
        throw new Error(`the internal writer did not open: ${admitted.reason}`);
      }
      await expect(openWriterRows()).resolves.toBe(1);
      await admitted.lease.complete("ok");
      await expect(openWriterRows()).resolves.toBe(0);
    });

    it("refuses a candidate run whose candidate row left the commit window", async () => {
      const fixture = await seedAdmissionFixture();
      await seedCandidateProof({
        revision: CANDIDATE_REVISION_A,
        buildId: CANDIDATE_BUILD_A,
        scenarioId: SCENARIO_ID,
        organizationId: fixture.organizationId,
        imageSha256: IMAGE_SHA_ONE,
      });
      // A promotion retires the candidate row between the source read and the
      // commit. The shared writer does not serialize the start against another
      // shared writer, so only the commit anchor can catch this.
      admissionHarness.armBeforeAdmissionBatch(async () => {
        await env.DB.prepare(
          "DELETE FROM scenario_catalog_candidates WHERE id = ?1",
        )
          .bind(
            candidateScenarioId(
              fixture.organizationId,
              CANDIDATE_REVISION_A,
              SCENARIO_ID,
            ),
          )
          .run();
      });

      await expect(
        beginScenarioRun(fixture.input(RUNNER_USER_ID, candidateProofInput())),
      ).rejects.toMatchObject({
        status: 409,
        code: "scenario_candidate_not_ready",
      });
      // The refused insert rolls the whole batch back: no run, and no orphan
      // runtime execution or desired VM that no run can release.
      await expect(admissionSnapshot()).resolves.toEqual(
        emptyAdmissionSnapshot(),
      );
      expect((await desiredDocument()).vms).toHaveLength(0);
    });

    it("refuses a candidate run whose build artifacts were retired in the commit window", async () => {
      const fixture = await seedAdmissionFixture();
      await seedCandidateProof({
        revision: CANDIDATE_REVISION_A,
        buildId: CANDIDATE_BUILD_A,
        scenarioId: SCENARIO_ID,
        organizationId: fixture.organizationId,
        imageSha256: IMAGE_SHA_ONE,
      });
      admissionHarness.armBeforeAdmissionBatch(async () => {
        await env.DB.prepare(
          "UPDATE image_builds SET artifacts_retired_at = ?1 WHERE id = ?2",
        )
          .bind(Date.now(), CANDIDATE_BUILD_A)
          .run();
      });

      await expect(
        beginScenarioRun(fixture.input(RUNNER_USER_ID, candidateProofInput())),
      ).rejects.toMatchObject({
        status: 409,
        code: "scenario_candidate_not_ready",
      });
      await expect(admissionSnapshot()).resolves.toEqual(
        emptyAdmissionSnapshot(),
      );
    });

    it("refuses a candidate run whose manifest was rewritten in the commit window", async () => {
      const fixture = await seedAdmissionFixture();
      await seedCandidateProof({
        revision: CANDIDATE_REVISION_A,
        buildId: CANDIDATE_BUILD_A,
        scenarioId: SCENARIO_ID,
        organizationId: fixture.organizationId,
        imageSha256: IMAGE_SHA_ONE,
      });
      // A republish of the same revision and build rewrites the manifest of the
      // candidate row between the source read and the commit. The run was built
      // from the manifest the read returned, so the row no longer describes it
      // and the batch must refuse instead of committing an old spec.
      admissionHarness.armBeforeAdmissionBatch(async () => {
        const republished = candidateProofManifest(SCENARIO_ID, IMAGE_SHA_ONE);
        republished.title = "Republished candidate";
        await env.DB.prepare(
          "UPDATE scenario_catalog_candidates SET manifest_json = ?1, updated_at = ?2" +
            " WHERE id = ?3",
        )
          .bind(
            JSON.stringify(republished),
            Date.now(),
            candidateScenarioId(
              fixture.organizationId,
              CANDIDATE_REVISION_A,
              SCENARIO_ID,
            ),
          )
          .run();
      });

      await expect(
        beginScenarioRun(fixture.input(RUNNER_USER_ID, candidateProofInput())),
      ).rejects.toMatchObject({
        status: 409,
        code: "scenario_candidate_not_ready",
      });
      await expect(admissionSnapshot()).resolves.toEqual(
        emptyAdmissionSnapshot(),
      );
      expect((await desiredDocument()).vms).toHaveLength(0);
    });

    it("keeps a committed candidate run whole and leaves no writer behind", async () => {
      const fixture = await seedAdmissionFixture();
      await seedCandidateProof({
        revision: CANDIDATE_REVISION_A,
        buildId: CANDIDATE_BUILD_A,
        scenarioId: SCENARIO_ID,
        organizationId: fixture.organizationId,
        imageSha256: IMAGE_SHA_ONE,
      });

      const result = await beginScenarioRun(
        fixture.input(RUNNER_USER_ID, candidateProofInput()),
      );
      await result.deliveryHint;

      // Every row the retention projection and the host both read is present:
      // the run, its runtime VM mirror, its desired VM, and the capacity
      // reservation. The start's writer is gone, so the next sweep can run.
      await expect(admissionSnapshot()).resolves.toMatchObject({
        runs: 1,
        sshKeys: 1,
        runtimeExecutions: 1,
        runtimeVms: 1,
        accessKeys: 1,
        cpuReservations: 1,
        cpuMillis: FIRST_VM_CPU_MILLIS,
        resourceReservations: 1,
        activeSlots: 1,
        desiredVersion: 1,
      });
      expect(await loadRunRow(result.runId)).toMatchObject({
        userId: RUNNER_USER_ID,
        scenarioId: SCENARIO_ID,
        hostId: HOST_ID,
        state: "provisioning",
      });
      expect((await desiredDocument()).vms).toHaveLength(1);
      await expect(openWriterRows()).resolves.toBe(0);
    });

    it("refuses a live start for each identity field a publish can replace", async () => {
      const fixture = await seedAdmissionFixture();
      // A live row has no candidate proof to anchor on, so a publish can
      // replace the image of the scenario between the source read and the
      // commit. The run was built from what the read returned, so the batch
      // must refuse instead of launching an image the read never saw. One
      // field changes per attempt, so every comparison in the anchor carries
      // its own evidence: drop a single one and that attempt commits.
      const replacements = [
        { label: "image id", set: "image_sha256 = ?1", value: "9".repeat(64) },
        {
          label: "chunk manifest",
          set: "chunk_manifest_sha256 = ?1",
          value: "7".repeat(64),
        },
        { label: "kernel", set: "kernel_sha256 = ?1", value: "8".repeat(64) },
        { label: "initrd", set: "initrd_sha256 = ?1", value: "6".repeat(64) },
        {
          label: "key arch",
          set: "image_key_json = json_set(image_key_json, '$.arch', ?1)",
          value: "aarch64",
        },
        {
          label: "key vm",
          set: "image_key_json = json_set(image_key_json, '$.vm', ?1)",
          value: "database",
        },
        {
          label: "key scenario",
          set: "image_key_json = json_set(image_key_json, '$.scenario', ?1)",
          value: "other-scenario",
        },
        { label: "vm name", set: "vm_name = ?1", value: "database" },
      ];
      for (const replacement of replacements) {
        admissionHarness.armBeforeAdmissionBatch(async () => {
          await env.DB.prepare(
            "UPDATE vm_scenario_vms SET " +
              replacement.set +
              " WHERE id = ?2",
          )
            .bind(replacement.value, SEEDED_VM_ROW_ID)
            .run();
        });
        await expect(
          beginScenarioRun(
            fixture.input(RUNNER_USER_ID, {
              idempotencyKey: `identity-${replacement.label.replaceAll(" ", "-")}`,
            }),
          ),
          replacement.label,
        ).rejects.toMatchObject({
          status: 409,
          code: "scenario_source_changed",
        });
        await restoreSeededScenarioVmRow();
      }
      // Every refused insert rolled its whole batch back: no run, no orphan
      // runtime execution, and no desired VM that no run can release.
      await expect(admissionSnapshot()).resolves.toEqual(
        emptyAdmissionSnapshot(),
      );
      expect((await desiredDocument()).vms).toHaveLength(0);
      await expect(openWriterRows()).resolves.toBe(0);
    });

    it("refuses a live start when the scenario gains a VM in the commit window", async () => {
      const fixture = await seedAdmissionFixture();
      // The count is part of the anchor, so a VM that appears inside the window
      // refuses the run instead of committing a one-VM launch spec for a
      // scenario that now declares two.
      admissionHarness.armBeforeAdmissionBatch(async () => {
        await drizzle(env.DB)
          .insert(vmScenarioVms)
          .values({
            id: `${SCENARIO_ID}:database`,
            scenarioId: SCENARIO_ID,
            ordinal: 1,
            vmName: "database",
            image: `${SCENARIO_ID}-database-x86_64.raw_chunks.json`,
            imageKeyJson: {
              scenario: SCENARIO_ID,
              vm: "database",
              arch: "x86_64",
            },
            imageSha256: "5".repeat(64),
            imageFormat: "raw_chunks_v1",
            imageVirtualSizeBytes: 1_073_741_824,
            chunkManifestSha256: "d".repeat(64),
            guestBootstrapAbi: SCENARIO_VM_GUEST_BOOTSTRAP_ABI,
            kernelSha256: "a".repeat(64),
            initrdSha256: "b".repeat(64),
            bootCmdline: "root=/dev/vda rw",
            cpuMillis: FIRST_VM_CPU_MILLIS,
            memoryMib: VM_MEMORY_MIB,
            diskMib: VM_DISK_MIB,
          });
      });

      await expect(
        beginScenarioRun(fixture.input(RUNNER_USER_ID)),
      ).rejects.toMatchObject({
        status: 409,
        code: "scenario_source_changed",
      });
      await expect(admissionSnapshot()).resolves.toEqual(
        emptyAdmissionSnapshot(),
      );
    });

    it("keeps a legacy live start whose image has no chunk manifest", async () => {
      const fixture = await seedAdmissionFixture();
      // A legacy image has no chunk manifest, so the fingerprint carries null
      // for that field. The anchor compares null-safely: an absent manifest
      // matches an absent manifest instead of refusing a launchable image.
      await env.DB.prepare(
        "UPDATE vm_scenario_vms SET image_format = 'raw_zstd'," +
          " chunk_manifest_sha256 = NULL, guest_bootstrap_abi = NULL" +
          " WHERE scenario_id = ?1",
      )
        .bind(SCENARIO_ID)
        .run();

      const result = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
      await result.deliveryHint;

      expect(result.reused).toBe(false);
      await expect(admissionSnapshot()).resolves.toMatchObject({
        runs: 1,
        runtimeVms: 1,
        desiredVersion: 1,
      });
      expect((await desiredDocument()).vms).toHaveLength(1);
      await expect(openWriterRows()).resolves.toBe(0);
    });

    it("keeps a live start when only metadata changes in the commit window", async () => {
      const fixture = await seedAdmissionFixture();
      // The anchor covers image identity, not presentation: the run carries the
      // briefing, the probes, and the resources of the read it did, so a title
      // or description edit inside the window cannot make the launch spec
      // inconsistent with the catalog row it came from.
      admissionHarness.armBeforeAdmissionBatch(async () => {
        const now = Date.now();
        await drizzle(env.DB)
          .update(vmScenarios)
          .set({
            title: `${SCENARIO_ID} renamed`,
            description: "renamed while the run was starting",
            updatedAt: now,
          })
          .where(eq(vmScenarios.scenarioId, SCENARIO_ID));
      });

      const result = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
      await result.deliveryHint;

      expect(result.reused).toBe(false);
      await expect(admissionSnapshot()).resolves.toMatchObject({
        runs: 1,
        sshKeys: 1,
        runtimeExecutions: 1,
        runtimeVms: 1,
        accessKeys: 1,
        cpuReservations: 1,
        resourceReservations: 1,
        activeSlots: 1,
        desiredVersion: 1,
      });
      expect((await desiredDocument()).vms).toHaveLength(1);
      await expect(openWriterRows()).resolves.toBe(0);
    });
  });
});

/** The candidate proof arguments that the fixture can start from. */
function candidateProofInput(): Partial<BeginScenarioRunInput> {
  return {
    candidateRevision: CANDIDATE_REVISION_A,
    candidateBuildId: CANDIDATE_BUILD_A,
    allowDrainedAdminProof: true,
  };
}

interface AdmissionFixture {
  hostId: string;
  organizationId: string;
  keyFor(userId: string): string;
  /** Seeds one more beta user for this host and returns that user's input. */
  addUser(userId: string): Promise<BeginScenarioRunInput>;
  input(userId: string, overrides?: Partial<BeginScenarioRunInput>): BeginScenarioRunInput;
}

interface AdmissionFixtureOptions {
  userIds?: string[];
  hostCpuMillis?: number;
  memoryAvailableMib?: number;
  diskAvailableMib?: number;
  withSecondScenario?: boolean;
}

async function seedAdmissionFixture(
  options: AdmissionFixtureOptions = {},
): Promise<AdmissionFixture> {
  const userIds = options.userIds ?? [RUNNER_USER_ID];
  const fixture = await seedHostAndCatalog({
    ...options,
    userIds,
  });
  return fixture;
}

/**
 * Seeds the candidate proof a candidate start commits from: the bundle rev the
 * build references, the succeeded build, and the candidate row. The candidate
 * source read is mocked in this file, but the commit anchor of the start reads
 * these rows, so a test can retire one of them inside the commit window.
 */
async function seedCandidateProof(input: {
  revision: string;
  buildId: string;
  scenarioId: string;
  organizationId: string | null;
  imageSha256: string;
  contentHash?: string;
}): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const bundleRev = `${input.buildId}-bundle`;
  const contentHash = input.contentHash ?? CANDIDATE_CONTENT_HASH;
  const manifest = candidateProofManifest(input.scenarioId, input.imageSha256);
  await db.insert(imageBuildBundles).values({
    rev: bundleRev,
    organizationId: input.organizationId,
    r2Key: `builds/bundles/${bundleRev}.json`,
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "candidate",
      scenarios: [
        {
          scenarioId: input.scenarioId,
          arch: "x86_64",
          contentHash,
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(imageBuilds).values({
    id: input.buildId,
    organizationId: input.organizationId,
    scenarioId: input.scenarioId,
    arch: "x86_64",
    rev: bundleRev,
    contentHash,
    catalogChannel: "candidate",
    status: "succeeded",
    publishedManifestJson: manifest,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(scenarioCatalogCandidates).values({
    id: candidateScenarioId(
      input.organizationId,
      input.revision,
      input.scenarioId,
    ),
    revision: input.revision,
    organizationId: input.organizationId,
    scenarioId: input.scenarioId,
    buildId: input.buildId,
    manifestJson: manifest,
    createdAt: now,
    updatedAt: now,
  });
}

/** One scenario VM, so the seeded candidate describes the seeded host image. */
function candidateProofManifest(
  scenarioId: string,
  imageSha256: string,
): ScenarioManifestV5 {
  return {
    schema_version: 5,
    scenario_id: scenarioId,
    name: scenarioId,
    title: scenarioId,
    category: "test",
    description: `${scenarioId} candidate`,
    difficulty: "easy",
    estimated_minutes: 15,
    tags: [],
    briefing_markdown: `# ${scenarioId}`,
    solution_markdown: "solution",
    hints: [],
    vms: [
      {
        name: "webserver",
        image_key: { scenario: scenarioId, vm: "webserver", arch: "x86_64" },
        image_id: imageSha256,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: 1_073_741_824,
        chunk_manifest_sha256: "d".repeat(64),
        guest_bootstrap_abi: SCENARIO_VM_GUEST_BOOTSTRAP_ABI,
        boot: {
          kernel_sha256: "a".repeat(64),
          initrd_sha256: "b".repeat(64),
          cmdline: "console=hvc0 root=/dev/vda rw",
        },
        cpu_millis: FIRST_VM_CPU_MILLIS,
        memory_mib: VM_MEMORY_MIB,
        disk_mib: VM_DISK_MIB,
        probes: [],
      },
    ],
  };
}

/** The shared registry writers that still hold the collector, if any. */
async function openWriterRows(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM image_registry_operation_writers" +
      " WHERE released_at IS NULL OR outcome = 'unknown'",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Puts the seeded VM row back to the identity the fixture publishes, so one
 * test can replace field after field against the same scenario.
 */
async function restoreSeededScenarioVmRow(): Promise<void> {
  await env.DB.prepare(
    "UPDATE vm_scenario_vms SET vm_name = 'webserver'," +
      " image_key_json = ?1, image_sha256 = ?2, chunk_manifest_sha256 = ?3," +
      " kernel_sha256 = ?4, initrd_sha256 = ?5 WHERE id = ?6",
  )
    .bind(
      JSON.stringify({ scenario: SCENARIO_ID, vm: "webserver", arch: "x86_64" }),
      IMAGE_SHA_ONE,
      SCENARIO_VM_CHUNK_MANIFEST_SHA,
      SCENARIO_VM_KERNEL_SHA,
      SCENARIO_VM_INITRD_SHA,
      SEEDED_VM_ROW_ID,
    )
    .run();
}

async function seedHostAndCatalog(input: {
  userIds: string[];
  hostCpuMillis?: number;
  memoryAvailableMib?: number;
  diskAvailableMib?: number;
  withSecondScenario?: boolean;
}): Promise<AdmissionFixture> {
  const now = Date.now();
  const db = drizzle(env.DB);
  const organizationId = "admission-organization";

  await db.insert(organization).values({
    id: organizationId,
    name: organizationId,
    slug: organizationId,
    createdAt: new Date(now),
  });
  const seedUser = createUserSeeder(now, organizationId);
  for (const userId of input.userIds) {
    await seedUser(userId);
  }

  const scenarios = [
    { scenarioId: SCENARIO_ID, imageSha256: IMAGE_SHA_ONE },
    {
      scenarioId: SECOND_SCENARIO_ID,
      imageSha256: "3".repeat(64),
    },
    {
      scenarioId: THIRD_SCENARIO_ID,
      imageSha256: "4".repeat(64),
    },
  ];
  for (const scenario of scenarios) {
    await insertScenario(db, scenario.scenarioId, scenario.imageSha256, now);
  }

  await syncCourseCatalogSnapshot(db, {
    snapshot: courseCatalog(),
    sourceRevision: "admission-fixture",
    organizationId: null,
    nowUnixMs: now,
  });
  await syncCourseCatalogSnapshot(db, {
    snapshot: organizationCourseCatalog(),
    sourceRevision: "admission-fixture",
    organizationId,
    nowUnixMs: now,
  });

  const hostId = HOST_ID;
  await db.insert(agentHosts).values({
    id: hostId,
    userId: input.userIds[0] as string,
    // The host belongs to the fixture organization, so every seeded member
    // of that organization can start on it.
    organizationId,
    name: hostId,
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
    connected: true,
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(hostActualState).values({
    hostId,
    appliedDesiredVersion: 0,
    observedAt: now,
    reportJson: hostReport({
      hostId,
      now,
      schedulableCpuMillis: input.hostCpuMillis ?? HOST_CPU_MILLIS,
      memoryAvailableMib: input.memoryAvailableMib ?? 4_096,
      diskAvailableMib: input.diskAvailableMib ?? 80_000,
      images: (input.withSecondScenario
        ? scenarios
        : scenarios.slice(0, 1)
      ).map((scenario) => ({
        imageKey: {
          scenario: scenario.scenarioId,
          vm: "webserver",
          arch: "x86_64" as const,
        },
        imageSha256: scenario.imageSha256,
      })),
    }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(hostDesiredState).values({
    hostId,
    version: 0,
    docJson: createEmptyHostDesiredState({ hostId, nowUnixMs: now }),
    createdAt: now,
    updatedAt: now,
  });

  const admissions = new Map<string, BetaAdmissionEpoch>();
  for (const userId of input.userIds) {
    const [access] = await db
      .select({
        sourceInviteId: accessAllowlist.sourceInviteId,
        sourceLeaseId: accessAllowlist.sourceLeaseId,
        grantedAt: accessAllowlist.grantedAt,
      })
      .from(accessAllowlist)
      .where(eq(accessAllowlist.userId, userId))
      .limit(1);
    if (!access) {
      throw new Error(`beta admission fixture is missing for ${userId}`);
    }
    admissions.set(userId, access);
  }

  const addUser = createUserSeeder(now, organizationId);

  return {
    hostId,
    organizationId,
    keyFor: (userId: string) => `${userId}-admission-key`,
    async addUser(userId: string) {
      await addUser(userId);
      const betaAdmission = await loadAdmissionEpoch(userId);
      admissions.set(userId, betaAdmission);
      return {
        scenarioId: SCENARIO_ID,
        userId,
        betaAdmission,
      idempotencyKey: `${userId}-admission-key`,
        organizationId,
        hostId,
      } satisfies BeginScenarioRunInput;
    },
    input(userId, overrides = {}) {
      const betaAdmission = admissions.get(userId);
      if (!betaAdmission) {
        throw new Error(`beta admission fixture is missing for ${userId}`);
      }
      return {
        scenarioId: SCENARIO_ID,
        userId,
        betaAdmission,
        idempotencyKey: `${userId}-admission-key`,
        organizationId,
        hostId,
        ...overrides,
      } satisfies BeginScenarioRunInput;
    },
  };
}

/**
 * Seeds one beta-accessible user for the admission fixtures. Each user gets
 * its own GitHub account and invitation, so one test can admit several
 * users to the same host.
 */
function createUserSeeder(
  startNow: number,
  organizationId: string,
): (userId: string) => Promise<void> {
  let index = 0;
  return async (userId: string) => {
    const now = startNow + index;
    index += 1;
    await drizzle(env.DB).insert(user).values({
      id: userId,
      name: userId,
      email: `${userId}@example.test`,
      emailVerified: true,
      username: userId,
      role: "user",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await grantFixtureBetaAccess({
      d1: env.DB,
      userId,
      githubAccountId: `${userId}-github`,
      githubUsername: userId,
      now,
    });
    // The course gate resolves the organization catalog through a membership
    // row, so every fixture user must be a member of the fixture organization.
    await drizzle(env.DB).insert(member).values({
      id: `${organizationId}:${userId}`,
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(now),
    });
  };
}

/** Reads the live beta admission epoch of one seeded user. */
async function loadAdmissionEpoch(userId: string): Promise<BetaAdmissionEpoch> {
  const [access] = await drizzle(env.DB)
    .select({
      sourceInviteId: accessAllowlist.sourceInviteId,
      sourceLeaseId: accessAllowlist.sourceLeaseId,
      grantedAt: accessAllowlist.grantedAt,
    })
    .from(accessAllowlist)
    .where(eq(accessAllowlist.userId, userId))
    .limit(1);
  if (!access) {
    throw new Error(`beta admission fixture is missing for ${userId}`);
  }
  return access;
}

async function seedForeignActiveSlot(userId: string): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(runtimeExecutions).values({
    id: `${userId}-foreign-execution`,
    userId,
    organizationId: null,
    hostId: HOST_ID,
    providerKind: "agent_kvm",
    providerConnectionId: null,
    domainKind: "scenario",
    domainId: `${userId}-foreign-execution`,
    generation: 1,
    sourceExecutionId: null,
    checkpointId: null,
    state: "provisioning",
    leaseExpiresAt: null,
    archiveRequestedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(activeRuntimeSlots)
    .values({
      userId,
      executionId: `${userId}-foreign-execution`,
      acquiredAt: now,
    });
}

async function insertScenario(
  db: ReturnType<typeof drizzle>,
  scenarioId: string,
  imageSha256: string,
  now: number,
): Promise<void> {
  await db.insert(vmScenarios).values({
    scenarioId,
    organizationId: null,
    title: scenarioId,
    category: "test",
    description: `${scenarioId} description`,
    difficulty: "easy",
    estimatedMinutes: 15,
    tagsJson: [],
    briefingMarkdown: `# ${scenarioId}`,
    solutionMarkdown: "solution",
    hintsJson: [],
    enabled: true,
    enabledAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(vmScenarioVms).values({
    id: `${scenarioId}:webserver`,
    scenarioId,
    ordinal: 0,
    vmName: "webserver",
    image: `${scenarioId}-webserver-x86_64.raw_chunks.json`,
    imageKeyJson: { scenario: scenarioId, vm: "webserver", arch: "x86_64" },
    imageSha256,
    imageFormat: "raw_chunks_v1",
    imageVirtualSizeBytes: 1_073_741_824,
    chunkManifestSha256: SCENARIO_VM_CHUNK_MANIFEST_SHA,
    guestBootstrapAbi: SCENARIO_VM_GUEST_BOOTSTRAP_ABI,
    kernelSha256: SCENARIO_VM_KERNEL_SHA,
    initrdSha256: SCENARIO_VM_INITRD_SHA,
    bootCmdline: "root=/dev/vda rw",
    cpuMillis: FIRST_VM_CPU_MILLIS,
    memoryMib: VM_MEMORY_MIB,
    diskMib: VM_DISK_MIB,
  });
}

function lecture(
  lectureId: string,
  scenarioId: string,
): CourseCatalogLectureV2 {
  return {
    lectureId,
    title: lectureId,
    summary: `${lectureId} summary`,
    bodyMarkdown: `${lectureId} body`,
    category: "test",
    tags: ["test"],
    difficulty: "easy",
    estimatedMinutes: 15,
    scenarioId,
  };
}

function courseCatalog(): CourseCatalogSnapshotV2 {
  return {
    version: 2,
    courses: [
      {
        courseId: "admission-course",
        title: "Admission course",
        summary: "Admission course",
        bodyMarkdown: "Admission course",
        sequential: true,
        lectures: [lecture("first-lecture", SCENARIO_ID)],
      },
      {
        courseId: "second-course",
        title: "Second course",
        summary: "Second course",
        bodyMarkdown: "Second course",
        sequential: true,
        lectures: [lecture("second-lecture", SECOND_SCENARIO_ID)],
      },
    ],
  };
}

/**
 * The organization catalog holds a different scenario, so the public catalog
 * still serves the two test scenarios to a request with an organization.
 */
function organizationCourseCatalog(): CourseCatalogSnapshotV2 {
  return {
    version: 2,
    courses: [
      {
        courseId: "organization-course",
        title: "Organization course",
        summary: "Organization course",
        bodyMarkdown: "Organization course",
        sequential: true,
        lectures: [lecture("organization-lecture", THIRD_SCENARIO_ID)],
      },
    ],
  };
}

function hostReport(input: {
  hostId: string;
  now: number;
  schedulableCpuMillis: number;
  memoryAvailableMib: number;
  diskAvailableMib: number;
  images: Array<{
    imageKey: { scenario: string; vm: string; arch: "x86_64" };
    imageSha256: string;
  }>;
}): typeof hostActualState.$inferInsert.reportJson {
  return {
    schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
    host_id: input.hostId,
    observed_at_unix_ms: input.now,
    applied_desired_version: 0,
    capacity: {
      total_cpu_millis: input.schedulableCpuMillis + 1_000,
      reserved_cpu_millis: 1_000,
      schedulable_cpu_millis: input.schedulableCpuMillis,
      committed_cpu_millis: 0,
      memory_total_mib: 8_192,
      memory_available_mib: input.memoryAvailableMib,
      disk_probe_path: "/var/lib/intar-agent",
      disk_total_mib: 100_000,
      disk_available_mib: input.diskAvailableMib,
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
    },
    cached_images: input.images.map((image) => ({
      image_key: image.imageKey,
      image_id: image.imageSha256,
      phase: "ready",
    })),
    vms: [],
    builds: [],
  } as unknown as typeof hostActualState.$inferInsert.reportJson;
}

interface AdmissionSnapshot {
  runs: number;
  sshKeys: number;
  runtimeExecutions: number;
  runtimeVms: number;
  accessKeys: number;
  cpuReservations: number;
  cpuMillis: number;
  resourceReservations: number;
  activeSlots: number;
  desiredVersion: number | null;
}

function emptyAdmissionSnapshot(): AdmissionSnapshot {
  return {
    runs: 0,
    sshKeys: 0,
    runtimeExecutions: 0,
    runtimeVms: 0,
    accessKeys: 0,
    cpuReservations: 0,
    cpuMillis: 0,
    resourceReservations: 0,
    activeSlots: 0,
    desiredVersion: 0,
  };
}

async function admissionSnapshot(): Promise<AdmissionSnapshot> {
  const row = await env.DB.prepare(
    "SELECT" +
      " (SELECT count(*) FROM scenario_runs) AS runs," +
      " (SELECT count(*) FROM scenario_run_ssh_keys) AS sshKeys," +
      " (SELECT count(*) FROM runtime_executions) AS runtimeExecutions," +
      " (SELECT count(*) FROM runtime_vms) AS runtimeVms," +
      " (SELECT count(*) FROM runtime_vm_access_keys) AS accessKeys," +
      " (SELECT count(*) FROM host_cpu_reservations) AS cpuReservations," +
      " (SELECT coalesce(sum(cpu_millis), 0) FROM host_cpu_reservations) AS cpuMillis," +
      " (SELECT count(*) FROM host_resource_reservations) AS resourceReservations," +
      " (SELECT count(*) FROM active_runtime_slots) AS activeSlots," +
      " (SELECT version FROM host_desired_state WHERE host_id = ?1) AS desiredVersion",
  )
    .bind(HOST_ID)
    .first<AdmissionSnapshot>();
  return row ?? emptyAdmissionSnapshot();
}

async function desiredDocument(): Promise<{
  version: number;
  vms: Array<{ run_id: string; desired_phase: string; image_id: string }>;
}> {
  const row = await env.DB.prepare(
    "SELECT doc_json FROM host_desired_state WHERE host_id = ?1",
  )
    .bind(HOST_ID)
    .first<{ doc_json: string }>();
  if (!row) {
    throw new Error("desired-state row is missing");
  }
  return JSON.parse(row.doc_json) as {
    version: number;
    vms: Array<{ run_id: string; desired_phase: string; image_id: string }>;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadRunRow(runId: string) {
  const [row] = await drizzle(env.DB)
    .select()
    .from(scenarioRuns)
    .where(eq(scenarioRuns.runId, runId))
    .limit(1);
  return row ?? null;
}

async function storedRunRows(): Promise<Array<{ runId: string; userId: string }>> {
  return drizzle(env.DB)
    .select({ runId: scenarioRuns.runId, userId: scenarioRuns.userId })
    .from(scenarioRuns);
}

function assertRejected(
  results: PromiseSettledResult<unknown>[],
  statuses: number[],
  codes?: string[],
): void {
  for (const entry of results) {
    expect(entry.status).toBe("rejected");
    const error = (entry as PromiseRejectedResult).reason as {
      status?: number;
      code?: string;
      message?: string;
    };
    const reason = `rejected with ${String(error.status)} ${String(error.code)}: ${
      error.message ?? String(error)
    }`;
    expect(statuses, reason).toContain(error.status);
    if (codes) {
      expect(codes, reason).toContain(error.code);
    }
  }
}

async function settleDeliveryHints(
  results: PromiseSettledResult<
    Awaited<ReturnType<typeof beginScenarioRun>>
  >[],
): Promise<void> {
  for (const entry of results) {
    if (entry.status === "fulfilled") {
      await entry.value.deliveryHint;
    }
  }
}
