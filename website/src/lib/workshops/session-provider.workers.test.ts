/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import type { ProviderPriceObservation } from "@/db/schema";
import { workshopForecastTriggerForResolvedPrices } from "./session-provider";

describe("workshop session provider price refresh", () => {
  it("records a changed provider price as a price_changed forecast", () => {
    const previous = observation("0.6250");
    const resolved = observation("0.6500");

    expect(
      workshopForecastTriggerForResolvedPrices({
        requestedTrigger: "lobby_refresh",
        previous,
        resolved,
      }),
    ).toBe("price_changed");
  });
});

function observation(serverHourlyGross: string): ProviderPriceObservation {
  return {
    currency: "NOK",
    observedAt: 1_750_000_000_000,
    expiresAt: 1_750_086_400_000,
    serverType: "cx43",
    locations: [
      {
        location: "nbg1",
        available: true,
        serverHourlyNet: "0.5000",
        serverHourlyGross,
        serverMonthlyNet: "250.0000",
        serverMonthlyGross: "312.5000",
        ipv4HourlyNet: "0.0100",
        ipv4HourlyGross: "0.0125",
        ipv4MonthlyNet: "5.0000",
        ipv4MonthlyGross: "6.2500",
      },
    ],
  };
}
