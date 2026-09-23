/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  isActiveAccount: vi.fn(),
}));

vi.mock("@/lib/account-access", () => ({
  isActiveAccount: accessMocks.isActiveAccount,
}));

import { issueAccountFencedRoute } from "./account-route-issuance";

describe("account-fenced route issuance", () => {
  it("rejects an inactive account before calling Stargate", async () => {
    accessMocks.isActiveAccount.mockReset();
    accessMocks.isActiveAccount.mockResolvedValue(false);
    const issue = vi.fn();
    const revoke = vi.fn();

    await expect(
      issueAccountFencedRoute({
        userId: "user-a",
        routeId: "run-vm-web",
        issue,
        issuedRouteIds: () => [],
        revoke,
      }),
    ).rejects.toMatchObject({ code: "access_revoked", status: 403 });
    expect(issue).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("deletes a route created while the account was revoked", async () => {
    accessMocks.isActiveAccount.mockReset();
    accessMocks.isActiveAccount
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const issue = vi
      .fn()
      .mockResolvedValue({ routeUsername: "alternate-run-vm-web" });
    const revoke = vi.fn().mockResolvedValue(undefined);

    await expect(
      issueAccountFencedRoute({
        userId: "user-a",
        routeId: "run-vm-web",
        issue,
        issuedRouteIds: (result: { routeUsername: string }) => [
          result.routeUsername,
        ],
        revoke,
      }),
    ).rejects.toMatchObject({ code: "access_revoked", status: 403 });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith("run-vm-web");
    expect(revoke).toHaveBeenCalledWith("alternate-run-vm-web");
  });

  it("deletes the deterministic route when Stargate creation is ambiguous", async () => {
    accessMocks.isActiveAccount.mockReset();
    accessMocks.isActiveAccount.mockResolvedValue(true);
    const issueError = new Error("Stargate response was lost");
    const issue = vi.fn().mockRejectedValue(issueError);
    const revoke = vi.fn().mockResolvedValue(undefined);

    await expect(
      issueAccountFencedRoute({
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

  it("deletes the issued route when the account post-read fails", async () => {
    accessMocks.isActiveAccount.mockReset();
    const readError = new Error("account read failed");
    accessMocks.isActiveAccount
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(readError);
    const issue = vi.fn().mockResolvedValue({ routeUsername: "run-vm-web" });
    const revoke = vi.fn().mockResolvedValue(undefined);

    await expect(
      issueAccountFencedRoute({
        userId: "user-a",
        routeId: "run-vm-web",
        issue,
        issuedRouteIds: (result: { routeUsername: string }) => [
          result.routeUsername,
        ],
        revoke,
      }),
    ).rejects.toBe(readError);
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("run-vm-web");
  });

  it("returns the issued route only while the account stays active", async () => {
    accessMocks.isActiveAccount.mockReset();
    accessMocks.isActiveAccount.mockResolvedValue(true);
    const issue = vi.fn().mockResolvedValue({ route: "issued" });
    const revoke = vi.fn();

    await expect(
      issueAccountFencedRoute({
        userId: "user-a",
        routeId: "run-vm-web",
        issue,
        issuedRouteIds: () => [],
        revoke,
      }),
    ).resolves.toEqual({ route: "issued" });
    expect(accessMocks.isActiveAccount).toHaveBeenCalledTimes(2);
    expect(accessMocks.isActiveAccount).toHaveBeenCalledWith("user-a");
    expect(revoke).not.toHaveBeenCalled();
  });
});
