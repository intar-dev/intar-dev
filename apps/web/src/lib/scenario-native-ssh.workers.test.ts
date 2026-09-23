/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildInitialRunState } from "@/lib/run-state";

const mocks = vi.hoisted(() => ({
  loadRunRow: vi.fn(),
  loadHostTerminalAddress: vi.fn(),
  listUserAuthorizedSshKeysForNativeRoutes: vi.fn(),
  loadScenarioRunSshKey: vi.fn(),
  issueStargateTerminalSession: vi.fn(),
  issueAccountFencedRoute: vi.fn(),
  buildRunVmRouteUsername: vi.fn(),
  loadScenarioTerminalRouteGeneration: vi.fn(),
  attachReadyScenarioTerminalTargets: vi.fn(),
  deleteStargateRoute: vi.fn(),
}));

vi.mock("@/lib/stargate-relay", () => ({
  loadStargateSshTransport: vi.fn(async (input) => ({kind:"direct",host:input.directHost,port:input.directPort})),
}));
vi.mock("@/lib/account-route-issuance", () => ({
  issueAccountFencedRoute: mocks.issueAccountFencedRoute,
}));
vi.mock("@/lib/scenario-runs/storage", () => ({
  loadRunRow: mocks.loadRunRow,
  loadHostTerminalAddress: mocks.loadHostTerminalAddress,
  updateRunState: vi.fn(),
  fromDbRow: vi.fn(),
  toScenarioRunRecord: vi.fn(),
}));
vi.mock("@/lib/user-ssh-keys", () => ({
  listUserAuthorizedSshKeysForNativeRoutes:
    mocks.listUserAuthorizedSshKeysForNativeRoutes,
}));
vi.mock("@/lib/scenario-run-ssh-keys", () => ({
  loadScenarioRunSshKey: mocks.loadScenarioRunSshKey,
}));
vi.mock("@/lib/stargate", () => ({
  deleteStargateRoute: mocks.deleteStargateRoute,
  issueStargateTerminalSession: mocks.issueStargateTerminalSession,
  stargateRouteTtlMs: () => 10_000,
}));
vi.mock("@/lib/scenario-runs/start", () => ({
  startScenarioRunInternal: vi.fn(),
  markRunVmsAbsentInDesiredState: vi.fn(),
  revokeScenarioRunRoutes: vi.fn(),
  buildRunVmRouteUsername: mocks.buildRunVmRouteUsername,
}));
vi.mock("@/lib/scenario-terminal-route-generation", () => ({
  loadScenarioTerminalRouteGeneration:
    mocks.loadScenarioTerminalRouteGeneration,
}));
vi.mock("@/lib/scenario-terminal-attach", () => ({
  attachReadyScenarioTerminalTargets: mocks.attachReadyScenarioTerminalTargets,
}));

import { createScenarioSshSessionForUser } from "@/lib/scenario-runs/lifecycle";

