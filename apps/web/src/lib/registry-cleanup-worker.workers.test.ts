/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  imageBuildBundles,
  imageBuilds,
  vmScenarios,
  vmScenarioVms,
} from "@/db/schema";
import { MaintenanceState } from "@/maintenance-state";
import {
  handleMaintenanceMode,
  handleRegistryCleanupGateRequest,
  REGISTRY_CLEANUP_GATE_PATH,
} from "@/maintenance";
import {
  bootArtifactObjectKey,
  imageObjectKey,
} from "@/lib/image-artifact-retention";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  REGISTRY_ADMISSION_KEY,
  REGISTRY_ADMISSION_PROTOCOL_VERSION,
} from "@/lib/image-registry-admission";
import { DEFAULT_CLEANUP_OWNER } from "@/lib/image-registry-cleanup";
import { resetD1Database } from "@/test/d1-migrations";
import {
  CLEANUP_PAUSE_REASON,
  runCleanup,
  type CleanupEnv,
} from "../../workers/image-registry-cleanup/src/cleanup";
import { RegistryCleanup } from "../../workers/image-registry-cleanup/src/worker";
import cleanupWorker from "../../workers/image-registry-cleanup/src/worker";

/**
 * Real wiring, no mocks of the sweep: the child entrypoint, the parent
 * maintenance entrypoint, the pool D1 database, the pool R2 bucket, and the
 * real retention projection and sweep core.
 */

const SCENARIO_ID = "registry-cleanup-fixture";
const VM_NAME = "control-plane";
const ARCH = "x86_64";

/** A live catalog image the sweep must keep. */
const IMAGE_ID = "1".repeat(64);
/** A live kernel artifact the sweep must keep. */
const KERNEL_SHA256 = "2".repeat(64);
/** A live initrd artifact the sweep must keep. */
const INITRD_SHA256 = "3".repeat(64);
/** An object no reference names: the only candidate of these tests. */
const ORPHAN_SHA256 = "4".repeat(64);
const ORPHAN_BYTES = 3;
/** A published build whose only member nothing references any more. */
const RETIRED_BUILD_ID = "registry-cleanup-retired-build";
const RETIRED_REV = "registry-cleanup-retired-rev";
const PENDING_WRITER_ID = "registry-cleanup-pending-writer";
const CLEANUP_OWNER = DEFAULT_CLEANUP_OWNER;
const RETIRED_IMAGE_ID = "5".repeat(64);
const RETIRED_IMAGE_KEY = imageObjectKey(
  { scenario: SCENARIO_ID, vm: "retired", arch: ARCH },
  RETIRED_IMAGE_ID,
);

const IMAGE_KEY = imageObjectKey(
  { scenario: SCENARIO_ID, vm: VM_NAME, arch: ARCH },
  IMAGE_ID,
);
const KERNEL_KEY = bootArtifactObjectKey(KERNEL_SHA256);
const INITRD_KEY = bootArtifactObjectKey(INITRD_SHA256);
const ORPHAN_KEY = bootArtifactObjectKey(ORPHAN_SHA256);

/**
 * Every object this file puts in R2. The pool shares one D1 database and one
 * R2 bucket across test files, so a file may only add and remove its own
 * fixture: it must never wipe a prefix, and it must never assume the bucket or
 * the database is otherwise empty.
 */
const FIXTURE_OBJECT_KEYS = [
  IMAGE_KEY,
  KERNEL_KEY,
  INITRD_KEY,
  ORPHAN_KEY,
  RETIRED_IMAGE_KEY,
];

function childEnv(overrides: Partial<CleanupEnv> = {}): CleanupEnv {
  return {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
    REGISTRY_CLEANUP_MODE: "report-only",
    CONTROL_PLANE: new MaintenanceState(createExecutionContext(), env),
    ...overrides,
  };
}

function child(overrides: Partial<CleanupEnv> = {}): RegistryCleanup {
  return new RegistryCleanup(createExecutionContext(), childEnv(overrides));
}

/** The parent entrypoint of a version that has maintenance on. */
function fencedParent(): MaintenanceState {
  return new MaintenanceState(
    createExecutionContext(),
    new Proxy(env, {
      get(target, property, receiver) {
        if (property === "CONTROL_PLANE_MAINTENANCE") return "on";
        return Reflect.get(target, property, receiver);
      },
    }),
  );
}

