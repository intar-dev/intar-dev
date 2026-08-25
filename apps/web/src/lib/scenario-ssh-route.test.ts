import { beforeEach, describe, expect, it, vi } from "vitest";
import { appError } from "@/lib/app-error";

const agentBridgeMock = vi.hoisted(() => ({
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  requireUserContext: vi.fn(),
}));
const scenarioRunsMock = vi.hoisted(() => ({
  createScenarioSshSessionForUser: vi.fn(),
}));
const userSshKeysMock = vi.hoisted(() => ({
  normalizeTemporaryNativeSshPublicKey: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/scenario-runs", () => scenarioRunsMock);
vi.mock("@/lib/user-ssh-keys", () => userSshKeysMock);

import { POST } from "@/pages/api/scenarios/runs/[runId]/ssh";

describe("scenario SSH route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "user-1" },
    });
    scenarioRunsMock.createScenarioSshSessionForUser.mockResolvedValue({
      routeUsername: "run-1-webserver-ssh-issued",
      expiresAt: 1_000,
      native: {
        authMode: "issued_key",
      },
    });
    userSshKeysMock.normalizeTemporaryNativeSshPublicKey.mockResolvedValue(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest temporary@example.test",
    );
  });

  it("normalizes and forwards a temporary native SSH key", async () => {
    const response = await sshRequest({
      vmId: "vm-1",
      mode: "native",
      clientPublicKeyOpenssh:
        " ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest temporary@example.test ",
    });

    expect(response.status).toBe(200);
    expect(userSshKeysMock.normalizeTemporaryNativeSshPublicKey).toHaveBeenCalledWith(
      " ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest temporary@example.test ",
    );
    expect(scenarioRunsMock.createScenarioSshSessionForUser).toHaveBeenCalledWith({
      runId: "run-1",
      vmId: "vm-1",
      userId: "user-1",
      mode: "native",
      clientPublicKeyOpenssh:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest temporary@example.test",
    });
  });

  it("keeps a native profile-key request unchanged when no temporary key is supplied", async () => {
    const response = await sshRequest({ vmId: "vm-1", mode: "native" });

    expect(response.status).toBe(200);
    expect(userSshKeysMock.normalizeTemporaryNativeSshPublicKey).not.toHaveBeenCalled();
    expect(scenarioRunsMock.createScenarioSshSessionForUser).toHaveBeenCalledWith({
      runId: "run-1",
      vmId: "vm-1",
      userId: "user-1",
      mode: "native",
    });
  });

  it("rejects a temporary key outside native SSH", async () => {
    const response = await sshRequest({
      vmId: "vm-1",
      mode: "browser",
      clientPublicKeyOpenssh:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest temporary@example.test",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "clientPublicKeyOpenssh is only supported for native SSH",
    });
    expect(userSshKeysMock.normalizeTemporaryNativeSshPublicKey).not.toHaveBeenCalled();
    expect(scenarioRunsMock.createScenarioSshSessionForUser).not.toHaveBeenCalled();
  });

  it("returns public-key validation errors without opening a route", async () => {
    userSshKeysMock.normalizeTemporaryNativeSshPublicKey.mockRejectedValue(
      appError(
        400,
        "native_ssh_public_key_invalid",
        "temporary native SSH key must be a valid ssh-ed25519 public key",
      ),
    );

    const response = await sshRequest({
      vmId: "vm-1",
      mode: "native",
      clientPublicKeyOpenssh: "ssh-rsa not-allowed",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "temporary native SSH key must be a valid ssh-ed25519 public key",
      code: "native_ssh_public_key_invalid",
    });
    expect(scenarioRunsMock.createScenarioSshSessionForUser).not.toHaveBeenCalled();
  });
});

async function sshRequest(body: unknown): Promise<Response> {
  return POST({
    request: new Request("https://intar.test/api/scenarios/runs/run-1/ssh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: { runId: "run-1" },
  } as never);
}
