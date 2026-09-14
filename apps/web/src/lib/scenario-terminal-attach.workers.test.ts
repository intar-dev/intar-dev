/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  drizzle,
  env,
  eq,
  resetHostRuntimeTestDatabase,
  scenarioRuns,
  seedHost,
  seedRun,
} from "@/control-plane/host-runtime-do/test-fixtures";

const mocks = vi.hoisted(() => {
  class StargateTerminalAttachError extends Error {
    constructor(readonly status: number) {
      super("stargate terminal target attach failed (" + status + ")");
    }
  }
  return {
    StargateTerminalAttachError,
    deleteStargateRoute: vi.fn(),
    deleteStargateTerminalRoute: vi.fn(),
    stageStargateTerminalTarget: vi.fn(),
    activateStargateTerminalTarget: vi.fn(),
    loadRuntimeVmAccessKey: vi.fn(),
    getBetaAccess: vi.fn(),
  };
});

vi.mock("@/lib/stargate", () => ({
  StargateTerminalAttachError: mocks.StargateTerminalAttachError,
  deleteStargateRoute: mocks.deleteStargateRoute,
  deleteStargateTerminalRoute: mocks.deleteStargateTerminalRoute,
  stageStargateTerminalTarget: mocks.stageStargateTerminalTarget,
  activateStargateTerminalTarget: mocks.activateStargateTerminalTarget,
}));
vi.mock("@/lib/runtime-vm-state", () => ({
  loadRuntimeVmAccessKey: mocks.loadRuntimeVmAccessKey,
}));
// The admission fence reads the epoch before and after the attach, so the
// post-read is part of the fail-closed path under test.
vi.mock("@/lib/allowlist", () => ({
  getBetaAccess: mocks.getBetaAccess,
}));

import {
  attachReadyScenarioTerminalTargets,
  reconcileScenarioTerminalRouteAttachments,
} from "@/lib/scenario-terminal-attach";

const RUN_ID = "run-1";
const NOW = 1_700_000_000_000;