/**
 * Sweep rows are shared, and another file may have run a sweep before this one.
 * A test that asserts about the collector's own rows counts the rows that exist
 * around it instead of assuming the table is empty.
 */
async function gcRunIds(): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT id FROM image_registry_gc_runs").all<{
    id: string;
  }>();
  return new Set((rows.results ?? []).map((row) => row.id));
}

async function gcRunsAddedSince(before: Set<string>): Promise<GcRunRow[]> {
  const added = [...(await gcRunIds())].filter((id) => !before.has(id));
  if (!added.length) return [];
  const rows = await env.DB.prepare(
    `SELECT state, scanned_objects, deleted_objects, blocked_objects,
            bytes_reclaimed, error
       FROM image_registry_gc_runs
      WHERE id IN (${added.map(() => "?").join(",")})`,
  )
    .bind(...added)
    .all<GcRunRow>();
  return rows.results ?? [];
}

/** The first moment this file touched the shared storage. */
const FIXTURE_STARTED_AT_MS = Date.now();

/**
 * Remove this file's footprint and nothing else, so a later file starts from
 * the state it expects and a re-run of this file is deterministic.
 *
 * `reset()` from the pool only deletes Durable Objects in this version, so D1
 * and R2 rows survive a test file and must be removed by hand. Everything here
 * is scoped to this file: its own fixture keys, its own scenario, and the sweep
 * rows the collector wrote from the moment this file started.
 */
async function resetCollectorFixture(): Promise<void> {
  await env.VM_IMAGE_REGISTRY_BUCKET.delete([...FIXTURE_OBJECT_KEYS]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM image_registry_operation_writers WHERE id = ?").bind(
      PENDING_WRITER_ID,
    ),
    env.DB.prepare(
      "DELETE FROM image_registry_gc_runs WHERE owner = ? AND created_at >= ?",
    ).bind(CLEANUP_OWNER, FIXTURE_STARTED_AT_MS),
    env.DB.prepare("DELETE FROM image_builds WHERE id = ?").bind(RETIRED_BUILD_ID),
    env.DB.prepare("DELETE FROM image_build_bundles WHERE rev = ?").bind(
      RETIRED_REV,
    ),
    env.DB.prepare("DELETE FROM vm_scenario_vms WHERE scenario_id = ?").bind(
      SCENARIO_ID,
    ),
    env.DB.prepare("DELETE FROM vm_scenarios WHERE scenario_id = ?").bind(
      SCENARIO_ID,
    ),
    env.DB.prepare("DELETE FROM image_registry_admission WHERE key = ?").bind(
      REGISTRY_ADMISSION_KEY,
    ),
  ]);
}

/**
 * One live scenario whose image, kernel, and initrd must survive a sweep.
 * These are the references the projection retains; the objects are in R2, so
 * the retained-coverage check finds nothing missing and reports no fault.
 */
async function seedReferencedCatalog(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(vmScenarios).values({
    scenarioId: SCENARIO_ID,
    sourceRevision: "fixture",
    title: "Registry cleanup fixture",
    description: "A live scenario the sweep must not break.",
    difficulty: "easy",
    estimatedMinutes: 5,
    tagsJson: [],
    briefingMarkdown: "",
    solutionMarkdown: "",
    hintsJson: [],
    enabled: true,
    enabledAt: Date.now(),
  });
  await db.insert(vmScenarioVms).values({
    id: `${SCENARIO_ID}:${VM_NAME}`,
    scenarioId: SCENARIO_ID,
    ordinal: 0,
    vmName: VM_NAME,
    image: "fixture.raw.zst",
    imageKeyJson: { scenario: SCENARIO_ID, vm: VM_NAME, arch: ARCH },
    imageSha256: IMAGE_ID,
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 1_024,
    kernelSha256: KERNEL_SHA256,
    initrdSha256: INITRD_SHA256,
    bootCmdline: "root=/dev/vda rw console=ttyS0",
    memoryMib: 512,
    diskMib: 1_024,
  });
  await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      IMAGE_KEY,
      new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      KERNEL_KEY,
      new Uint8Array([1, 2, 3, 4, 5]),
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      INITRD_KEY,
      new Uint8Array([1, 2, 3, 4, 5, 6]),
    ),
  ]);
}

