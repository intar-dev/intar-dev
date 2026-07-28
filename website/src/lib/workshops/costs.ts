import type {
  ProviderPriceObservation,
  WorkshopCostScenarioJson,
} from "@/db/schema";
import { appError } from "@/lib/app-error";

export const CURRENCY_MICROS = 1_000_000;
export const FORECAST_TTL_MS = 24 * 60 * 60 * 1_000;
const HOUR_SECONDS = 3_600;

export interface NormalizedPrice {
  raw: string;
  micros: number;
}

interface LocationPrices {
  location: string;
  available: boolean;
  serverHourlyNet: NormalizedPrice;
  serverHourlyGross: NormalizedPrice;
  serverMonthlyNet: NormalizedPrice | null;
  serverMonthlyGross: NormalizedPrice | null;
  ipv4HourlyNet: NormalizedPrice;
  ipv4HourlyGross: NormalizedPrice;
  ipv4MonthlyNet: NormalizedPrice | null;
  ipv4MonthlyGross: NormalizedPrice | null;
}

export interface WorkshopCostForecastCalculation {
  currency: string;
  participantCount: number;
  preferredLocation: string;
  expected: WorkshopCostScenarioJson;
  leaseCeiling: WorkshopCostScenarioJson;
  oneRestore: WorkshopCostScenarioJson;
  assumptions: string[];
  exclusions: string[];
  observedAt: number;
  expiresAt: number;
}

export interface CalculateWorkshopForecastInput {
  participantCount: number;
  provisioningStartsAt: number;
  scheduledEndsAt: number;
  leaseGraceMinutes: number;
  approvedLocations: readonly string[];
  prices: ProviderPriceObservation;
  teardownBufferMinutes?: number;
}

export function decimalCurrencyToMicros(raw: string): number {
  const value = raw.trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match) {
    throw appError(
      502,
      "provider_price_invalid",
      "provider returned an invalid decimal price",
    );
  }
  const fraction = match[2] ?? "";
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    throw appError(
      502,
      "provider_price_precision_unsupported",
      "provider price precision exceeds currency micro-units",
    );
  }
  const micros =
    BigInt(match[1]!) * BigInt(CURRENCY_MICROS) +
    BigInt((fraction.slice(0, 6) + "000000").slice(0, 6));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw appError(
      502,
      "provider_price_too_large",
      "provider price exceeds the supported range",
    );
  }
  return Number(micros);
}

export function billableHours(lifetimeSeconds: number): number {
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 0) {
    throw appError(
      400,
      "provider_lifetime_invalid",
      "provider resource lifetime must be a non-negative whole number of seconds",
    );
  }
  return Math.max(1, Math.ceil(lifetimeSeconds / HOUR_SECONDS));
}

