/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  resolveOrganizationId: vi.fn(),
  connect: vi.fn(),
  list: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-bridge")>()),
  requireUserContext: mocks.requireUserContext,
}));
vi.mock("@/lib/organizations", () => ({
  resolveOrganizationId: mocks.resolveOrganizationId,
}));
vi.mock("@/lib/workshops/provider-connections", () => ({
  connectProviderProject: mocks.connect,
  listProviderConnections: mocks.list,
  inspectProviderConnection: mocks.inspect,
}));

import {
  GET as listConnections,
  POST as connectProject,
} from "./[orgId]/workshop-providers/index";
import { GET as inspectConnection } from "./[orgId]/workshop-providers/[connectionId]/inspect";

describe("generic Workshop provider routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUserContext.mockResolvedValue({
      ok: true as const,
      context: { userId: "owner-a" },
    });
    mocks.resolveOrganizationId.mockResolvedValue("organization-a");
  });

  it("forwards a GCP service-account key only to the generic connection service", async () => {
    const credential = JSON.stringify({
      type: "service_account",
      project_id: "intar-pilot-123",
      private_key: "sensitive-private-key",
    });
    const result = {
      id: "provider-gcp-a",
      providerKind: "gcp_compute",
      credential: { version: 1, fingerprint: "abcd…1234" },
    };
    mocks.connect.mockResolvedValue(result);
    const response = await connectProject({
      request: new Request(
        "https://intar.dev/api/organizations/pilot/workshop-providers",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerKind: "gcp_compute",
            credential,
            displayName: "GCP pilot",
            approvedLocations: ["europe-west3-a"],
            maxConcurrentAllocations: 2,
          }),
        },
      ),
      params: { orgId: "pilot" },
    } as never);

    expect(response.status).toBe(201);
    const responseBody = await response.json();
    expect(responseBody).toEqual(result);
    expect(mocks.connect).toHaveBeenCalledWith({
      organizationId: "organization-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential,
      displayName: "GCP pilot",
      approvedLocations: ["europe-west3-a"],
      maxConcurrentAllocations: 2,
    });
    expect(JSON.stringify(responseBody)).not.toContain("sensitive-private-key");
  });

  it("rejects credential requests larger than 64 KiB before provider code runs", async () => {
    const response = await connectProject({
      request: new Request(
        "https://intar.dev/api/organizations/pilot/workshop-providers",
        {
          method: "POST",
          body: JSON.stringify({
            providerKind: "gcp_compute",
            credential: "x".repeat(70 * 1024),
          }),
        },
      ),
      params: { orgId: "pilot" },
    } as never);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_request_too_large",
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("lists masked provider health for organization managers", async () => {
    const connections = [
      { id: "provider-hcloud-a", providerKind: "hetzner_cloud" },
      { id: "provider-gcp-a", providerKind: "gcp_compute" },
    ];
    mocks.list.mockResolvedValue(connections);
    const response = await listConnections({
      request: new Request(
        "https://intar.dev/api/organizations/pilot/workshop-providers",
      ),
      params: { orgId: "pilot" },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(connections);
    expect(mocks.list).toHaveBeenCalledWith({
      organizationId: "organization-a",
      actorUserId: "owner-a",
    });
  });

  it("uses one provider-neutral inspection endpoint", async () => {
    const inspection = {
      connectionId: "provider-gcp-a",
      providerKind: "gcp_compute",
      observedAt: 1_900_000_000_000,
      data: { clean: true },
    };
    mocks.inspect.mockResolvedValue(inspection);
    const response = await inspectConnection({
      request: new Request(
        "https://intar.dev/api/organizations/pilot/workshop-providers/provider-gcp-a/inspect",
      ),
      params: { orgId: "pilot", connectionId: "provider-gcp-a" },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(inspection);
    expect(mocks.inspect).toHaveBeenCalledWith({
      organizationId: "organization-a",
      connectionId: "provider-gcp-a",
      actorUserId: "owner-a",
    });
  });
});
