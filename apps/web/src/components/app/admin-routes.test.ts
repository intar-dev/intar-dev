import { describe, expect, it } from "vitest";
import { router } from "./router";
import { findActiveNavItem } from "./shell/nav-config";

describe("admin people routes", () => {
  it("opens a person's details under People", () => {
    expect(router.routesByPath).toHaveProperty("/admin/people");
    expect(router.routesByPath).toHaveProperty("/admin/people/$userId");
    const people = findActiveNavItem("/admin/people");
    expect(people).not.toBeNull();
    expect(findActiveNavItem("/admin/people/user-blocked")?.id).toBe(people?.id);
  });
});
