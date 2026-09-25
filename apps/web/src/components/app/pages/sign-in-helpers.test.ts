import { describe, expect, it } from "vitest";
import {
  githubCallbackMessage,
  normalizeOrganizationSlug,
  organizationSignInErrorMessage,
} from "./sign-in-helpers";

describe("organization sign-in helpers", () => {
  it("reads a slug in any case, with surrounding spaces", () => {
    expect(normalizeOrganizationSlug(" org-platform-01 ")).toBe(
      "org-platform-01",
    );
    expect(normalizeOrganizationSlug("  Org-Platform ")).toBe("org-platform");
    expect(normalizeOrganizationSlug("org/platform")).toBeNull();
    expect(normalizeOrganizationSlug("-org-platform")).toBeNull();
  });

  it("explains known sign-in codes and nothing else", () => {
    expect(organizationSignInErrorMessage("sso_email_in_use")).toContain(
      "already uses this email",
    );
    expect(organizationSignInErrorMessage("signups_full")).toBe(
      "No sign-up spots are open right now.",
    );
    for (const code of [null, "unknown_code", "constructor", "__proto__"]) {
      expect(organizationSignInErrorMessage(code)).toBe(
        "Organization sign-in failed. Try again.",
      );
    }
  });

  it("names the provider's missing email claim", () => {
    expect(organizationSignInErrorMessage("oidc_email_missing")).toContain(
      "include the email claim",
    );
  });

  it("explains GitHub callback codes and ignores prototype keys", () => {
    expect(githubCallbackMessage("state_not_found")).toBe(
      "Your sign-in session expired. Please try again.",
    );
    expect(githubCallbackMessage("Account not linked")).toContain(
      "already belongs to an Intar account",
    );
    expect(githubCallbackMessage("github_account_mismatch")).toContain(
      "a different GitHub account",
    );
    // The OAuth provider sends broken app authorization links here too.
    expect(githubCallbackMessage("invalid_client")).toContain(
      "This app's sign-in link isn't valid",
    );
    for (const code of [null, "", "unknown", "__proto__", "constructor"]) {
      expect(githubCallbackMessage(code)).toBeNull();
    }
  });
});
