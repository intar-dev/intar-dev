import { describe, expect, it } from "vitest";
import { GcpCatalogClient } from "../src/catalog";

const EXTERNAL_IPV4_SKU_ID = "C054-7F72-A02E";
const E2_CORE_SKU_ID = "C921-088E-792A";
const E2_RAM_SKU_ID = "7D80-F9E4-6A44";
const PD_BALANCED_SKU_ID = "B1B5-0BAA-CB31";

function sku(
  skuId: string,
  description: string,
  resourceGroup: string,
  usageUnit: string,
  nanos: number,
  location: {
    serviceRegions?: string[];
    geoTaxonomy?: { type: string; regions?: string[] };
    usageType?: string;
  } = {},
) {
  return {
    skuId,
    description,
    category: {
      resourceFamily: "Compute",
      resourceGroup,
      usageType: location.usageType ?? "OnDemand",
    },
    serviceRegions: location.serviceRegions ?? ["europe-west3"],
    ...(location.geoTaxonomy === undefined ? {} : { geoTaxonomy: location.geoTaxonomy }),
    pricingInfo: [{
      pricingExpression: {
        usageUnit,
        tieredRates: [{ startUsageAmount: 0, unitPrice: { currencyCode: "USD", units: "0", nanos } }],
      },
    }],
  };
}

