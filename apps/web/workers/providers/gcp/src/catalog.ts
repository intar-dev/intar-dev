import type { ProviderPriceLineItem } from "@intar/workshop-contracts";
import { ProviderServiceError } from "@intar/provider-worker-core";

const COMPUTE_SERVICE_ID = "6F81-5844-456A";
const FRANKFURT_ON_DEMAND_E2_CORE_SKU_ID = "C921-088E-792A";
const FRANKFURT_ON_DEMAND_E2_RAM_SKU_ID = "7D80-F9E4-6A44";
const FRANKFURT_ON_DEMAND_PD_BALANCED_SKU_ID = "B1B5-0BAA-CB31";
const EXTERNAL_IPV4_SKU_ID = "C054-7F72-A02E";
const DEFAULT_CATALOG_BASE = "https://cloudbilling.googleapis.com/v1";

interface Money {
  currencyCode?: string;
  units?: string;
  nanos?: number;
}

interface PricingExpression {
  usageUnit?: string;
  usageUnitDescription?: string;
  baseUnit?: string;
  baseUnitConversionFactor?: number;
  tieredRates?: Array<{ startUsageAmount?: number; unitPrice?: Money }>;
}

interface Sku {
  skuId?: string;
  description?: string;
  category?: {
    resourceFamily?: string;
    resourceGroup?: string;
    usageType?: string;
  };
  serviceRegions?: string[];
  geoTaxonomy?: {
    type?: string;
    regions?: string[];
  };
  pricingInfo?: Array<{
    effectiveTime?: string;
    pricingExpression?: PricingExpression;
  }>;
}

interface SkuPage {
  skus?: Sku[];
  nextPageToken?: string;
}

export interface GcpCatalogOptions {
  fetcher?: typeof fetch;
  catalogBase?: string;
  now?: () => Date;
}

export function requireGcpCatalogApiKey(apiKey: unknown): string {
  if (typeof apiKey !== "string" || !/^[A-Za-z0-9_-]{20,256}$/u.test(apiKey)) {
    throw new ProviderServiceError({
      code: "gcp_catalog_configuration_invalid",
      message: "GCP public catalog is not configured",
      retryable: false,
    });
  }
  return apiKey;
}

type PriceTarget = "compute_core" | "compute_ram" | "pd_balanced" | "external_ipv4";

const BILLING_POLICY: Record<
  PriceTarget,
  { billingGranularitySeconds: number; minimumDurationSeconds: number }
> = {
  compute_core: { billingGranularitySeconds: 1, minimumDurationSeconds: 60 },
  compute_ram: { billingGranularitySeconds: 1, minimumDurationSeconds: 60 },
  pd_balanced: { billingGranularitySeconds: 1, minimumDurationSeconds: 1 },
  external_ipv4: { billingGranularitySeconds: 1, minimumDurationSeconds: 1 },
};

const USAGE_UNITS: Record<PriceTarget, string> = {
  compute_core: "h",
  compute_ram: "GiBy.h",
  pd_balanced: "GiBy.mo",
  external_ipv4: "h",
};

function targetForSku(sku: Sku): PriceTarget | undefined {
  switch (sku.skuId) {
    case FRANKFURT_ON_DEMAND_E2_CORE_SKU_ID:
      return "compute_core";
    case FRANKFURT_ON_DEMAND_E2_RAM_SKU_ID:
      return "compute_ram";
    case FRANKFURT_ON_DEMAND_PD_BALANCED_SKU_ID:
      return "pd_balanced";
    case EXTERNAL_IPV4_SKU_ID:
      return "external_ipv4";
    default:
      return undefined;
  }
}

function isRegionalWorkshopSku(sku: Sku): boolean {
  return sku.serviceRegions?.some(
    (region) => region === "europe-west3" || region === "europe",
  ) ?? false;
}

function assertGlobalExternalIpv4Sku(sku: Sku): void {
  const taxonomy = sku.geoTaxonomy;
  if (
    taxonomy !== undefined &&
    (taxonomy.type !== "GLOBAL" || (taxonomy.regions?.length ?? 0) !== 0)
  ) {
    throw new ProviderServiceError({
      code: "gcp_catalog_invalid",
      message: "GCP catalog returned an invalid external IPv4 SKU location",
      retryable: false,
    });
  }
}

function assertOnDemandWorkshopSku(sku: Sku): void {
  if (sku.category?.usageType !== "OnDemand" || !isRegionalWorkshopSku(sku)) {
    throw new ProviderServiceError({
      code: "gcp_catalog_invalid",
      message: "GCP catalog returned an invalid Workshop SKU",
      retryable: false,
    });
  }
}

function moneyToNanos(money: Money): bigint {
  if (money.currencyCode !== "USD" || !/^-?\d+$/u.test(money.units ?? "0")) {
    throw new ProviderServiceError({
      code: "gcp_catalog_invalid",
      message: "GCP catalog returned an unsupported price",
      retryable: false,
    });
  }
  const nanos = money.nanos ?? 0;
  if (!Number.isSafeInteger(nanos) || Math.abs(nanos) >= 1_000_000_000) {
    throw new ProviderServiceError({
      code: "gcp_catalog_invalid",
      message: "GCP catalog returned an unsupported price",
      retryable: false,
    });
  }
  const value = BigInt(money.units ?? "0") * 1_000_000_000n + BigInt(nanos);
  if (value < 0n) {
    throw new ProviderServiceError({
      code: "gcp_catalog_invalid",
      message: "GCP catalog returned a negative price",
      retryable: false,
    });
  }
  return value;
}

