import { beforeEach, describe, expect, it } from "vitest";
import {
  betaAdmissionForHostFixture,
  drizzle,
  env,
  resetHostRuntimeTestDatabase,
  seedEnabledScenario,
  seedHost,
  startScenarioRunForUser,
} from "@/control-plane/host-runtime-do/test-fixtures";
import { withRuntimeAllocationLock } from "@/lib/runtime-allocation-lock";

describe("scenario allocation contention", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("keeps the lock-busy code and creates no run while another allocation holds the lock", async () => {
    await seedHost("host-allocation-busy");
    await seedEnabledScenario(drizzle(env.DB), Date.now());
    const betaAdmission = await betaAdmissionForHostFixture("user-1");

    await withRuntimeAllocationLock({
      key: "runtime-capacity:unscoped",
      operation: async () => {
        await expect(
          startScenarioRunForUser({
            scenarioId: "broken-nginx",
            userId: "user-1",
            betaAdmission,
          }),
        ).rejects.toMatchObject({ code: "runtime_allocation_busy" });

        const run = await env.DB.prepare("SELECT run_id FROM scenario_runs").first();
        expect(run).toBeNull();
        const lock = await env.DB.prepare(
          "SELECT key FROM runtime_allocation_locks WHERE key = ?",
        ).bind("runtime-capacity:unscoped").first();
        expect(lock).not.toBeNull();
      },
    });

    const lock = await env.DB.prepare("SELECT key FROM runtime_allocation_locks").first();
    expect(lock).toBeNull();
  });
});
