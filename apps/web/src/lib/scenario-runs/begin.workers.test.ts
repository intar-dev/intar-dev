/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * Behavioural tests for the single-batch scenario admission.
 *
 * The test client wraps env.DB.batch so a test can inject one deterministic
 * event between the capacity read and the commit, or directly after the
 * commit. The wrapper finds the admission batch by its own SQL, so it never
 * depends on how many read batches the caller makes.
 *
 * These tests use the real D1 schema, the real admission code, and the real
 * host runtime wake path, against live scenario revisions.
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
  activeRuntimeSlots,
  agentHosts,
  hostActualState,
  courseCatalogs,
  hostDesiredState,
  member,
  organization,
  runtimeExecutions,
  scenarioRevisions,
  scenarios,
  scenarioRuns,
  user,
  runtimeOperationGates,
} from "@/db/schema";
import { setPlatformUserRole } from "@/lib/platform-admin-authority";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { emptyDesiredState } from "@/control-plane/host-runtime-do/test-fixtures";
import type { HostStateReportV3 } from "@/generated/contracts/bridge-message-v9";
import {
  acquireRegistrySweep,
  admitInternalRegistryOperation,
  finishRegistrySweep,
} from "@/lib/image-registry-admission";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import {
  HARDWARE,
  KINO,
  machineImage,
  revisionDoc,
  specBlob,
  store,
} from "./revision-test-fixtures";
import { beginScenarioRun, type BeginScenarioRunInput } from "@/lib/scenario-runs/begin";
import {
  FIXTURE_ADMIN_ID,
  ensureFixtureMember,
  revokeFixtureAccount,
} from "@/test/account-fixtures";
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

