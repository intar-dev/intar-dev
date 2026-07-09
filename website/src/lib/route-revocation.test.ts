import { describe, expect, it, vi } from "vitest";
import { revokeAllRoutes } from "./route-revocation";

describe("revokeAllRoutes", () => {
  it("deduplicates routes and waits for every revocation", async () => {
    const revoke = vi.fn(async () => undefined);

    await revokeAllRoutes(["route-a", "route-a", "route-b"], revoke);

    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith("route-a");
    expect(revoke).toHaveBeenCalledWith("route-b");
  });

  it("reports every failure after attempting all routes", async () => {
    const attempted: string[] = [];
    const revoke = vi.fn(async (route: string) => {
      attempted.push(route);
      if (route !== "route-b") throw new Error(`offline: ${route}`);
    });

    const failure = revokeAllRoutes(["route-a", "route-b", "route-c"], revoke);

    await expect(failure).rejects.toThrow(
      "failed to revoke 2 of 3 Stargate routes",
    );
    expect(attempted).toEqual(["route-a", "route-b", "route-c"]);
  });
});
