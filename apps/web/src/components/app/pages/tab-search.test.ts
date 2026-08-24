import { describe, expect, it } from "vitest";
import {
  ADMIN_PEOPLE_TABS,
  ORGANIZATION_DETAIL_TABS,
  validateAdminPeopleSearch,
  validateOrganizationDetailSearch,
  validateScenarioBriefingSearch,
} from "./tab-search";

describe("organization detail tab search", () => {
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

describe("scenario briefing search", () => {
  it("keeps only normalized catalog filters", () => {
    expect(
      validateScenarioBriefingSearch({
        course: " public:operations ",
        q: " nginx ",
        difficulty: "medium",
        category: " Linux services ",
        tags: [" networking ", "linux", "linux", " "],
        sort: "title",
        organizationId: " org-platform ",
        step: "2",
        steps: "5",
      }),
    ).toEqual({
      q: "nginx",
      difficulty: "medium",
      category: "Linux services",
      tags: ["linux", "networking"],
      sort: "title",
    });
  });

  it("drops invalid and legacy navigation values", () => {
    expect(
      validateScenarioBriefingSearch({
        course: " ",
        q: 42,
        difficulty: "expert",
        category: " ",
        tags: [" ", 42, null],
        sort: "popular",
        organizationId: 42,
        step: 4,
        steps: 3,
      }),
    ).toEqual({});
  });
});
