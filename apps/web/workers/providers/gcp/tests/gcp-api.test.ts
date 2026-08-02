import { describe, expect, it } from "vitest";
import type { GcpServiceAccountKey } from "@intar/provider-contracts/gcp";
import { GcpApi, gcpOperationErrorCode } from "../src/gcp-api";

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

function apiWith(response: Response): GcpApi {
  return new GcpApi(key, {
    fetcher: (async () => response.clone()) as typeof fetch,
    tokenProvider: async () => ({ accessToken: "secret-access-token", expiresAtEpochSeconds: 4_000_000_000 }),
  });
}

describe("GCP API failure classification", () => {
  it("classifies IAM denial, quota exhaustion, and rate limiting without leaking bodies", async () => {
    const permission = apiWith(Response.json({
      error: { status: "PERMISSION_DENIED", message: "secret provider body" },
    }, { status: 403 }));
    await expect(permission.compute("/projects/p/zones/z/instances")).rejects.toMatchObject({
      shape: { code: "gcp_permission_denied", retryable: false },
    });

    const quota = apiWith(Response.json({
      error: { errors: [{ reason: "quotaExceeded" }], message: "secret provider body" },
    }, { status: 403 }));
    let quotaError: unknown;
    try {
      await quota.compute("/projects/p/zones/z/instances");
    } catch (error) {
      quotaError = error;
    }
    expect(quotaError).toMatchObject({ shape: { code: "gcp_quota_exceeded", retryable: false } });
    expect(JSON.stringify(quotaError)).not.toContain("secret provider body");

    const rate = apiWith(Response.json({ error: { message: "no" } }, {
      status: 429,
      headers: { "retry-after": "7" },
    }));
    await expect(rate.compute("/projects/p/zones/z/instances")).rejects.toMatchObject({
      shape: { code: "gcp_rate_limit_exceeded", retryable: true, retryAfterSeconds: 7 },
    });
  });

  it("classifies an ambiguous transport failure as retryable and credential-free", async () => {
    const api = new GcpApi(key, {
      fetcher: (async () => { throw new Error("socket closed with secret-access-token"); }) as typeof fetch,
      tokenProvider: async () => ({ accessToken: "secret-access-token", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    let caught: unknown;
    try {
      await api.compute("/projects/p/zones/z/instances", { method: "POST", body: "{}" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ shape: { code: "gcp_transport_error", retryable: true } });
    expect(JSON.stringify(caught)).not.toContain("secret-access-token");
  });

  it("distinguishes zonal capacity exhaustion from project quota exhaustion", async () => {
    const capacity = apiWith(
      Response.json(
        {
          error: {
            errors: [{ reason: "resourcePoolExhausted" }],
            message: "capacity unavailable",
          },
        },
        { status: 503 },
      ),
    );
    await expect(
      capacity.compute("/projects/p/zones/z/instances", { method: "POST" }),
    ).rejects.toMatchObject({
      shape: { code: "gcp_resource_unavailable" },
    });
    expect(
      gcpOperationErrorCode({
        id: "1",
        name: "operation-1",
        selfLink: "https://compute.googleapis.com/operation-1",
        status: "DONE",
        error: { errors: [{ code: "ZONE_RESOURCE_POOL_EXHAUSTED" }] },
      }),
    ).toBe("gcp_resource_unavailable");
  });
});