export function cappedResourceCost(
  hours: number,
  hourlyMicros: number,
  monthlyCapMicros: number | null,
): number {
  if (
    !Number.isSafeInteger(hours) ||
    hours < 1 ||
    !Number.isSafeInteger(hourlyMicros) ||
    hourlyMicros < 0 ||
    (monthlyCapMicros !== null &&
      (!Number.isSafeInteger(monthlyCapMicros) || monthlyCapMicros < 0))
  ) {
    throw appError(
      400,
      "provider_cost_input_invalid",
      "provider cost input is invalid",
    );
  }
  const uncapped = BigInt(hours) * BigInt(hourlyMicros);
  const capped =
    monthlyCapMicros === null
      ? uncapped
      : uncapped < BigInt(monthlyCapMicros)
        ? uncapped
        : BigInt(monthlyCapMicros);
  if (capped > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw appError(
      400,
      "provider_cost_too_large",
      "provider cost exceeds the supported range",
    );
  }
  return Number(capped);
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
  const leaseGraceMinutes = nonNegativeInteger(
    input.leaseGraceMinutes,
    "leaseGraceMinutes",
  );
  const teardownBufferMinutes = nonNegativeInteger(
    input.teardownBufferMinutes ?? 10,
    "teardownBufferMinutes",
  );
  if (scheduledEndsAt < provisioningStartsAt) {
    throw appError(
      400,
      "workshop_cost_window_invalid",
      "scheduled workshop end must not precede provisioning",
    );
  }
  if (
    !Number.isSafeInteger(input.prices.observedAt) ||
    !Number.isSafeInteger(input.prices.expiresAt) ||
    input.prices.expiresAt <= input.prices.observedAt
  ) {
    throw appError(
      502,
      "provider_price_observation_invalid",
      "provider price observation timestamps are invalid",
    );
  }
  const approved = uniqueLocations(input.approvedLocations);
  const locations = normalizeLocations(input.prices).filter((entry) =>
    approved.includes(entry.location),
  );
  const preferred = approved
    .map((location) => locations.find((entry) => entry.location === location))
    .find((entry): entry is LocationPrices => entry?.available === true);
  if (!preferred) {
    throw appError(
      409,
      "provider_server_type_unavailable",
      "the pinned server type is unavailable in every approved location",
    );
  }
  const ceilingLocation = locations.reduce<LocationPrices | null>(
    (highest, candidate) => {
      if (!highest) return candidate;
      return oneHourGross(candidate) > oneHourGross(highest)
        ? candidate
        : highest;
    },
    null,
  );
  if (!ceilingLocation) {
    throw appError(
      502,
      "provider_price_missing",
      "provider returned no price for an approved location",
    );
  }

  const expectedSeconds = secondsBetween(
    provisioningStartsAt,
    scheduledEndsAt + teardownBufferMinutes * 60_000,
  );
  const ceilingSeconds = secondsBetween(
    provisioningStartsAt,
    scheduledEndsAt + leaseGraceMinutes * 60_000,
  );
  const expected = scenario(
    preferred,
    [billableHours(expectedSeconds)],
    expectedSeconds,
    participantCount,
  );
  const leaseCeiling = scenario(
    ceilingLocation,
    [billableHours(ceilingSeconds)],
    ceilingSeconds,
    participantCount,
  );
  const oneRestore = scenario(
    ceilingLocation,
    [billableHours(ceilingSeconds), 1],
    ceilingSeconds + HOUR_SECONDS,
    participantCount,
  );

  return {
    currency: normalizedCurrency(input.prices.currency),
    participantCount,
    preferredLocation: preferred.location,
    expected,
    leaseCeiling,
    oneRestore,
    assumptions: [
      "Hetzner bills every server and Primary IPv4 generation independently with a one-hour minimum.",
      "Expected cost includes a ten-minute teardown buffer unless the session specifies another buffer.",
      "Lease ceiling uses the highest observed price across approved fallback locations.",
      "One-restore contingency adds one separately rounded hour for both server and Primary IPv4 per learner.",
      "Stopped servers remain billable until deletion is confirmed.",
    ],
    exclusions: [
      "Traffic overages",
      "Account credits and promotional balances",
      "Invoice adjustments and provider-side price changes after observation",
    ],
    observedAt: input.prices.observedAt,
    expiresAt: Math.min(
      input.prices.expiresAt,
      input.prices.observedAt + FORECAST_TTL_MS,
    ),
  };
}

export interface CostLedgerResourceInput {
  createdAt: number;
  deletionConfirmedAt?: number | null;
  now: number;
  hourlyNetMicros: number;
  hourlyGrossMicros: number;
  monthlyNetMicros?: number | null;
  monthlyGrossMicros?: number | null;
}

export function estimateLedgerResource(input: CostLedgerResourceInput): {
  lifetimeSeconds: number;
  billableHours: number;
  netMicros: number;
  grossMicros: number;
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
  const hours = billableHours(lifetimeSeconds);
  return {
    lifetimeSeconds,
    billableHours: hours,
    netMicros: cappedResourceCost(
      hours,
      input.hourlyNetMicros,
      input.monthlyNetMicros ?? null,
    ),
    grossMicros: cappedResourceCost(
      hours,
      input.hourlyGrossMicros,
      input.monthlyGrossMicros ?? null,
    ),
    accumulating: input.deletionConfirmedAt == null,
  };
}

