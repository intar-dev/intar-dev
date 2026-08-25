/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildInitialRunState } from "@/lib/run-state";

const mocks = vi.hoisted(() => ({
  loadRunRow: vi.fn(),
  loadHostTerminalAddress: vi.fn(),
  listUserAuthorizedSshKeysForNativeRoutes: vi.fn(),
  loadScenarioRunSshKey: vi.fn(),
  issueStargateTerminalSession: vi.fn(),
  issueBetaAccessFencedRoute: vi.fn(),
  buildRunVmRouteUsername: vi.fn(),
}));

vi.mock("@/lib/beta-route-issuance", () => ({
  issueBetaAccessFencedRoute: mocks.issueBetaAccessFencedRoute,
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
  deleteStargateRoute: vi.fn(),
  issueStargateTerminalSession: mocks.issueStargateTerminalSession,
  stargateRouteTtlMs: () => 10_000,
}));
vi.mock("@/lib/scenario-runs/start", () => ({
  startScenarioRunInternal: vi.fn(),
  markRunVmsAbsentInDesiredState: vi.fn(),
  revokeScenarioRunRoutes: vi.fn(),
  buildRunVmRouteUsername: mocks.buildRunVmRouteUsername,
}));

import { createScenarioSshSessionForUser } from "@/lib/scenario-runs/lifecycle";

describe("scenario native SSH authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadRunRow.mockResolvedValue(readyRunRow());
    mocks.loadHostTerminalAddress.mockResolvedValue(null);
    mocks.loadScenarioRunSshKey.mockResolvedValue({
      privateKeyOpenssh: "PRIVATE KEY",
    });
    mocks.buildRunVmRouteUsername.mockImplementation(
      (_runId: string, _vms: unknown, _vmId: string, routeType: string) =>
        `route-${routeType}`,
    );
    mocks.issueBetaAccessFencedRoute.mockImplementation(
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
        authorizedClientPublicKeysOpenssh: [
          "ssh-ed25519 PROFILE profile@example.test",
        ],
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
        authorizedClientPublicKeysOpenssh: [],
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
