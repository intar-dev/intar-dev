/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it } from "vitest";
import {
  destroyScenarioRunForUserWithDependencies,
} from "@/lib/scenario-runs/lifecycle";
import { markRunVmsAbsentInDesiredState } from "@/lib/scenario-runs/start";
import { updateRunState } from "@/lib/scenario-runs/storage";
import { recomputeRunState } from "@/lib/run-state";
import {
  drizzle,
  env,
  eq,
  hostDesiredState,
  mutateStoredHostDesiredState,
  resetHostRuntimeTestDatabase,
  scenarioRuns,
  seedHost,
  seedRun,
  testImageKey,
  upsertDesiredVm,
} from "@/control-plane/host-runtime-do/test-fixtures";

describe("scenario run destroy acceptance", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("releases the active slot only after absence intent and route revocation", async () => {
    const now = Date.now();
    await seedDestroyableRun("run-a", now);

    const result = await destroyScenarioRunForUserWithDependencies(
      { runId: "run-a", userId: "user-1" },
      successfulDependencies(),
    );

    expect(result).toMatchObject({
      accepted: true,
      activeSlotReleased: true,
      run: {
        activity: "background",
        active: false,
        deleteRequestedAt: expect.any(Number),
      },
    });
    const db = drizzle(env.DB);
    const [row] = await db
      .select({
        activeKey: scenarioRuns.activeKey,
        deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "run-a"));
    expect(row?.activeKey).toBeNull();
    expect(row?.deleteRequestedAt).not.toBeNull();

    const [desired] = await db
      .select({ docJson: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "host-1"));
    expect(
      desired?.docJson.vms.find((vm) => vm.run_id === "run-a")?.desired_phase,
    ).toBe("absent");
  });

  it("retains the foreground slot when route revocation fails and succeeds on retry", async () => {
    const now = Date.now();
    await seedDestroyableRun("run-a", now);

    await expect(
      destroyScenarioRunForUserWithDependencies(
        { runId: "run-a", userId: "user-1" },
        {
          ...successfulDependencies(),
          revokeRoutes: async () => {
            throw new Error("stargate unavailable");
          },
        },
      ),
    ).rejects.toThrow("Shell access could not be revoked");

    const db = drizzle(env.DB);
    let [row] = await db
      .select({ activeKey: scenarioRuns.activeKey })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "run-a"));
    expect(row?.activeKey).toBe("user-1");

    await updateRunState("run-a", {
      mutate: (current) =>
        recomputeRunState({
          ...current,
          phase: "completed",
          vms: current.vms.map((vm) => ({ ...vm, phase: "completed" })),
        }),
    });
    [row] = await db
      .select({ activeKey: scenarioRuns.activeKey })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "run-a"));
    expect(row?.activeKey).toBe("user-1");

    const retry = await destroyScenarioRunForUserWithDependencies(
      { runId: "run-a", userId: "user-1" },
      successfulDependencies(),
    );
    expect(retry.activeSlotReleased).toBe(true);
    [row] = await db
      .select({ activeKey: scenarioRuns.activeKey })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "run-a"));
    expect(row?.activeKey).toBeNull();
  });

  it("retains the foreground slot when desired-state mutation fails", async () => {
    const now = Date.now();
    await seedDestroyableRun("run-a", now);

    await expect(
      destroyScenarioRunForUserWithDependencies(
        { runId: "run-a", userId: "user-1" },
        {
          ...successfulDependencies(),
          markVmsAbsent: async () => {
            throw new Error("D1 unavailable");
          },
        },
      ),
    ).rejects.toThrow("Workspace shutdown could not be requested");

    const [row] = await drizzle(env.DB)
      .select({
        activeKey: scenarioRuns.activeKey,
        deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "run-a"));
    expect(row?.activeKey).toBe("user-1");
    expect(row?.deleteRequestedAt).not.toBeNull();
  });

  it("does not auto-release when teardown intent and a terminal state land together", async () => {
    const now = Date.now();
    await seedDestroyableRun("run-a", now);

    await updateRunState("run-a", {
      mutate: (current) =>
        recomputeRunState({
          ...current,
          phase: "completed",
          vms: current.vms.map((vm) => ({ ...vm, phase: "completed" })),
        }),
      deleteRequestedAt: now + 1,
    });

    const [row] = await drizzle(env.DB)
      .select({ activeKey: scenarioRuns.activeKey })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "run-a"));
    expect(row?.activeKey).toBe("user-1");
  });

  it("allows a new foreground run while the old run finishes without cross-clearing", async () => {
    const now = Date.now();
    await seedDestroyableRun("run-a", now);
    await destroyScenarioRunForUserWithDependencies(
      { runId: "run-a", userId: "user-1" },
      successfulDependencies(),
    );

    const db = drizzle(env.DB);
    await seedRun({
      db,
      hostId: "host-1",
      runId: "run-b",
      runtimeVmName: "runtime-b",
      now: now + 100,
    });
    await updateRunState("run-a", {
      mutate: (current) =>
        recomputeRunState({
          ...current,
          phase: "completed",
          vms: current.vms.map((vm) => ({ ...vm, phase: "completed" })),
        }),
    });

    const rows = await db
      .select({
        runId: scenarioRuns.runId,
        activeKey: scenarioRuns.activeKey,
      })
      .from(scenarioRuns);
    expect(rows.find((row) => row.runId === "run-a")?.activeKey).toBeNull();
    expect(rows.find((row) => row.runId === "run-b")?.activeKey).toBe(
      "user-1",
    );
  });
});

function successfulDependencies() {
  return {
    markVmsAbsent: markRunVmsAbsentInDesiredState,
    revokeRoutes: async () => {},
    wakeHostRuntime: async () => {},
  };
}

async function seedDestroyableRun(runId: string, now: number) {
  await seedHost("host-1");
  const db = drizzle(env.DB);
  await seedRun({
    db,
    hostId: "host-1",
    runId,
    runtimeVmName: "runtime-a",
    now,
  });
  await mutateStoredHostDesiredState(db, "host-1", now, (draft) => {
    upsertDesiredVm(draft, {
      run_id: runId,
      vm_name: "runtime-a",
      desired_phase: "running",
      image_key: testImageKey,
      image_sha256: "2".repeat(64),
      resources: {
        cpu_millis: 1_000,
        vcpu_count: 1,
        memory_mib: 512,
        disk_mib: 4_096,
      },
      ssh_authorized_keys_openssh: [],
      lease_expires_at_unix_ms: now + 60_000,
    });
  });
}