function normalizeLocations(
  observation: ProviderPriceObservation,
): LocationPrices[] {
  const seen = new Set<string>();
  return observation.locations.map((price) => {
    const location = locationName(price.location);
    if (seen.has(location)) {
      throw appError(
        502,
        "provider_price_duplicate_location",
        "provider returned duplicate location pricing",
      );
    }
    seen.add(location);
    return {
      location,
      available: price.available,
      serverHourlyNet: normalizedPrice(price.serverHourlyNet),
      serverHourlyGross: normalizedPrice(price.serverHourlyGross),
      serverMonthlyNet: optionalPrice(price.serverMonthlyNet),
      serverMonthlyGross: optionalPrice(price.serverMonthlyGross),
      ipv4HourlyNet: normalizedPrice(price.ipv4HourlyNet),
      ipv4HourlyGross: normalizedPrice(price.ipv4HourlyGross),
      ipv4MonthlyNet: optionalPrice(price.ipv4MonthlyNet),
      ipv4MonthlyGross: optionalPrice(price.ipv4MonthlyGross),
    };
  });
}

function scenario(
  prices: LocationPrices,
  generationHours: number[],
  lifetimeSeconds: number,
  participantCount: number,
): WorkshopCostScenarioJson {
  const serverNet = generationHours.reduce(
    (total, hours) =>
      safeAdd(
        total,
        cappedResourceCost(
          hours,
          prices.serverHourlyNet.micros,
          prices.serverMonthlyNet?.micros ?? null,
        ),
      ),
    0,
  );
  const serverGross = generationHours.reduce(
    (total, hours) =>
      safeAdd(
        total,
        cappedResourceCost(
          hours,
          prices.serverHourlyGross.micros,
          prices.serverMonthlyGross?.micros ?? null,
        ),
      ),
    0,
  );
  const ipv4Net = generationHours.reduce(
    (total, hours) =>
      safeAdd(
        total,
        cappedResourceCost(
          hours,
          prices.ipv4HourlyNet.micros,
          prices.ipv4MonthlyNet?.micros ?? null,
        ),
      ),
    0,
  );
  const ipv4Gross = generationHours.reduce(
    (total, hours) =>
      safeAdd(
        total,
        cappedResourceCost(
          hours,
          prices.ipv4HourlyGross.micros,
          prices.ipv4MonthlyGross?.micros ?? null,
        ),
      ),
    0,
  );
  return {
    lifetimeSeconds,
    billableHours: generationHours.reduce((sum, hours) => sum + hours, 0),
    generationBillableHours: generationHours,
    location: prices.location,
    participantCount,
    serverNetMicrosPerLearner: serverNet,
    serverGrossMicrosPerLearner: serverGross,
    ipv4NetMicrosPerLearner: ipv4Net,
    ipv4GrossMicrosPerLearner: ipv4Gross,
    totalNetMicros: safeMultiply(
      safeAdd(serverNet, ipv4Net),
      participantCount,
    ),
    totalGrossMicros: safeMultiply(
      safeAdd(serverGross, ipv4Gross),
      participantCount,
    ),
  };
}

function oneHourGross(price: LocationPrices): number {
  return safeAdd(price.serverHourlyGross.micros, price.ipv4HourlyGross.micros);
}

function normalizedPrice(raw: string): NormalizedPrice {
  return { raw, micros: decimalCurrencyToMicros(raw) };
}

function optionalPrice(raw: string | undefined): NormalizedPrice | null {
  return raw === undefined ? null : normalizedPrice(raw);
}

function uniqueLocations(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = locationName(value);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  if (!result.length) {
    throw appError(
      400,
      "provider_locations_required",
      "at least one approved provider location is required",
    );
  }
  return result;
}

function locationName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(normalized)) {
    throw appError(
      502,
      "provider_location_invalid",
      "provider returned an invalid location",
    );
  }
  return normalized;
}

function normalizedCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw appError(
      502,
      "provider_currency_invalid",
      "provider returned an invalid billing currency",
    );
  }
  return normalized;
}

function secondsBetween(startMs: number, endMs: number): number {
  return Math.ceil((endMs - startMs) / 1_000);
}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(400, "timestamp_invalid", `${field} must be a timestamp`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(
      400,
      "integer_invalid",
      `${field} must be a non-negative integer`,
    );
  }
  return value;
}

function safeAdd(left: number, right: number): number {
  const total = BigInt(left) + BigInt(right);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw appError(400, "provider_cost_too_large", "provider cost is too large");
  }
  return Number(total);
}

function safeMultiply(left: number, right: number): number {
  const total = BigInt(left) * BigInt(right);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw appError(400, "provider_cost_too_large", "provider cost is too large");
  }
  return Number(total);
}
