import { describe, expect, it } from "vitest";
import {
  breadcrumbTarget,
  buildCrumbs,
  safeDynamicPageLabel,
} from "./AppBar";

describe("safe dynamic app-bar labels", () => {
  it("never exposes run or lecture route identifiers while data loads", () => {
    expect(safeDynamicPageLabel("/runs/run_technical_identifier")).toBe(
      "Scenario run",
    );
    expect(safeDynamicPageLabel("/runs/start/repair-nginx")).toBe(
      "Starting run",
    );
    expect(
      safeDynamicPageLabel("/courses/linux-operations/lectures/broken-nginx"),
    ).toBe("Lecture");
    expect(
      safeDynamicPageLabel(
        "/organizations/acme/courses/public/linux-operations/lectures/broken-nginx",
      ),
    ).toBe("Lecture");
    expect(
      safeDynamicPageLabel(
        "/organizations/acme/courses/private/linux-operations/lectures/broken-nginx",
      ),
    ).toBe("Lecture");
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
  it("keeps two course levels and three lecture levels", () => {
    const publicOverrides = new Map([
      ["/courses/linux", "Linux operations"],
      ["/courses/linux/lectures/broken-nginx", "Broken Nginx"],
    ]);
    expect(
      buildCrumbs("/courses/linux", publicOverrides).map(
        (crumb) => crumb.label,
      ),
    ).toEqual(["Courses", "Linux operations"]);
    expect(
      buildCrumbs("/courses/linux/lectures/broken-nginx", publicOverrides).map(
        (crumb) => crumb.label,
      ),
    ).toEqual(["Courses", "Linux operations", "Broken Nginx"]);

    const organizationOverrides = new Map([
      ["/organizations/acme/courses/private/linux", "Linux operations"],
      [
        "/organizations/acme/courses/private/linux/lectures/broken-nginx",
        "Broken Nginx",
      ],
    ]);
    expect(
      buildCrumbs(
        "/organizations/acme/courses/private/linux/lectures/broken-nginx",
        organizationOverrides,
      ),
    ).toEqual([
      { label: "Courses", to: "/organizations/acme/courses" },
      {
        label: "Linux operations",
        to: "/organizations/acme/courses/private/linux",
      },
      { label: "Broken Nginx" },
    ]);
  });

  it("keeps organization course breadcrumbs inside the learner flow", () => {
    expect(
      buildCrumbs(
        "/organizations/acme/courses",
        new Map(),
      ).map((crumb) => crumb.label),
    ).toEqual(["Courses"]);
    expect(
      buildCrumbs(
        "/organizations/acme/courses/public/linux",
        new Map([["/organizations/acme/courses/public/linux", "Linux Basics"]]),
      ).map((crumb) => crumb.label),
    ).toEqual(["Courses", "Linux Basics"]);
  });
});