describe("scenario terminal attach", () => {
  beforeEach(async () => {
    await resetHostRuntimeTestDatabase();
    vi.clearAllMocks();
    await seedHost("host-1");
    await seedRun({
      db: drizzle(env.DB),
      hostId: "host-1",
      runId: RUN_ID,
      runtimeVmName: "run-1-webserver",
      now: NOW,
    });
    await markRunActive();
    await seedTerminalTarget();
    mocks.stageStargateTerminalTarget.mockResolvedValue({
      attachmentId: "attachment-1",
    });
    mocks.activateStargateTerminalTarget.mockResolvedValue(undefined);
    mocks.getBetaAccess.mockResolvedValue({
      userId: "user-1",
      state: "active",
      githubAccountId: "github-1",
      githubUsername: "user-1",
      revocationId: null,
      sourceInviteId: "invite-1",
      sourceLeaseId: "lease-1",
      grantedAt: NOW,
    });
    mocks.loadRuntimeVmAccessKey.mockResolvedValue({
      executionId: RUN_ID,
      runtimeVmId: "runtime-vm-1",
      vmId: "vm-1",
      runtimeVmName: "run-1-webserver",
      publicKeyOpenssh: "ssh-ed25519 ACCESS access@example.test",
      privateKeyOpenssh: "PRIVATE KEY",
    });
  });

  it("stages, activates, and only then marks the target attached", async () => {
    await expect(attachRequest()).resolves.toBe("attached");

    expect(mocks.stageStargateTerminalTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: `${RUN_ID}:1`,
        runId: RUN_ID,
        vmId: "vm-1",
        userId: "user-1",
        target: expect.objectContaining({
          host: "10.0.0.10",
          port: 22,
          username: "ubuntu",
          privateKeyOpenssh: "PRIVATE KEY",
          authorizedClientPublicKeysOpenssh: [
            "ssh-ed25519 ACCESS access@example.test",
          ],
        }),
      }),
    );
    // Activation carries the id from the stage, so the PTY can only open for
    // the exact attachment the fence confirmed.
    expect(mocks.activateStargateTerminalTarget).toHaveBeenCalledWith({
      routeUsername: expect.any(String),
      generation: `${RUN_ID}:1`,
      attachmentId: "attachment-1",
      runId: RUN_ID,
      vmId: "vm-1",
      userId: "user-1",
    });
    expect(await attachedAt()).toBeGreaterThan(0);

    // The marker removes the work from the pending set, so the next reconcile
    // pass sends nothing.
    await expect(
      reconcileScenarioTerminalRouteAttachments({ hostId: "host-1" }),
    ).resolves.toEqual({ attempted: 0, attached: 0 });
  });

  it("refuses a replaced generation before any credential is read", async () => {
    await expect(
      attachReadyScenarioTerminalTargets({
        ...attachInput(),
        expectedGeneration: 2,
      }),
    ).rejects.toThrow(/replaced runtime generation/);

    expect(mocks.loadRuntimeVmAccessKey).not.toHaveBeenCalled();
    expect(mocks.stageStargateTerminalTarget).not.toHaveBeenCalled();
    expect(mocks.activateStargateTerminalTarget).not.toHaveBeenCalled();
  });

  it("keeps a transient stage failure pending for the next reconcile", async () => {
    mocks.stageStargateTerminalTarget.mockRejectedValue(
      new mocks.StargateTerminalAttachError(503),
    );

    await expect(
      reconcileScenarioTerminalRouteAttachments({ hostId: "host-1" }),
    ).resolves.toEqual({ attempted: 1, attached: 0 });
    expect(await attachedAt()).toBeNull();

    mocks.stageStargateTerminalTarget.mockResolvedValue({
      attachmentId: "attachment-1",
    });
    await expect(
      reconcileScenarioTerminalRouteAttachments({ hostId: "host-1" }),
    ).resolves.toEqual({ attempted: 1, attached: 1 });
    expect(await attachedAt()).toBeGreaterThan(0);
  });

  it("treats a revoked route as a rejection without losing the work", async () => {
    mocks.stageStargateTerminalTarget.mockRejectedValue(
      new mocks.StargateTerminalAttachError(409),
    );

    await expect(
      reconcileScenarioTerminalRouteAttachments({ hostId: "host-1" }),
    ).resolves.toEqual({ attempted: 1, attached: 0 });
    expect(await attachedAt()).toBeNull();
  });

  it("stages the new endpoint after the guest reports it", async () => {
    await expect(attachRequest()).resolves.toBe("attached");

    await observeNewEndpoint("10.0.0.11", NOW + 5_000);

    await expect(
      reconcileScenarioTerminalRouteAttachments({ hostId: "host-1" }),
    ).resolves.toEqual({ attempted: 1, attached: 1 });
    expect(mocks.stageStargateTerminalTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ host: "10.0.0.11" }),
      }),
    );
    expect(await attachedAt()).toBe(NOW + 5_000);
  });

  it("never activates a target the guest replaced while it was staged", async () => {
    // The stage reads the current revision, then the guest reports a new
    // endpoint while the gateway call is still in flight.
    mocks.stageStargateTerminalTarget.mockImplementation(async () => {
      await observeNewEndpoint("10.0.0.11", NOW + 5_000);
      return { attachmentId: "attachment-1" };
    });

    await expect(attachRequest()).resolves.toBe("not_ready");

    // The stale target is never activated and never marked attached, so no
    // shell can appear on an endpoint the guest no longer serves. The route is
    // kept for now: this branch returns before activation, so the staged
    // target is inert and the browser socket stays in its pending wait.
    expect(mocks.activateStargateTerminalTarget).not.toHaveBeenCalled();
    expect(await attachedAt()).toBeNull();
    expect(mocks.deleteStargateTerminalRoute).not.toHaveBeenCalled();

    // The replaced endpoint is still refused. The gateway rejects a second,
    // different target for one route with 409, so the fence revokes the route
    // rather than activating the endpoint the guest stopped serving.
    mocks.stageStargateTerminalTarget.mockRejectedValue(
      new mocks.StargateTerminalAttachError(409),
    );
    await expect(
      reconcileScenarioTerminalRouteAttachments({ hostId: "host-1" }),
    ).resolves.toEqual({ attempted: 1, attached: 0 });
    expect(mocks.deleteStargateTerminalRoute).toHaveBeenCalledWith(
      expect.any(String),
      `${RUN_ID}:1`,
    );
    expect(mocks.activateStargateTerminalTarget).not.toHaveBeenCalled();
    expect(await attachedAt()).toBeNull();
  });

  it("keeps the route and the work pending when only the observation advanced", async () => {
    // The agent re-reports the same endpoint while the stage is in flight. That
    // advances terminal_observed_at without changing the target, which is the
    // shape a busy route meets on every report interval.
    mocks.stageStargateTerminalTarget.mockImplementation(async () => {
      await observeNewEndpoint("10.0.0.10", NOW + 5_000);
      return { attachmentId: "attachment-1" };
    });

    await expect(attachRequest()).resolves.toBe("not_ready");

    // The route survives, so a live socket on it is not terminated, and no
    // shell opens on the revision that was staged.
    expect(mocks.deleteStargateTerminalRoute).not.toHaveBeenCalled();
    expect(mocks.activateStargateTerminalTarget).not.toHaveBeenCalled();
    expect(await attachedAt()).toBeNull();

    // The target is still pending, so the next reconcile pass activates the
    // observation the guest reports now: the wait is not permanent.
    mocks.stageStargateTerminalTarget.mockResolvedValue({
      attachmentId: "attachment-1",
    });
    await expect(
      reconcileScenarioTerminalRouteAttachments({ hostId: "host-1" }),
    ).resolves.toEqual({ attempted: 1, attached: 1 });
    expect(mocks.activateStargateTerminalTarget).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: "attachment-1" }),
    );
    expect(await attachedAt()).toBe(NOW + 5_000);
    expect(mocks.deleteStargateTerminalRoute).not.toHaveBeenCalled();
  });

  it("refuses to attach when the host session was replaced", async () => {
    await env.DB.prepare(
      "UPDATE agent_hosts SET active_session_id = 'session-2' WHERE id = ?1",
    )
      .bind("host-1")
      .run();

    await expect(
      attachReadyScenarioTerminalTargets({
        ...attachInput(),
        expectedHostSessionId: "session-1",
      }),
    ).rejects.toThrow(/replaced runtime generation/);
    expect(mocks.stageStargateTerminalTarget).not.toHaveBeenCalled();
    expect(mocks.activateStargateTerminalTarget).not.toHaveBeenCalled();
  });

  it("keeps the shell inert when the post-stage epoch read fails", async () => {
    // The stage landed, then the confirmation read itself throws. The fence
    // revokes, and activation must never run: no PTY, no woken socket.
    mocks.getBetaAccess
      .mockResolvedValueOnce(activeAdmission())
      .mockRejectedValueOnce(new Error("D1 read unavailable"));

    await expect(attachRequest()).rejects.toThrow(/D1 read unavailable/);

    expect(mocks.stageStargateTerminalTarget).toHaveBeenCalledTimes(1);
    expect(mocks.activateStargateTerminalTarget).not.toHaveBeenCalled();
    expect(mocks.deleteStargateTerminalRoute).toHaveBeenCalledWith(
      expect.any(String),
      `${RUN_ID}:1`,
    );
    expect(await attachedAt()).toBeNull();
  });

  it("does not activate until the post-stage epoch read resolves", async () => {
    // Hold the confirmation read open and prove activation can not start while
    // the fence is still deciding. This is the ordering the two phases exist
    // for: the shell is gated on the post-fence, exactly like the old flow,
    // where the route URL was returned only after it.
    let releasePost!: (value: ReturnType<typeof activeAdmission>) => void;
    const postGate = new Promise<ReturnType<typeof activeAdmission>>((resolve) => {
      releasePost = resolve;
    });
    mocks.getBetaAccess
      .mockResolvedValueOnce(activeAdmission())
      .mockReturnValueOnce(postGate);

    const pending = attachRequest();
    await expect.poll(() => mocks.stageStargateTerminalTarget.mock.calls.length).toBe(1);
    // Give the pipeline every chance to move past the fence before it can.
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(mocks.activateStargateTerminalTarget).not.toHaveBeenCalled();
    expect(await attachedAt()).toBeNull();

    releasePost(activeAdmission());
    await expect(pending).resolves.toBe("attached");
    expect(mocks.activateStargateTerminalTarget).toHaveBeenCalledTimes(1);
    expect(await attachedAt()).toBe(NOW);
  });

  it("revokes the generation route and never activates when the epoch changes", async () => {
    mocks.getBetaAccess
      .mockResolvedValueOnce(activeAdmission())
      .mockResolvedValueOnce({ ...activeAdmission(), state: "blocked" });

    await expect(attachRequest()).rejects.toMatchObject({ status: 403 });

    expect(mocks.activateStargateTerminalTarget).not.toHaveBeenCalled();
    expect(mocks.deleteStargateTerminalRoute).toHaveBeenCalledWith(
      expect.any(String),
      `${RUN_ID}:1`,
    );
    expect(await attachedAt()).toBeNull();
  });

  it("revokes the generation route when activation is not confirmed", async () => {
    // The gate opened, then activation itself failed ambiguously. A shell may
    // exist on the gateway, so the route is revoked and the failure surfaces.
    mocks.activateStargateTerminalTarget.mockRejectedValue(
      new mocks.StargateTerminalAttachError(503),
    );

    await expect(attachRequest()).rejects.toThrow(/attach failed/);

    expect(mocks.deleteStargateTerminalRoute).toHaveBeenCalledWith(
      expect.any(String),
      `${RUN_ID}:1`,
    );
    expect(await attachedAt()).toBeNull();
  });

  it("stages and activates again for a re-created route of the same generation", async () => {
    await expect(attachRequest()).resolves.toBe("attached");
    expect(await attachedAt()).toBe(NOW);

    // A revoke and a reconnect re-create the route with the same generation.
    // The fresh route is unattached even though the marker still names the
    // current observation, so the create path forces the attach. Both phases
    // run again, and activation is idempotent for the same attachment.
    mocks.stageStargateTerminalTarget.mockClear();
    mocks.activateStargateTerminalTarget.mockClear();
    await expect(
      attachReadyScenarioTerminalTargets({ ...attachInput(), force: true }),
    ).resolves.toBe("attached");
    expect(mocks.stageStargateTerminalTarget).toHaveBeenCalledTimes(1);
    expect(mocks.activateStargateTerminalTarget).toHaveBeenCalledTimes(1);
  });
});

