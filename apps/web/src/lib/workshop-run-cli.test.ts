import { describe, expect, it, vi } from "vitest";
import {
  DISPOSABLE_WORKSHOP_TEARDOWN_CONFIRMATION,
  assertDisposableWorkshopConfirmation,
  assertFreshWorkshopTerminalRejected,
  assertWorkshopSolutionStateUnchanged,
  endDisposableWorkshopSession,
  issueWorkshopNativeSshRoute,
  requireParticipantWorkspace,
  waitForWorkshopCheckParity,
  waitForWorkshopHintParity,
  workshopHintAliasesFromCompletionOutput,
  type WorkshopRunCliStatus,
} from "../../scripts/workshop-run-cli/workshop-run-cli";

describe("workshop run CLI", () => {
  it("issues a temporary participant key through the exact workshop workspace route", async () => {
    const json = vi.fn().mockResolvedValue({
      routeUsername: "workshop-session-a-learner-a-native",
      expiresAt: 1_000,
      native: {
        authMode: "issued_key",
        host: "ssh.intar.test",
        port: 2222,
        username: "workshop-session-a-learner-a-native",
        knownHostsLine: "[ssh.intar.test]:2222 ssh-ed25519 AAAATEST",
      },
    });

    const issued = await issueWorkshopNativeSshRoute({
      client: { json } as never,
      sessionId: "session-a",
      workspaceId: "workspace-a",
    });

    expect(json).toHaveBeenCalledWith(
      "/api/workshops/session-a/terminal",
      expect.objectContaining({
        method: "POST",
        json: expect.objectContaining({
          workspaceId: "workspace-a",
          mode: "native",
          clientPublicKeyOpenssh: expect.stringMatching(/^ssh-ed25519 /),
        }),
      }),
    );
    expect(issued.route.native.authMode).toBe("issued_key");
  });

  it("rejects an empty workshop session or workspace ID before an API request", async () => {
    const json = vi.fn();

    await expect(
      issueWorkshopNativeSshRoute({
        client: { json } as never,
        sessionId: " ",
        workspaceId: "workspace-a",
      }),
    ).rejects.toThrow("workshop session ID is required");
    await expect(
      issueWorkshopNativeSshRoute({
        client: { json } as never,
        sessionId: "session-a",
        workspaceId: " ",
      }),
    ).rejects.toThrow("workshop workspace ID is required");
    expect(json).not.toHaveBeenCalled();
  });

  it("requires an explicit disposable-session confirmation before it can end a workshop", () => {
    expect(() => assertDisposableWorkshopConfirmation("no")).toThrow(
      "disposable workshop confirmation",
    );
    expect(() =>
      assertDisposableWorkshopConfirmation(
        DISPOSABLE_WORKSHOP_TEARDOWN_CONFIRMATION,
      ),
    ).not.toThrow();
  });

  it("requires a participant-only terminal-ready workspace", () => {
    expect(
      requireParticipantWorkspace(workshopStatus(), "kvm"),
    ).toMatchObject({ id: "workspace-a", state: "ready" });
    expect(() =>
      requireParticipantWorkspace(
        workshopStatus({ viewer: { canFacilitate: true } }),
        "kvm",
      ),
    ).toThrow("participant-only learner cookie");
  });

  it("waits until the browser status matches a fresh passing check", async () => {
    const json = vi
      .fn()
      .mockResolvedValueOnce(
        workshopStatus({ probes: [{ id: "probe-a", status: "unknown" }] }),
      )
      .mockResolvedValueOnce(
        workshopStatus({ probes: [{ id: "probe-a", status: "pending" }] }),
      )
      .mockResolvedValueOnce(
        workshopStatus({ probes: [{ id: "probe-a", status: "pass" }] }),
      );

    await expect(
      waitForWorkshopCheckParity({
        client: { json } as never,
        sessionId: "session-a",
        providerLabel: "kvm",
        expected: "all_pass",
        timeoutMs: 100,
        pollMs: 1,
      }),
    ).resolves.toMatchObject({ session: { id: "session-a" } });
  });

  it("waits until the browser status matches a fresh failing check", async () => {
    const json = vi
      .fn()
      .mockResolvedValueOnce(
        workshopStatus({ probes: [{ id: "probe-a", status: "unknown" }] }),
      )
      .mockResolvedValueOnce(
        workshopStatus({ probes: [{ id: "probe-a", status: "fail" }] }),
      );

    await expect(
      waitForWorkshopCheckParity({
        client: { json } as never,
        sessionId: "session-a",
        providerLabel: "direct-cloud",
        expected: "not_all_pass",
        timeoutMs: 100,
        pollMs: 1,
      }),
    ).resolves.toMatchObject({ session: { id: "session-a" } });
  });

  it("waits for the exact CLI-revealed hint to appear in browser status", async () => {
    const json = vi
      .fn()
      .mockResolvedValueOnce(workshopStatus())
      .mockResolvedValueOnce(
        workshopStatus({ hints: [{ id: "hint-a", revealed: true }] }),
      );

    await expect(
      waitForWorkshopHintParity({
        client: { json } as never,
        sessionId: "session-a",
        providerLabel: "kvm",
        moduleId: "module-a",
        hintId: "hint-a",
        timeoutMs: 100,
        pollMs: 1,
      }),
    ).resolves.toMatchObject({ session: { id: "session-a" } });
  });

  it("fails if a learner solution command changes facilitator solution state", () => {
    const before = workshopStatus({ solutionRevealed: false });
    expect(() =>
      assertWorkshopSolutionStateUnchanged({
        before,
        after: workshopStatus({ solutionRevealed: false }),
        moduleId: "module-a",
        providerLabel: "direct-cloud",
        action: "intar solution reveal",
      }),
    ).not.toThrow();
    expect(() =>
      assertWorkshopSolutionStateUnchanged({
        before,
        after: workshopStatus({ solutionRevealed: true }),
        moduleId: "module-a",
        providerLabel: "direct-cloud",
        action: "intar solution reveal",
      }),
    ).toThrow("changed facilitator solution state");
  });

  it("ends a disposable workshop through a facilitator and observes learner session teardown", async () => {
    const facilitatorJson = vi
      .fn()
      .mockResolvedValueOnce(
        workshopStatus({ viewer: { role: "facilitator", canFacilitate: true } }),
      )
      .mockResolvedValueOnce({});
    const learnerJson = vi.fn().mockResolvedValue(
      workshopStatus({ session: { state: "ended" } }),
    );

    await endDisposableWorkshopSession({
      learnerClient: { json: learnerJson } as never,
      facilitatorClient: { json: facilitatorJson } as never,
      sessionId: "session-a",
      providerLabel: "kvm",
      timeoutMs: 100,
      pollMs: 1,
    });

    expect(facilitatorJson).toHaveBeenNthCalledWith(
      2,
      "/api/workshops/session-a/actions",
      {
        method: "POST",
        json: { action: "end_session", version: 7 },
      },
    );
  });

  it("requires a rejected fresh terminal route after session teardown", async () => {
    const raw = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "workshop terminal closed" }), {
        status: 409,
      }),
    );

    await expect(
      assertFreshWorkshopTerminalRejected({
        client: { raw } as never,
        sessionId: "session-a",
        workspaceId: "workspace-a",
        providerLabel: "direct-cloud",
      }),
    ).resolves.toBeUndefined();
    expect(raw).toHaveBeenCalledWith("/api/workshops/session-a/terminal", {
      method: "POST",
      json: { workspaceId: "workspace-a", mode: "browser" },
    });
  });

  it("uses dynamic completion aliases only when they are safe workshop hints", () => {
    expect(
      workshopHintAliasesFromCompletionOutput(
        [
          "complete -F _intar_complete intar",
          "__INTAR_STATIC__hints",
          "__INTAR_HINT__hint-1",
          "__INTAR_HINT__hint-12",
          "__INTAR_SOLUTION__reveal",
        ].join("\n"),
      ),
    ).toEqual(["hint-1", "hint-12"]);
  });

  it("rejects dynamic aliases that could expose another learner-facing namespace", () => {
    expect(() =>
      workshopHintAliasesFromCompletionOutput(
        [
          "__INTAR_STATIC__hints",
          "__INTAR_HINT__check-1",
          "__INTAR_HINT__hint-2",
          "__INTAR_SOLUTION__reveal",
        ].join("\n"),
      ),
    ).toThrow("non-workshop hint alias");
  });
});

function workshopStatus(
  overrides: {
    session?: Partial<{
      state: string;
      version: number;
      currentModuleId: string | null;
    }>;
    viewer?: Partial<{
      role: string;
      workspaceEnabled: boolean;
      canFacilitate: boolean;
    }>;
    hints?: Array<{ id: string; revealed: boolean }>;
    probes?: Array<{ id: string; status: string }>;
    solutionRevealed?: boolean;
  } = {},
): WorkshopRunCliStatus {
  return {
    session: {
      id: "session-a",
      version: 7,
      state: "live",
      currentModuleId: "module-a",
      ...overrides.session,
    },
    viewer: {
      role: "participant",
      workspaceEnabled: true,
      canFacilitate: false,
      ...overrides.viewer,
    },
    modules: [
      {
        id: "module-a",
        released: true,
        solutionRevealed: overrides.solutionRevealed ?? false,
        hints: overrides.hints ?? [{ id: "hint-a", revealed: false }],
        probes: overrides.probes ?? [{ id: "probe-a", status: "unknown" }],
      },
    ],
    workspace: {
      id: "workspace-a",
      state: "ready",
      terminalAvailable: true,
    },
  } as WorkshopRunCliStatus;
}
