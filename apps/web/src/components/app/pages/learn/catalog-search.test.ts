import { describe, expect, it } from "vitest";
import {
  compactCatalogSearch,
  normalizeCatalogSearch,
  validateSearch,
} from "./catalog-search";

describe("course catalog search", () => {
  it("keeps only catalog filters", () => {
    expect(
      normalizeCatalogSearch({
        course: "  org-platform:operations  ",
        q: "  repair  ",
      }),
    ).toEqual({
      q: "repair",
      difficulty: undefined,
      category: undefined,
      tags: [],
    });
  });

  it("drops legacy course state from compact search", () => {
    const normalized = normalizeCatalogSearch({ course: "   " });

    expect(compactCatalogSearch(normalized)).not.toHaveProperty("course");
    expect(validateSearch({ course: 42 })).not.toHaveProperty("course");
  });
});
