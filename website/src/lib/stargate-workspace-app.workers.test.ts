/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { parseStargateWorkspaceAppSessionResponse } from "./stargate";

describe("Stargate workspace application bootstrap contract", () => {
  it("preserves the one-time bootstrap deadline for the browser", () => {
    expect(
      parseStargateWorkspaceAppSessionResponse({
        route_id: "wa-secure-route",
        url: "https://wa-secure-route.workshop-apps.example.test/?__intar_bootstrap=one-time",
        bootstrap_expires_at: 1_800_000_060,
        expires_at: 1_800_000_900,
      }),
    ).toEqual({
      routeId: "wa-secure-route",
      url: "https://wa-secure-route.workshop-apps.example.test/?__intar_bootstrap=one-time",
      bootstrapExpiresAt: 1_800_000_060_000,
      expiresAt: 1_800_000_900_000,
    });
  });

  it.each([
    {
      route_id: "wa-bearer-route",
      url: "https://wa-bearer-route.workshop-apps.example.test/",
      bootstrap_expires_at: 1_800_000_060,
      expires_at: 1_800_000_900,
    },
    {
      route_id: "wa-expired-bootstrap",
      url: "https://wa-expired-bootstrap.workshop-apps.example.test/?__intar_bootstrap=one-time",
      bootstrap_expires_at: 1_800_001_000,
      expires_at: 1_800_000_900,
    },
  ])("rejects a response without a bounded bootstrap capability", (value) => {
    expect(() => parseStargateWorkspaceAppSessionResponse(value)).toThrow(
      "invalid stargate workspace application response",
    );
  });
});
