import { env } from "cloudflare:workers";
import type {
  CatalogObservation,
  ConnectProjectRequest,
  ConnectProjectResult,
  EncryptedCredentialEnvelope,
  HcloudOperationResult,
  HcloudPricing,
  HcloudServerType,
  ProviderRpcResult,
  RotateCredentialRequest,
  RotateCredentialResult,
  RunOperationRequest,
  ServiceErrorShape,
} from "../../../hcloud-provider-worker/src/contracts";
import type {
  ProviderHardwareShape,
  ProviderPriceObservation,
} from "@/db/schema";
import { appError } from "@/lib/app-error";

interface HcloudProviderServiceBinding {
  connectProject(
    request: ConnectProjectRequest,
  ): Promise<ProviderRpcResult<ConnectProjectResult>>;
  rotateCredential(
    request: RotateCredentialRequest,
  ): Promise<ProviderRpcResult<RotateCredentialResult>>;
  runOperation(
    request: RunOperationRequest,
  ): Promise<ProviderRpcResult<HcloudOperationResult>>;
  reconcile(
    request: RunOperationRequest,
  ): Promise<ProviderRpcResult<unknown>>;
}

export interface ResolvedHetznerCatalog {
  serverType: string;
  systemImage: string;
  hardware: ProviderHardwareShape;
  prices: ProviderPriceObservation;
}

export async function hcloudConnectProject(
  request: ConnectProjectRequest,
): Promise<ConnectProjectResult> {
  return invokeProviderService(
    () => providerBinding().connectProject(request),
    "Hetzner project connection failed",
  );
}

export async function hcloudRotateCredential(
  request: RotateCredentialRequest,
): Promise<RotateCredentialResult> {
  return invokeProviderService(
    () => providerBinding().rotateCredential(request),
    "Hetzner credential rotation failed",
  );
}

export async function hcloudRunOperation(
  request: RunOperationRequest,
): Promise<HcloudOperationResult> {
  return invokeProviderService(
    () => providerBinding().runOperation(request),
    "Hetzner provider operation failed",
  );
}

export function resolveHetznerCatalog(input: {
  catalog: CatalogObservation;
  exactServerType: string;
  systemImage: string;
  permittedLocations: readonly string[];
  requiredCpuMillis: number;
  requiredMemoryMib: number;
  requiredDiskMib: number;
  observedAt?: number;
}): ResolvedHetznerCatalog {
  const matches = input.catalog.serverTypes.filter(
    (entry) => entry.name === input.exactServerType,
  );
  if (matches.length !== 1) {
    throw appError(
      409,
      "hcloud_server_type_unavailable",
      "the exact pinned Hetzner server type is unavailable",
    );
  }
  const type = matches[0]!;
  if (
    type.architecture !== "x86" ||
    type.deprecated === true ||
    type.deprecation != null
  ) {
    throw appError(
      409,
      "hcloud_server_type_incompatible",
      "the pinned Hetzner server type is deprecated or not x86",
    );
  }
  const hardware = serverHardware(type);
  if (
    hardware.cores * 1_000 < input.requiredCpuMillis ||
    hardware.memoryMib < input.requiredMemoryMib ||
    hardware.diskMib < input.requiredDiskMib
  ) {
    throw appError(
      409,
      "hcloud_server_type_undersized",
      "the pinned Hetzner server type no longer satisfies the workshop requirements",
    );
  }
  const image = input.catalog.systemImages.find(
    (candidate) =>
      candidate.name === input.systemImage &&
      candidate.architecture === "x86" &&
      candidate.status === "available" &&
      candidate.deprecated === null &&
      candidate.deleted === null,
  );
  if (!image) {
    throw appError(
      409,
      "hcloud_system_image_unavailable",
      "the pinned Hetzner system image is unavailable",
    );
  }
  const permittedLocations = normalizeLocations(input.permittedLocations);
  const serverPricing = input.catalog.pricing.server_types.find(
    (entry) => entry.name === input.exactServerType,
  );
  const ipv4Pricing = input.catalog.pricing.primary_ips.find(
    (entry) => entry.type === "ipv4",
  );
  if (!serverPricing || !ipv4Pricing) {
    throw appError(
      502,
      "hcloud_pricing_unavailable",
      "Hetzner pricing for the pinned resources is unavailable",
    );
  }
  const observedAt =
    input.observedAt ?? parseProviderTimestamp(input.catalog.observedAt);
  const locations = permittedLocations.map((location) => {
    const server = serverPricing.prices.find(
      (entry) => entry.location === location,
    );
    const ipv4 = ipv4Pricing.prices.find(
      (entry) => entry.location === location,
    );
    if (!server || !ipv4) {
      throw appError(
        502,
        "hcloud_location_pricing_unavailable",
        `Hetzner pricing is unavailable for approved location ${location}`,
      );
    }
    return {
      location,
      available: locationAvailable(type, location),
      serverHourlyNet: providerDecimal(server.price_hourly.net),
      serverHourlyGross: providerDecimal(server.price_hourly.gross),
      serverMonthlyNet: providerDecimal(server.price_monthly.net),
      serverMonthlyGross: providerDecimal(server.price_monthly.gross),
      ipv4HourlyNet: providerDecimal(ipv4.price_hourly.net),
      ipv4HourlyGross: providerDecimal(ipv4.price_hourly.gross),
      ipv4MonthlyNet: providerDecimal(ipv4.price_monthly.net),
      ipv4MonthlyGross: providerDecimal(ipv4.price_monthly.gross),
    };
  });
  return {
    serverType: input.exactServerType,
    systemImage: input.systemImage,
    hardware,
    prices: {
      currency: providerCurrency(input.catalog.pricing),
      observedAt,
      expiresAt: observedAt + 24 * 60 * 60 * 1_000,
      serverType: input.exactServerType,
      locations,
    },
  };
}

