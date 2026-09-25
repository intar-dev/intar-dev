import { describe, expect, it } from "vitest";
import {
  ADMIN_PEOPLE_TABS,
  ORGANIZATION_DETAIL_TABS,
  validateAdminPeopleSearch,
  validateOrganizationDetailSearch,
} from "./tab-search";

describe("organization detail tab search", () => {
  it("keeps only known OIDC test results in Settings", () => {
    expect(validateOrganizationDetailSearch({ error: "oidc_sign_in_failed" }))
      .toEqual({
        tab: "settings",
        oidcTest: "failed",
        oidcError: "oidc_sign_in_failed",
      });
    expect(
      validateOrganizationDetailSearch({ error: "sso_identity_linked_elsewhere" }),
    ).toEqual({
      tab: "settings",
      oidcTest: "failed",
      oidcError: "sso_identity_linked_elsewhere",
    });
    expect(validateOrganizationDetailSearch({ error: "<script>" })).toEqual({});
    expect(
      validateOrganizationDetailSearch({
        tab: "settings",
        oidcTest: "passed",
        error_description: "untrusted",
      }),
    ).toEqual({ tab: "settings", oidcTest: "passed" });
    expect(
      validateOrganizationDetailSearch({ tab: "settings", oidcTest: "failed" }),
    ).toEqual({ tab: "settings", oidcTest: "failed" });
    expect(
      validateOrganizationDetailSearch({
        tab: "settings",
        oidcTest: "unknown",
      }),
    ).toEqual({ tab: "settings" });
    expect(
      validateOrganizationDetailSearch({ tab: "people", oidcTest: "passed" }),
    ).toEqual({ tab: "people" });
  });
  it("keeps shared server links and drops unrelated query state", () => {
    expect(
      validateOrganizationDetailSearch({ tab: "servers", host: "old" }),
    ).toEqual({ tab: "servers" });
    expect(ORGANIZATION_DETAIL_TABS).toContain("servers");
  });

  it("drops the former course panel and its drill-down query state", () => {
    expect(
      validateOrganizationDetailSearch({
        tab: "courses",
        course: " org-platform:operations ",
      }),
    ).toEqual({});
    expect(
      validateOrganizationDetailSearch({
        tab: "assignments",
        course: "org-platform:operations",
      }),
    ).toEqual({ tab: "assignments" });
    expect(ORGANIZATION_DETAIL_TABS).not.toContain("courses");
  });

  it("falls legacy scenario tab links back to overview", () => {
    expect(validateOrganizationDetailSearch({ tab: "scenarios" })).toEqual({});
    expect(ORGANIZATION_DETAIL_TABS).not.toContain("scenarios");
  });
});

describe("admin people tab search", () => {
  it("uses users as the canonical default", () => {
    expect(validateAdminPeopleSearch({})).toEqual({});
    expect(validateAdminPeopleSearch({ tab: "users" })).toEqual({});
    expect(ADMIN_PEOPLE_TABS[0]).toBe("users");
  });

  it("keeps the sign-up and organization tabs", () => {
    expect(validateAdminPeopleSearch({ tab: "signups" })).toEqual({
      tab: "signups",
    });
    expect(validateAdminPeopleSearch({ tab: "organizations" })).toEqual({
      tab: "organizations",
    });
  });

  it("falls removed tab links back to users", () => {
    expect(validateAdminPeopleSearch({ tab: "beta" })).toEqual({});
    expect(validateAdminPeopleSearch({ tab: "requests" })).toEqual({});
    expect(ADMIN_PEOPLE_TABS).not.toContain("beta");
    expect(ADMIN_PEOPLE_TABS).not.toContain("requests");
  });
});