/** An object inside a swept prefix that no reference names. */
async function seedOrphan(): Promise<void> {
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    ORPHAN_KEY,
    new Uint8Array([9, 9, 9]),
  );
}

/**
 * A published build whose members nothing else references. The projection
 * retires it, which frees its artifacts for the next pass: the trigger for a
 * pass that finished its bounded work and still needs another one.
 */
async function seedSupersededBuild(): Promise<void> {
  const db = drizzle(env.DB);
  const rev = RETIRED_REV;
  await db.insert(imageBuildBundles).values({
    rev,
    r2Key: `builds/bundles/${rev}.tar.gz`,
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "live",
      scenarios: [],
    },
  });
  await db.insert(imageBuilds).values({
    id: RETIRED_BUILD_ID,
    scenarioId: SCENARIO_ID,
    arch: ARCH,
    rev,
    contentHash: "6".repeat(64),
    catalogChannel: "live",
    status: "succeeded",
    phase: "succeeded",
    publishedManifestJson: {
      scenario_id: SCENARIO_ID,
      vms: [
        {
          name: "retired",
          image_key: { scenario: SCENARIO_ID, vm: "retired", arch: ARCH },
          image_id: RETIRED_IMAGE_ID,
        },
      ],
    } as never,
  });
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    RETIRED_IMAGE_KEY,
    new Uint8Array([7, 7]),
  );
}

/** A live scenario whose retained image manifest is absent from R2. */
async function breakRetainedManifest(): Promise<void> {
  const db = drizzle(env.DB);
  await db
    .update(vmScenarioVms)
    .set({ chunkManifestSha256: "9".repeat(64), imageFormat: "raw_chunks_v1" })
    .where(eq(vmScenarioVms.id, `${SCENARIO_ID}:${VM_NAME}`));
}

/** An unresolved writer, which is what makes a sweep refuse to start. */
async function seedPendingWriter(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO image_registry_operation_writers
       (id, session_id, owner_kind, owner_id, operation, epoch, outcome,
        created_at, heartbeat_at, expires_at, released_at)
     VALUES (?1, NULL, 'builder', 'builder-host', 'publish', 1, 'pending',
             ?2, ?2, ?3, NULL)`,
  )
    .bind(PENDING_WRITER_ID, now, now + 60_000)
    .run();
}

/** Turn the shared gate on, which is what allows a delete at all. */
async function enforceRegistrySweep(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO image_registry_admission
       (key, protocol_version, enforcement, epoch, state, updated_at)
     VALUES (?1, ?2, 'enforce', 0, 'open', ?3)
     ON CONFLICT(key) DO UPDATE SET
       enforcement = 'enforce',
       state = 'open',
       sweep_token = NULL,
       sweep_owner = NULL,
       sweep_started_at = NULL,
       sweep_heartbeat_at = NULL,
       sweep_expires_at = NULL,
       paused_at = NULL,
       pause_reason = NULL,
       updated_at = ?3`,
  )
    .bind(REGISTRY_ADMISSION_KEY, REGISTRY_ADMISSION_PROTOCOL_VERSION, now)
    .run();
}

interface GcRunRow {
  state: string;
  scanned_objects: number;
  deleted_objects: number;
  blocked_objects: number;
  bytes_reclaimed: number;
  error: string | null;
}

async function objectExists(key: string): Promise<boolean> {
  return (await env.VM_IMAGE_REGISTRY_BUCKET.head(key)) !== null;
}

/** Run the real scheduled handler and return its structured log payloads. */
async function runScheduled(
  overrides: Partial<CleanupEnv> = {},
): Promise<Array<Record<string, unknown>>> {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await cleanupWorker.scheduled(
      createScheduledController(),
      childEnv(overrides),
      createExecutionContext(),
    );
    return logs.mock.calls.map(
      (call) => JSON.parse(String(call[0])) as Record<string, unknown>,
    );
  } finally {
    vi.restoreAllMocks();
  }
}

