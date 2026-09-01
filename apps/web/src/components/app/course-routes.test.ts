import { describe, expect, it } from "vitest";
import { router } from "./router";
import { NAV_SECTIONS, findActiveNavItem } from "./shell/nav-config";

describe("course learner routes", () => {
  it("exposes canonical public and organization course paths", () => {
    expect(router.routesByPath).toHaveProperty("/courses");
    expect(router.routesByPath).toHaveProperty("/courses/$courseId");
    expect(router.routesByPath).toHaveProperty(
      "/courses/$courseId/lectures/$lectureId",
    );
    expect(router.routesByPath).toHaveProperty("/organizations/$orgId/courses");
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/public/$courseId",
    );
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/public/$courseId/lectures/$lectureId",
    );
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/private/$courseId",
    );
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/courses/private/$courseId/lectures/$lectureId",
    );
  });

  it("does not retain scenario briefing, General practice, or authoring paths", () => {
    expect(router.routesByPath).not.toHaveProperty("/scenarios");
    expect(router.routesByPath).not.toHaveProperty("/scenarios/$scenarioId");
    expect(router.routesByPath).not.toHaveProperty("/courses/$scenarioId");
    expect(router.routesByPath).not.toHaveProperty("/courses/$courseId/$scenarioId");
    expect(router.routesByPath).not.toHaveProperty(
      "/organizations/$orgId/courses/public/$courseId/$scenarioId",
    );
    expect(router.routesByPath).not.toHaveProperty(
      "/organizations/$orgId/courses/private/$courseId/$scenarioId",
    );
    expect(router.routesByPath).not.toHaveProperty(
      "/organizations/$orgId/courses/general-practice",
    );
    expect(router.routesByPath).not.toHaveProperty(
      "/organizations/$orgId/courses/general-practice/$scenarioId",
    );
    expect(router.routesByPath).not.toHaveProperty("/admin/authoring");
  });

  it("activates course navigation for catalog and lecture paths", () => {
    expect(findActiveNavItem("/courses")?.label).toBe("Courses");
    expect(findActiveNavItem("/courses/linux/lectures/repair-nginx")?.id).toBe(
      "courses",
    );
    expect(findActiveNavItem("/scenarios")).toBeNull();
  });

  it("does not show General practice or authoring navigation", () => {
    const items = NAV_SECTIONS.flatMap((section) => section.items);

    expect(items).not.toContainEqual(
      expect.objectContaining({ label: "General practice" }),
    );
    expect(items).not.toContainEqual(
      expect.objectContaining({ id: "admin-authoring" }),
    );
    expect(items).not.toContainEqual(
      expect.objectContaining({ label: "Authoring" }),
    );
  });

  it("keeps Discord in a signed-in Support section", () => {
    const support = NAV_SECTIONS.find((section) => section.id === "support");

    expect(support?.label).toBe("Support");
    expect(support?.requires).toBe("signedIn");
    expect(support?.items).toEqual([
      expect.objectContaining({
        id: "discord",
        label: "Discord",
        to: "https://discord.gg/BgknKxJKa",
        requires: "signedIn",
        external: true,
      }),
    ]);
  });
});
