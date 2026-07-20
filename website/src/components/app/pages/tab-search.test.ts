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

  it("falls legacy scenario tab links back to overview", () => {
    expect(validateOrganizationDetailSearch({ tab: "scenarios" })).toEqual(
      {},
    );
    expect(ORGANIZATION_DETAIL_TABS).not.toContain("scenarios");
  });
});
