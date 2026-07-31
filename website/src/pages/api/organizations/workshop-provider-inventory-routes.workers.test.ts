/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { appError } from "@/lib/app-error";

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  resolveOrganizationId: vi.fn(),
  inspectInventory: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-bridge")>()),
  requireUserContext: mocks.requireUserContext,
}));
vi.mock("@/lib/organizations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizations")>()),
  resolveOrganizationId: mocks.resolveOrganizationId,
}));
vi.mock("@/lib/workshops/provider-connections", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/workshops/provider-connections")
  >()),
  inspectHetznerProjectInventory: mocks.inspectInventory,
}));

import { GET } from "./[orgId]/workshop-providers/hetzner/[connectionId]/inventory";

describe("Hetzner project inventory route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUserContext.mockResolvedValue({
      ok: true as const,
      context: { userId: "owner-a" },
    });
    mocks.resolveOrganizationId.mockResolvedValue("organization-a");
  });

  it("returns the sanitized inspection for the resolved organization", async () => {
    const inspection = {
      connectionId: "connection-a",
      observedAt: 1_750_000_000_000,
      counts: {
        servers: 0,
        primaryIps: 0,
        floatingIps: 0,
        firewalls: 1,
        networks: 0,
        volumes: 0,
        placementGroups: 0,
        snapshots: 0,
        sshKeys: 0,
        loadBalancers: 0,
        certificates: 0,
      },
      sentinel: {
        expected: { id: "42", name: "intar-connection-a-sentinel" },
        present: true,
        onlyFirewall: true,
      },
      clean: true,
    };
    mocks.inspectInventory.mockResolvedValue(inspection);

    const response = await GET({
      request: new Request(
        "https://intar.dev/api/organizations/org-slug/workshop-providers/hetzner/connection-a/inventory",
      ),
      params: { orgId: "org-slug", connectionId: "connection-a" },
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "no-store",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    await expect(response.json()).resolves.toEqual(inspection);
    expect(mocks.resolveOrganizationId).toHaveBeenCalledWith("org-slug");
    expect(mocks.inspectInventory).toHaveBeenCalledWith({
      organizationId: "organization-a",
      connectionId: "connection-a",
      actorUserId: "owner-a",
    });
  });

  it("does not resolve an organization or inspect the provider before authentication", async () => {
    const unauthorized = new Response("unauthorized", { status: 401 });
    mocks.requireUserContext.mockResolvedValue({
      ok: false as const,
      response: unauthorized,
    });

    const response = await GET({
      request: new Request(
        "https://intar.dev/api/organizations/org-slug/workshop-providers/hetzner/connection-a/inventory",
      ),
      params: { orgId: "org-slug", connectionId: "connection-a" },
    } as never);

    expect(response).toBe(unauthorized);
    expect(mocks.resolveOrganizationId).not.toHaveBeenCalled();
    expect(mocks.inspectInventory).not.toHaveBeenCalled();
  });

  it("does not inspect the provider when the organization cannot be resolved", async () => {
    mocks.resolveOrganizationId.mockResolvedValue(null);

    const response = await GET({
      request: new Request(
        "https://intar.dev/api/organizations/unknown/workshop-providers/hetzner/connection-a/inventory",
      ),
      params: { orgId: "unknown", connectionId: "connection-a" },
    } as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "organization not found",
      code: "organization_not_found",
    });
    expect(mocks.inspectInventory).not.toHaveBeenCalled();
  });

  it("does not reveal whether an unauthorized organization exists", async () => {
    mocks.resolveOrganizationId.mockResolvedValue(null);
    const missing = await GET({
      request: new Request(
        "https://intar.dev/api/organizations/missing/workshop-providers/hetzner/connection-a/inventory",
      ),
      params: { orgId: "missing", connectionId: "connection-a" },
    } as never);
    const missingBody = await missing.json();

    mocks.resolveOrganizationId.mockResolvedValue("foreign-organization");
    mocks.inspectInventory.mockRejectedValue(
      appError(404, "organization_not_found", "organization not found"),
    );
    const foreign = await GET({
      request: new Request(
        "https://intar.dev/api/organizations/foreign/workshop-providers/hetzner/connection-a/inventory",
      ),
      params: { orgId: "foreign", connectionId: "connection-a" },
    } as never);

    expect(foreign.status).toBe(missing.status);
    await expect(foreign.json()).resolves.toEqual(missingBody);
  });
});
