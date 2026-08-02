import { appError } from "@/lib/app-error";

export const CURRENCY_NANOS = 1_000_000_000;
export const FORECAST_TTL_MS = 24 * 60 * 60 * 1_000;
export const GCP_CATALOG_MONTH_SECONDS = 730 * 60 * 60;

export type CostTaxTreatment =
  | "provider_net"
  | "provider_gross"
  | "tax_excluded_public_list";

export interface ProviderCostLineItemInput {
  id?: string;
  sku: string;
  resourceKind: string;
  location: string;
  currency: string;
  rawPrice: string;
  priceNanos: number;
  unit: "second" | "hour" | "gib_second" | "gib_hour" | "gib_month";
  quantityNanos: number;
  billingIncrementSeconds: number;
  minimumDurationSeconds: number;
  capPriceNanos: number | null;
  taxTreatment: CostTaxTreatment;
}

export interface CostLineCalculation {
  sku: string;
  resourceKind: string;
  taxTreatment: CostTaxTreatment;
  generationBillableDurationSeconds: number[];
  /** Per-learner billed units across independently rounded generations. */
  billedQuantityNanos: number;
  generationCostsNanos: number[];
  totalCostNanos: number;
}

export interface WorkshopCostScenario {
  location: string;
  participantCount: number;
  generationLifetimeSeconds: number[];
  perLearnerCostNanos: number;
  totalCostNanos: number;
  providerNetCostNanos: number | null;
  providerGrossCostNanos: number | null;
  taxExcludedListCostNanos: number | null;
  lineItems: CostLineCalculation[];
}

export interface WorkshopCostForecastCalculation {
  currency: string;
  participantCount: number;
  preferredLocation: string;
  expected: WorkshopCostScenario;
  leaseCeiling: WorkshopCostScenario;
  oneRestore: WorkshopCostScenario;
  assumptions: string[];
  exclusions: string[];
  observedAt: number;
  expiresAt: number;
}

export interface CalculateWorkshopForecastInput {
  providerKind: "agent_kvm" | "hetzner_cloud" | "gcp_compute";
  participantCount: number;
  provisioningStartsAt: number;
  scheduledEndsAt: number;
  leaseGraceMinutes: number;
  approvedLocations: readonly string[];
  availableLocations: readonly string[];
  currency: string;
  lineItems: readonly ProviderCostLineItemInput[];
  observedAt: number;
  expiresAt: number;
  teardownBufferMinutes?: number;
}

export function decimalCurrencyToNanos(raw: string): number {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(raw.trim());
  if (!match) throw invalidProviderPrice();
  const fraction = match[2] ?? "";
  if (fraction.length > 9 && /[1-9]/u.test(fraction.slice(9))) {
    throw appError(
      502,
      "provider_price_precision_unsupported",
      "provider price precision exceeds currency nanos",
    );
  }
  return safeBigintToNumber(
    BigInt(match[1]!) * BigInt(CURRENCY_NANOS) +
      BigInt((fraction.slice(0, 9) + "000000000").slice(0, 9)),
  );
}

/** Convert an RPC/catalog payload into a value that D1 JSON can serialize. */
export function providerObservationToJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(providerObservationToJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      providerObservationToJson(entry),
    ]),
  );
}

export function billableDurationSeconds(input: {
  lifetimeSeconds: number;
  minimumDurationSeconds: number;
  billingIncrementSeconds: number;
}): number {
  const lifetime = nonNegativeInteger(input.lifetimeSeconds, "lifetimeSeconds");
  const minimum = nonNegativeInteger(
    input.minimumDurationSeconds,
    "minimumDurationSeconds",
  );
  const increment = positiveInteger(
    input.billingIncrementSeconds,
    "billingIncrementSeconds",
  );
  const rounded = Math.ceil(Math.max(lifetime, minimum) / increment) * increment;
  if (!Number.isSafeInteger(rounded)) throw costTooLarge();
  return rounded;
}

