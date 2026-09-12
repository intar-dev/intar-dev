/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostDesiredState, runtimeOperationGates } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import { upsertRunVmsIntoDesiredState } from "@/lib/scenario-runs/start";
import { resetD1Database } from "@/test/d1-migrations";

const gateMocks = vi.hoisted(() => ({
  assertAgentKvmRunsOpen: vi.fn(),
}));

const pinMocks = vi.hoisted(() => ({
  loadScenarioGuestToolsPin: vi.fn(),
}));

vi.mock("@/lib/run-admission-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/run-admission-gate")>()),
  assertAgentKvmRunsOpen: gateMocks.assertAgentKvmRunsOpen,
}));

vi.mock("@/lib/scenario-guest-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scenario-guest-tools")>()),
  loadScenarioGuestToolsPin: pinMocks.loadScenarioGuestToolsPin,
}));

const PINNED_GUEST_TOOLS = {
  tools_disk_sha256: "a".repeat(64),
  tools_disk_size_bytes: 64 * 1024 * 1024,
  kino_sha256: "b".repeat(64),
  bootstrap_abi: 1,
};

const HOST_ID = "publish-reads-runner";
const PIN_UNAVAILABLE = "scenario guest-tools stable pin is unavailable";

describe("scenario start desired-state publish reads", () => {
  beforeEach(async () => {
    await resetD1Database();
    gateMocks.assertAgentKvmRunsOpen.mockReset();
    pinMocks.loadScenarioGuestToolsPin.mockReset();
  });

  it("reads the guest-tools pin while the drain gate query is still pending", async () => {
    const gate = deferred<void>();
    const pin = deferred<void>();
    let gateSettled = false;
    gateMocks.assertAgentKvmRunsOpen.mockImplementation(async () => {
      await gate.promise;
      gateSettled = true;
      throw drainGateError();
    });
    pinMocks.loadScenarioGuestToolsPin.mockImplementation(async () => {
      await pin.promise;
      return PINNED_GUEST_TOOLS;
    });

    const publish = upsertRunVmsIntoDesiredState(publishInput());
    await vi.waitFor(() =>
      expect(pinMocks.loadScenarioGuestToolsPin).toHaveBeenCalledTimes(1),
    );
    expect(gateSettled).toBe(false);

    gate.resolve();
    pin.resolve();
    await expect(publish).rejects.toMatchObject({
      status: 503,
      code: "runtime_cutover_drained",
    });
    await expect(desiredStateRows()).resolves.toEqual([]);
  });

  it("reports the drain gate rejection when the pin read also fails", async () => {
    gateMocks.assertAgentKvmRunsOpen.mockRejectedValue(drainGateError());
    pinMocks.loadScenarioGuestToolsPin.mockRejectedValue(
      new Error(PIN_UNAVAILABLE),
    );

    await expect(
      upsertRunVmsIntoDesiredState(publishInput()),
    ).rejects.toMatchObject({
      status: 503,
      code: "runtime_cutover_drained",
    });
    await expect(desiredStateRows()).resolves.toEqual([]);
  });

  it("refuses to publish when the pin read fails and the gate is open", async () => {
    gateMocks.assertAgentKvmRunsOpen.mockResolvedValue(undefined);
    pinMocks.loadScenarioGuestToolsPin.mockRejectedValue(
      new Error(PIN_UNAVAILABLE),
    );

    await expect(
      upsertRunVmsIntoDesiredState(publishInput()),
    ).rejects.toThrow(PIN_UNAVAILABLE);
    await expect(desiredStateRows()).resolves.toEqual([]);
  });

  it("refuses to publish on the stored drain gate", async () => {
    const actualGate = await vi.importActual<
      typeof import("@/lib/run-admission-gate")
    >("@/lib/run-admission-gate");
    gateMocks.assertAgentKvmRunsOpen.mockImplementation(
      actualGate.assertAgentKvmRunsOpen,
    );
    await drizzle(env.DB).insert(runtimeOperationGates).values({
      key: IMAGE_CUTOVER_GATE,
      state: "drained",
      updatedAt: Date.now(),
    });
    pinMocks.loadScenarioGuestToolsPin.mockResolvedValue(PINNED_GUEST_TOOLS);

    await expect(
      upsertRunVmsIntoDesiredState(publishInput()),
    ).rejects.toMatchObject({
      status: 503,
      code: "runtime_cutover_drained",
    });
    await expect(desiredStateRows()).resolves.toEqual([]);
  });
});

function publishInput() {
  return {
    hostId: HOST_ID,
    runId: "publish-reads-run",
    userId: "publish-reads-user",
    betaAdmission: {
      sourceInviteId: "publish-reads-invite",
      sourceLeaseId: "publish-reads-lease",
      grantedAt: 1_000,
    },
    vms: [],
    nowUnixMs: 2_000,
    sshAuthorizedKeysByVmId: new Map<string, string[]>(),
  };
}

function desiredStateRows() {
  return drizzle(env.DB)
    .select({ doc: hostDesiredState.docJson })
    .from(hostDesiredState)
    .where(eq(hostDesiredState.hostId, HOST_ID));
}

function drainGateError() {
  return appError(
    503,
    "runtime_cutover_drained",
    "new VM runs are paused for a short runtime update",
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
