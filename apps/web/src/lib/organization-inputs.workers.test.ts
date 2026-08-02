/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { isSafePublicHttpsEndpoint } from "@/lib/organization-oidc";
import { namespaceOrganizationScenarioSource } from "@/lib/scenario-sources";

describe("organization input boundaries", () => {
  it("namespaces local scenario HCL without accepting a mismatched label", () => {
    expect(
      namespaceOrganizationScenarioSource({
        organizationSlug: "rawkode-academy-a1b2c3",
        localScenarioId: "broken-nginx",
        hcl: 'scenario "broken-nginx" {\n  title = "Broken nginx"\n}\n',
      }),
    ).toEqual({
      scenarioId: "rawkode-academy-a1b2c3-broken-nginx",
      hcl: 'scenario "rawkode-academy-a1b2c3-broken-nginx" {\n  title = "Broken nginx"\n}\n',
    });
    expect(() =>
      namespaceOrganizationScenarioSource({
        organizationSlug: "rawkode-academy-a1b2c3",
        localScenarioId: "expected",
        hcl: 'scenario "different" {}',
      }),
    ).toThrow(/must match/);
  });

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
