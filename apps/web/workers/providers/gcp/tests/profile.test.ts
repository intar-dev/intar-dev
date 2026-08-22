import { describe, expect, it } from "vitest";
import type { GcpServiceAccountKey } from "@intar/provider-contracts/gcp";
import { GcpClient } from "../src/gcp-client";
import {
  GCP_CERTIFIED_MACHINE_TYPE,
  GCP_DEBIAN_13_IMAGE_FAMILY,
  GCP_FRANKFURT_ZONE_FALLBACK,
  assertCertifiedProfileInput,
} from "../src/profile";

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

describe("certified GCP runtime profile", () => {
  it("locks e2-standard-4, Debian 13, and the Frankfurt zone set", () => {
    expect(() => assertCertifiedProfileInput({
      machineType: GCP_CERTIFIED_MACHINE_TYPE,
      imageFamily: GCP_DEBIAN_13_IMAGE_FAMILY,
      zones: GCP_FRANKFURT_ZONE_FALLBACK,
    })).not.toThrow();
    expect(() => assertCertifiedProfileInput({
      machineType: "e2-standard-8",
      imageFamily: GCP_DEBIAN_13_IMAGE_FAMILY,
      zones: GCP_FRANKFURT_ZONE_FALLBACK,
    })).toThrow("e2-standard-4");
    expect(() => assertCertifiedProfileInput({
      machineType: GCP_CERTIFIED_MACHINE_TYPE,
      imageFamily: "projects/debian-cloud/global/images/family/debian-12",
      zones: GCP_FRANKFURT_ZONE_FALLBACK,
    })).toThrow("Debian 13");
    expect(() => assertCertifiedProfileInput({
      machineType: GCP_CERTIFIED_MACHINE_TYPE,
      imageFamily: GCP_DEBIAN_13_IMAGE_FAMILY,
      zones: ["europe-west3-b", "europe-west3-a", "europe-west3-c"],
    })).not.toThrow();
    expect(() => assertCertifiedProfileInput({
      machineType: GCP_CERTIFIED_MACHINE_TYPE,
      imageFamily: GCP_DEBIAN_13_IMAGE_FAMILY,
      zones: ["europe-west3-b"],
    })).not.toThrow();
    expect(() => assertCertifiedProfileInput({
      machineType: GCP_CERTIFIED_MACHINE_TYPE,
      imageFamily: GCP_DEBIAN_13_IMAGE_FAMILY,
      zones: ["europe-west3-b", "europe-west3-b"],
    })).toThrow("unique certified Frankfurt zones");
  });

  it("resolves all zones and converts the mutable family to an immutable image", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.includes("/machineTypes/")) {
        const zone = /\/zones\/([^/]+)\//u.exec(url.pathname)?.[1];
        return Response.json({
          id: `machine-${zone}`,
          name: GCP_CERTIFIED_MACHINE_TYPE,
          selfLink: `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/zones/${zone}/machineTypes/${GCP_CERTIFIED_MACHINE_TYPE}`,
          guestCpus: 4,
          memoryMb: 16_384,
          architecture: "X86_64",
        });
      }
      if (url.pathname.endsWith("/images/family/debian-13")) {
        return Response.json({
          id: "image-1301",
          name: "debian-13-20260731",
          selfLink: "https://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/debian-13-20260731",
          architecture: "X86_64",
          status: "READY",
          diskSizeGb: "10",
          creationTimestamp: "2026-07-31T00:00:00.000Z",
        });
      }
      throw new Error(`Unhandled ${url.pathname}`);
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    const [machineTypes, image] = await Promise.all([
      client.resolveMachineTypes(GCP_CERTIFIED_MACHINE_TYPE, GCP_FRANKFURT_ZONE_FALLBACK),
      client.resolveImageFamily(GCP_DEBIAN_13_IMAGE_FAMILY),
    ]);
    expect(machineTypes).toHaveLength(3);
    expect(machineTypes.every((machine) => machine.guestCpus === 4 && machine.memoryMib === 16_384)).toBe(true);
    expect(image.selfLink).toContain("/global/images/debian-13-20260731");
    expect(image.selfLink).not.toContain("/family/");
  });

  it("rejects a provider response that remains mutable or is deprecated", async () => {
    const client = new GcpClient(key, key.project_id, {
      fetcher: (async () => Response.json({
        id: "image-1301",
        name: "debian-13-20260731",
        selfLink: "https://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/family/debian-13",
        architecture: "X86_64",
        status: "READY",
        diskSizeGb: "10",
        creationTimestamp: "2026-07-31T00:00:00.000Z",
      })) as typeof fetch,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    await expect(client.resolveImageFamily(GCP_DEBIAN_13_IMAGE_FAMILY))
      .rejects.toThrow("not a ready x86_64 image");
  });

  it("rejects an obsolete machine type", async () => {
    const client = new GcpClient(key, key.project_id, {
      fetcher: (async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return Response.json({
          id: "machine-europe-west3-a",
          name: GCP_CERTIFIED_MACHINE_TYPE,
          selfLink: `${url.origin}${url.pathname}`,
          guestCpus: 4,
          memoryMb: 16_384,
          architecture: "X86_64",
          deprecated: { state: "OBSOLETE" },
        });
      }) as typeof fetch,
      tokenProvider: async () => ({
        accessToken: "token",
        expiresAtEpochSeconds: 4_000_000_000,
      }),
    });

    await expect(client.resolveMachineTypes(
      GCP_CERTIFIED_MACHINE_TYPE,
      ["europe-west3-a"],
    )).rejects.toMatchObject({ shape: { code: "gcp_machine_type_unsupported" } });
  });
});