/** Calculate one independently billed resource generation using integer nanos. */
export function calculateLineItemCostNanos(
  lineItem: ProviderCostLineItemInput,
  lifetimeSeconds: number,
): number {
  validateLineItem(lineItem);
  const seconds = billableDurationSeconds({
    lifetimeSeconds,
    minimumDurationSeconds: lineItem.minimumDurationSeconds,
    billingIncrementSeconds: lineItem.billingIncrementSeconds,
  });
  const unitSeconds = costUnitSeconds(lineItem.unit);
  const numerator =
    BigInt(lineItem.priceNanos) *
    BigInt(lineItem.quantityNanos) *
    BigInt(seconds);
  const denominator = BigInt(CURRENCY_NANOS) * BigInt(unitSeconds);
  const uncapped = ceilDiv(numerator, denominator);
  const capped =
    lineItem.capPriceNanos === null
      ? uncapped
      : uncapped < BigInt(lineItem.capPriceNanos)
        ? uncapped
        : BigInt(lineItem.capPriceNanos);
  return safeBigintToNumber(capped);
}

/** Billed resource units, scaled to nanos, after the provider duration policy. */
export function calculateBilledQuantityNanos(
  lineItem: ProviderCostLineItemInput,
  lifetimeSeconds: number,
): number {
  validateLineItem(lineItem);
  const seconds = billableDurationSeconds({
    lifetimeSeconds,
    minimumDurationSeconds: lineItem.minimumDurationSeconds,
    billingIncrementSeconds: lineItem.billingIncrementSeconds,
  });
  return safeBigintToNumber(
    ceilDiv(
      BigInt(lineItem.quantityNanos) * BigInt(seconds),
      BigInt(costUnitSeconds(lineItem.unit)),
    ),
  );
}

export function calculateWorkshopCostForecast(
  input: CalculateWorkshopForecastInput,
): WorkshopCostForecastCalculation {
  const participantCount = nonNegativeInteger(
    input.participantCount,
    "participantCount",
  );
  const provisioningStartsAt = timestamp(
    input.provisioningStartsAt,
    "provisioningStartsAt",
  );
  const scheduledEndsAt = timestamp(input.scheduledEndsAt, "scheduledEndsAt");
  if (scheduledEndsAt < provisioningStartsAt) {
    throw appError(
      400,
      "workshop_cost_window_invalid",
      "scheduled workshop end must not precede provisioning",
    );
  }
  const leaseGraceMinutes = nonNegativeInteger(
    input.leaseGraceMinutes,
    "leaseGraceMinutes",
  );
  const teardownBufferMinutes = nonNegativeInteger(
    input.teardownBufferMinutes ?? 10,
    "teardownBufferMinutes",
  );
  const observedAt = timestamp(input.observedAt, "observedAt");
  const providerExpiresAt = timestamp(input.expiresAt, "expiresAt");
  if (providerExpiresAt <= observedAt) throw invalidProviderPrice();
  const currency = normalizeCurrency(input.currency);
  const approved = uniqueLocations(input.approvedLocations);
  const available = new Set(uniqueLocations(input.availableLocations));
  const preferredLocation = approved.find((location) => available.has(location));
  if (!preferredLocation) {
    throw appError(
      409,
      "provider_profile_unavailable",
      "the pinned runtime profile is unavailable in every approved location",
    );
  }
  const lineItems = input.lineItems.map((line) => normalizeLine(line, currency));
  const expectedSeconds = secondsBetween(
    provisioningStartsAt,
    scheduledEndsAt + teardownBufferMinutes * 60_000,
  );
  const ceilingSeconds = secondsBetween(
    provisioningStartsAt,
    scheduledEndsAt + leaseGraceMinutes * 60_000,
  );
  const expected = scenario(
    preferredLocation,
    [expectedSeconds],
    participantCount,
    lineItems,
  );
  const ceilingCandidates = approved.map((location) =>
    scenario(location, [ceilingSeconds], participantCount, lineItems),
  );
  const leaseCeiling = ceilingCandidates.reduce((highest, candidate) =>
    candidate.totalCostNanos > highest.totalCostNanos ? candidate : highest,
  );
  const oneRestore = scenario(
    leaseCeiling.location,
    [ceilingSeconds, 60 * 60],
    participantCount,
    lineItems,
  );
  return {
    currency,
    participantCount,
    preferredLocation,
    expected,
    leaseCeiling,
    oneRestore,
    assumptions: assumptions(input.providerKind),
    exclusions:
      input.providerKind === "agent_kvm"
        ? []
        : [
            "Network traffic and egress",
            "Credits, discounts, negotiated pricing, and promotional balances",
            "Invoice adjustments and provider-side price changes after observation",
          ],
    observedAt,
    expiresAt: Math.min(providerExpiresAt, observedAt + FORECAST_TTL_MS),
  };
}

