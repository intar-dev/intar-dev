/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  activeAccessGeneration: vi.fn(),
}));

vi.mock("@/lib/account-access", () => ({
  activeAccessGeneration: accessMocks.activeAccessGeneration,
}));

import { issueAccountFencedRoute } from "./account-route-issuance";

describe("account-fenced route issuance", () => {
  it("rejects an inactive account before calling Stargate", async () => {
    accessMocks.activeAccessGeneration.mockReset();
    accessMocks.activeAccessGeneration.mockResolvedValue(null);
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
    accessMocks.activeAccessGeneration.mockReset();
    accessMocks.activeAccessGeneration
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(null);
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

  it("deletes a route when access was revoked and restored during issuance", async () => {
    accessMocks.activeAccessGeneration.mockReset();
    accessMocks.activeAccessGeneration
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4);
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
    ).rejects.toMatchObject({ code: "access_revoked", status: 403 });
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("run-vm-web");
  });

  it("deletes the deterministic route when Stargate creation is ambiguous", async () => {
    accessMocks.activeAccessGeneration.mockReset();
    accessMocks.activeAccessGeneration.mockResolvedValue(0);
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
    accessMocks.activeAccessGeneration.mockReset();
    const readError = new Error("account read failed");
    accessMocks.activeAccessGeneration
      .mockResolvedValueOnce(0)
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
    accessMocks.activeAccessGeneration.mockReset();
    accessMocks.activeAccessGeneration.mockResolvedValue(0);
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
    expect(accessMocks.activeAccessGeneration).toHaveBeenCalledTimes(2);
    expect(accessMocks.activeAccessGeneration).toHaveBeenCalledWith("user-a");
    expect(revoke).not.toHaveBeenCalled();
  });
});
