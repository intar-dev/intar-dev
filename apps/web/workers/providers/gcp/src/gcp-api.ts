import type {
  GcpAsyncOperation,
  GcpServiceAccountKey,
} from "@intar/provider-contracts/gcp";
import { ProviderServiceError } from "@intar/provider-worker-core";
import { mintAccessToken } from "./auth";
import type { GcpAccessToken } from "./auth";

const DEFAULT_COMPUTE_BASE = "https://compute.googleapis.com/compute/v1";
const DEFAULT_RESOURCE_MANAGER_BASE = "https://cloudresourcemanager.googleapis.com/v1";
const DEFAULT_SERVICE_USAGE_BASE = "https://serviceusage.googleapis.com/v1";
const DEFAULT_CLOUD_ASSET_BASE = "https://cloudasset.googleapis.com/v1";
const REQUEST_TIMEOUT_MS = 15_000;

export interface GcpApiOptions {
  fetcher?: typeof fetch;
  computeBase?: string;
  resourceManagerBase?: string;
  serviceUsageBase?: string;
  cloudAssetBase?: string;
  now?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
  tokenProvider?: () => Promise<GcpAccessToken>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerCode(status: number, body: unknown): string {
  const providerStatus = isRecord(body) && isRecord(body.error) && typeof body.error.status === "string"
    ? body.error.status
    : undefined;
  const detail =
    isRecord(body) && isRecord(body.error) && Array.isArray(body.error.errors)
      ? body.error.errors.find(isRecord)
      : undefined;
  const reason = detail?.reason;
  const errorCode = detail?.code;
  if (
    reason === "resourcePoolExhausted" ||
    reason === "resourcePoolExhaustedWithDetails" ||
    reason === "zoneResourcePoolExhausted" ||
    reason === "ZONE_RESOURCE_POOL_EXHAUSTED" ||
    errorCode === "ZONE_RESOURCE_POOL_EXHAUSTED" ||
    errorCode === "RESOURCE_POOL_EXHAUSTED"
  ) {
    return "gcp_resource_unavailable";
  }
  if (providerStatus === "RESOURCE_EXHAUSTED") return "gcp_quota_exceeded";
  if (providerStatus === "PERMISSION_DENIED") return "gcp_permission_denied";
  if (reason === "quotaExceeded" || reason === "resourceQuotaExceeded") return "gcp_quota_exceeded";
  if (reason === "rateLimitExceeded" || status === 429) return "gcp_rate_limit_exceeded";
  if (status === 401) return "gcp_credential_rejected";
  if (status === 403) return "gcp_permission_denied";
  if (status === 404) return "gcp_not_found";
  if (status === 409) return "gcp_conflict";
  return "gcp_api_error";
}

export function gcpOperationErrorCode(
  operation: GcpAsyncOperation,
): string | undefined {
  const code = operation.error?.errors?.find(
    (error) => typeof error.code === "string",
  )?.code;
  if (
    code === "ZONE_RESOURCE_POOL_EXHAUSTED" ||
    code === "RESOURCE_POOL_EXHAUSTED" ||
    code === "resourcePoolExhausted" ||
    code === "resourcePoolExhaustedWithDetails"
  ) {
    return "gcp_resource_unavailable";
  }
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(code)
    ? `gcp_operation_${code.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}`
    : undefined;
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.min(value, 3_600) : undefined;
}

export class GcpApiError extends ProviderServiceError {
  constructor(response: Response, body: unknown) {
    const retryAfter = retryAfterSeconds(response);
    super({
      code: providerCode(response.status, body),
      message: "GCP API rejected the provider operation",
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      providerStatus: response.status,
      ...(response.headers.get("x-guploader-uploadid")
        ? { providerRequestId: response.headers.get("x-guploader-uploadid")! }
        : {}),
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    });
    this.name = "GcpApiError";
  }
}

export class GcpApi {
  readonly #key: GcpServiceAccountKey;
  readonly #fetcher: typeof fetch;
  readonly #computeBase: string;
  readonly #resourceManagerBase: string;
  readonly #serviceUsageBase: string;
  readonly #cloudAssetBase: string;
  readonly #now: () => Date;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #tokenProvider: (() => Promise<GcpAccessToken>) | undefined;
  #token?: { value: string; expiresAtEpochSeconds: number };