const HOST_ID = "admission-runner";
const SCENARIO_ID = "intar/scenario-one";
const SECOND_SCENARIO_ID = "intar/scenario-two";
/** Owned by the fixture organization. */
const THIRD_SCENARIO_ID = "admission-organization/scenario-three";
const RUNNER_USER_ID = "admission-user";
const FIRST_VM_CPU_MILLIS = 1_000;
const VM_MEMORY_MIB = 512;
const VM_DISK_MIB = 4_096;
const HOST_CPU_MILLIS = 8_000;

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
    // opened after the key validation.
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
      image: fixture.images[SCENARIO_ID],
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

  it.each([
      ["membership removed", "DELETE FROM member"],
      ["catalog removed", "DELETE FROM course_catalogs WHERE scope_key = 'public'"],
      ["lecture unlinked", "UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].lectures[0].scenarioId', NULL) WHERE scope_key = 'public'"],
      ["public lecture hidden by organization", `UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].lectures[0].scenarioId', '${SCENARIO_ID}') WHERE organization_id IS NOT NULL`],
      ["new incomplete prerequisite", "UPDATE course_catalogs SET catalog_json = json_insert(catalog_json, '$.courses[0].lectures[#]', json_extract(catalog_json, '$.courses[0].lectures[0]')) WHERE scope_key = 'public'; UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].lectures[0].lectureId', 'new-prerequisite', '$.courses[0].lectures[0].scenarioId', NULL) WHERE scope_key = 'public'"],
    ])("rolls back content and slots when %s before commit", async (_name, sql) => {
      const fixture = await seedAdmissionFixture();
      admissionHarness.armBeforeAdmissionBatch(async () => {
        // The admission statements are already prepared and bound here.
        for (const statement of sql.split("; ")) await env.DB.prepare(statement).run();
      });
      await expect(beginScenarioRun(fixture.input(RUNNER_USER_ID))).rejects.toMatchObject({
        code: "scenario_content_access_changed",
      });
      await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
      expect((await desiredDocument()).vms).toEqual([]);
      expect(admissionHarness.state.admissionBatches).toBe(1);
      expect(admissionHarness.eventIndex(`host-runtime-id:${HOST_ID}`)).toBe(-1);
  });

  it.each(["moves", "is disabled"])("refuses a start whose live revision %s in the commit window", async (change) => {
    const fixture = await seedAdmissionFixture();
    admissionHarness.armBeforeAdmissionBatch(async () => {
      if (change === "is disabled") {
        await env.DB.prepare("UPDATE scenarios SET enabled = 0 WHERE id = ?1").bind(SCENARIO_ID).run();
        return;
      }
      await drizzle(env.DB).insert(scenarioRevisions).values({
        scenarioId: SCENARIO_ID, rev: "r2", guestContract: 3, docJson: fixture.docs[SCENARIO_ID]!, state: "ready",
      });
      await env.DB.prepare("UPDATE scenarios SET live_rev = 'r2' WHERE id = ?1").bind(SCENARIO_ID).run();
    });
    await expect(beginScenarioRun(fixture.input(RUNNER_USER_ID))).rejects.toMatchObject({
      status: 409,
      code: "scenario_source_changed",
    });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
    expect((await desiredDocument()).vms).toEqual([]);
  });

  for (const automatic of [false, true]) {
    it.each([
      ["disconnected", "UPDATE agent_hosts SET connected = 0, active_session_id = NULL"],
      ["credential rotated", "UPDATE agent_hosts SET credential_generation = credential_generation + 1, active_session_id = NULL"],
      ["session cleared", "UPDATE agent_hosts SET active_session_id = NULL"],
      ["heartbeat expired", "UPDATE agent_hosts SET last_heartbeat_at = 1"],
      ["report expired", "UPDATE host_actual_state SET updated_at = 1"],
      ["hardware lost KVM", "UPDATE host_actual_state SET report_json = json_set(report_json, '$.hardware.kvm', json('false'))"],
      ["capacity reduced", "UPDATE host_actual_state SET report_json = json_set(report_json, '$.capacity.memory_available_mib', 0)"],
    ])(`refuses ${automatic ? "automatic" : "explicit"} admission when host %s before commit`, async (_name, sql) => {
      const fixture = await seedAdmissionFixture();
      admissionHarness.armBeforeAdmissionBatch(() => env.DB.prepare(sql).run());
      const input = fixture.input(RUNNER_USER_ID);
      if (automatic) delete input.hostId;
      await expect(beginScenarioRun(input)).rejects.toMatchObject({ status: 409 });
      await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
      expect((await desiredDocument()).vms).toEqual([]);
      expect(admissionHarness.eventIndex(`host-runtime-id:${HOST_ID}`)).toBe(-1);
    });
  }

  it.each([
    ["session", "UPDATE agent_hosts SET active_session_id = 'replacement-session'"],
    ["credential generation", "UPDATE agent_hosts SET credential_generation = credential_generation + 1"],
    ["report bytes at the same timestamp", "UPDATE host_actual_state SET report_json = json_set(report_json, '$.capacity.memory_available_mib', 4095)"],
    ["report timestamp", "UPDATE host_actual_state SET updated_at = updated_at + 1"],
  ])("retries from fresh reads after a changed %s invalidates the prepared batch", async (_name, sql) => {
    const fixture = await seedAdmissionFixture();
    admissionHarness.armBeforeAdmissionBatch(async () => {
      await env.DB.prepare(sql).run();
      admissionHarness.armBeforeAdmissionBatch(async () => {
        await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
        expect((await desiredDocument()).vms).toEqual([]);
      });
    });
    const result = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await result.deliveryHint;
    expect(admissionHarness.state.admissionBatches).toBe(2);
    expect(admissionHarness.state.admissionChanges).toHaveLength(1);
    await expect(admissionSnapshot()).resolves.toMatchObject({ runs: 1, activeSlots: 1, desiredVersion: 1 });
  });

  it("admits a public live start without an organization membership", async () => {
    const fixture = await seedAdmissionFixture();
    await env.DB.prepare("DELETE FROM member").run();
    const input = fixture.input(RUNNER_USER_ID);
    delete input.organizationId;
    const result = await beginScenarioRun(input);
    await result.deliveryHint;
    expect(result.accepted).toBe(true);
  });

  it("admits current organization content through its private course", async () => {
    const fixture = await seedAdmissionFixture({ withSecondScenario: true });
    const result = await beginScenarioRun(fixture.input(RUNNER_USER_ID, { scenarioId: THIRD_SCENARIO_ID }));
    await result.deliveryHint;
    expect(await loadRunRow(result.runId)).toMatchObject({
      courseScopeKey: "organization:" + fixture.organizationId,
      courseId: "organization-course",
    });
  });

  it.each(["completed", "nonsequential", "admin bypass"])(
    "keeps valid course access with a %s prerequisite at commit",
    async (mode) => {
      const fixture = await seedAdmissionFixture();
      if (mode === "admin bypass") {
        await drizzle(env.DB).update(user).set({ role: "admin" }).where(eq(user.id, RUNNER_USER_ID));
      }
      admissionHarness.armBeforeAdmissionBatch(async () => {
        await env.DB.prepare("UPDATE course_catalogs SET catalog_json = json_insert(catalog_json, '$.courses[0].lectures[#]', json_extract(catalog_json, '$.courses[0].lectures[0]')) WHERE scope_key = 'public'").run();
        await env.DB.prepare("UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].lectures[0].lectureId', 'new-prerequisite', '$.courses[0].lectures[0].scenarioId', NULL) WHERE scope_key = 'public'").run();
        if (mode === "completed") {
          await env.DB.prepare("INSERT INTO course_unit_completions (user_id, scope_key, course_id, lecture_id, completed_at) VALUES (?1, 'public', 'admission-course', 'new-prerequisite', ?2)")
            .bind(RUNNER_USER_ID, Date.now()).run();
        } else if (mode === "nonsequential") {
          await env.DB.prepare("UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].sequential', json('false')) WHERE scope_key = 'public'").run();
        }
      });
      const result = await beginScenarioRun(fixture.input(RUNNER_USER_ID, {
        allowSequenceBypass: mode === "admin bypass",
      }));
      await result.deliveryHint;
      expect(admissionHarness.state.admissionBatches).toBe(1);
    },
  );

  it.each([
    ["sequence", false, true],
    ["drained proof", true, false],
    ["both", true, true],
  ] as const)("rejects a captured %s bypass after admin demotion at commit", async (_name, proof, sequence) => {
    const fixture = await seedAdmissionFixture();
    await setPlatformUserRole({ d1: env.DB, targetUserId: RUNNER_USER_ID, actorUserId: FIXTURE_ADMIN_ID, role: "admin" });
    if (sequence) {
      await env.DB.prepare("UPDATE course_catalogs SET catalog_json = json_insert(catalog_json, '$.courses[0].lectures[#]', json_extract(catalog_json, '$.courses[0].lectures[0]')) WHERE scope_key = 'public'").run();
      await env.DB.prepare("UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].lectures[0].lectureId', 'locked-prerequisite', '$.courses[0].lectures[0].scenarioId', NULL) WHERE scope_key = 'public'").run();
    }
    if (proof) {
      await drizzle(env.DB).insert(runtimeOperationGates).values({ key: IMAGE_CUTOVER_GATE, state: "drained" });
    }
    admissionHarness.armBeforeAdmissionBatch(() => setPlatformUserRole({
      d1: env.DB, targetUserId: RUNNER_USER_ID, actorUserId: FIXTURE_ADMIN_ID, role: "user",
    }));
    await expect(beginScenarioRun(fixture.input(RUNNER_USER_ID, {
      ...(proof ? { allowDrainedAdminProof: true } : {}), allowSequenceBypass: sequence,
    }))).rejects.toMatchObject({ status: 409, code: "scenario_content_access_changed" });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
    expect((await desiredDocument()).vms).toEqual([]);
  });

  it("admits a live start on the user's own personal host", async () => {
    const fixture = await seedAdmissionFixture();
    await env.DB.prepare("UPDATE user SET metal_placement = 'personal' WHERE id = ?1").bind(RUNNER_USER_ID).run();
    await env.DB.prepare("UPDATE agent_hosts SET scope = 'personal' WHERE id = ?1").bind(HOST_ID).run();
    await env.DB.prepare("UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.scope', 'personal') WHERE host_id = ?1").bind(HOST_ID).run();
    const result = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
    await result.deliveryHint;
    expect(result.hostId).toBe(HOST_ID);
  });

  it("reselects a ready host after the selected host disconnects in the commit window", async () => {
    const fixture = await seedAdmissionFixture();
    const db = drizzle(env.DB);
    const [host] = await db.select().from(agentHosts).where(eq(agentHosts.id, HOST_ID));
    const [actual] = await db.select().from(hostActualState).where(eq(hostActualState.hostId, HOST_ID));
    if (!host || !actual) throw new Error("fixture host missing");
    const fallbackId = "fallback-runner";
    await db.insert(agentHosts).values({ ...host, id: fallbackId, activeSessionId: "fallback-session", updatedAt: host.updatedAt - 1 });
    await db.insert(hostActualState).values({ ...actual, hostId: fallbackId, reportJson: { ...actual.reportJson, host_id: fallbackId } });
    const [desired] = await db.select().from(hostDesiredState).where(eq(hostDesiredState.hostId, HOST_ID));
    await db.insert(hostDesiredState).values({ ...desired!, hostId: fallbackId, docJson: { ...desired!.docJson, host_id: fallbackId } });
    admissionHarness.armBeforeAdmissionBatch(async () => {
      await env.DB.prepare("UPDATE agent_hosts SET connected = 0, active_session_id = NULL WHERE id = ?1").bind(HOST_ID).run();
      admissionHarness.armBeforeAdmissionBatch(async () => {
        await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
      });
    });
    const input = fixture.input(RUNNER_USER_ID);
    delete input.hostId;
    const result = await beginScenarioRun(input);
    await result.deliveryHint;
    expect(result.hostId).toBe(fallbackId);
    expect(admissionHarness.state.admissionBatches).toBe(2);
    expect((await desiredDocument()).vms).toEqual([]);
    await expect(admissionSnapshot()).resolves.toMatchObject({ runs: 1, activeSlots: 1, cpuReservations: 1, desiredVersion: 0 });
  });

  it("refuses an unknown explicit host before creating desired state", async () => {
    const fixture = await seedAdmissionFixture();
    await expect(beginScenarioRun(fixture.input(RUNNER_USER_ID, { hostId: "unknown-host" }))).rejects.toMatchObject({ code: "scenario_host_unavailable" });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
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
    await env.DB.prepare(
      "UPDATE scenario_revisions SET doc_json = json_set(doc_json, '$.machines[0].cpu_millis', 500) WHERE scenario_id = ?1",
    ).bind(SCENARIO_ID).run();
    for (const userId of ["half-a", "half-b"]) {
      const result = await beginScenarioRun(fixture.input(userId));
      await result.deliveryHint;
    }
    await expect(admissionSnapshot()).resolves.toMatchObject({ runs: 2, cpuReservations: 2, cpuMillis: 1000 });
    const overflow = await fixture.addUser("half-c");
    await expect(beginScenarioRun(overflow)).rejects.toMatchObject({ code: "scenario_host_capacity_contended" });
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
      code: "scenario_host_capacity_contended",
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
    const first = await beginScenarioRun(fixture.input(RUNNER_USER_ID));
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
        name: "drained proof flag",
        input: fixture.input(RUNNER_USER_ID, { allowDrainedAdminProof: true }),
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

  it("leaves no rows when the account is revoked before the commit", async () => {
    const fixture = await seedAdmissionFixture();
    admissionHarness.armBeforeAdmissionBatch(async () => {
      await revokeFixtureAccount({ d1: env.DB, userId: RUNNER_USER_ID });
    });

    await expect(
      beginScenarioRun(fixture.input(RUNNER_USER_ID)),
    ).rejects.toMatchObject({ status: 403, code: "access_revoked" });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
  });

  it.each([IMAGE_CUTOVER_GATE])("stops a start when %s closes after the selection", async (key) => {
    const fixture = await seedAdmissionFixture();
    admissionHarness.armBeforeAdmissionBatch(async () => {
      await env.DB.prepare(
        "INSERT INTO runtime_operation_gates (key, state, updated_at)" +
          " VALUES (?1, 'drained', ?2)" +
          " ON CONFLICT(key) DO UPDATE SET state = 'drained', updated_at = ?2",
      )
        .bind(key, Date.now())
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
        .where(eq(runtimeOperationGates.key, key)),
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
      code: "scenario_host_capacity_contended",
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
    ).rejects.toMatchObject({ code: "scenario_host_capacity_contended" });
    // The requested host path makes the same decision without the selection.
    await expect(
      beginScenarioRun(fixture.input("memory-user", { hostId: HOST_ID })),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_host_capacity_contended",
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
    ).rejects.toMatchObject({ code: "scenario_host_capacity_contended" });
    // The requested host path makes the same decision without the selection.
    await expect(
      beginScenarioRun(fixture.input("disk-user", { hostId: HOST_ID })),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_host_capacity_contended",
    });
    await expect(admissionSnapshot()).resolves.toEqual(emptyAdmissionSnapshot());
  });

  it("cancels the run and clears the desired VM when the post-commit fence fails", async () => {
    const fixture = await seedAdmissionFixture();
    admissionHarness.armAfterAdmissionBatch(async () => {
      await revokeFixtureAccount({ d1: env.DB, userId: RUNNER_USER_ID });
    });

    await expect(
      beginScenarioRun(fixture.input(RUNNER_USER_ID)),
    ).rejects.toMatchObject({ status: 403, code: "access_revoked" });

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
      // delete the image the run is about to point at.
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
  });
});

