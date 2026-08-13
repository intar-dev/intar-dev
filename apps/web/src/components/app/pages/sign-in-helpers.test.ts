import { describe, expect, it } from "vitest";
import {
  normalizeOrganizationSlug,
  resolveGithubClaimRedirect,
} from "./sign-in-helpers";

describe("organization and invite sign-in helpers", () => {
  it("accepts only canonical organization slugs", () => {
    expect(normalizeOrganizationSlug(" org-platform-01 ")).toBe(
      "org-platform-01",
    );
    expect(normalizeOrganizationSlug("Org-Platform")).toBeNull();
    expect(normalizeOrganizationSlug("org/platform")).toBeNull();
    expect(normalizeOrganizationSlug("-org-platform")).toBeNull();
  });

  it("accepts GitHub and same-origin invite redirects", () => {
    expect(
      resolveGithubClaimRedirect({
        redirectUrl: "https://github.com/login/oauth/authorize",
        redirectKind: "github",
        applicationOrigin: "https://intar.dev",
      })?.hostname,
    ).toBe("github.com");
    expect(
      resolveGithubClaimRedirect({
        redirectUrl: "/join",
        redirectKind: "github",
        applicationOrigin: "https://intar.dev",
      })?.href,
    ).toBe("https://intar.dev/join");
  });

  it("rejects non-GitHub redirect kinds and external social URLs", () => {
    expect(
      resolveGithubClaimRedirect({
        redirectUrl: "https://github.com/login/oauth/authorize",
        redirectKind: "sso",
        applicationOrigin: "https://intar.dev",
      }),
    ).toBeNull();
    expect(
      resolveGithubClaimRedirect({
        redirectUrl: "https://evil.example/authorize",
        redirectKind: "github",
        applicationOrigin: "https://intar.dev",
      }),
    ).toBeNull();
  });
});