  constructor(key: GcpServiceAccountKey, options: GcpApiOptions = {}) {
    this.#key = key;
    this.#fetcher = options.fetcher ?? fetch;
    this.#computeBase = options.computeBase ?? DEFAULT_COMPUTE_BASE;
    this.#resourceManagerBase = options.resourceManagerBase ?? DEFAULT_RESOURCE_MANAGER_BASE;
    this.#serviceUsageBase = options.serviceUsageBase ?? DEFAULT_SERVICE_USAGE_BASE;
    this.#cloudAssetBase = options.cloudAssetBase ?? DEFAULT_CLOUD_ASSET_BASE;
    this.#now = options.now ?? (() => new Date());
    this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#tokenProvider = options.tokenProvider;
  }

  async #accessToken(): Promise<string> {
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (this.#token && this.#token.expiresAtEpochSeconds - 60 > nowSeconds) {
      return this.#token.value;
    }
    const minted = this.#tokenProvider
      ? await this.#tokenProvider()
      : await mintAccessToken(this.#key, {
          fetcher: this.#fetcher,
          now: this.#now,
        });
    this.#token = {
      value: minted.accessToken,
      expiresAtEpochSeconds: minted.expiresAtEpochSeconds,
    };
    return minted.accessToken;
  }

  async request<T>(
    base: "compute" | "resource_manager" | "service_usage" | "cloud_asset",
    path: string,
    init: RequestInit = {},
    query: Record<string, string | undefined> = {},
  ): Promise<T> {
    if (!path.startsWith("/") || path.includes("..") || path.includes("\\")) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP API path is invalid",
        retryable: false,
      });
    }
    const root = base === "compute"
      ? this.#computeBase
      : base === "resource_manager"
        ? this.#resourceManagerBase
        : base === "service_usage"
          ? this.#serviceUsageBase
          : this.#cloudAssetBase;
    const url = new URL(`${root}${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const token = await this.#accessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.#fetcher.call(undefined, url, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderServiceError({
        code: "gcp_transport_error",
        message: "GCP API transport failed before the operation was confirmed",
        retryable: true,
      });
    }
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json<unknown>();
      } catch {
        body = undefined;
      }
      throw new GcpApiError(response, body);
    }
    if (response.status === 204) return undefined as T;
    try {
      return await response.json<T>();
    } catch {
      throw new ProviderServiceError({
        code: "gcp_invalid_response",
        message: "GCP API returned an invalid response",
        retryable: false,
      });
    }
  }

  compute<T>(path: string, init?: RequestInit, query?: Record<string, string | undefined>): Promise<T> {
    return this.request<T>("compute", path, init, query);
  }

  resourceManager<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>("resource_manager", path, init);
  }

  serviceUsage<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    return this.request<T>("service_usage", path, undefined, query);
  }

  cloudAsset<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    return this.request<T>("cloud_asset", path, undefined, query);
  }

  async waitForOperation(
    projectId: string,
    operation: GcpAsyncOperation,
    maxWaitMs = 20_000,
  ): Promise<GcpAsyncOperation> {
    let current = operation;
    const deadline = this.#now().getTime() + Math.max(0, maxWaitMs);
    while (current.status !== "DONE" && this.#now().getTime() < deadline) {
      await this.#delay(500);
      current = await this.getOperation(projectId, current.selfLink);
    }
    if (current.status === "DONE" && current.error?.errors?.length) {
      throw new ProviderServiceError({
        code: "gcp_async_operation_failed",
        message: "GCP asynchronous operation failed",
        retryable: false,
      });
    }
    return current;
  }

  getOperation(projectId: string, selfLink: string): Promise<GcpAsyncOperation> {
    const parsed = new URL(selfLink);
    const prefix = `/compute/v1/projects/${projectId}/`;
    const relative = parsed.pathname.slice(prefix.length);
    if (
      !parsed.pathname.startsWith(prefix) ||
      !/^(?:global|zones\/[a-z0-9-]+|regions\/[a-z0-9-]+)\/operations\/[A-Za-z0-9_-]+$/u.test(relative)
    ) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP operation reference is invalid",
        retryable: false,
      });
    }
    return this.compute<GcpAsyncOperation>(parsed.pathname.slice("/compute/v1".length));
  }
}
