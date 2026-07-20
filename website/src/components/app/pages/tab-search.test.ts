import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_DETAIL_TABS,
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
