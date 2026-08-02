import { describe, expect, it } from "vitest";
import type {
  GcpCredentialContext,
  GcpServiceAccountKey,
  RunGcpOperationRequest,
} from "@intar/provider-contracts/gcp";
import { sealGcpCredential } from "../src/credential";
import { ownershipLabels } from "../src/gcp-client";
import { runOperation } from "../src/provider";

const context = {
  organizationId: "org_0123456789",
  connectionId: "conn_0123456789",
  credentialId: "cred_0123456789",
  provider: "gcp_compute",
  version: 1,
} satisfies GcpCredentialContext;

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

function kek(): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(23)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("GCP provider allocation observation", () => {
  it("keeps an orphan boot disk active until its independent GET returns 404", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    let diskPresent = true;
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      paths.push(url.pathname);
      if (url.pathname.endsWith("/instances/intar-learner-abc")) {
        return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      if (url.pathname.endsWith("/disks/intar-learner-abc")) {
        return diskPresent
          ? Response.json({
              id: "disk-9001",
              name: "intar-learner-abc",
              selfLink: `${url.origin}${url.pathname}`,
              labels: ownershipLabels(ownership),
              status: "READY",
              zone: "europe-west3-a",
            })
          : Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      throw new Error(`Unhandled GET ${url.pathname}`);
    }) as typeof fetch;
    const request = {
      requestId: "observe-allocation-0001",
      connectionId: context.connectionId,
      credentialContext: context,
      credential,
      projectId: key.project_id,
      operation: {
        kind: "observe_allocation",
        zone: "europe-west3-a",
        instanceName: "intar-learner-abc",
        bootDiskName: "intar-learner-abc",
        ownership,
      },
    } satisfies RunGcpOperationRequest;
    const options = {
      api: {
        fetcher,
        tokenProvider: async () => ({
          accessToken: "token",
          expiresAtEpochSeconds: 4_000_000_000,
        }),
      },
      now: () => new Date("2026-08-01T10:01:00.000Z"),
    };

    const orphaned = await runOperation(request, kek(), "unused", options);
    expect(orphaned.data).toMatchObject({
      status: "missing",
      instance: null,
      bootDisk: { id: "disk-9001", name: "intar-learner-abc" },
    });
    expect(orphaned.canonicalWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "resource_deleted",
        resourceKind: "instance",
        name: "intar-learner-abc",
      }),
      expect.objectContaining({
        operation: "resource_deleted",
        resourceKind: "ipv4",
        name: "intar-learner-abc-ephemeral-ipv4",
      }),
      expect.objectContaining({
        operation: "resource_observed",
        resourceKind: "boot_disk",
        externalId: "disk-9001",
      }),
    ]));

    diskPresent = false;
    const deleted = await runOperation(
      { ...request, requestId: "observe-allocation-0002" },
      kek(),
      "unused",
      options,
    );
    expect(deleted.canonicalWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "resource_deleted",
        resourceKind: "boot_disk",
        externalId: "intar-learner-abc",
        name: "intar-learner-abc",
      }),
    ]));
    expect(paths).toEqual([
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/instances/intar-learner-abc`,
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/disks/intar-learner-abc`,
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/instances/intar-learner-abc`,
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/disks/intar-learner-abc`,
    ]);
  });

  it("does not close a boot disk on a transient disk lookup while the instance still exists", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const instancePath = `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/instances/intar-learner-abc`;
    const diskPath = `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/disks/intar-learner-abc`;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === instancePath) {
        return Response.json({
          id: "instance-9001",
          name: "intar-learner-abc",
          selfLink: `${url.origin}${url.pathname}`,
          labels: ownershipLabels(ownership),
          status: "RUNNING",
          zone: "europe-west3-a",
          disks: [{ boot: true, source: `${url.origin}${diskPath}` }],
          networkInterfaces: [],
        });
      }
      if (url.pathname === diskPath) {
        return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      throw new Error(`Unhandled GET ${url.pathname}`);
    }) as typeof fetch;
    const result = await runOperation(
      {
        requestId: "observe-allocation-0003",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        projectId: key.project_id,
        operation: {
          kind: "observe_allocation",
          zone: "europe-west3-a",
          instanceName: "intar-learner-abc",
          bootDiskName: "intar-learner-abc",
          ownership,
        },
      },
      kek(),
      "unused",
      {
        api: {
          fetcher,
          tokenProvider: async () => ({
            accessToken: "token",
            expiresAtEpochSeconds: 4_000_000_000,
          }),
        },
        now: () => new Date("2026-08-01T10:01:00.000Z"),
      },
    );
    expect(result.canonicalWrites).toEqual([
      expect.objectContaining({
        operation: "resource_observed",
        resourceKind: "instance",
        externalId: "instance-9001",
      }),
    ]);
  });
});