describe("scenario native SSH authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadScenarioTerminalRouteGeneration.mockResolvedValue({
      executionId: "run-1",
      generation: 1,
      routeGeneration: "run-1:1",
      userId: "user-1",
      hostId: "host-1",
      hostCredentialGeneration: 1,
    });
    mocks.attachReadyScenarioTerminalTargets.mockResolvedValue("not_ready");
    mocks.loadRunRow.mockResolvedValue(readyRunRow());
    mocks.loadHostTerminalAddress.mockResolvedValue(null);
    mocks.loadScenarioRunSshKey.mockResolvedValue({
      privateKeyOpenssh: "PRIVATE KEY",
    });
    mocks.buildRunVmRouteUsername.mockImplementation(
      (_runId: string, _vms: unknown, _vmId: string, routeType: string) =>
        `route-${routeType}`,
    );
    mocks.issueAccountFencedRoute.mockImplementation(
      (input: { issue: () => Promise<unknown> }) => input.issue(),
    );
    mocks.issueStargateTerminalSession.mockResolvedValue({
      routeUsername: "route-native",
      expiresAt: 1_000,
      native: { authMode: "profile_keys" },
    });
  });

  it("uses saved profile keys when no temporary key is supplied", async () => {
    mocks.listUserAuthorizedSshKeysForNativeRoutes.mockResolvedValue([
      { publicKeyOpenssh: "ssh-ed25519 PROFILE profile@example.test" },
    ]);

    await createScenarioSshSessionForUser({
      runId: "run-1",
      vmId: "vm-1",
      userId: "user-1",
      mode: "native",
    });

    expect(mocks.buildRunVmRouteUsername).toHaveBeenCalledWith(
      "run-1",
      expect.any(Array),
      "vm-1",
      "native_profile_keys",
    );
    expect(mocks.issueStargateTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        routeUsername: "route-native_profile_keys",
        mode: "native",
        target: expect.objectContaining({
          username: "ubuntu",
          transport: {kind:"direct", host:"10.0.0.10",port:22},
          authorizedClientPublicKeysOpenssh: [
            "ssh-ed25519 PROFILE profile@example.test",
          ],
        }),
      }),
    );
    expect(
      mocks.issueStargateTerminalSession.mock.calls[0]?.[0],
    ).not.toHaveProperty("temporaryClientPublicKeyOpenssh");
  });

  it("uses the supplied temporary key even when profile keys exist", async () => {
    mocks.listUserAuthorizedSshKeysForNativeRoutes.mockResolvedValue([
      { publicKeyOpenssh: "ssh-ed25519 PROFILE profile@example.test" },
    ]);

    await createScenarioSshSessionForUser({
      runId: "run-1",
      vmId: "vm-1",
      userId: "user-1",
      mode: "native",
      clientPublicKeyOpenssh: "ssh-ed25519 TEMP temporary@example.test",
    });

    expect(mocks.buildRunVmRouteUsername).toHaveBeenCalledWith(
      "run-1",
      expect.any(Array),
      "vm-1",
      "native_issued_key",
    );
    expect(mocks.issueStargateTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        routeUsername: "route-native_issued_key",
        mode: "native",
        target: expect.objectContaining({
          authorizedClientPublicKeysOpenssh: [],
        }),
        temporaryClientPublicKeyOpenssh:
          "ssh-ed25519 TEMP temporary@example.test",
      }),
    );
  });

  it("rejects native SSH when neither a temporary nor a profile key exists", async () => {
    mocks.listUserAuthorizedSshKeysForNativeRoutes.mockResolvedValue([]);

    await expect(
      createScenarioSshSessionForUser({
        runId: "run-1",
        vmId: "vm-1",
        userId: "user-1",
        mode: "native",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_native_ssh_key_required",
    });
    expect(mocks.issueStargateTerminalSession).not.toHaveBeenCalled();
  });

  it("opens a pending browser route without the guest key or address", async () => {
    mocks.issueStargateTerminalSession.mockResolvedValue({
      routeUsername: "route-browser",
      expiresAt: 1_000,
      generation: "run-1:1",
      browser: { websocketUrl: "wss://stargate.test/v1/terminal/ws?token=t" },
    });

    await createScenarioSshSessionForUser({
      runId: "run-1",
      vmId: "vm-1",
      userId: "user-1",
    });

    expect(mocks.buildRunVmRouteUsername).toHaveBeenCalledWith(
      "run-1",
      expect.any(Array),
      "vm-1",
      "browser",
    );
    const issueInput = mocks.issueStargateTerminalSession.mock.calls[0]?.[0];
    expect(issueInput).toMatchObject({
      mode: "browser",
      routeUsername: "route-browser",
      generation: "run-1:1",
    });
    // The pending create carries no endpoint, no host key, and no guest key.
    expect(issueInput).not.toHaveProperty("target");
    expect(issueInput).not.toHaveProperty("privateKeyOpenssh");
    expect(JSON.stringify(issueInput)).not.toContain("10.0.0.10");
    expect(mocks.loadScenarioRunSshKey).not.toHaveBeenCalled();
  });

  it("attaches immediately when the VM was already ready before the route", async () => {
    mocks.issueStargateTerminalSession.mockResolvedValue({
      routeUsername: "route-browser",
      expiresAt: 1_000,
      generation: "run-1:1",
      browser: { websocketUrl: "wss://stargate.test/v1/terminal/ws?token=t" },
    });
    mocks.attachReadyScenarioTerminalTargets.mockResolvedValue("attached");

    await createScenarioSshSessionForUser({
      runId: "run-1",
      vmId: "vm-1",
      userId: "user-1",
    });

    // A freshly created route is always unattached, so the create path forces
    // the attach even when a stale marker names the current observation.
    expect(mocks.attachReadyScenarioTerminalTargets).toHaveBeenCalledWith({
      executionId: "run-1",
      expectedGeneration: 1,
      expectedUserId: "user-1",
      hostId: "host-1",
      runId: "run-1",
      vmId: "vm-1",
      force: true,
    });
  });

  it("fails closed when the immediate attach is not confirmed", async () => {
    mocks.issueStargateTerminalSession.mockResolvedValue({
      routeUsername: "route-browser",
      expiresAt: 1_000,
      generation: "run-1:1",
      browser: { websocketUrl: "wss://stargate.test/v1/terminal/ws?token=t" },
    });
    mocks.attachReadyScenarioTerminalTargets.mockRejectedValue(
      new Error("stargate terminal target attach failed (503)"),
    );

    // The attach fence revokes the route on an unconfirmed outcome, so the
    // create must not hand the browser a socket to a revoked route.
    await expect(
      createScenarioSshSessionForUser({
        runId: "run-1",
        vmId: "vm-1",
        userId: "user-1",
      }),
    ).rejects.toThrow(/attach failed/);
  });

  it("does not rotate or re-attach an already attached route", async () => {
    mocks.issueStargateTerminalSession.mockResolvedValue({
      routeUsername: "route-browser",
      expiresAt: 1_000,
      generation: "run-1:1",
      browser: { websocketUrl: "wss://stargate.test/v1/terminal/ws?token=t" },
    });
    // The route already carries the current revision, so the helper reports no
    // work. A second tab must not reset the ready target or steal the socket.
    mocks.attachReadyScenarioTerminalTargets.mockResolvedValue("not_ready");

    const session = await createScenarioSshSessionForUser({
      runId: "run-1",
      vmId: "vm-1",
      userId: "user-1",
    });

    expect(session).toMatchObject({
      routeUsername: "route-browser",
      generation: "run-1:1",
    });
    expect(mocks.attachReadyScenarioTerminalTargets).toHaveBeenCalledTimes(1);
    expect(mocks.deleteStargateRoute).not.toHaveBeenCalled();
  });

  it("opens one pending browser route while the run is still booting", async () => {
    mocks.loadRunRow.mockResolvedValue(bootingRunRow());
    mocks.issueStargateTerminalSession.mockResolvedValue({
      routeUsername: "route-browser",
      expiresAt: 1_000,
      generation: "run-1:1",
      browser: { websocketUrl: "wss://stargate.test/v1/terminal/ws?token=t" },
    });

    // The transport is mounted and connecting while the VM boots, so this is
    // the boot-time request. It must return the waiting route, not 409.
    const session = await createScenarioSshSessionForUser({
      runId: "run-1",
      vmId: "vm-1",
      userId: "user-1",
    });

    expect(session).toMatchObject({
      routeUsername: "route-browser",
      generation: "run-1:1",
      browser: { websocketUrl: expect.stringContaining("wss://") },
    });
    const issueInput = mocks.issueStargateTerminalSession.mock.calls[0]?.[0];
    expect(issueInput).toMatchObject({ mode: "browser" });
    // The boot-time create is pending: no endpoint, no host key, no credential.
    expect(issueInput).not.toHaveProperty("target");
    expect(mocks.loadScenarioRunSshKey).not.toHaveBeenCalled();
    // The route exists before the target, so the attach reports not_ready and
    // the create still succeeds for the transport that waits for ready.
    expect(mocks.attachReadyScenarioTerminalTargets).toHaveBeenCalledWith(
      expect.objectContaining({ vmId: "vm-1", force: true }),
    );
  });

  it("keeps native SSH closed while the run is still booting", async () => {
    mocks.loadRunRow.mockResolvedValue(bootingRunRow());

    await expect(
      createScenarioSshSessionForUser({
        runId: "run-1",
        vmId: "vm-1",
        userId: "user-1",
        mode: "native",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_terminal_closed",
    });
    expect(mocks.issueStargateTerminalSession).not.toHaveBeenCalled();
  });

  it("keeps the native ready guard on a booting VM of an active run", async () => {
    const row = bootingRunRow();
    row.state.phase = "active_partial";
    mocks.loadRunRow.mockResolvedValue(row);

    await expect(
      createScenarioSshSessionForUser({
        runId: "run-1",
        vmId: "vm-1",
        userId: "user-1",
        mode: "native",
        // A supplied key clears the key guard so this case reaches the ready
        // guard that native SSH keeps on a booting VM.
        clientPublicKeyOpenssh: "ssh-ed25519 TEMP temporary@example.test",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_shell_not_ready",
    });
    expect(mocks.issueStargateTerminalSession).not.toHaveBeenCalled();
  });

  it("keeps a stopped, failed, or completed run closed to browser prearm", async () => {
    const booting = bootingRunRow();
    const cases = [
      { ...booting, state: { ...booting.state } },
      { ...readyRunRow(), failedAt: 1 },
      { ...readyRunRow(), completedAt: 1 },
    ];
    cases[0]!.state.phase = "teardown_requested";

    for (const row of cases) {
      mocks.loadRunRow.mockResolvedValue(row);
      await expect(
        createScenarioSshSessionForUser({
          runId: "run-1",
          vmId: "vm-1",
          userId: "user-1",
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "scenario_terminal_closed",
      });
    }
    expect(mocks.issueStargateTerminalSession).not.toHaveBeenCalled();
  });
});

function readyRunRow() {
  const state = buildInitialRunState({
    vms: [
      {
        id: "vm-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-1",
        scenarioVmName: "webserver",
        runtimeVmName: "run-1-webserver",
        hostname: "webserver",
        launchSummary: {
          scenarioVmName: "webserver",
          hostname: "webserver",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  const vm = state.vms[0];
  if (!vm) throw new Error("missing test VM");
  vm.canOpenTerminal = true;
  vm.terminalPhase = "ready";
  vm.terminalTarget = {
    host: "10.0.0.10",
    port: 22,
    username: "ubuntu",
    hostKeyOpenssh: "ssh-ed25519 HOST host@example.test",
    checkedAt: null,
  };
  state.phase = "active_full";

  return {
    runId: "run-1",
    userId: "user-1",
    hostId: "host-1",
    completedAt: null,
    failedAt: null,
    state,
  };
}

/**
 * The run row as it exists right after the begin batch: the phase is
 * provisioning, the VM is booting, and no terminal target is observed yet.
 */
function bootingRunRow() {
  const state = buildInitialRunState({
    vms: [
      {
        id: "vm-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-1",
        scenarioVmName: "webserver",
        runtimeVmName: "run-1-webserver",
        hostname: "webserver",
        launchSummary: {
          scenarioVmName: "webserver",
          hostname: "webserver",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  const vm = state.vms[0];
  if (!vm) throw new Error("missing test VM");
  vm.phase = "booting";
  state.phase = "provisioning";

  return {
    runId: "run-1",
    userId: "user-1",
    hostId: "host-1",
    completedAt: null,
    failedAt: null,
    state,
  };
}
