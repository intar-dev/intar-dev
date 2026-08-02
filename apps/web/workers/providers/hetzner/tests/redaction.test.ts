import { describe, expect, it } from "vitest";
import { ProviderServiceError, redactString, safeUnknownError } from "../src/redaction";

describe("provider error redaction", () => {
  it("removes bearer credentials and explicit secret values", () => {
    const token = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const value = redactString(`Authorization: Bearer ${token}; token=${token}`, [token]);
    expect(value).not.toContain(token);
    expect(value).toContain("[REDACTED]");
  });

  it("returns only structured allowlisted provider errors", () => {
    const expected = {
      code: "hcloud_rate_limit_exceeded",
      message: "Hetzner API rejected the provider operation",
      retryable: true,
    };
    expect(safeUnknownError(new ProviderServiceError(expected))).toEqual(expected);
    expect(safeUnknownError(new Error("token=super-secret"))).toEqual({
      code: "provider_internal_error",
      message: "Hetzner provider operation failed",
      retryable: false,
    });
  });
});