export function estimateLedgerLineItem(input: {
  lineItem: ProviderCostLineItemInput;
  createdAt: number;
  deletionConfirmedAt?: number | null;
  now: number;
}): {
  lifetimeSeconds: number;
  billableDurationSeconds: number;
  costNanos: number;
  accumulating: boolean;
} {
  const createdAt = timestamp(input.createdAt, "createdAt");
  const endAt = timestamp(
    input.deletionConfirmedAt ?? input.now,
    input.deletionConfirmedAt == null ? "now" : "deletionConfirmedAt",
  );
  if (endAt < createdAt) {
    throw appError(
      400,
      "provider_ledger_lifetime_invalid",
      "provider resource deletion cannot precede creation",
    );
  }
  const lifetimeSeconds = secondsBetween(createdAt, endAt);
  return {
    lifetimeSeconds,
    billableDurationSeconds: billableDurationSeconds({
      lifetimeSeconds,
      minimumDurationSeconds: input.lineItem.minimumDurationSeconds,
      billingIncrementSeconds: input.lineItem.billingIncrementSeconds,
    }),
    costNanos: calculateLineItemCostNanos(input.lineItem, lifetimeSeconds),
    accumulating: input.deletionConfirmedAt == null,
  };
}

function scenario(
  location: string,
  generationLifetimeSeconds: number[],
  participantCount: number,
  allLineItems: readonly ProviderCostLineItemInput[],
): WorkshopCostScenario {
  const applicable = allLineItems.filter((line) => line.location === location);
  const lineItems = applicable.map((line): CostLineCalculation => {
    const generationBillableDurationSeconds = generationLifetimeSeconds.map(
      (seconds) =>
        billableDurationSeconds({
          lifetimeSeconds: seconds,
          minimumDurationSeconds: line.minimumDurationSeconds,
          billingIncrementSeconds: line.billingIncrementSeconds,
        }),
    );
    const billedQuantityNanos = safeSum(
      generationLifetimeSeconds.map((seconds) =>
        calculateBilledQuantityNanos(line, seconds),
      ),
    );
    const generationCostsNanos = generationLifetimeSeconds.map((seconds) =>
      calculateLineItemCostNanos(line, seconds),
    );
    return {
      sku: line.sku,
      resourceKind: line.resourceKind,
      taxTreatment: line.taxTreatment,
      generationBillableDurationSeconds,
      billedQuantityNanos,
      generationCostsNanos,
      totalCostNanos: safeSum(generationCostsNanos),
    };
  });
  const net = treatmentTotal(lineItems, "provider_net");
  const gross = treatmentTotal(lineItems, "provider_gross");
  const publicList = treatmentTotal(lineItems, "tax_excluded_public_list");
  const perLearnerCostNanos = gross ?? publicList ?? net ?? 0;
  return {
    location,
    participantCount,
    generationLifetimeSeconds,
    perLearnerCostNanos,
    totalCostNanos: safeMultiply(perLearnerCostNanos, participantCount),
    providerNetCostNanos: net,
    providerGrossCostNanos: gross,
    taxExcludedListCostNanos: publicList,
    lineItems,
  };
}

