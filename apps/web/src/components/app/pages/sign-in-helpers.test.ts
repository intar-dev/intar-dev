import { describe, expect, it } from "vitest";
import { normalizeOrganizationSlug } from "./sign-in-helpers";

describe("organization sign-in helpers", () => {
  it("accepts only canonical organization slugs", () => {
    expect(normalizeOrganizationSlug(" org-platform-01 ")).toBe(
      "org-platform-01",
    );
    expect(normalizeOrganizationSlug("Org-Platform")).toBeNull();
    expect(normalizeOrganizationSlug("org/platform")).toBeNull();
    expect(normalizeOrganizationSlug("-org-platform")).toBeNull();
  });
});
