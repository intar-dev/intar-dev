/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  normalizeTemporaryNativeSshPublicKey: vi.fn(),
  requireWorkshopsEnabledForSession: vi.fn(),
  issueWorkshopBrowserTerminalSession: vi.fn(),
  issueWorkshopNativeSshSession: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: async () => ({
    ok: true as const,
    context: { userId: "learner-a" },
  }),
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...Object.fromEntries(new Headers(init?.headers)),
      },
    }),
}));
vi.mock("@/lib/app-error", () => ({
  toErrorResponse: (error: unknown) => ({
    status:
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 500,
    body: {
      error:
        error instanceof Error ? error.message : "failed to open workshop terminal",
      ...(typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? { code: error.code }
        : {}),
    },
  }),
}));
vi.mock("@/lib/user-ssh-keys", () => ({
  normalizeTemporaryNativeSshPublicKey:
    mocks.normalizeTemporaryNativeSshPublicKey,
}));
vi.mock("@/lib/workshops/feature-flag", () => ({
  requireWorkshopsEnabledForSession: mocks.requireWorkshopsEnabledForSession,
}));
vi.mock("@/lib/workshops/terminal", () => ({
  issueWorkshopBrowserTerminalSession:
    mocks.issueWorkshopBrowserTerminalSession,
  issueWorkshopNativeSshSession: mocks.issueWorkshopNativeSshSession,
}));

import { POST } from "./terminal";

describe("workshop terminal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkshopsEnabledForSession.mockResolvedValue(undefined);
    mocks.issueWorkshopNativeSshSession.mockResolvedValue({
      routeUsername: "workshop-workspace-a-learner-a-native",
      expiresAt: 1_800_000_000_000,
      native: { authMode: "issued_key" },
    });
    mocks.issueWorkshopBrowserTerminalSession.mockResolvedValue({
      routeUsername: "workshop-workspace-a-learner-a-browser",
      expiresAt: 1_800_000_000_000,
      browser: { websocketUrl: "wss://terminal.example.test/session" },
    });
  });

  it("normalizes a temporary native key and forwards only the normalized public key", async () => {
    const rawClientPublicKeyOpenssh =
      " ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItemporary learner@browser ";
    const temporaryClientPublicKeyOpenssh =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItemporary learner@browser";
    mocks.normalizeTemporaryNativeSshPublicKey.mockResolvedValue(
      temporaryClientPublicKeyOpenssh,
    );

    const response = await terminalRequest({
      mode: "native",
      clientPublicKeyOpenssh: rawClientPublicKeyOpenssh,
    });

    expect(response.status).toBe(200);
    expect(mocks.normalizeTemporaryNativeSshPublicKey).toHaveBeenCalledWith(
      rawClientPublicKeyOpenssh,
    );
    expect(mocks.issueWorkshopNativeSshSession).toHaveBeenCalledWith({
      sessionId: "session-a",
      workspaceId: "workspace-a",
      actorUserId: "learner-a",
      temporaryClientPublicKeyOpenssh,
    });
    expect(mocks.issueWorkshopBrowserTerminalSession).not.toHaveBeenCalled();
  });

  it("keeps the existing profile-key path when no temporary key is supplied", async () => {
    const response = await terminalRequest({ mode: "native" });

    expect(response.status).toBe(200);
    expect(mocks.normalizeTemporaryNativeSshPublicKey).not.toHaveBeenCalled();
    expect(mocks.issueWorkshopNativeSshSession).toHaveBeenCalledWith({
      sessionId: "session-a",
      workspaceId: "workspace-a",
      actorUserId: "learner-a",
    });
  });

  it("rejects a non-string temporary key before issuing a terminal route", async () => {
    const response = await terminalRequest({
      mode: "native",
      clientPublicKeyOpenssh: { not: "a public key" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "clientPublicKeyOpenssh must be a string",
    });
    expect(mocks.normalizeTemporaryNativeSshPublicKey).not.toHaveBeenCalled();
    expect(mocks.issueWorkshopNativeSshSession).not.toHaveBeenCalled();
  });

  it("rejects a temporary key outside native SSH", async () => {
    const response = await terminalRequest({
      mode: "browser",
      clientPublicKeyOpenssh:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItemporary learner@browser",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "clientPublicKeyOpenssh is only supported for native SSH",
    });
    expect(mocks.normalizeTemporaryNativeSshPublicKey).not.toHaveBeenCalled();
    expect(mocks.issueWorkshopNativeSshSession).not.toHaveBeenCalled();
    expect(mocks.issueWorkshopBrowserTerminalSession).not.toHaveBeenCalled();
  });

  it("does not issue a route when temporary-key validation fails", async () => {
    mocks.normalizeTemporaryNativeSshPublicKey.mockRejectedValue(
      Object.assign(new Error("temporary key is invalid"), {
        status: 400,
        code: "native_ssh_public_key_invalid",
      }),
    );

    const response = await terminalRequest({
      mode: "native",
      clientPublicKeyOpenssh: "not an OpenSSH public key",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "temporary key is invalid",
      code: "native_ssh_public_key_invalid",
    });
    expect(mocks.issueWorkshopNativeSshSession).not.toHaveBeenCalled();
  });
});

function terminalRequest(body: Record<string, unknown>) {
  return POST({
    request: new Request("https://intar.dev/api/workshops/session-a/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-a", ...body }),
    }),
    params: { sessionId: "session-a" },
  } as never);
}