function eventNames(logs: Array<Record<string, unknown>>): unknown[] {
  return logs.map((entry) => entry.event);
}

/** The deployment gate request shape, exactly as the deploy lane sends it. */
function gateRequest(body: Record<string, unknown>): Request {
  return new Request(`https://intar.dev${REGISTRY_CLEANUP_GATE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GATE_SECRET = "maintenance-test-secret-that-is-long-enough";

/** A parent environment whose D1 binding fails on any access at all. */
function parentEnvWithoutDatabase(overrides: Record<string, unknown>): Cloudflare.Env {
  const database = new Proxy(
    {},
    {
      get() {
        throw new Error("the parent read D1 for a maintenance request");
      },
    },
  );
  return {
    BETTER_AUTH_URL: "https://intar.dev",
    CONTROL_PLANE_MAINTENANCE: "off",
    CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: GATE_SECRET,
    DB: database,
    ...overrides,
  } as unknown as Cloudflare.Env;
}

function findEvent(
  logs: Array<Record<string, unknown>>,
  event: string,
): Record<string, unknown> | undefined {
  return logs.find((entry) => entry.event === event);
}

describe("image registry cleanup worker", () => {
  // The pool shares one database and one bucket across files in this version,
  // so this file removes its fixture before each test and again at the end.
  afterAll(async () => {
    await resetCollectorFixture();
  });

  it("reads the live maintenance flag through the parent entrypoint", async () => {
    const open = new MaintenanceState(createExecutionContext(), env);
    expect(await open.state()).toMatchObject({ maintenance: "off" });

    // The flag is read from the parent version that serves traffic, so a
    // maintenance deployment fences the collector with no child redeploy.
    expect(await fencedParent().state()).toMatchObject({ maintenance: "on" });
  });

  it("serves no public route", async () => {
    expect((await cleanupWorker.fetch()).status).toBe(404);
  });

  it("fences the scheduled run when the control plane is not bound", async () => {
    const logs = await runScheduled({ CONTROL_PLANE: undefined });

    expect(eventNames(logs)).toContain("registry_cleanup_maintenance_probe_missing");
    expect(eventNames(logs)).toContain("registry_cleanup_fenced");
  });

  it("fences the scheduled run when the parent reports maintenance", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedReferencedCatalog();
    await seedOrphan();

    const parent = fencedParent();
    const logs = await runScheduled({ CONTROL_PLANE: parent });

    expect(eventNames(logs)).toContain("registry_cleanup_fenced");
    expect(eventNames(logs)).not.toContain("registry_cleanup_finished");
    expect(await objectExists(ORPHAN_KEY)).toBe(true);
    expect(await child({ CONTROL_PLANE: parent }).status()).toMatchObject({
      maintenance: "on",
      maintenanceSource: "control-plane",
    });
  });

  it("holds the registry in shared D1, so a second isolate sees the hold", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedOrphan();

    expect(await child().status()).toMatchObject({
      mode: "report-only",
      modeValid: true,
      paused: false,
      sweepActive: false,
      idle: true,
    });

    expect(await child().pause()).toMatchObject({
      paused: true,
      pauseReason: CLEANUP_PAUSE_REASON,
      idle: true,
    });

    // A fresh entrypoint instance shares no memory with the first one, so this
    // answer can only come from D1.
    expect(await child().status()).toMatchObject({
      paused: true,
      pauseReason: CLEANUP_PAUSE_REASON,
    });

    expect(eventNames(await runScheduled())).toContain("registry_cleanup_held");
    expect(await objectExists(ORPHAN_KEY)).toBe(true);

    expect(await child().resume()).toMatchObject({ paused: false, idle: true });
    expect(await child().status()).toMatchObject({
      paused: false,
      pauseReason: null,
    });
  });

  it("treats another isolate's live sweep as busy and leaves the bucket alone", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedOrphan();
    const before = await gcRunIds();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO image_registry_admission
         (key, protocol_version, enforcement, epoch, state, sweep_token,
          sweep_owner, sweep_started_at, sweep_heartbeat_at, sweep_expires_at,
          updated_at)
       VALUES (?1, 1, 'enforce', 1, 'sweeping', 'other-token', 'other-owner',
               ?2, ?2, ?3, ?2)`,
    )
      .bind(REGISTRY_ADMISSION_KEY, now, now + 60_000)
      .run();

    expect(await child().status()).toMatchObject({
      sweepActive: true,
      running: true,
      idle: false,
    });

    const logs = await runScheduled();
    expect(eventNames(logs)).toContain("registry_cleanup_busy");
    expect(eventNames(logs)).not.toContain("registry_cleanup_finished");
    expect(await objectExists(ORPHAN_KEY)).toBe(true);
    expect(await gcRunsAddedSince(before)).toEqual([]);
  });

  it("plans the real sweep against live references and mutates nothing", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedReferencedCatalog();
    await seedOrphan();

    const before = await gcRunIds();

    const planned = await child().plan();

    // A report-only pass must succeed on a valid fixture. It may not fall back
    // to a failure, or the pass would prove nothing about the sweep at all.
    expect(planned.status).toBe("report-only");
    expect(planned.error).toBeNull();
    expect(planned.result).toBeNull();
    const plan = planned.plan;
    expect(plan).not.toBeNull();
    if (!plan) throw new Error("the report-only pass returned no plan");

    expect(planned.mode).toBe("report-only");
    expect(plan.mode).toBe("report-only");
    expect(plan.truncated).toBe(false);
    expect(plan.details.faults).toEqual([]);
    expect(plan.details.deleteAllowedByReferences).toBe(true);

    // The orphan is a candidate and nothing this file retains is one. The plan
    // covers every object in the shared bucket, so the assertions name this
    // file's keys rather than the whole listing.
    const candidates = plan.candidateObjects.map((object) => object.key);
    expect(candidates).toContain(ORPHAN_KEY);
    for (const retained of [IMAGE_KEY, KERNEL_KEY, INITRD_KEY, RETIRED_IMAGE_KEY]) {
      expect(candidates, retained).not.toContain(retained);
    }
    const orphan = plan.candidateObjects.find(
      (object) => object.key === ORPHAN_KEY,
    );
    expect(orphan).toMatchObject({
      key: ORPHAN_KEY,
      bytes: ORPHAN_BYTES,
      category: "boot_artifact",
    });

    // Zero mutation: every object is still there and no run was recorded.
    expect(await objectExists(ORPHAN_KEY)).toBe(true);
    expect(await objectExists(IMAGE_KEY)).toBe(true);
    expect(await objectExists(KERNEL_KEY)).toBe(true);
    expect(await objectExists(INITRD_KEY)).toBe(true);
    expect(await gcRunsAddedSince(before)).toEqual([]);
  });

  it("deletes the orphan on a scheduled pass and keeps every live reference", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedReferencedCatalog();
    await seedOrphan();
    await enforceRegistrySweep();
    const before = await gcRunIds();

    const logs = await runScheduled({ REGISTRY_CLEANUP_MODE: "delete" });

    const finished = findEvent(logs, "registry_cleanup_finished");
    expect(finished).toBeDefined();
    expect(finished).toMatchObject({
      status: "ok",
      candidateTotal: 1,
      deletedObjects: 1,
      deletedBytes: ORPHAN_BYTES,
      failedObjects: 0,
      blockedObjects: 0,
      error: null,
    });

    // The orphan is gone; every referenced object is still readable.
    expect(await objectExists(ORPHAN_KEY)).toBe(false);
    expect(await objectExists(IMAGE_KEY)).toBe(true);
    expect(await objectExists(KERNEL_KEY)).toBe(true);
    expect(await objectExists(INITRD_KEY)).toBe(true);

    // Exactly one sweep row was written by this pass, it records the counters,
    // and it is closed. Rows from another file's sweep are not this file's
    // business, so the assertion names the rows this pass added.
    const added = await gcRunsAddedSince(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      state: "completed",
      blocked_objects: 0,
      error: null,
    });
    expect(added[0]?.deleted_objects).toBe(1);
    expect(added[0]?.bytes_reclaimed).toBe(ORPHAN_BYTES);
    // The listing of the shared bucket also holds other files' objects, so the
    // count is bounded below by this file's four rather than equal to it.
    expect(added[0]?.scanned_objects).toBeGreaterThanOrEqual(4);
    expect(await child().status()).toMatchObject({
      sweepActive: false,
      idle: true,
    });
  });

  it("fails the pass when a retained manifest is missing, and deletes nothing", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedReferencedCatalog();
    await seedOrphan();
    // The live scenario still points at a chunked image whose manifest is not in
    // the bucket. The sweep cannot prove what a retained object needs, so it
    // must stop. Reporting this as success would let a promotion believe that
    // retired artifacts are gone.
    await breakRetainedManifest();
    await enforceRegistrySweep();

    const outcome = await runCleanup(childEnv({ REGISTRY_CLEANUP_MODE: "delete" }), {
      source: "scheduled",
    });

    expect(outcome.status).toBe("core-failed");
    expect(outcome.plan).toBeNull();
    expect(outcome.result?.deletedObjects).toBe(0);
    expect(outcome.error).toContain("reference verification stopped the sweep");
    expect(outcome.error).toContain("retained_manifest_missing");
    // Nothing was deleted, not even the orphan that no reference names.
    expect(await objectExists(ORPHAN_KEY)).toBe(true);
    expect(await objectExists(IMAGE_KEY)).toBe(true);
    expect(await objectExists(KERNEL_KEY)).toBe(true);
  });

  it("reports busy, not success, when an unresolved writer blocks the sweep", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedReferencedCatalog();
    await seedOrphan();
    await enforceRegistrySweep();
    // A writer that never released holds the registry: the sweep refuses.
    await seedPendingWriter();
    const before = await gcRunIds();

    const outcome = await runCleanup(childEnv({ REGISTRY_CLEANUP_MODE: "delete" }), {
      source: "scheduled",
    });

    expect(outcome.status).toBe("busy");
    expect(outcome.result?.deletedObjects).toBe(0);
    expect(outcome.result?.resumeRequired).toBe(true);
    expect(await objectExists(ORPHAN_KEY)).toBe(true);
    // A refusal must not leave a sweep behind, so the next attempt can run.
    expect(await gcRunsAddedSince(before)).toEqual([]);
  });

  it("completes in one pass when retirement and deletion agree", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedReferencedCatalog();
    await seedOrphan();
    await seedSupersededBuild();
    await enforceRegistrySweep();

    const outcome = await runCleanup(childEnv({ REGISTRY_CLEANUP_MODE: "delete" }), {
      source: "scheduled",
    });

    // The retention projection decides retirement and the retained set in one
    // step, so the plan a pass executes already excludes the artifacts that
    // retirement frees. There is nothing left for a second pass, and the core
    // says so through `completed`: the collector copies that verdict, `ok`.
    expect(outcome.status).toBe("ok");
    expect(outcome.mode).toBe("delete");
    expect(outcome.result?.error).toBeNull();
    expect(outcome.result?.failedObjects).toBe(0);
    expect(outcome.result?.phases.retired_builds).toBe(1);
    expect(outcome.result?.completed).toBe(true);

    const retired = await drizzle(env.DB)
      .select({ retiredAt: imageBuilds.artifactsRetiredAt })
      .from(imageBuilds)
      .where(eq(imageBuilds.id, RETIRED_BUILD_ID));
    expect(retired[0]?.retiredAt).toBeGreaterThan(0);
    // The retired build no longer pins its image, so this pass deleted it.
    expect(await objectExists(RETIRED_IMAGE_KEY)).toBe(false);
    // Everything the live scenario still needs survives.
    expect(await objectExists(IMAGE_KEY)).toBe(true);
    expect(await objectExists(KERNEL_KEY)).toBe(true);
    expect(await objectExists(INITRD_KEY)).toBe(true);
  });

  it("reaches the real collector through the parent gate while maintenance is off", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedReferencedCatalog();
    await seedOrphan();

    // The parent D1 binding is a trap: the gate must reach the collector
    // through the service binding and read no database of its own.
    const parentEnv = parentEnvWithoutDatabase({ REGISTRY_CLEANUP: child() });

    const status = await handleRegistryCleanupGateRequest(
      gateRequest({ secret: GATE_SECRET, action: "status" }),
      parentEnv,
    );
    expect(status?.status).toBe(200);
    await expect(status?.json()).resolves.toMatchObject({
      action: "status",
      result: {
        mode: "report-only",
        maintenance: "off",
        idle: true,
        paused: false,
      },
    });

    // The plan runs before the hold: a held collector refuses the plan, which
    // is the point of the hold.
    const planned = await handleRegistryCleanupGateRequest(
      gateRequest({ secret: GATE_SECRET, action: "plan" }),
      parentEnv,
    );
    expect(planned?.status).toBe(200);
    const plannedBody = (await planned?.json()) as {
      result: { status: string; plan: { candidateObjects: Array<{ key: string }> } | null };
    };
    expect(plannedBody.result.status).toBe("report-only");
    expect(
      plannedBody.result.plan?.candidateObjects.map((object) => object.key),
    ).toEqual([ORPHAN_KEY]);
    expect(await objectExists(ORPHAN_KEY)).toBe(true);

    const paused = await handleRegistryCleanupGateRequest(
      gateRequest({ secret: GATE_SECRET, action: "pause", wait_ms: 0 }),
      parentEnv,
    );
    expect(paused?.status).toBe(200);
    await expect(paused?.json()).resolves.toMatchObject({
      action: "pause",
      result: { paused: true, idle: true },
    });

    // The hold is the shared admission row, written by the real collector.
    const held = await env.DB.prepare(
      "SELECT paused_at, pause_reason FROM image_registry_admission WHERE key = ?",
    )
      .bind(REGISTRY_ADMISSION_KEY)
      .first<{ paused_at: number | null; pause_reason: string | null }>();
    expect(held?.paused_at).toBeGreaterThan(0);
    expect(held?.pause_reason).toBe(CLEANUP_PAUSE_REASON);

    // A held collector refuses a new pass, and the orphan survives it.
    const heldPlan = await handleRegistryCleanupGateRequest(
      gateRequest({ secret: GATE_SECRET, action: "plan" }),
      parentEnv,
    );
    await expect(heldPlan?.json()).resolves.toMatchObject({
      result: { status: "paused" },
    });
    expect(await objectExists(ORPHAN_KEY)).toBe(true);

    const released = await handleRegistryCleanupGateRequest(
      gateRequest({ secret: GATE_SECRET, action: "resume" }),
      parentEnv,
    );
    expect(released?.status).toBe(200);
    await expect(released?.json()).resolves.toMatchObject({
      action: "resume",
      result: { paused: false, idle: true },
    });
  });

  it("reaches neither the collector nor D1 while maintenance is on", async () => {
    const calls: string[] = [];
    const fencedEnv = parentEnvWithoutDatabase({
      CONTROL_PLANE_MAINTENANCE: "on",
      REGISTRY_CLEANUP: {
        status: async () => {
          calls.push("status");
          return {};
        },
        plan: async () => {
          calls.push("plan");
          return {};
        },
        run: async () => {
          calls.push("run");
          return {};
        },
        pause: async () => {
          calls.push("pause");
          return {};
        },
        resume: async () => {
          calls.push("resume");
          return {};
        },
      },
    });

    // The fence answers every gate request first, so the collector keeps its
    // state and the parent never reads D1 for a maintenance request.
    for (const action of ["pause", "resume", "status", "plan", "run"]) {
      const fenced = await handleMaintenanceMode(
        gateRequest({ secret: GATE_SECRET, action }),
        fencedEnv,
      );
      expect(fenced?.status).toBe(503);
      await expect(fenced?.json()).resolves.toMatchObject({ code: "maintenance" });
    }
    expect(calls).toEqual([]);
  });

  it("keeps the mode the collector was configured with", async () => {
    await resetD1Database();

    expect(
      await runCleanup(childEnv({ REGISTRY_CLEANUP_MODE: "delete" }), {
        source: "rpc",
      }),
    ).toMatchObject({ mode: "delete", modeValid: true });

    expect(
      await runCleanup(childEnv({ REGISTRY_CLEANUP_MODE: "nonsense" }), {
        source: "rpc",
      }),
    ).toMatchObject({ mode: "report-only", modeValid: false });
  });
});
