/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { isSafePublicHttpsEndpoint } from "@/lib/organization-oidc";

describe("organization input boundaries", () => {
  it("accepts public HTTPS OIDC endpoints and rejects local or nonstandard endpoints", () => {
    expect(isSafePublicHttpsEndpoint("https://id.rawkode.academy")).toBe(true);
    expect(isSafePublicHttpsEndpoint("http://id.rawkode.academy")).toBe(false);
    expect(isSafePublicHttpsEndpoint("https://127.0.0.1")).toBe(false);
    expect(isSafePublicHttpsEndpoint("https://metadata.google.internal")).toBe(
      false,
    );
    expect(isSafePublicHttpsEndpoint("https://id.example.com:8443")).toBe(
      false,
    );
  });
});
