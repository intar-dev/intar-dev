import { describe, expect, it } from "vitest";
import { router } from "./router";
import { findActiveNavItem } from "./shell/nav-config";
import {
  workshopModuleStateLabel,
  workshopSessionStateLabel,
} from "./workshops/types";

describe("standalone workshop routes", () => {
  it("registers learner, presenter, projector, and organization surfaces", () => {
    expect(router.routesByPath).toHaveProperty("/workshops");
    expect(router.routesByPath).toHaveProperty("/workshops/$sessionId");
    expect(router.routesByPath).toHaveProperty("/workshops/$sessionId/present");
    expect(router.routesByPath).toHaveProperty(
      "/workshops/$sessionId/projector",
    );
    expect(router.routesByPath).toHaveProperty(
      "/organizations/$orgId/workshops",
    );
  });

  it("keeps workshop navigation separate from courses", () => {
    expect(findActiveNavItem("/workshops")?.label).toBe("Workshops");
    expect(findActiveNavItem("/workshops/session-1/present")?.id).toBe(
      "workshops",
    );
    expect(findActiveNavItem("/courses")?.id).toBe("courses");
  });

  it("uses explicit labels for nonstandard progress states", () => {
    expect(workshopSessionStateLabel("lobby")).toBe("Lobby open");
    expect(workshopModuleStateLabel("caught_up")).toBe("Caught up");
    expect(workshopModuleStateLabel("manually_completed")).toBe("Completed");
  });
});
