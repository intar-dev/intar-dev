import { describe, expect, it } from "vitest";
import type { GcpServiceAccountKey } from "@intar/provider-contracts/gcp";
import { GcpClient, ownershipLabels } from "../src/gcp-client";

const key = {
  type: "service_account",
  project_id: "intar-empty-12345",
  private_key_id: "0123456789abcdef",
  private_key: "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n",
  client_email: "intar-runtime@intar-empty-12345.iam.gserviceaccount.com",
  client_id: "123456789012345678901",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
} satisfies GcpServiceAccountKey;

const ownership = {
  organizationRef: "org_0123456789",
  connectionRef: "conn_0123456789",
  purpose: "learner_workspace",
  workspaceRef: "workspace_0123456789",
  generation: 1,
} as const;

function operation(name: string) {
  return {
    id: `id-${name}`,
    name,
    selfLink: `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/zones/europe-west3-a/operations/${name}`,
    status: "PENDING",
  };
}

describe("GCP allocation lifecycle", () => {
  it("uses idempotent reboot/delete calls and sweeps only owned resources", async () => {
    const mutationRequests: Request[] = [];
    const ownedLabels = ownershipLabels(ownership);
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/reset")) {
        mutationRequests.push(request);
        return Response.json(operation("reset-1"));
      }
      if (
        request.method === "GET" &&
        url.pathname.endsWith("/instances/intar-learner-abc")
      ) {
        return Response.json({
          id: "instance-owned",
          name: "intar-learner-abc",
          selfLink: `${url.origin}${url.pathname}`,
          labels: ownedLabels,
        });
      }
      if (request.method === "DELETE") {
        mutationRequests.push(request);
        return Response.json(operation("delete-1"));
      }
      const fixture = (kind: "instances" | "disks" | "addresses") => ({
        items: {
          "zones/europe-west3-a": {
            [kind]: [
              {
                id: `${kind}-owned`,
                name: `intar-${kind}-owned`,
                selfLink: `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/zones/europe-west3-a/${kind}/intar-owned`,
                labels: ownedLabels,
              },
              {
                id: `${kind}-foreign`,
                name: `foreign-${kind}`,
                selfLink: `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/zones/europe-west3-a/${kind}/foreign`,
                labels: { "intar-managed": "true", "intar-org": "other" },
              },
            ],
          },
        },
      });
      if (url.pathname.endsWith("/aggregated/instances")) return Response.json(fixture("instances"));
      if (url.pathname.endsWith("/aggregated/disks")) return Response.json(fixture("disks"));
      if (url.pathname.endsWith("/aggregated/addresses")) return Response.json(fixture("addresses"));
      throw new Error(`Unhandled ${request.method} ${url.pathname}`);
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });

    await expect(client.rebootInstance(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-reset-1",
    ))
      .resolves.toMatchObject({ name: "reset-1" });
    await expect(client.rebootInstance(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-reset-1",
    )).resolves.toMatchObject({ name: "reset-1" });
    await expect(client.rebootInstance(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-reset-2",
    )).resolves.toMatchObject({ name: "reset-1" });
    await expect(client.deleteInstance(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-delete-1",
    )).resolves.toMatchObject({ name: "delete-1" });
    await expect(client.deleteInstance(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-delete-1",
    )).resolves.toMatchObject({ name: "delete-1" });
    await expect(client.deleteInstance(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-delete-2",
    ))
      .resolves.toMatchObject({ name: "delete-1" });
    const swept = await client.sweep(ownership);
    expect(swept.instances).toHaveLength(1);
    expect(swept.disks).toHaveLength(1);
    expect(swept.addresses).toHaveLength(1);
    expect(mutationRequests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "POST",
      "DELETE",
      "DELETE",
      "DELETE",
    ]);
    const requestIds = mutationRequests.map((request) => new URL(request.url).searchParams.get("requestId"));
    expect(requestIds[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(requestIds[0]).not.toBe(requestIds[2]);
    expect(requestIds[2]).not.toBe(requestIds[3]);
    expect(requestIds[3]).toBe(requestIds[4]);
    expect(requestIds[3]).not.toBe(requestIds[5]);
  });

  it("treats an already deleted instance as confirmed missing", async () => {
    const client = new GcpClient(key, key.project_id, {
      fetcher: (async () => Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 })) as typeof fetch,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    await expect(client.deleteInstance(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-delete-missing",
    ))
      .resolves.toBeNull();
  });

  it("deletes an owned orphan boot disk and rejects a foreign one", async () => {
    let foreign = false;
    const methods: string[] = [];
    const requestIds: Array<string | null> = [];
    const client = new GcpClient(key, key.project_id, {
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        methods.push(request.method);
        if (request.method === "GET") {
          return Response.json({
            id: foreign ? "disk-foreign" : "disk-owned",
            name: "intar-learner-abc",
            selfLink: `${url.origin}${url.pathname}`,
            labels: foreign
              ? { "intar-managed": "true", "intar-org": "other" }
              : ownershipLabels(ownership),
          });
        }
        requestIds.push(url.searchParams.get("requestId"));
        return Response.json(operation("delete-disk-1"));
      }) as typeof fetch,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });

    await expect(client.deleteDisk(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-delete-disk-1",
    )).resolves.toMatchObject({ name: "delete-disk-1" });
    await expect(client.deleteDisk(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-delete-disk-1",
    )).resolves.toMatchObject({ name: "delete-disk-1" });
    await expect(client.deleteDisk(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-delete-disk-2",
    ))
      .resolves.toMatchObject({ name: "delete-disk-1" });
    foreign = true;
    await expect(client.deleteDisk(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-delete-disk-3",
    ))
      .rejects.toMatchObject({ shape: { code: "gcp_allocation_ownership_mismatch" } });
    expect(methods).toEqual([
      "GET", "DELETE",
      "GET", "DELETE",
      "GET", "DELETE",
      "GET",
    ]);
    expect(requestIds[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(requestIds[0]).not.toBe(requestIds[2]);
  });

  it("refuses to reboot or delete a foreign instance at the deterministic name", async () => {
    const methods: string[] = [];
    const client = new GcpClient(key, key.project_id, {
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        methods.push(request.method);
        const url = new URL(request.url);
        return Response.json({
          id: "instance-foreign",
          name: "intar-learner-abc",
          selfLink: `${url.origin}${url.pathname}`,
          labels: { "intar-managed": "true", "intar-org": "other" },
        });
      }) as typeof fetch,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    await expect(client.rebootInstance(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-reset-1",
    ))
      .rejects.toMatchObject({ shape: { code: "gcp_allocation_ownership_mismatch" } });
    await expect(client.deleteInstance(
      "europe-west3-a",
      "intar-learner-abc",
      ownership,
      "logical-delete-foreign",
    ))
      .rejects.toMatchObject({ shape: { code: "gcp_allocation_ownership_mismatch" } });
    expect(methods).toEqual(["GET", "GET"]);
  });
});
