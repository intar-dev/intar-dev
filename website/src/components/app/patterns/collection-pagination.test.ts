import { describe, expect, it } from "vitest";
import {
  buildVisiblePageNumbers,
  paginateCollection,
} from "./CollectionPagination";

describe("collection pagination", () => {
  it("slices collections and clamps out-of-range pages", () => {
    const items = Array.from({ length: 19 }, (_, index) => index + 1);

    expect(paginateCollection(items, 2, 8)).toMatchObject({
      items: [9, 10, 11, 12, 13, 14, 15, 16],
      page: 2,
      totalItems: 19,
      totalPages: 3,
    });
    expect(paginateCollection(items, 99, 8)).toMatchObject({
      items: [17, 18, 19],
      page: 3,
    });
    expect(paginateCollection([], 2, 8)).toMatchObject({
      items: [],
      page: 1,
      totalPages: 1,
    });
  });

  it("builds a stable five-page window", () => {
    expect(buildVisiblePageNumbers(1, 9)).toEqual([1, 2, 3, 4, 5]);
    expect(buildVisiblePageNumbers(5, 9)).toEqual([3, 4, 5, 6, 7]);
    expect(buildVisiblePageNumbers(9, 9)).toEqual([5, 6, 7, 8, 9]);
    expect(buildVisiblePageNumbers(2, 3)).toEqual([1, 2, 3]);
  });

  it("rejects invalid page sizes", () => {
    expect(() => paginateCollection([1], 1, 0)).toThrow(RangeError);
  });
});