function rawMoney(money: Money): string {
  const units = money.units ?? "0";
  const nanos = String(Math.abs(money.nanos ?? 0)).padStart(9, "0").replace(/0+$/u, "");
  return nanos.length > 0 ? `${units}.${nanos}` : units;
}

function lineItem(
  target: PriceTarget,
  sku: Sku,
  zone: string,
  quantity: number,
  observedAt: string,
): ProviderPriceLineItem {
  const expression = sku.pricingInfo?.[0]?.pricingExpression;
  const rate = expression?.tieredRates?.find((entry) => (entry.startUsageAmount ?? 0) === 0);
  const unitPrice = rate?.unitPrice;
  if (
    !sku.skuId ||
    !expression ||
    !unitPrice ||
    expression.usageUnit !== USAGE_UNITS[target]
  ) {
    throw new ProviderServiceError({
      code: "gcp_catalog_invalid",
      message: "GCP catalog returned an incomplete price",
      retryable: false,
    });
  }
  const isDisk = target === "pd_balanced";
  const billingPolicy = BILLING_POLICY[target];
  return {
    provider: "gcp_compute",
    sku: sku.skuId,
    resourceKind: target,
    location: zone,
    currency: "USD",
    rawUnitPrice: rawMoney(unitPrice),
    unitPriceNanos: moneyToNanos(unitPrice),
    unit: isDisk ? "gib_month" : "hour",
    quantity,
    billingGranularitySeconds: billingPolicy.billingGranularitySeconds,
    minimumDurationSeconds: billingPolicy.minimumDurationSeconds,
    taxTreatment: "tax_excluded_public_list",
    source: "gcp-cloud-billing-catalog-public-list",
    observedAt,
  };
}

export class GcpCatalogClient {
  readonly #apiKey: string;
  readonly #fetcher: typeof fetch;
  readonly #catalogBase: string;
  readonly #now: () => Date;

  constructor(apiKey: string | undefined, options: GcpCatalogOptions = {}) {
    this.#apiKey = requireGcpCatalogApiKey(apiKey);
    this.#fetcher = options.fetcher ?? fetch;
    this.#catalogBase = options.catalogBase ?? DEFAULT_CATALOG_BASE;
    this.#now = options.now ?? (() => new Date());
  }

  async quoteE2Standard4(
    zones: readonly string[],
    rootDiskGib: number,
  ): Promise<ProviderPriceLineItem[]> {
    if (
      zones.length === 0 ||
      zones.some((zone) => !/^europe-west3-[abc]$/u.test(zone)) ||
      !Number.isInteger(rootDiskGib) || rootDiskGib < 10 || rootDiskGib > 65_536
    ) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP quote request is invalid",
        retryable: false,
      });
    }
    const skus: Sku[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.#catalogBase}/services/${COMPUTE_SERVICE_ID}/skus`);
      url.searchParams.set("currencyCode", "USD");
      url.searchParams.set("pageSize", "5000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      let response: Response;
      try {
        response = await this.#fetcher.call(undefined, url, {
          headers: {
            accept: "application/json",
            "x-goog-api-key": this.#apiKey,
          },
        });
      } catch {
        throw new ProviderServiceError({
          code: "gcp_catalog_transport_error",
          message: "GCP public catalog transport failed",
          retryable: true,
        });
      }
      if (!response.ok) {
        throw new ProviderServiceError({
          code: "gcp_catalog_error",
          message: "GCP public catalog rejected the request",
          retryable: response.status === 429 || response.status >= 500,
          providerStatus: response.status,
        });
      }
      const page = await response.json<SkuPage>();
      skus.push(...(page.skus ?? []));
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);

    const selected = new Map<PriceTarget, Sku>();
    for (const sku of skus) {
      const target = targetForSku(sku);
      if (!target) continue;
      if (selected.has(target)) {
        throw new ProviderServiceError({
          code: "gcp_catalog_invalid",
          message: "GCP catalog returned a duplicate Workshop SKU",
          retryable: false,
        });
      }
      if (target === "external_ipv4") {
        assertGlobalExternalIpv4Sku(sku);
        selected.set(target, sku);
      } else {
        assertOnDemandWorkshopSku(sku);
        selected.set(target, sku);
      }
    }
    const missing = (["compute_core", "compute_ram", "pd_balanced", "external_ipv4"] as const)
      .filter((target) => !selected.has(target));
    if (missing.length > 0) {
      throw new ProviderServiceError({
        code: "gcp_catalog_sku_missing",
        message: "GCP public catalog is missing a required Workshop SKU",
        retryable: false,
      });
    }
    const observedAt = this.#now().toISOString();
    const zone = zones[0]!;
    return [
      lineItem("compute_core", selected.get("compute_core")!, zone, 4, observedAt),
      lineItem("compute_ram", selected.get("compute_ram")!, zone, 16, observedAt),
      lineItem("pd_balanced", selected.get("pd_balanced")!, zone, rootDiskGib, observedAt),
      lineItem("external_ipv4", selected.get("external_ipv4")!, zone, 1, observedAt),
    ];
  }
}
