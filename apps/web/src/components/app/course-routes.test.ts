import { describe, expect, it } from "vitest";
import { router } from "./router";
import { findActiveNavItem } from "./shell/nav-config";

describe("course learner routes", () => {
  it("exposes canonical public and organization course paths", () => {
    expect(router.routesByPath).toHaveProperty("/courses");
    expect(router.routesByPath).toHaveProperty("/courses/$courseId");
    expect(router.routesByPath).toHaveProperty(
      "/courses/$courseId/$scenarioId",
    );
    expect(router.routesByPath).toHaveProperty("/organizations/$orgId/courses");
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/public/$courseId",
    );
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/public/$courseId/$scenarioId",
    );
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/private/$courseId",
    );
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/private/$courseId/$scenarioId",
    );
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/general-practice",
    );
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/general-practice/$scenarioId",
    );
  });

  it("does not retain the legacy scenario paths", () => {
    expect(router.routesByPath).not.toHaveProperty("/scenarios");
    expect(router.routesByPath).not.toHaveProperty("/scenarios/$scenarioId");
    expect(router.routesByPath).not.toHaveProperty("/courses/$scenarioId");
  });

  it("activates course navigation for catalog and briefing paths", () => {
    expect(findActiveNavItem("/courses")?.label).toBe("Courses");
    expect(findActiveNavItem("/courses/linux/repair-nginx")?.id).toBe(
      "courses",
    );
    expect(findActiveNavItem("/scenarios")).toBeNull();
  });
});
