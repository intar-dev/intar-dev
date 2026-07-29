import { describe, expect, it } from "vitest";
import type { ProviderPriceObservation } from "@/db/schema";
import {
  billableHours,
  calculateWorkshopCostForecast,
  cappedResourceCost,
  decimalCurrencyToMicros,
  estimateLedgerResource,
} from "./costs";

const observedAt = Date.UTC(2026, 6, 22, 8);

function prices(
  overrides: Partial<ProviderPriceObservation> = {},
): ProviderPriceObservation {
  return {
    currency: "NOK",
    observedAt,
    expiresAt: observedAt + 48 * 60 * 60 * 1_000,
    serverType: "cx43",
    locations: [
      {
        location: "nbg1",
        available: true,
        serverHourlyNet: "0.100000",
        serverHourlyGross: "0.125000",
        serverMonthlyNet: "50.000000",
        serverMonthlyGross: "62.500000",
        ipv4HourlyNet: "0.010000",
        ipv4HourlyGross: "0.012500",
        ipv4MonthlyNet: "5.000000",
        ipv4MonthlyGross: "6.250000",
      },
      {
        location: "fsn1",
        available: true,
        serverHourlyNet: "0.120000",
        serverHourlyGross: "0.150000",
        ipv4HourlyNet: "0.010000",
        ipv4HourlyGross: "0.012500",
      },
    ],
    ...overrides,
  };
}

describe("Hetzner currency arithmetic", () => {
  it("normalizes provider decimals without floating point", () => {
    expect(decimalCurrencyToMicros("12.345678")).toBe(12_345_678);
    expect(decimalCurrencyToMicros("0.1")).toBe(100_000);
    expect(decimalCurrencyToMicros("1.0000000")).toBe(1_000_000);
    expect(() => decimalCurrencyToMicros("1.0000001")).toThrow(
      /precision/,
    );
  });

  it("uses a one-hour minimum and monthly caps", () => {
    expect(billableHours(0)).toBe(1);
    expect(billableHours(3_600)).toBe(1);
    expect(billableHours(3_601)).toBe(2);
    expect(cappedResourceCost(10, 1_000_000, 6_000_000)).toBe(6_000_000);
  });
});

describe("workshop cost forecast", () => {
  it("calculates preferred, ceiling, and independently rounded restore", () => {
    const forecast = calculateWorkshopCostForecast({
      participantCount: 2,
      provisioningStartsAt: observedAt,
      scheduledEndsAt: observedAt + 4 * 60 * 60 * 1_000,
      leaseGraceMinutes: 60,
      approvedLocations: ["nbg1", "fsn1"],
      prices: prices(),
    });

    expect(forecast.currency).toBe("NOK");
    expect(forecast.preferredLocation).toBe("nbg1");
    expect(forecast.expected.generationBillableHours).toEqual([5]);
    expect(forecast.expected.totalGrossMicros).toBe(1_375_000);
    expect(forecast.leaseCeiling.location).toBe("fsn1");
    expect(forecast.leaseCeiling.totalGrossMicros).toBe(1_625_000);
    expect(forecast.oneRestore.generationBillableHours).toEqual([5, 1]);
    expect(forecast.oneRestore.totalGrossMicros).toBe(1_950_000);
    expect(forecast.expiresAt).toBe(observedAt + 24 * 60 * 60 * 1_000);
  });

  it("counts no workspace for helpers and facilitators by accepting only the supplied participant count", () => {
    const forecast = calculateWorkshopCostForecast({
      participantCount: 0,
      provisioningStartsAt: observedAt,
      scheduledEndsAt: observedAt,
      leaseGraceMinutes: 0,
      approvedLocations: ["nbg1"],
      prices: prices(),
    });
    expect(forecast.expected.totalGrossMicros).toBe(0);
    expect(forecast.expected.billableHours).toBe(1);
  });
});

describe("live and final ledger estimates", () => {
  it("rounds replacement generations independently", () => {
    const first = estimateLedgerResource({
      createdAt: observedAt,
      deletionConfirmedAt: observedAt + 61 * 60 * 1_000,
      now: observedAt + 4 * 60 * 60 * 1_000,
      hourlyNetMicros: 100_000,
      hourlyGrossMicros: 125_000,
    });
    const replacement = estimateLedgerResource({
      createdAt: observedAt + 61 * 60 * 1_000,
      deletionConfirmedAt: observedAt + 62 * 60 * 1_000,
      now: observedAt + 4 * 60 * 60 * 1_000,
      hourlyNetMicros: 100_000,
      hourlyGrossMicros: 125_000,
    });
    expect(first.billableHours).toBe(2);
    expect(replacement.billableHours).toBe(1);
    expect(first.grossMicros + replacement.grossMicros).toBe(375_000);
  });

  it("keeps cleanup-pending resources accumulating", () => {
    const estimate = estimateLedgerResource({
      createdAt: observedAt,
      deletionConfirmedAt: null,
      now: observedAt + 2 * 60 * 60 * 1_000 + 1,
      hourlyNetMicros: 100_000,
      hourlyGrossMicros: 125_000,
    });
    expect(estimate.accumulating).toBe(true);
    expect(estimate.billableHours).toBe(3);
  });
});
