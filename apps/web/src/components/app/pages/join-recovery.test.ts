import { describe, expect, it } from "vitest";
import {
  normalizeRecoveryOrganizationSlug,
  resolveClaimRedirect,
} from "./join-recovery";

describe("beta invite OIDC recovery", () => {
  it("accepts only canonical organization slugs", () => {
    expect(normalizeRecoveryOrganizationSlug(" org-platform-01 ")).toBe(
      "org-platform-01",
    );
    expect(normalizeRecoveryOrganizationSlug("Org-Platform")).toBeNull();
    expect(normalizeRecoveryOrganizationSlug("org/platform")).toBeNull();
    expect(normalizeRecoveryOrganizationSlug("-org-platform")).toBeNull();
  });

  it("accepts arbitrary HTTPS OIDC providers but rejects insecure redirects", () => {
    expect(
      resolveClaimRedirect({
        redirectUrl: "https://login.example.net/authorize?state=signed",
        redirectKind: "sso",
        expectedKind: "sso",
        applicationOrigin: "https://intar.dev",
      })?.hostname,
    ).toBe("login.example.net");
    expect(
      resolveClaimRedirect({
        redirectUrl: "http://login.example.net/authorize",
        redirectKind: "sso",
        expectedKind: "sso",
        applicationOrigin: "https://intar.dev",
      }),
    ).toBeNull();
  });

  it("rejects redirect-kind confusion and non-GitHub external social URLs", () => {
    expect(
      resolveClaimRedirect({
        redirectUrl: "https://github.com/login/oauth/authorize",
        redirectKind: "github",
        expectedKind: "sso",
        applicationOrigin: "https://intar.dev",
      }),
    ).toBeNull();
    expect(
      resolveClaimRedirect({
        redirectUrl: "https://evil.example/authorize",
        redirectKind: "github",
        expectedKind: "github",
        applicationOrigin: "https://intar.dev",
      }),
    ).toBeNull();
  });
});
