import { describe, expect, it } from "vitest";
import { ProviderServiceError, redactString } from "@intar/provider-worker-core";
import { safeUnknownError } from "../src/redaction";

describe("GCP provider redaction", () => {
  it("does not expose private keys, bearer tokens, or unknown error details", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----";
    const bearer = "ya29.super-secret-access-token";
    expect(redactString(`${privateKey}\nAuthorization: Bearer ${bearer}`))
      .not.toContain("secret-material");
    expect(JSON.stringify(safeUnknownError(new Error(privateKey)))).not.toContain("secret-material");
  });

  it("passes only explicit structured provider errors", () => {
    expect(safeUnknownError(new ProviderServiceError({
      code: "gcp_quota_exceeded",
      message: "GCP API rejected the provider operation",
      retryable: false,
      providerStatus: 403,
    }))).toEqual({
      code: "gcp_quota_exceeded",
      message: "GCP API rejected the provider operation",
      retryable: false,
      providerStatus: 403,
    });
  });
});