function externalIpv4Sku(usageUnit = "h") {
  return sku(
    EXTERNAL_IPV4_SKU_ID,
    "External IP Charge on a Standard VM",
    "IP",
    usageUnit,
    5_000_000,
    { serviceRegions: [], geoTaxonomy: { type: "GLOBAL", regions: [] } },
  );
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
            sku(E2_CORE_SKU_ID, "E2 Instance Core running in Frankfurt", "CPU", "h", 20_000_000),
            sku(E2_RAM_SKU_ID, "E2 Instance Ram running in Frankfurt", "RAM", "GiBy.h", 3_000_000),
          ],
          nextPageToken: "next",
        });
      }
      return Response.json({ skus: [
        sku(PD_BALANCED_SKU_ID, "Balanced PD Capacity in Frankfurt", "PdBalanced", "GiBy.mo", 100_000),
        externalIpv4Sku(),
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
    expect(lines[3]).toMatchObject({
      sku: EXTERNAL_IPV4_SKU_ID,
      minimumDurationSeconds: 1,
      billingGranularitySeconds: 1,
    });
    expect(lines.some((line) => line.rawUnitPrice.includes(apiKey))).toBe(false);
  });

  it("selects the pinned on-demand SKUs instead of cheaper Spot SKUs", async () => {
    const skus = [
      sku(
        "spot-core",
        "Spot Preemptible E2 Instance Core running in Frankfurt",
        "CPU",
        "h",
        1,
        { usageType: "Preemptible" },
      ),
      sku(
        "spot-ram",
        "Spot Preemptible E2 Instance Ram running in Frankfurt",
        "RAM",
        "GiBy.h",
        1,
        { usageType: "Preemptible" },
      ),
      sku(E2_CORE_SKU_ID, "E2 Instance Core running in Frankfurt", "CPU", "h", 20_000_000),
      sku(E2_RAM_SKU_ID, "E2 Instance Ram running in Frankfurt", "RAM", "GiBy.h", 3_000_000),
      sku(PD_BALANCED_SKU_ID, "Balanced PD Capacity in Frankfurt", "PdBalanced", "GiBy.mo", 100_000),
      externalIpv4Sku(),
    ];
    const lines = await new GcpCatalogClient(
      "catalog-key-01234567890123456789",
      { fetcher: (async () => Response.json({ skus })) as typeof fetch },
    ).quoteE2Standard4(["europe-west3-a"], 32);

    expect(lines.map((line) => line.sku)).toEqual([
      E2_CORE_SKU_ID,
      E2_RAM_SKU_ID,
      PD_BALANCED_SKU_ID,
      EXTERNAL_IPV4_SKU_ID,
    ]);
  });

  it("rejects a pinned Workshop SKU that is not on-demand", async () => {
    const skus = [
      sku(
        E2_CORE_SKU_ID,
        "Spot Preemptible E2 Instance Core running in Frankfurt",
        "CPU",
        "h",
        1,
        { usageType: "Preemptible" },
      ),
      sku(E2_RAM_SKU_ID, "E2 Instance Ram running in Frankfurt", "RAM", "GiBy.h", 3_000_000),
      sku(PD_BALANCED_SKU_ID, "Balanced PD Capacity in Frankfurt", "PdBalanced", "GiBy.mo", 100_000),
      externalIpv4Sku(),
    ];
    const client = new GcpCatalogClient(
      "catalog-key-01234567890123456789",
      { fetcher: (async () => Response.json({ skus })) as typeof fetch },
    );

    await expect(client.quoteE2Standard4(["europe-west3-a"], 32))
      .rejects.toMatchObject({ shape: { code: "gcp_catalog_invalid" } });
  });

  it("rejects a duplicate pinned Workshop SKU", async () => {
    const core = sku(
      E2_CORE_SKU_ID,
      "E2 Instance Core running in Frankfurt",
      "CPU",
      "h",
      20_000_000,
    );
    const client = new GcpCatalogClient(
      "catalog-key-01234567890123456789",
      { fetcher: (async () => Response.json({ skus: [core, core] })) as typeof fetch },
    );

    await expect(client.quoteE2Standard4(["europe-west3-a"], 32))
      .rejects.toMatchObject({ shape: { code: "gcp_catalog_invalid" } });
  });

  it("rejects a wrong usage unit for each required SKU", async () => {
    const targets = [
      [E2_CORE_SKU_ID, "E2 Instance Core running in Frankfurt", "CPU", "GiBy.h"],
      [E2_RAM_SKU_ID, "E2 Instance Ram running in Frankfurt", "RAM", "h"],
      [PD_BALANCED_SKU_ID, "Balanced PD Capacity in Frankfurt", "PdBalanced", "h"],
      [EXTERNAL_IPV4_SKU_ID, "External IP Charge on a Standard VM", "IP", "GiBy.mo"],
    ] as const;
    for (let wrongIndex = 0; wrongIndex < targets.length; wrongIndex += 1) {
      const skus = [
        sku(E2_CORE_SKU_ID, "E2 Instance Core running in Frankfurt", "CPU", "h", 20_000_000),
        sku(E2_RAM_SKU_ID, "E2 Instance Ram running in Frankfurt", "RAM", "GiBy.h", 3_000_000),
        sku(PD_BALANCED_SKU_ID, "Balanced PD Capacity in Frankfurt", "PdBalanced", "GiBy.mo", 100_000),
        externalIpv4Sku(),
      ];
      const [skuId, description, resourceGroup, wrongUnit] = targets[wrongIndex]!;
      skus[wrongIndex] = wrongIndex === 3
        ? externalIpv4Sku(wrongUnit)
        : sku(skuId, description, resourceGroup, wrongUnit, 1);
      const client = new GcpCatalogClient(
        "catalog-key-01234567890123456789",
        { fetcher: (async () => Response.json({ skus })) as typeof fetch },
      );

      await expect(client.quoteE2Standard4(["europe-west3-a"], 32))
        .rejects.toMatchObject({ shape: { code: "gcp_catalog_invalid" } });
    }
  });

  it("rejects a negative unit price", async () => {
    const skus = [
      sku(E2_CORE_SKU_ID, "E2 Instance Core running in Frankfurt", "CPU", "h", -1),
      sku(E2_RAM_SKU_ID, "E2 Instance Ram running in Frankfurt", "RAM", "GiBy.h", 3_000_000),
      sku(PD_BALANCED_SKU_ID, "Balanced PD Capacity in Frankfurt", "PdBalanced", "GiBy.mo", 100_000),
      externalIpv4Sku(),
    ];
    const client = new GcpCatalogClient(
      "catalog-key-01234567890123456789",
      { fetcher: (async () => Response.json({ skus })) as typeof fetch },
    );

    await expect(client.quoteE2Standard4(["europe-west3-a"], 32))
      .rejects.toMatchObject({ shape: { code: "gcp_catalog_invalid" } });
  });

  it("rejects a non-global taxonomy for the exact external IPv4 SKU", async () => {
    const skus = [
      sku(E2_CORE_SKU_ID, "E2 Instance Core running in Frankfurt", "CPU", "h", 20_000_000),
      sku(E2_RAM_SKU_ID, "E2 Instance Ram running in Frankfurt", "RAM", "GiBy.h", 3_000_000),
      sku(PD_BALANCED_SKU_ID, "Balanced PD Capacity in Frankfurt", "PdBalanced", "GiBy.mo", 100_000),
      sku(
        EXTERNAL_IPV4_SKU_ID,
        "External IP Charge on a Standard VM",
        "IP",
        "h",
        5_000_000,
        { serviceRegions: [], geoTaxonomy: { type: "REGIONAL", regions: ["europe-west3"] } },
      ),
    ];
    const client = new GcpCatalogClient(
      "catalog-key-01234567890123456789",
      { fetcher: (async () => Response.json({ skus })) as typeof fetch },
    );

    await expect(client.quoteE2Standard4(["europe-west3-a"], 32))
      .rejects.toMatchObject({ shape: { code: "gcp_catalog_invalid" } });
  });

  it("does not substitute another external IPv4 SKU", async () => {
    const skus = [
      sku(E2_CORE_SKU_ID, "E2 Instance Core running in Frankfurt", "CPU", "h", 20_000_000),
      sku(E2_RAM_SKU_ID, "E2 Instance Ram running in Frankfurt", "RAM", "GiBy.h", 3_000_000),
      sku(PD_BALANCED_SKU_ID, "Balanced PD Capacity in Frankfurt", "PdBalanced", "GiBy.mo", 100_000),
      sku("wrong-ip", "External IP Charge on a Standard VM", "IP", "h", 5_000_000),
    ];
    const client = new GcpCatalogClient(
      "catalog-key-01234567890123456789",
      { fetcher: (async () => Response.json({ skus })) as typeof fetch },
    );

    await expect(client.quoteE2Standard4(["europe-west3-a"], 32))
      .rejects.toMatchObject({ shape: { code: "gcp_catalog_sku_missing" } });
  });
});
