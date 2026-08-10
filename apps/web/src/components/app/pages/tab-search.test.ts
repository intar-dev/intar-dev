import { describe, expect, it } from "vitest";
import {
  ADMIN_PEOPLE_TABS,
  ORGANIZATION_DETAIL_TABS,
  validateAdminPeopleSearch,
  validateOrganizationDetailSearch,
} from "./tab-search";

describe("organization detail tab search", () => {
  it("accepts the course tab", () => {
    expect(validateOrganizationDetailSearch({ tab: "courses" })).toEqual({
      tab: "courses",
    });
    expect(ORGANIZATION_DETAIL_TABS).toContain("courses");
  });

  it("keeps course drill-down state only on the Courses tab", () => {
    expect(
      validateOrganizationDetailSearch({
        tab: "courses",
        course: " org-platform:operations ",
      }),
    ).toEqual({
      tab: "courses",
      course: "org-platform:operations",
    });
    expect(
      validateOrganizationDetailSearch({
        tab: "assignments",
        course: "org-platform:operations",
      }),
    ).toEqual({ tab: "assignments" });
  });

  it("falls legacy scenario tab links back to overview", () => {
    expect(validateOrganizationDetailSearch({ tab: "scenarios" })).toEqual(
      {},
    );
    expect(ORGANIZATION_DETAIL_TABS).not.toContain("scenarios");
  });
});

describe("admin people tab search", () => {
  it("uses beta access as the canonical default", () => {
    expect(validateAdminPeopleSearch({})).toEqual({});
    expect(validateAdminPeopleSearch({ tab: "beta" })).toEqual({});
    expect(ADMIN_PEOPLE_TABS[0]).toBe("beta");
  });

  it("keeps supported operational tabs and drops the removed request tab", () => {
    expect(validateAdminPeopleSearch({ tab: "users" })).toEqual({
      tab: "users",
    });
    expect(validateAdminPeopleSearch({ tab: "organizations" })).toEqual({
      tab: "organizations",
    });
    expect(validateAdminPeopleSearch({ tab: "requests" })).toEqual({});
    expect(ADMIN_PEOPLE_TABS).not.toContain("requests");
  });
});