interface AdmissionFixture {
  hostId: string;
  organizationId: string;
  /** The machine image digest of each seeded scenario. */
  images: Record<string, string>;
  /** The live revision document of each seeded scenario. */
  docs: Record<string, ReturnType<typeof revisionDoc>>;
  keyFor(userId: string): string;
  /** Seeds one more member for this host and returns that user's input. */
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

  // The newest Kino of guest contract 3, which the host's desired state pins.
  expect(await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "run-test" },
    [["application/octet-stream", "kino binary"]])).toBe(KINO);
  const images: Record<string, string> = {};
  const docs: Record<string, ReturnType<typeof revisionDoc>> = {};
  for (const scenarioId of [SCENARIO_ID, SECOND_SCENARIO_ID, THIRD_SCENARIO_ID]) {
    const image = await machineImage(scenarioId);
    images[scenarioId] = image;
    docs[scenarioId] = await insertScenario(
      db, scenarioId, scenarioId === THIRD_SCENARIO_ID ? organizationId : null, image, await specBlob(scenarioId),
    );
  }

  await db.insert(courseCatalogs).values([
    { scopeKey: "public", organizationId: null, sourceRevision: "admission-fixture", catalogJson: courseCatalog() },
    {
      scopeKey: `organization:${organizationId}`,
      organizationId,
      sourceRevision: "admission-fixture",
      catalogJson: organizationCourseCatalog(),
    },
  ]);

  const hostId = HOST_ID;
  await db.insert(agentHosts).values({
    scope: "platform",
    credentialGeneration: 1,
    activeSessionId: "admission-session",
    id: hostId,
    userId: input.userIds[0] as string,
    // The platform host is shared; course access is checked for each user.
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
      readyImages: Object.values(images),
    }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(hostDesiredState).values({
    hostId,
    version: 0,
    docJson: {
      ...emptyDesiredState({ ownerUserId: input.userIds[0]!, scope: "platform", hostId, nowUnixMs: now }),
      kino_pin: KINO,
    },
    createdAt: now,
    updatedAt: now,
  });

  const addUser = createUserSeeder(now, organizationId);

  return {
    hostId,
    organizationId,
    images,
    docs,
    keyFor: (userId: string) => `${userId}-admission-key`,
    async addUser(userId: string) {
      await addUser(userId);
      return {
        scenarioId: SCENARIO_ID,
        userId,
        idempotencyKey: `${userId}-admission-key`,
        organizationId,
        hostId,
      } satisfies BeginScenarioRunInput;
    },
    input(userId, overrides = {}) {
      return {
        scenarioId: SCENARIO_ID,
        userId,
        idempotencyKey: `${userId}-admission-key`,
        organizationId,
        hostId,
        ...overrides,
      } satisfies BeginScenarioRunInput;
    },
  };
}

