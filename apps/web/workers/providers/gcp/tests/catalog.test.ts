import { describe, expect, it } from "vitest";
import { GcpCatalogClient } from "../src/catalog";

function sku(
  skuId: string,
  description: string,
  resourceGroup: string,
  nanos: number,
) {
  return {
    skuId,
    description,
    category: { resourceFamily: "Compute", resourceGroup, usageType: "OnDemand" },
    serviceRegions: ["europe-west3"],
    pricingInfo: [{
      pricingExpression: {
        usageUnit: "h",
        tieredRates: [{ startUsageAmount: 0, unitPrice: { currencyCode: "USD", units: "0", nanos } }],
      },
    }],
  };
}

describe("GCP public catalog", () => {
  it("paginates and returns compute, disk, and ephemeral IPv4 line items", async () => {
    const urls: URL[] = [];
    const apiKeyHeaders: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      apiKeyHeaders.push(request.headers.get("x-goog-api-key") ?? "");
      if (!url.searchParams.has("pageToken")) {
        return Response.json({
          skus: [
            sku("core", "E2 Instance Core running in EMEA", "CPU", 20_000_000),
            sku("ram", "E2 Instance Ram running in EMEA", "RAM", 3_000_000),
          ],
          nextPageToken: "next",
        });
      }
      return Response.json({ skus: [
        sku("disk", "Balanced PD Capacity", "PdBalanced", 100_000),
        sku("ip", "External IP Charge on a Standard VM", "IP", 5_000_000),
      ] });
    }) as typeof fetch;
    const apiKey = "catalog-key-01234567890123456789";
    const lines = await new GcpCatalogClient(apiKey, {
      fetcher,
      now: () => new Date("2026-08-01T10:00:00.000Z"),
    }).quoteE2Standard4(["europe-west3-a"], 32);
    expect(urls).toHaveLength(2);
    expect(urls[0]!.searchParams.has("key")).toBe(false);
    expect(urls[0]!.toString()).not.toContain(apiKey);
    expect(apiKeyHeaders).toEqual([apiKey, apiKey]);
    expect(lines.map((line) => line.resourceKind)).toEqual([
      "compute_core", "compute_ram", "pd_balanced", "external_ipv4",
    ]);
    expect(lines[0]).toMatchObject({ quantity: 4, minimumDurationSeconds: 60, billingGranularitySeconds: 1 });
    expect(lines[1]).toMatchObject({ quantity: 16, minimumDurationSeconds: 60, billingGranularitySeconds: 1 });
    expect(lines[2]).toMatchObject({ quantity: 32, unit: "gib_month", taxTreatment: "tax_excluded_public_list" });
    expect(lines[2]).toMatchObject({ minimumDurationSeconds: 1, billingGranularitySeconds: 1 });
    expect(lines[3]).toMatchObject({ minimumDurationSeconds: 1, billingGranularitySeconds: 1 });
    expect(lines.some((line) => line.rawUnitPrice.includes(apiKey))).toBe(false);
  });
});
