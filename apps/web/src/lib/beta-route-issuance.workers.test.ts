/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  getBetaAccess: vi.fn(),
}));

vi.mock("@/lib/allowlist", () => ({
  getBetaAccess: accessMocks.getBetaAccess,
}));

import { issueBetaAccessFencedRoute } from "./beta-route-issuance";

const originalAdmission = {
  userId: "user-a",
  state: "active" as const,
  githubAccountId: "1000",
  githubUsername: "user-a",
  sourceInviteId: "invite-a",
  sourceLeaseId: "lease-a",
  grantedAt: 1_000,
  revocationId: null,
};

describe("beta-fenced route issuance", () => {
  it("rejects a blocked user before calling Stargate", async () => {
    accessMocks.getBetaAccess.mockReset();
    accessMocks.getBetaAccess.mockResolvedValue({
      ...originalAdmission,
      state: "blocked",
      revocationId: "revocation-a",
    });
    const issue = vi.fn();
    const revoke = vi.fn();

    await expect(
      issueBetaAccessFencedRoute({
        userId: "user-a",
        routeId: "run-vm-web",
        issue,
        issuedRouteIds: () => [],
        revoke,
      }),
    ).rejects.toMatchObject({ code: "beta_access_revoked", status: 403 });
    expect(issue).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("deletes a route created across revoke and fresh readmission", async () => {
    accessMocks.getBetaAccess.mockReset();
    accessMocks.getBetaAccess
      .mockResolvedValueOnce(originalAdmission)
      .mockResolvedValueOnce({
        ...originalAdmission,
        sourceInviteId: "invite-b",
        sourceLeaseId: "lease-b",
        grantedAt: 2_000,
      });
    const issue = vi
      .fn()
      .mockResolvedValue({ routeUsername: "alternate-run-vm-web" });
    const revoke = vi.fn().mockResolvedValue(undefined);

    await expect(
      issueBetaAccessFencedRoute({
        userId: "user-a",
        routeId: "run-vm-web",
        issue,
        issuedRouteIds: (result: { routeUsername: string }) => [
          result.routeUsername,
        ],
        revoke,
      }),
    ).rejects.toMatchObject({ code: "beta_access_revoked", status: 403 });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith("run-vm-web");
    expect(revoke).toHaveBeenCalledWith("alternate-run-vm-web");
  });

  it("deletes the deterministic route when Stargate creation is ambiguous", async () => {
    accessMocks.getBetaAccess.mockReset();
    accessMocks.getBetaAccess.mockResolvedValue(originalAdmission);
    const issueError = new Error("Stargate response was lost");
    const issue = vi.fn().mockRejectedValue(issueError);
    const revoke = vi.fn().mockResolvedValue(undefined);

    await expect(
      issueBetaAccessFencedRoute({
        userId: "user-a",
        routeId: "run-vm-web",
        issue,
        issuedRouteIds: () => [],
        revoke,
      }),
    ).rejects.toBe(issueError);
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("run-vm-web");
  });

  it("returns the issued route only while the admission epoch is unchanged", async () => {
    accessMocks.getBetaAccess.mockReset();
    accessMocks.getBetaAccess.mockResolvedValue(originalAdmission);
    const issue = vi.fn().mockResolvedValue({ route: "issued" });
    const revoke = vi.fn();

    await expect(
      issueBetaAccessFencedRoute({
        userId: "user-a",
        routeId: "run-vm-web",
        issue,
        issuedRouteIds: () => [],
        revoke,
      }),
    ).resolves.toEqual({ route: "issued" });
    expect(accessMocks.getBetaAccess).toHaveBeenCalledTimes(2);
    expect(revoke).not.toHaveBeenCalled();
  });
});