/**
 * Seeds one member for the admission fixtures. Each user gets its own GitHub
 * account, so one test can admit several users to the same host.
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
    await ensureFixtureMember({
      d1: env.DB,
      userId,
      githubAccountId: `${userId}-github`,
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

/** Seeds a live revision of `scenarioId` with one `webserver` machine and returns its document. */
async function insertScenario(
  db: ReturnType<typeof drizzle>,
  scenarioId: string,
  organizationId: string | null,
  image: string,
  spec: string,
): Promise<ReturnType<typeof revisionDoc>> {
  const base = revisionDoc({}, {});
  const machine = { ...base.machines[0]!, name: "webserver", image_digest: image, spec, cpu_millis: FIRST_VM_CPU_MILLIS,
    memory_mib: VM_MEMORY_MIB, disk_mib: VM_DISK_MIB };
  const doc = { ...base, title: scenarioId, machines: [machine],
    tasks: [{ id: "serve", title: "Serve", machine: "webserver", needs: [], optional: false, ordinal: 0, hints: [] }] };
  const [namespace, slug] = scenarioId.split("/") as [string, string];
  await db.insert(scenarios).values({
    id: scenarioId, namespace, slug, organizationId,
    scopeKey: organizationId ? `organization:${organizationId}` : "public", enabled: true, play: false, liveRev: "r1",
  });
  await db.insert(scenarioRevisions).values({ scenarioId, rev: "r1", guestContract: 3, docJson: doc, state: "ready" });
  return doc;
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
  /** The images the host reports ready. */
  readyImages: readonly string[];
}): HostStateReportV3 {
  return {
    relay_connected: true,
    schema_version: 8,
    host_id: input.hostId,
    observed_at_unix_ms: input.now,
    applied_desired_version: 0,
    guest_contract: 3,
    hardware: HARDWARE,
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
    cached_images: input.readyImages.map((image) => ({ image, phase: "ready", updated_at_unix_ms: input.now })),
    vms: [],
  };
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
  vms: Array<{ run_id: string; desired_phase: string; image: string }>;
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
    vms: Array<{ run_id: string; desired_phase: string; image: string }>;
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