function activeAdmission() {
  return {
    userId: "user-1",
    state: "active",
    githubAccountId: "github-1",
    githubUsername: "user-1",
    revocationId: null,
    sourceInviteId: "invite-1",
    sourceLeaseId: "lease-1",
    grantedAt: NOW,
  };
}

function attachInput() {
  return {
    executionId: RUN_ID,
    expectedGeneration: 1,
    expectedUserId: "user-1",
    hostId: "host-1",
    runId: RUN_ID,
    vmId: "vm-1",
  };
}

function attachRequest() {
  return attachReadyScenarioTerminalTargets(attachInput());
}

async function attachedAt(): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT terminal_attached_at AS attached_at FROM runtime_vms" +
      " WHERE execution_id = ?1 AND vm_id = ?2",
  )
    .bind(RUN_ID, "vm-1")
    .first<{ attached_at: number | null }>();
  return row?.attached_at ?? null;
}

async function observeNewEndpoint(
  host: string,
  observedAt: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE runtime_vms SET terminal_observed_at = ?1, terminal_host = ?2" +
      " WHERE execution_id = ?3 AND vm_id = ?4",
  )
    .bind(observedAt, host, RUN_ID, "vm-1")
    .run();
}

async function markRunActive(): Promise<void> {
  const db = drizzle(env.DB);
  const [row] = await db
    .select({ stateJson: scenarioRuns.stateJson })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.runId, RUN_ID));
  if (!row) throw new Error("run fixture is missing");
  const state = JSON.parse(row.stateJson) as Record<string, unknown>;
  // The projection recomputes the run phase from the VM state, so the VM must
  // be ready for the run to accept terminal sessions.
  state.vms = (state.vms as Array<Record<string, unknown>>).map((vm) => ({
    ...vm,
    phase: "ready",
    terminalPhase: "ready",
    canOpenTerminal: true,
    terminalTarget: {
      host: "10.0.0.10",
      port: 22,
      username: "ubuntu",
      hostKeyOpenssh: "ssh-ed25519 HOST host@example.test",
      checkedAt: NOW,
    },
  }));
  await db
    .update(scenarioRuns)
    .set({ stateJson: JSON.stringify(state) })
    .where(eq(scenarioRuns.runId, RUN_ID));
}

async function seedTerminalTarget(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO runtime_vms (" +
      " id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json," +
      " image_sha256, cpu_millis, memory_mib, disk_mib, terminal_host," +
      " terminal_port, terminal_username, terminal_host_key_openssh," +
      " terminal_private_key_ciphertext_b64, terminal_private_key_iv_b64," +
      " terminal_observed_at, created_at, updated_at" +
      " ) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, 1000, 512, 4096, ?7, 22, 'ubuntu'," +
      " ?8, 'cipher', 'iv', ?9, ?9, ?9)",
  )
    .bind(
      "runtime-vm-1",
      RUN_ID,
      "vm-1",
      "run-1-webserver",
      JSON.stringify({ schema_version: 1 }),
      "2".repeat(64),
      "10.0.0.10",
      "ssh-ed25519 HOST host@example.test",
      NOW,
    )
    .run();
}
