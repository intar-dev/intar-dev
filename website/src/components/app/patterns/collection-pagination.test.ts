import { describe, expect, it } from "vitest";
import {
  COLLECTION_PAGE_SIZE,
  buildVisiblePageNumbers,
  paginateCollection,
  paginateWeightedCollection,
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

  it("uses nine cards as the shared card-page default", () => {
    expect(COLLECTION_PAGE_SIZE.cards).toBe(9);
  });

  it("packs weighted units toward nine without splitting them", () => {
    const units = [
      { item: "course-a", weight: 6 },
      { item: "course-b", weight: 4 },
      ...Array.from({ length: 7 }, (_, index) => ({
        item: `individual-${index + 1}`,
        weight: 1,
      })),
    ];

    expect(paginateWeightedCollection(units, 1, 9)).toMatchObject({
      items: ["course-a"],
      page: 1,
      totalItems: 17,
      totalPages: 3,
      start: 1,
      end: 6,
    });
    expect(paginateWeightedCollection(units, 2, 9)).toMatchObject({
      items: [
        "course-b",
        "individual-1",
        "individual-2",
        "individual-3",
        "individual-4",
        "individual-5",
      ],
      start: 7,
      end: 15,
    });
    expect(paginateWeightedCollection(units, 3, 9)).toMatchObject({
      items: ["individual-6", "individual-7"],
      start: 16,
      end: 17,
    });
  });

  it("puts an oversized atomic unit on a page by itself", () => {
    const units = [
      { item: "large-course", weight: 11 },
      { item: "individual", weight: 1 },
    ];

    expect(paginateWeightedCollection(units, 1, 9)).toMatchObject({
      items: ["large-course"],
      start: 1,
      end: 11,
      totalPages: 2,
    });
    expect(paginateWeightedCollection(units, 2, 9)).toMatchObject({
      items: ["individual"],
      start: 12,
      end: 12,
    });
    expect(() =>
      paginateWeightedCollection([{ item: "bad", weight: 0 }], 1, 9),
    ).toThrow(RangeError);
  });
});
