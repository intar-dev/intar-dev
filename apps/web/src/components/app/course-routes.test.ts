import { describe, expect, it } from "vitest";
import { router } from "./router";
import { findActiveNavItem } from "./shell/nav-config";

describe("course learner routes", () => {
  it("exposes course catalog and scenario briefing paths", () => {
    expect(router.routesByPath).toHaveProperty("/courses");
    expect(router.routesByPath).toHaveProperty("/courses/$scenarioId");
  });

  it("does not retain the legacy scenario paths", () => {
    expect(router.routesByPath).not.toHaveProperty("/scenarios");
    expect(router.routesByPath).not.toHaveProperty("/scenarios/$scenarioId");
  });

  it("activates course navigation for catalog and briefing paths", () => {
    expect(findActiveNavItem("/courses")?.label).toBe("Courses");
    expect(findActiveNavItem("/courses/repair-nginx")?.id).toBe("courses");
    expect(findActiveNavItem("/scenarios")).toBeNull();
  });
});
