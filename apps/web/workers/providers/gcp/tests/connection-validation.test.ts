import { describe, expect, it } from "vitest";
import type { GcpServiceAccountKey } from "@intar/provider-contracts/gcp";
import {
  CLEANUP_IAM_PERMISSIONS,
  GcpClient,
  REQUIRED_IAM_PERMISSIONS,
} from "../src/gcp-client";

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

function client(fetcher: typeof fetch): GcpClient {
  return new GcpClient(key, key.project_id, {
    fetcher,
    tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
  });
}

describe("GCP connection validation", () => {
  it("requires every control-plane API", async () => {
    const runtime = client((async () => Response.json({
      services: [
        { name: "projects/123/services/compute.googleapis.com", state: "ENABLED" },
        { name: "projects/123/services/cloudresourcemanager.googleapis.com", state: "ENABLED" },
        { name: "projects/123/services/serviceusage.googleapis.com", state: "ENABLED" },
        { name: "projects/123/services/cloudasset.googleapis.com", state: "ENABLED" },
      ],
    })) as typeof fetch);
    await expect(runtime.assertRequiredServices("123"))
      .rejects.toMatchObject({ shape: { code: "gcp_required_api_disabled" } });
  });

  it("submits and verifies the complete IAM permission set", async () => {
    let body: unknown;
    const complete = client((async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ permissions: REQUIRED_IAM_PERMISSIONS });
    }) as typeof fetch);
    await expect(complete.assertRequiredIamPermissions()).resolves.toEqual(
      [...REQUIRED_IAM_PERMISSIONS].sort(),
    );
    expect(REQUIRED_IAM_PERMISSIONS).toContain("compute.regions.get");
    expect(REQUIRED_IAM_PERMISSIONS).toEqual(expect.arrayContaining([
      "compute.disks.setLabels",
      "compute.instances.setLabels",
      "compute.instances.setMetadata",
      "compute.instances.setServiceAccount",
      "compute.instances.setTags",
      "compute.networks.getEffectiveFirewalls",
      "compute.networks.getRegionEffectiveFirewalls",
      "compute.networks.updatePolicy",
      "compute.networks.useExternalIp",
      "compute.subnetworks.useExternalIp",
      "serviceusage.services.use",
    ]));
    expect(REQUIRED_IAM_PERMISSIONS).not.toContain("compute.instances.setDeletionProtection");
    expect(body).toEqual({ permissions: REQUIRED_IAM_PERMISSIONS });

    const incomplete = client((async () => Response.json({
      permissions: REQUIRED_IAM_PERMISSIONS.slice(1),
    })) as typeof fetch);
    await expect(incomplete.assertRequiredIamPermissions())
      .rejects.toMatchObject({ shape: { code: "gcp_permission_missing" } });
  });

  it("requires an enabled Cloud Billing account for the same project", async () => {
    const urls: URL[] = [];
    const enabled = client((async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(url);
      return Response.json({
        name: `projects/${key.project_id}/billingInfo`,
        projectId: key.project_id,
        billingAccountName: "billingAccounts/ABCDEF-123456-ABCDEF",
        billingEnabled: true,
      });
    }) as typeof fetch);
    await expect(enabled.assertBillingEnabled()).resolves.toEqual({
      projectId: key.project_id,
      billingAccountName: "billingAccounts/ABCDEF-123456-ABCDEF",
      billingEnabled: true,
    });
    expect(urls[0]!.hostname).toBe("cloudbilling.googleapis.com");
    expect(urls[0]!.pathname).toBe(`/v1/projects/${key.project_id}/billingInfo`);

    const disabled = client((async () => Response.json({
      name: `projects/${key.project_id}/billingInfo`,
      projectId: key.project_id,
      billingAccountName: "",
      billingEnabled: false,
    })) as typeof fetch);
    await expect(disabled.assertBillingEnabled())
      .rejects.toMatchObject({ shape: { code: "gcp_billing_disabled" } });
  });

  it("validates cleanup authority independently from spare capacity", async () => {
    let body: unknown;
    const cleanup = client((async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ permissions: CLEANUP_IAM_PERMISSIONS });
    }) as typeof fetch);
    await expect(cleanup.assertCleanupIamPermissions()).resolves.toEqual(
      [...CLEANUP_IAM_PERMISSIONS].sort(),
    );
    expect(CLEANUP_IAM_PERMISSIONS).toContain("compute.instances.delete");
    expect(CLEANUP_IAM_PERMISSIONS).toContain("compute.regionOperations.get");
    expect(CLEANUP_IAM_PERMISSIONS).toContain("compute.networks.getEffectiveFirewalls");
    expect(CLEANUP_IAM_PERMISSIONS).toContain("compute.networks.getRegionEffectiveFirewalls");
    expect(CLEANUP_IAM_PERMISSIONS).toContain("serviceusage.services.use");
    expect(CLEANUP_IAM_PERMISSIONS).not.toContain("compute.instances.create");
    expect(CLEANUP_IAM_PERMISSIONS).not.toContain("compute.instances.reset");
    expect(REQUIRED_IAM_PERMISSIONS).toContain("compute.instances.reset");
    expect(body).toEqual({ permissions: CLEANUP_IAM_PERMISSIONS });

    const incomplete = client((async () => Response.json({
      permissions: CLEANUP_IAM_PERMISSIONS.slice(1),
    })) as typeof fetch);
    await expect(incomplete.assertCleanupIamPermissions())
      .rejects.toMatchObject({ shape: { code: "gcp_permission_missing" } });
  });

  it("requires free CPU, instance, IPv4, and balanced-disk capacity in Frankfurt", async () => {
    const requests: URL[] = [];
    const sufficient = client((async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url);
      return Response.json({ quotas: [
        { metric: "CPUS", limit: 8, usage: 0 },
        { metric: "INSTANCES", limit: 5, usage: 0 },
        { metric: "IN_USE_ADDRESSES", limit: 5, usage: 0 },
        { metric: "SSD_TOTAL_GB", limit: 100, usage: 0 },
      ] });
    }) as typeof fetch);
    await expect(sufficient.assertMinimumQuotas()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ metric: "CPUS", available: 8 })]),
    );
    expect(requests).toHaveLength(2);
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      `/compute/v1/projects/${key.project_id}/regions/europe-west3`,
      `/compute/v1/projects/${key.project_id}`,
    ]);
    expect(requests.every((url) => url.searchParams.get("fields") === "quotas"))
      .toBe(true);

    const insufficient = client((async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (!url.pathname.endsWith("/regions/europe-west3")) {
        return Response.json({ quotas: [] });
      }
      return Response.json({ quotas: [
        { metric: "CPUS", limit: 4, usage: 1 },
        { metric: "INSTANCES", limit: 5, usage: 0 },
        { metric: "IN_USE_ADDRESSES", limit: 5, usage: 0 },
        { metric: "SSD_TOTAL_GB", limit: 100, usage: 0 },
      ] });
    }) as typeof fetch);
    await expect(insufficient.assertMinimumQuotas())
      .rejects.toMatchObject({ shape: { code: "gcp_quota_insufficient" } });
  });

  it("derives full-roster seats from every current quota dimension", async () => {
    const runtime = client((async () => Response.json({ quotas: [
      { metric: "CPUS", limit: 12, usage: 4 },
      { metric: "INSTANCES", limit: 10, usage: 1 },
      { metric: "IN_USE_ADDRESSES", limit: 10, usage: 1 },
      { metric: "SSD_TOTAL_GB", limit: 128, usage: 32 },
    ] })) as typeof fetch);
    await expect(runtime.observeCapacity({
      requestedSeats: 3,
      cpuPerSeat: 4,
      instancesPerSeat: 1,
      addressesPerSeat: 1,
      diskGibPerSeat: 32,
    })).resolves.toMatchObject({
      availableSeats: 2,
      reasons: ["GCP CPUS quota has 8 remaining but 12 is required"],
      quotas: expect.arrayContaining([
        expect.objectContaining({ metric: "CPUS", available: 8 }),
        expect.objectContaining({ metric: "SSD_TOTAL_GB", available: 96 }),
      ]),
    });

    const missingAddressQuota = client((async () => Response.json({ quotas: [
      { metric: "CPUS", limit: 12, usage: 0 },
      { metric: "INSTANCES", limit: 10, usage: 0 },
      { metric: "SSD_TOTAL_GB", limit: 128, usage: 0 },
    ] })) as typeof fetch);
    await expect(missingAddressQuota.observeCapacity({
      requestedSeats: 1,
      cpuPerSeat: 4,
      instancesPerSeat: 1,
      addressesPerSeat: 1,
      diskGibPerSeat: 32,
    })).resolves.toMatchObject({
      availableSeats: 0,
      reasons: ["GCP did not return the IN_USE_ADDRESSES quota"],
    });
  });

  it("caps regional CPU seats by the optional all-regions CPU quota", async () => {
    const observe = (globalRemaining?: number) => client((async (
      input: RequestInfo | URL,
    ) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/regions/europe-west3")) {
        return Response.json({ quotas: [
          { metric: "CPUS", limit: 12, usage: 0 },
          { metric: "INSTANCES", limit: 10, usage: 0 },
          { metric: "IN_USE_ADDRESSES", limit: 10, usage: 0 },
          { metric: "SSD_TOTAL_GB", limit: 128, usage: 0 },
        ] });
      }
      return Response.json({
        quotas: globalRemaining === undefined
          ? []
          : [{ metric: "CPUS_ALL_REGIONS", limit: globalRemaining, usage: 0 }],
      });
    }) as typeof fetch).observeCapacity({
      requestedSeats: 3,
      cpuPerSeat: 4,
      instancesPerSeat: 1,
      addressesPerSeat: 1,
      diskGibPerSeat: 32,
    });

    await expect(observe(8)).resolves.toMatchObject({
      availableSeats: 2,
      reasons: [
        "GCP CPUS_ALL_REGIONS quota has 8 remaining but 12 is required",
      ],
      quotas: expect.arrayContaining([
        expect.objectContaining({ metric: "CPUS_ALL_REGIONS", available: 8 }),
      ]),
    });
    await expect(observe(0)).resolves.toMatchObject({
      availableSeats: 0,
      reasons: [
        "GCP CPUS_ALL_REGIONS quota has 0 remaining but 12 is required",
      ],
    });
    await expect(observe()).resolves.toMatchObject({
      availableSeats: 3,
      reasons: [],
    });
  });
});
