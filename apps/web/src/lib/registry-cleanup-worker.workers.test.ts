/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MaintenanceState } from "@/maintenance-state";
import {
  handleMaintenanceMode,
  handleRegistryCleanupGateRequest,
  REGISTRY_CLEANUP_GATE_PATH,
} from "@/maintenance";
import {
  REGISTRY_ADMISSION_KEY,
  REGISTRY_ADMISSION_PROTOCOL_VERSION,
} from "@/lib/image-registry-admission";
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

/** An object no reference names, which only a delete pass may remove. */
const ORPHAN_KEY = "registry-cleanup-worker-fixture/orphan";

function childEnv(overrides: Partial<CleanupEnv> = {}): CleanupEnv {
  return {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
    REGISTRY_CLEANUP_MODE: "report-only",
    CONTROL_PLANE: pinlessParent(),
    ...overrides,
  };
}

function child(overrides: Partial<CleanupEnv> = {}): RegistryCleanup {
  return new RegistryCleanup(createExecutionContext(), childEnv(overrides));
}

/** The parent entrypoint with some of its variables replaced. */
function parentWith(vars: Record<string, string>): MaintenanceState {
  return new MaintenanceState(
    createExecutionContext(),
    new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === "string" && property in vars) return vars[property];
        return Reflect.get(target, property, receiver);
      },
    }),
  );
}

/** The parent entrypoint of a version that has maintenance on. */
function fencedParent(): MaintenanceState {
  return parentWith({ CONTROL_PLANE_MAINTENANCE: "on" });
}

/**
 * The parent entrypoint of a version that pins no Kino. The test pin names a
 * Kino this file does not store, which a sweep rightly reports as a fault.
 */
function pinlessParent(): MaintenanceState {
  return parentWith({ KINO_PINS_JSON: "" });
}

/** An object inside a swept prefix that no reference names. */
async function resetCollectorFixture(): Promise<void> {
  await env.VM_IMAGE_REGISTRY_BUCKET.delete(ORPHAN_KEY);
  await env.DB.prepare("DELETE FROM image_registry_admission WHERE key = ?")
    .bind(REGISTRY_ADMISSION_KEY)
    .run();
}

async function seedOrphan(): Promise<void> {
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    ORPHAN_KEY,
    new Uint8Array([9, 9, 9]),
  );
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
  });

  it("plans the OCI sweep and mutates nothing", async () => {
    await resetD1Database();
    await resetCollectorFixture();
    await seedOrphan();

    const planned = await child({ REGISTRY_CLEANUP_MODE: "delete" }).plan();

    // A plan never deletes, whatever mode the collector was configured with.
    expect(planned.mode).toBe("delete");
    expect(planned.result?.mode).toBe("report-only");
    expect(planned.status).toBe("report-only");
    expect(planned.error).toBeNull();
    expect(planned.result?.deletedObjects).toBe(0);
    expect(await objectExists(ORPHAN_KEY)).toBe(true);
  });

  it("reaches the real collector through the parent gate while maintenance is off", async () => {
    await resetD1Database();
    await resetCollectorFixture();
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
    await expect(planned?.json()).resolves.toMatchObject({
      result: { status: "report-only", result: { mode: "report-only", deletedObjects: 0 } },
    });
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

  it("reports the D1 admission enforcement the parent gate decides deletes on", async () => {
    await resetD1Database();
    await resetCollectorFixture();

    // The parent holds no database binding here, so both values can only come
    // from the child reading the shared D1 row.
    const parentEnv = parentEnvWithoutDatabase({ REGISTRY_CLEANUP: child() });
    const report = async (): Promise<Record<string, unknown>> => {
      const response = await handleRegistryCleanupGateRequest(
        gateRequest({ secret: GATE_SECRET, action: "status" }),
        parentEnv,
      );
      expect(response?.status).toBe(200);
      return (await response?.json()) as Record<string, unknown>;
    };

    // The default row: deletes stay refused, and the refusal is explicit.
    await expect(report()).resolves.toMatchObject({
      result: { enforcement: "report_only", sessionRequired: false },
    });

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO image_registry_admission
         (key, protocol_version, enforcement, epoch, state, updated_at)
       VALUES (?1, ?2, 'enforce', 0, 'open', ?3)
       ON CONFLICT(key) DO UPDATE SET
         enforcement = excluded.enforcement,
         updated_at = excluded.updated_at`,
    )
      .bind(REGISTRY_ADMISSION_KEY, REGISTRY_ADMISSION_PROTOCOL_VERSION, now)
      .run();

    // A later status call reads the fresh row, so an activation reaches the
    // gate that decides without a collector redeploy.
    await expect(report()).resolves.toMatchObject({
      result: { enforcement: "enforce", sessionRequired: true },
    });

    // Back to the default in the same row: the pair follows D1 both ways.
    await env.DB.prepare(
      "UPDATE image_registry_admission SET enforcement = 'report_only' WHERE key = ?1",
    )
      .bind(REGISTRY_ADMISSION_KEY)
      .run();
    await expect(report()).resolves.toMatchObject({
      result: { enforcement: "report_only", sessionRequired: false },
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
