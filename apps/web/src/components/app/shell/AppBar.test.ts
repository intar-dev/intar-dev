import { describe, expect, it } from "vitest";
import {
  breadcrumbTarget,
  buildCrumbs,
  safeDynamicPageLabel,
} from "./AppBar";

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

describe("breadcrumbTarget", () => {
  it("routes organization course scope crumbs to the course catalog", () => {
    expect(
      breadcrumbTarget("/organizations/org-a/courses/public"),
    ).toBe("/organizations/org-a/courses");
    expect(
      breadcrumbTarget("/organizations/org-a/courses/private"),
    ).toBe("/organizations/org-a/courses");
  });

  it("keeps real route ancestors unchanged", () => {
    expect(breadcrumbTarget("/courses")).toBe("/courses");
    expect(
      breadcrumbTarget("/organizations/org-a/courses/public/linux"),
    ).toBe("/organizations/org-a/courses/public/linux");
  });
});

describe("buildCrumbs", () => {
  it("keeps two course levels and three scenario levels", () => {
    const publicOverrides = new Map([
      ["/courses/linux", "Linux operations"],
      ["/courses/linux/broken-nginx", "Broken Nginx"],
    ]);
    expect(
      buildCrumbs("/courses/linux", publicOverrides).map(
        (crumb) => crumb.label,
      ),
    ).toEqual(["Courses", "Linux operations"]);
    expect(
      buildCrumbs("/courses/linux/broken-nginx", publicOverrides).map(
        (crumb) => crumb.label,
      ),
    ).toEqual(["Courses", "Linux operations", "Broken Nginx"]);

    const organizationOverrides = new Map([
      ["/organizations/acme/courses/private", "Courses"],
      ["/organizations/acme/courses/private/linux", "Linux operations"],
      [
        "/organizations/acme/courses/private/linux/broken-nginx",
        "Broken Nginx",
      ],
    ]);
    expect(
      buildCrumbs(
        "/organizations/acme/courses/private/linux/broken-nginx",
        organizationOverrides,
      ).map((crumb) => crumb.label),
    ).toEqual(["Courses", "Linux operations", "Broken Nginx"]);
  });
});
