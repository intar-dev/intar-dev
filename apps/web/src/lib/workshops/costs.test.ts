import { describe, expect, it } from "vitest";
import {
  CURRENCY_NANOS,
  billableDurationSeconds,
  calculateBilledQuantityNanos,
  calculateLineItemCostNanos,
  calculateWorkshopCostForecast,
  decimalCurrencyToNanos,
  estimateLedgerLineItem,
  providerObservationToJson,
  type ProviderCostLineItemInput,
} from "./costs";

const observedAt = Date.UTC(2026, 6, 22, 8);

function line(
  overrides: Partial<ProviderCostLineItemInput> = {},
): ProviderCostLineItemInput {
  return {
    sku: "server",
    resourceKind: "instance",
    location: "nbg1",
    currency: "NOK",
    rawPrice: "0.125",
    priceNanos: 125_000_000,
    unit: "hour",
    quantityNanos: CURRENCY_NANOS,
    billingIncrementSeconds: 3_600,
    minimumDurationSeconds: 3_600,
    capPriceNanos: null,
    taxTreatment: "provider_gross",
    ...overrides,
  };
}

describe("generic integer-nanos price arithmetic", () => {
  it("normalizes provider decimals without floating point", () => {
    expect(decimalCurrencyToNanos("12.345678901")).toBe(12_345_678_901);
    expect(decimalCurrencyToNanos("0.1")).toBe(100_000_000);
    expect(() => decimalCurrencyToNanos("1.0000000001")).toThrow("precision");
  });

  it("applies arbitrary minima, increments, quantity, and caps", () => {
    expect(
      billableDurationSeconds({
        lifetimeSeconds: 1,
        minimumDurationSeconds: 60,
        billingIncrementSeconds: 1,
      }),
    ).toBe(60);
    expect(calculateLineItemCostNanos(line(), 1)).toBe(125_000_000);
    expect(
      calculateLineItemCostNanos(
        line({ quantityNanos: 2 * CURRENCY_NANOS }),
        3_601,
      ),
    ).toBe(500_000_000);
    expect(
      calculateLineItemCostNanos(line({ capPriceNanos: 150_000_000 }), 7_200),
    ).toBe(150_000_000);
  });

  it("makes bigint provider observations safe for a D1 JSON round-trip", () => {
    const safe = providerObservationToJson({
      lines: [{ unitPriceNanos: 123_456_789n, nested: [2n] }],
    });
    expect(JSON.parse(JSON.stringify(safe))).toEqual({
      lines: [{ unitPriceNanos: "123456789", nested: ["2"] }],
    });
  });
});

describe("Hetzner forecast", () => {
  it("preserves net/gross and rounds a replacement generation independently", () => {
    const lines = [
      line({ taxTreatment: "provider_gross" }),
      line({
        taxTreatment: "provider_net",
        rawPrice: "0.1",
        priceNanos: 100_000_000,
      }),
      line({
        sku: "ipv4",
        resourceKind: "ipv4",
        taxTreatment: "provider_gross",
        rawPrice: "0.0125",
        priceNanos: 12_500_000,
      }),
      line({
        sku: "ipv4-net",
        resourceKind: "ipv4",
        taxTreatment: "provider_net",
        rawPrice: "0.01",
        priceNanos: 10_000_000,
      }),
    ];
    const forecast = calculateWorkshopCostForecast({
      providerKind: "hetzner_cloud",
      participantCount: 2,
      provisioningStartsAt: observedAt,
      scheduledEndsAt: observedAt + 4 * 60 * 60 * 1_000,
      leaseGraceMinutes: 60,
      approvedLocations: ["nbg1"],
      availableLocations: ["nbg1"],
      currency: "NOK",
      lineItems: lines,
      observedAt,
      expiresAt: observedAt + 48 * 60 * 60 * 1_000,
    });
    expect(forecast.expected.providerGrossCostNanos).toBe(687_500_000);
    expect(forecast.expected.totalCostNanos).toBe(1_375_000_000);
    expect(forecast.oneRestore.generationLifetimeSeconds).toEqual([
      18_000,
      3_600,
    ]);
    expect(forecast.oneRestore.providerGrossCostNanos).toBe(825_000_000);
    const serverGross = forecast.oneRestore.lineItems.find(
      (item) => item.sku === "server" && item.taxTreatment === "provider_gross",
    );
    expect(serverGross?.generationBillableDurationSeconds).toEqual([18_000, 3_600]);
    expect(serverGross?.billedQuantityNanos).toBe(6 * CURRENCY_NANOS);
  });
});

describe("GCP forecast and ledger", () => {
  it("uses a 60-second compute minimum and one-second increments", () => {
    const compute = line({
      sku: "gcp-core",
      location: "europe-west3-a",
      currency: "USD",
      rawPrice: "0.036",
      priceNanos: 36_000_000,
      billingIncrementSeconds: 1,
      minimumDurationSeconds: 60,
      taxTreatment: "tax_excluded_public_list",
    });
    expect(calculateLineItemCostNanos(compute, 1)).toBe(600_000);
    expect(calculateLineItemCostNanos(compute, 61)).toBe(610_000);
    // The SKU is priced per hour, so billed quantity is represented as a
    // fractional hour in nanos after the 60-second minimum is applied.
    expect(calculateBilledQuantityNanos(compute, 1)).toBe(16_666_667);
    expect(calculateBilledQuantityNanos(compute, 61)).toBe(16_944_445);
  });

  it("applies catalog disk and IP policies as independent lines", () => {
    const disk = line({
      sku: "pd-balanced",
      resourceKind: "boot_disk",
      location: "europe-west3-a",
      currency: "USD",
      rawPrice: "0.1",
      priceNanos: 100_000_000,
      unit: "gib_month",
      quantityNanos: 32 * CURRENCY_NANOS,
      billingIncrementSeconds: 1,
      minimumDurationSeconds: 0,
      taxTreatment: "tax_excluded_public_list",
    });
    const estimate = estimateLedgerLineItem({
      lineItem: disk,
      createdAt: observedAt,
      deletionConfirmedAt: observedAt + 3_600_000,
      now: observedAt + 7_200_000,
    });
    expect(estimate.accumulating).toBe(false);
    expect(estimate.costNanos).toBe(4_383_562);
  });
});
