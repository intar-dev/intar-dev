import { describe, expect, it } from "vitest";
import { safeDynamicPageLabel } from "./AppBar";

describe("safe dynamic app-bar labels", () => {
  it("never exposes run or scenario route identifiers while data loads", () => {
    expect(safeDynamicPageLabel("/runs/run_technical_identifier")).toBe(
      "Lab run",
    );
    expect(
      safeDynamicPageLabel("/courses/linux-operations/broken-nginx"),
    ).toBe("Lab");
    expect(
      safeDynamicPageLabel(
        "/organizations/acme/courses/public/linux-operations/broken-nginx",
      ),
    ).toBe("Lab");
    expect(
      safeDynamicPageLabel(
        "/organizations/acme/courses/private/linux-operations/broken-nginx",
      ),
    ).toBe("Lab");
    expect(
      safeDynamicPageLabel(
        "/organizations/acme/courses/general-practice/broken-nginx",
      ),
    ).toBe("Lab");
  });

  it("leaves static pages and course catalogs unchanged", () => {
    expect(safeDynamicPageLabel("/runs")).toBeNull();
    expect(safeDynamicPageLabel("/courses/linux-operations")).toBeNull();
    expect(safeDynamicPageLabel("/admin/hosts")).toBeNull();
  });
});