export function credentialEnvelopeStorage(
  envelope: EncryptedCredentialEnvelope,
): {
  algorithm: string;
  kekVersion: string;
  aadSha256: string;
  encryptedTokenB64: string;
  tokenIvB64: string;
  wrappedDekB64: string;
  dekIvB64: string;
  envelopeCreatedAt: number;
} {
  return {
    algorithm: envelope.algorithm,
    kekVersion: envelope.kekVersion,
    aadSha256: envelope.aadSha256,
    encryptedTokenB64: envelope.ciphertext,
    tokenIvB64: envelope.ciphertextIv,
    wrappedDekB64: envelope.wrappedDek,
    dekIvB64: envelope.wrappedDekIv,
    envelopeCreatedAt: parseProviderTimestamp(envelope.createdAt),
  };
}

export function credentialEnvelopeFromStorage(row: {
  algorithm: string;
  kekVersion: string;
  aadSha256: string;
  encryptedTokenB64: string;
  tokenIvB64: string;
  wrappedDekB64: string;
  dekIvB64: string;
  envelopeCreatedAt: number;
}): EncryptedCredentialEnvelope {
  if (row.algorithm !== "AES-256-GCM" || row.kekVersion !== "v1") {
    throw appError(
      500,
      "provider_credential_envelope_unsupported",
      "provider credential envelope version is unsupported",
    );
  }
  return {
    algorithm: "AES-256-GCM",
    kekVersion: "v1",
    aadSha256: row.aadSha256,
    wrappedDek: row.wrappedDekB64,
    wrappedDekIv: row.dekIvB64,
    ciphertext: row.encryptedTokenB64,
    ciphertextIv: row.tokenIvB64,
    createdAt: new Date(row.envelopeCreatedAt).toISOString(),
  };
}

function providerBinding(): HcloudProviderServiceBinding {
  const binding = (
    env as Cloudflare.Env & {
      HCLOUD_PROVIDER_SERVICE?: HcloudProviderServiceBinding;
    }
  ).HCLOUD_PROVIDER_SERVICE;
  if (!binding) {
    throw appError(
      503,
      "hcloud_provider_service_unavailable",
      "Hetzner provider service is not configured",
    );
  }
  return binding;
}

function requireRpcResult<T>(
  result: ProviderRpcResult<T>,
  fallback: string,
): T {
  if (result.ok) return result.value;
  throw providerServiceError(result.error, fallback);
}

export async function invokeProviderService<T>(
  invocation: () => Promise<ProviderRpcResult<T>>,
  fallback: string,
): Promise<T> {
  let result: ProviderRpcResult<T>;
  try {
    result = await invocation();
  } catch {
    // RPC transport failures can be ambiguous: the provider Worker may have
    // completed a create before its response was lost. Keep the failure
    // retryable so the runtime reconciles deterministic ownership labels, and
    // never surface the binding exception because it can contain internals.
    throw appError(
      503,
      "hcloud_provider_service_unavailable",
      fallback,
    );
  }
  // Structured provider errors are interpreted outside the transport catch so
  // rate limits and non-retryable provider failures retain their semantics.
  return requireRpcResult(result, fallback);
}

export function providerServiceError(error: ServiceErrorShape, fallback: string) {
  const status = error.providerStatus === 429 ? 429 : error.retryable ? 503 : 409;
  const safeCode = /^[a-z0-9_]{3,80}$/.test(error.code)
    ? error.code
    : "hcloud_provider_error";
  const safeMessage =
    typeof error.message === "string" && error.message.length <= 300
      ? error.message
      : fallback;
  return appError(status, safeCode, safeMessage);
}

function serverHardware(type: HcloudServerType): ProviderHardwareShape {
  if (
    !Number.isSafeInteger(type.cores) ||
    type.cores <= 0 ||
    !Number.isFinite(type.memory) ||
    type.memory <= 0 ||
    !Number.isSafeInteger(type.disk) ||
    type.disk <= 0
  ) {
    throw appError(
      502,
      "hcloud_server_type_shape_invalid",
      "Hetzner returned an invalid server type shape",
    );
  }
  const memoryMib = type.memory * 1_024;
  const diskMib = type.disk * 1_024;
  if (!Number.isSafeInteger(memoryMib) || !Number.isSafeInteger(diskMib)) {
    throw appError(
      502,
      "hcloud_server_type_shape_invalid",
      "Hetzner returned an unsupported server type shape",
    );
  }
  return { architecture: "x86", cores: type.cores, memoryMib, diskMib };
}

function locationAvailable(type: HcloudServerType, location: string): boolean {
  const entry = type.locations?.find((candidate) => candidate.name === location);
  return entry?.available === true && entry.deprecation == null;
}

function normalizeLocations(values: readonly string[]): string[] {
  const result = [...new Set(values.map((value) => value.trim().toLowerCase()))];
  if (
    !result.length ||
    result.some((value) => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value))
  ) {
    throw appError(
      400,
      "hcloud_locations_invalid",
      "approved Hetzner locations are invalid",
    );
  }
  return result;
}

function providerDecimal(value: string): string {
  const normalized = value.trim();
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalized)) {
    throw appError(
      502,
      "hcloud_price_invalid",
      "Hetzner returned an invalid decimal price",
    );
  }
  return normalized;
}

function providerCurrency(pricing: HcloudPricing): string {
  const currency = pricing.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw appError(
      502,
      "hcloud_currency_invalid",
      "Hetzner returned an invalid billing currency",
    );
  }
  return currency;
}

function parseProviderTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw appError(
      502,
      "hcloud_timestamp_invalid",
      "Hetzner provider service returned an invalid timestamp",
    );
  }
  return parsed;
}
