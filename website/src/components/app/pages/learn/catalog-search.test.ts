import { describe, expect, it } from "vitest";
import {
  compactCatalogSearch,
  normalizeCatalogSearch,
  validateSearch,
} from "./catalog-search";

describe("course catalog search", () => {
  it("normalizes a scope-qualified course selection", () => {
    expect(
      normalizeCatalogSearch({
        course: "  org-platform:operations  ",
        q: "  repair  ",
      }),
    ).toMatchObject({
      course: "org-platform:operations",
      q: "repair",
    });
  });

  it("drops an empty course selection from compact search state", () => {
    const normalized = normalizeCatalogSearch({ course: "   " });

    expect(normalized.course).toBeUndefined();
    expect(compactCatalogSearch(normalized)).not.toHaveProperty("course");
    expect(validateSearch({ course: 42 })).not.toHaveProperty("course");
  });
});
