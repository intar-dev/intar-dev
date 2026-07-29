/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import {
  invokeProviderService,
  providerServiceError,
} from "./hcloud-provider-service";

describe("Hetzner provider service error mapping", () => {
  it("preserves provider rate limits even when the operation is retryable", () => {
    expect(
      providerServiceError(
        {
          code: "hcloud_rate_limit_exceeded",
          message: "Hetzner rate limit exceeded",
          providerStatus: 429,
          retryable: true,
        },
        "provider request failed",
      ),
    ).toMatchObject({
      status: 429,
      code: "hcloud_rate_limit_exceeded",
    });
  });

  it("maps other retryable provider failures to service unavailable", () => {
    expect(
      providerServiceError(
        {
          code: "hcloud_temporarily_unavailable",
          message: "Hetzner is temporarily unavailable",
          providerStatus: 503,
          retryable: true,
        },
        "provider request failed",
      ),
    ).toMatchObject({ status: 503 });
  });

  it("sanitizes service-binding rejections as retryable transport failures", async () => {
    await expect(
      invokeProviderService(
        () =>
          Promise.reject(
            new Error("rpc transport failed with token hcloud-super-secret"),
          ),
        "Hetzner provider operation failed",
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "hcloud_provider_service_unavailable",
      message: "Hetzner provider operation failed",
    });
  });

  it("preserves structured provider failures returned over the binding", async () => {
    await expect(
      invokeProviderService(
        () =>
          Promise.resolve({
            ok: false as const,
            error: {
              code: "hcloud_rate_limit_exceeded",
              message: "Hetzner rate limit exceeded",
              providerStatus: 429,
              retryable: true,
            },
          }),
        "Hetzner provider operation failed",
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "hcloud_rate_limit_exceeded",
    });
  });
});