function treatmentTotal(
  lines: readonly CostLineCalculation[],
  treatment: CostTaxTreatment,
): number | null {
  const selected = lines
    .filter((line) => line.taxTreatment === treatment)
    .map((line) => line.totalCostNanos);
  return selected.length === 0 ? null : safeSum(selected);
}

function normalizeLine(
  line: ProviderCostLineItemInput,
  currency: string,
): ProviderCostLineItemInput {
  validateLineItem(line);
  if (normalizeCurrency(line.currency) !== currency) {
    throw appError(
      502,
      "provider_price_currency_mismatch",
      "provider quote contains mixed currencies",
    );
  }
  return { ...line, location: locationName(line.location), currency };
}

function validateLineItem(line: ProviderCostLineItemInput): void {
  if (
    !line.sku ||
    !line.resourceKind ||
    !Number.isSafeInteger(line.priceNanos) ||
    line.priceNanos < 0 ||
    !Number.isSafeInteger(line.quantityNanos) ||
    line.quantityNanos <= 0 ||
    !Number.isSafeInteger(line.billingIncrementSeconds) ||
    line.billingIncrementSeconds <= 0 ||
    !Number.isSafeInteger(line.minimumDurationSeconds) ||
    line.minimumDurationSeconds < 0 ||
    (line.capPriceNanos !== null &&
      (!Number.isSafeInteger(line.capPriceNanos) || line.capPriceNanos < 0))
  ) {
    throw invalidProviderPrice();
  }
}

function costUnitSeconds(unit: ProviderCostLineItemInput["unit"]): number {
  switch (unit) {
    case "second":
    case "gib_second":
      return 1;
    case "hour":
    case "gib_hour":
      return 60 * 60;
    case "gib_month":
      return GCP_CATALOG_MONTH_SECONDS;
  }
}

function assumptions(
  providerKind: CalculateWorkshopForecastInput["providerKind"],
): string[] {
  if (providerKind === "agent_kvm") {
    return ["Organization-runner capacity is reserved but has no cloud list-price forecast."];
  }
  if (providerKind === "hetzner_cloud") {
    return [
      "Hetzner server and Primary IPv4 generations are billed independently with a one-hour minimum.",
      "Provider-reported net and gross prices and monthly caps are preserved without calculating tax.",
      "Stopped servers remain billable until deletion is confirmed.",
      "One-restore contingency adds a separate 60-minute replacement generation.",
    ];
  }
  return [
    "GCP Compute resources use the catalog billing increment and a 60-second minimum for compute.",
    "Persistent disk and external IPv4 use their catalog units and policies.",
    "Prices are estimated public USD list prices; tax is excluded.",
    "One-restore contingency adds a separate 60-minute replacement generation.",
  ];
}

function secondsBetween(startAt: number, endAt: number): number {
  return Math.max(0, Math.ceil((endAt - startAt) / 1000));
}

function timestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(400, "provider_timestamp_invalid", `${name} is invalid`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw appError(400, "provider_cost_input_invalid", `${name} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(400, "provider_cost_input_invalid", `${name} is invalid`);
  }
  return value;
}

function uniqueLocations(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const location = locationName(value);
    if (!seen.has(location)) {
      seen.add(location);
      result.push(location);
    }
  }
  if (result.length === 0) {
    throw appError(400, "provider_locations_invalid", "locations are required");
  }
  return result;
}

function locationName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalized)) {
    throw appError(400, "provider_location_invalid", "provider location is invalid");
  }
  return normalized;
}

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) throw invalidProviderPrice();
  return currency;
}

function safeSum(values: readonly number[]): number {
  return safeBigintToNumber(values.reduce((sum, value) => sum + BigInt(value), 0n));
}

function safeMultiply(left: number, right: number): number {
  return safeBigintToNumber(BigInt(left) * BigInt(right));
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function safeBigintToNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw costTooLarge();
  return Number(value);
}

function invalidProviderPrice() {
  return appError(502, "provider_price_invalid", "provider returned an invalid price");
}

function costTooLarge() {
  return appError(400, "provider_cost_too_large", "provider cost exceeds the supported range");
}
