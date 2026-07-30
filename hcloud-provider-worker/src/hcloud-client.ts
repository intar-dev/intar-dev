import type {
  CatalogObservation,
  HcloudAction,
  HcloudFirewall,
  HcloudFirewallRule,
  HcloudImage,
  HcloudLocation,
  HcloudPricing,
  HcloudPrimaryIp,
  HcloudServer,
  HcloudServerType,
  HcloudSshKey,
  NamedHcloudResource,
  OwnershipLabels,
  ProjectInventory,
  ReconcileResourceRef,
  ResourceObservation,
  SentinelSpec,
} from "./contracts";
import { ProviderServiceError, redactString } from "./redaction";

const DEFAULT_API_BASE = "https://api.hetzner.cloud/v1";
const MAX_CLOUD_INIT_BYTES = 32 * 1024;
const HCLOUD_API_TIMEOUT_MS = 10_000;
const HCLOUD_REQUEST_CONCURRENCY = 4;
const HCLOUD_GET_RETRY_BASE_MS = 100;
const HCLOUD_GET_RETRY_JITTER_MS = 100;
const encoder = new TextEncoder();

const EXPOSED_PROVIDER_CODES = new Set([
  "api_error",
  "conflict",
  "forbidden",
  "invalid_input",
  "json_error",
  "locked",
  "maintenance",
  "not_found",
  "protected",
  "quota_exceeded",
  "rate_limit_exceeded",
  "resource_limit_exceeded",
  "resource_unavailable",
  "service_error",
  "unauthorized",
  "uniqueness_error",
  "unknown_error",
]);

type Fetcher = typeof fetch;

interface ApiMeta {
  pagination?: {
    next_page?: number | null;
    last_page?: number;
  };
}

interface ApiListResponse<T, K extends string> {
  meta?: ApiMeta;
  [key: string]: T[] | ApiMeta | undefined;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export interface HcloudClientOptions {
  fetcher?: Fetcher;
  apiBase?: string;
  now?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
  onTransportFailure?: (event: HcloudTransportFailureEvent) => void;
}

export interface HcloudTransportFailureEvent {
  event: "hcloud_transport_failure";
  method: "GET" | "POST" | "DELETE";
  endpoint: string;
  attempt: number;
  failureKind: "timeout" | "transport";
  elapsedMs: number;
}

export interface EnsureSentinelResult {
  firewall: HcloudFirewall;
  actions: HcloudAction[];
  created: boolean;
}

export interface CreatePrimaryIpResult {
  primaryIp: HcloudPrimaryIp;
  action: HcloudAction | null;
  resourceCreatedAt?: string;
}

export interface CreateSshKeyResult {
  sshKey: HcloudSshKey;
}

export interface CreateServerResult {
  server: HcloudServer;
  action: HcloudAction;
  nextActions: HcloudAction[];
  resourceCreatedAt?: string;
}

export interface DeleteResourceResult {
  action: HcloudAction | null;
  alreadyMissing: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function transportEndpoint(path: string): string {
  const [pathname = "/"] = path.split("?", 1);
  return pathname.replace(/\/\d+(?=\/|$)/gu, "/:id");
}

function getRetryDelay(path: string): number {
  let hash = 0;
  for (const character of transportEndpoint(path)) {
    hash = (hash * 31 + character.codePointAt(0)!) % HCLOUD_GET_RETRY_JITTER_MS;
  }
  return HCLOUD_GET_RETRY_BASE_MS + hash;
}

class RequestLimiter {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }
}

function assertPositiveId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: `Invalid ${field}`,
      retryable: false,
    });
  }
}

export function assertDeterministicName(name: string): void {
  if (!/^intar-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(name) || name.length > 63) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "Provider resource name must be a canonical Intar DNS label",
      retryable: false,
    });
  }
}

function assertLabelRef(value: string, field: string): void {
  if (!/^[A-Za-z0-9._-]{1,63}$/u.test(value)) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: `Invalid ${field} ownership reference`,
      retryable: false,
    });
  }
}

export function ownershipToLabels(ownership: OwnershipLabels): Record<string, string> {
  assertLabelRef(ownership.organizationRef, "organization");
  assertLabelRef(ownership.connectionRef, "connection");
  const labels: Record<string, string> = {
    intar_managed: "true",
    intar_provider: "hetzner_cloud",
    intar_org: ownership.organizationRef,
    intar_connection: ownership.connectionRef,
  };
  if (ownership.purpose === "workshop_publication_verifier") {
    if (
      ("workspaceRef" in ownership &&
        ownership.workspaceRef !== undefined) ||
      ("generation" in ownership && ownership.generation !== undefined)
    ) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message:
          "Workshop publication ownership cannot include learner references",
        retryable: false,
      });
    }
    assertLabelRef(
      ownership.workshopPublicationRef,
      "workshop publication",
    );
    assertLabelRef(ownership.checkpointRef, "checkpoint");
    if (!Number.isSafeInteger(ownership.attempt) || ownership.attempt < 1) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "Invalid publication attempt ownership reference",
        retryable: false,
      });
    }
    return {
      ...labels,
      intar_purpose: ownership.purpose,
      intar_publication: ownership.workshopPublicationRef,
      intar_checkpoint: ownership.checkpointRef,
      intar_attempt: String(ownership.attempt),
    };
  }
  if (
    ownership.purpose !== undefined &&
    ownership.purpose !== "learner_workspace"
  ) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "Invalid ownership purpose",
      retryable: false,
    });
  }
  const untrustedOwnership = ownership as OwnershipLabels & {
    workshopPublicationRef?: unknown;
    checkpointRef?: unknown;
    attempt?: unknown;
  };
  if (
    untrustedOwnership.workshopPublicationRef !== undefined ||
    untrustedOwnership.checkpointRef !== undefined ||
    untrustedOwnership.attempt !== undefined
  ) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "Learner ownership cannot include publication references",
      retryable: false,
    });
  }
  if (ownership.workspaceRef !== undefined) {
    assertLabelRef(ownership.workspaceRef, "workspace");
    labels.intar_workspace = ownership.workspaceRef;
  }
  if (ownership.generation !== undefined) {
    if (!Number.isSafeInteger(ownership.generation) || ownership.generation < 1) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "Invalid generation ownership reference",
        retryable: false,
      });
    }
    labels.intar_generation = String(ownership.generation);
  }
  return labels;
}

export function labelsMatchOwnership(
  labels: Record<string, string> | undefined,
  ownership: OwnershipLabels,
): boolean {
  if (!labels) return false;
  const expected = ownershipToLabels(ownership);
  return Object.entries(expected).every(([key, value]) => labels[key] === value);
}

export function sentinelRules(cidrs: string[]): HcloudFirewallRule[] {
  if (cidrs.length === 0 || cidrs.length > 32) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "At least one Stargate IPv4 CIDR is required",
      retryable: false,
    });
  }
  const unique = [...new Set(cidrs)].sort();
  for (const cidr of unique) {
    const match = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/u.exec(cidr);
    const prefix = Number(cidr.split("/")[1]);
    const octets = cidr.split("/")[0]?.split(".").map(Number) ?? [];
    if (!match || prefix < 0 || prefix > 32 || octets.some((octet) => octet > 255)) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "Stargate egress entries must be IPv4 CIDRs",
        retryable: false,
      });
    }
  }
  return [
    {
      direction: "in",
      protocol: "tcp",
      port: "22",
      source_ips: unique,
      description: "Intar Stargate SSH forwarding",
    },
  ];
}

function providerCodeRetryable(code: string, status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 423 ||
    status === 429 ||
    status >= 500 ||
    ["conflict", "locked", "rate_limit_exceeded", "resource_unavailable"].includes(code)
  );
}

function exposedProviderCode(code: string): string {
  return EXPOSED_PROVIDER_CODES.has(code) ? code : "api_error";
}

function invalidActionResponse(): ProviderServiceError {
  return new ProviderServiceError({
    code: "hcloud_invalid_response",
    message: "Hetzner API returned an invalid action response",
    retryable: true,
  });
}

function sanitizedAction(action: unknown): HcloudAction {
  if (
    !isRecord(action) ||
    !Number.isSafeInteger(action.id) ||
    Number(action.id) < 1 ||
    !["running", "success", "error"].includes(String(action.status)) ||
    typeof action.command !== "string" ||
    !/^[a-z][a-z0-9_]{0,127}$/u.test(action.command) ||
    typeof action.progress !== "number" ||
    !Number.isFinite(action.progress) ||
    action.progress < 0 ||
    action.progress > 100 ||
    typeof action.started !== "string" ||
    action.started.length > 64 ||
    !Number.isFinite(Date.parse(action.started)) ||
    !(
      action.finished === null ||
      (typeof action.finished === "string" &&
        action.finished.length <= 64 &&
        Number.isFinite(Date.parse(action.finished)))
    ) ||
    !(action.error === null || isRecord(action.error)) ||
    !Array.isArray(action.resources) ||
    action.resources.length > 128
  ) {
    throw invalidActionResponse();
  }
  const resources = action.resources.map((resource) => {
    if (
      !isRecord(resource) ||
      !Number.isSafeInteger(resource.id) ||
      Number(resource.id) < 1 ||
      typeof resource.type !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(resource.type)
    ) {
      throw invalidActionResponse();
    }
    return { id: Number(resource.id), type: resource.type };
  });

  let error: HcloudAction["error"] = null;
  if (action.error !== null) {
    if (typeof action.error.code !== "string") throw invalidActionResponse();
    error = {
      code: exposedProviderCode(action.error.code),
      message: "Hetzner action failed",
    };
  }

  return {
    id: Number(action.id),
    status: action.status as HcloudAction["status"],
    command: action.command,
    progress: action.progress,
    started: action.started,
    finished: action.finished as string | null,
    error,
    resources,
  };
}

function sanitizedActions(actions: unknown): HcloudAction[] {
  if (!Array.isArray(actions) || actions.length > 128) throw invalidActionResponse();
  return actions.map(sanitizedAction);
}

function validatedResourceCreatedAt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isSafeInteger(Date.parse(value))
  ) {
    throw new ProviderServiceError({
      code: "hcloud_invalid_response",
      message: "Hetzner API returned an invalid resource creation timestamp",
      retryable: true,
    });
  }
  return value;
}

function invalidResourceResponse(resourceKind: string): ProviderServiceError {
  return new ProviderServiceError({
    code: "hcloud_invalid_response",
    message: `Hetzner API returned an invalid ${resourceKind} response`,
    retryable: true,
  });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isIpv4Address(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) =>
        /^(?:0|[1-9]\d{0,2})$/u.test(octet) &&
        Number(octet) >= 0 &&
        Number(octet) <= 255,
    )
  );
}

function validatedCreatedPrimaryIp(
  value: unknown,
  input: { name: string; location: string; ownership: OwnershipLabels },
): HcloudPrimaryIp {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    value.name !== input.name ||
    value.type !== "ipv4" ||
    !isIpv4Address(value.ip) ||
    value.auto_delete !== true ||
    value.assignee_id !== null ||
    typeof value.blocked !== "boolean" ||
    !isStringRecord(value.labels) ||
    !labelsMatchOwnership(value.labels, input.ownership) ||
    !isRecord(value.location) ||
    value.location.name !== input.location
  ) {
    throw invalidResourceResponse("Primary IPv4");
  }
  validatedResourceCreatedAt(value.created);
  return value as unknown as HcloudPrimaryIp;
}

function validatedCreatedSshKey(
  value: unknown,
  input: { name: string; ownership: OwnershipLabels },
): HcloudSshKey {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    value.name !== input.name ||
    typeof value.fingerprint !== "string" ||
    typeof value.public_key !== "string" ||
    !isStringRecord(value.labels) ||
    !labelsMatchOwnership(value.labels, input.ownership)
  ) {
    throw invalidResourceResponse("SSH key");
  }
  return value as unknown as HcloudSshKey;
}

function validatedCreatedServer(
  value: unknown,
  input: {
    name: string;
    serverType: string;
    location: string;
    primaryIpv4Id: number;
    ownership: OwnershipLabels;
  },
): HcloudServer {
  const publicNet = isRecord(value) && isRecord(value.public_net) ? value.public_net : null;
  const ipv4 = publicNet && isRecord(publicNet.ipv4) ? publicNet.ipv4 : null;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    value.name !== input.name ||
    typeof value.status !== "string" ||
    !isStringRecord(value.labels) ||
    !labelsMatchOwnership(value.labels, input.ownership) ||
    !isRecord(value.server_type) ||
    value.server_type.name !== input.serverType ||
    value.server_type.architecture !== "x86" ||
    !isRecord(value.location) ||
    value.location.name !== input.location ||
    !ipv4 ||
    ipv4.id !== input.primaryIpv4Id ||
    !isIpv4Address(ipv4.ip)
  ) {
    throw invalidResourceResponse("server");
  }
  validatedResourceCreatedAt(value.created);
  return value as unknown as HcloudServer;
}

function isProviderDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);
}

function hasValidPrice(value: unknown): boolean {
  return (
    isRecord(value) &&
    isProviderDecimal(value.net) &&
    isProviderDecimal(value.gross)
  );
}

function assertPricingCoverage(
  pricing: unknown,
  serverTypes: HcloudServerType[],
  permittedLocations: string[],
): void {
  if (
    !isRecord(pricing) ||
    typeof pricing.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(pricing.currency) ||
    !isProviderDecimal(pricing.vat_rate) ||
    !Array.isArray(pricing.server_types) ||
    !Array.isArray(pricing.primary_ips)
  ) {
    throw new ProviderServiceError({
      code: "hcloud_pricing_unavailable",
      message: "Hetzner pricing metadata is unavailable",
      retryable: true,
    });
  }

  const ipv4Entries = pricing.primary_ips.filter(
    (entry) => isRecord(entry) && entry.type === "ipv4",
  );
  if (ipv4Entries.length !== 1) {
    throw new ProviderServiceError({
      code: "hcloud_pricing_unavailable",
      message: "Hetzner Primary IPv4 pricing is unavailable",
      retryable: true,
    });
  }
  const ipv4 = ipv4Entries[0]!;
  if (!Array.isArray(ipv4.prices)) {
    throw new ProviderServiceError({
      code: "hcloud_pricing_unavailable",
      message: "Hetzner Primary IPv4 pricing is unavailable",
      retryable: true,
    });
  }
  for (const location of permittedLocations) {
    const ipv4Prices = ipv4.prices.filter(
      (entry: unknown) => isRecord(entry) && entry.location === location,
    );
    if (
      ipv4Prices.length !== 1 ||
      !hasValidPrice(ipv4Prices[0]?.price_hourly) ||
      !hasValidPrice(ipv4Prices[0]?.price_monthly)
    ) {
      throw new ProviderServiceError({
        code: "hcloud_pricing_unavailable",
        message: `Hetzner Primary IPv4 pricing is unavailable for ${redactString(location)}`,
        retryable: true,
      });
    }
  }

  for (const serverType of serverTypes) {
    const typeEntries = pricing.server_types.filter(
      (entry) => isRecord(entry) && entry.name === serverType.name,
    );
    if (typeEntries.length !== 1) {
      throw new ProviderServiceError({
        code: "hcloud_pricing_unavailable",
        message: `Hetzner pricing for ${redactString(serverType.name)} is unavailable`,
        retryable: true,
      });
    }
    const typePricing = typeEntries[0]!;
    if (!Array.isArray(typePricing.prices)) {
      throw new ProviderServiceError({
        code: "hcloud_pricing_unavailable",
        message: `Hetzner pricing for ${redactString(serverType.name)} is unavailable`,
        retryable: true,
      });
    }
    for (const location of permittedLocations) {
      const serverPrices = typePricing.prices.filter(
        (entry: unknown) => isRecord(entry) && entry.location === location,
      );
      if (
        serverPrices.length !== 1 ||
        !hasValidPrice(serverPrices[0]?.price_hourly) ||
        !hasValidPrice(serverPrices[0]?.price_monthly)
      ) {
        throw new ProviderServiceError({
          code: "hcloud_pricing_unavailable",
          message: `Hetzner pricing is unavailable for ${redactString(location)}`,
          retryable: true,
        });
      }
    }
  }
}

function serverTypeAvailableInPermittedLocation(
  serverType: HcloudServerType,
  permittedLocations: string[],
): boolean {
  const locationStates = serverType.locations ?? [];
  return (
    locationStates.length === 0 ||
    permittedLocations.some((location) =>
      locationStates.some(
        (state) => state.name === location && state.available && state.deprecation == null,
      ),
    )
  );
}

function supportedX86ServerType(
  serverType: HcloudServerType,
  permittedLocations: string[],
): boolean {
  return (
    serverType.architecture === "x86" &&
    serverType.deprecated !== true &&
    serverType.deprecation == null &&
    Number.isSafeInteger(serverType.id) &&
    serverType.id > 0 &&
    Number.isSafeInteger(serverType.cores) &&
    serverType.cores > 0 &&
    Number.isFinite(serverType.memory) &&
    serverType.memory > 0 &&
    Number.isSafeInteger(serverType.disk) &&
    serverType.disk > 0 &&
    serverTypeAvailableInPermittedLocation(serverType, permittedLocations)
  );
}

export class HcloudApiError extends ProviderServiceError {
  constructor(input: {
    status: number;
    providerCode: string;
    requestId?: string;
    retryAfterSeconds?: number;
  }) {
    const providerCode = exposedProviderCode(input.providerCode);
    super({
      code: `hcloud_${providerCode}`,
      message: `Hetzner API rejected the provider operation (${providerCode})`,
      retryable: providerCodeRetryable(providerCode, input.status),
      providerStatus: input.status,
      ...(input.requestId ? { providerRequestId: redactString(input.requestId) } : {}),
      ...(input.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: input.retryAfterSeconds }
        : {}),
    });
    this.name = "HcloudApiError";
  }
}

export class HcloudClient {
  readonly #token: string;
  readonly #fetcher: Fetcher;
  readonly #apiBase: string;
  readonly #now: () => Date;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #onTransportFailure: (event: HcloudTransportFailureEvent) => void;
  readonly #requestLimiter = new RequestLimiter(HCLOUD_REQUEST_CONCURRENCY);

  constructor(token: string, options: HcloudClientOptions = {}) {
    const tokenBytes = encoder.encode(token);
    if (
      tokenBytes.byteLength < 20 ||
      tokenBytes.byteLength > 512 ||
      token.trim() !== token ||
      /\s/u.test(token)
    ) {
      tokenBytes.fill(0);
      throw new ProviderServiceError({
        code: "invalid_provider_credential",
        message: "Hetzner credential is invalid",
        retryable: false,
      });
    }
    tokenBytes.fill(0);
    this.#token = token;
    this.#fetcher = options.fetcher ?? fetch;
    this.#apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/u, "");
    this.#now = options.now ?? (() => new Date());
    this.#delay =
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#onTransportFailure =
      options.onTransportFailure ??
      ((event) => {
        console.warn(JSON.stringify(event));
      });
  }

  async #request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!path.startsWith("/") || path.includes("..")) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "Invalid Hetzner API path",
        retryable: false,
      });
    }
    const maxAttempts = method === "GET" ? 2 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const result = await this.#requestLimiter.run(async () => {
        let response: Response;
        try {
          // Workers' built-in fetch rejects an arbitrary method receiver with
          // "Illegal invocation". Capture it first so the call remains a
          // standalone function invocation rather than `client.#fetcher(...)`.
          const fetcher = this.#fetcher;
          response = await fetcher(`${this.#apiBase}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${this.#token}`,
              Accept: "application/json",
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            signal: AbortSignal.timeout(HCLOUD_API_TIMEOUT_MS),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch (error) {
          return {
            kind: "transport_failure",
            failureKind:
              isRecord(error) && error.name === "TimeoutError"
                ? "timeout"
                : "transport",
          } as const;
        }

        if (!response.ok) {
          let providerCode = "api_error";
          try {
            const parsed = (await response.json()) as ApiErrorBody;
            if (parsed.error?.code) providerCode = parsed.error.code;
          } catch {
            // Provider bodies are intentionally not surfaced.
          }
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
          const providerRequestId = response.headers.get("x-request-id");
          throw new HcloudApiError({
            status: response.status,
            providerCode,
            ...(providerRequestId ? { requestId: providerRequestId } : {}),
            ...(typeof retryAfter === "number" && Number.isFinite(retryAfter)
              ? { retryAfterSeconds: retryAfter }
              : {}),
          });
        }

        if (response.status === 204) {
          return { kind: "success" as const, value: undefined as T };
        }
        try {
          return { kind: "success" as const, value: (await response.json()) as T };
        } catch {
          throw new ProviderServiceError({
            code: "hcloud_invalid_response",
            message: "Hetzner API returned an invalid response",
            retryable: true,
          });
        }
      });

      if (result.kind === "transport_failure") {
        this.#onTransportFailure({
          event: "hcloud_transport_failure",
          method,
          endpoint: transportEndpoint(path),
          attempt,
          failureKind: result.failureKind,
          elapsedMs: Math.max(0, Date.now() - startedAt),
        });
        if (attempt < maxAttempts) {
          await this.#delay(getRetryDelay(path));
          continue;
        }
        throw new ProviderServiceError({
          code: "hcloud_transport_error",
          message: "Hetzner API transport failed before the operation was confirmed",
          retryable: true,
        });
      }
      return result.value;
    }
    throw new Error("unreachable Hetzner request state");
  }

  async #list<T>(path: string, key: string, params: URLSearchParams = new URLSearchParams()): Promise<T[]> {
    const values: T[] = [];
    let page = 1;
    do {
      const query = new URLSearchParams(params);
      query.set("page", String(page));
      query.set("per_page", "50");
      const response = await this.#request<ApiListResponse<T, string>>(
        "GET",
        `${path}?${query.toString()}`,
      );
      const pageValues = response[key];
      if (!Array.isArray(pageValues)) {
        throw new ProviderServiceError({
          code: "hcloud_invalid_response",
          message: "Hetzner API returned an invalid list response",
          retryable: true,
        });
      }
      values.push(...(pageValues as T[]));
      const nextPage = response.meta?.pagination?.next_page;
      if (!nextPage || nextPage <= page) break;
      page = nextPage;
    } while (true);
    return values;
  }

  async inventory(): Promise<ProjectInventory> {
    const [
      servers,
      primaryIps,
      floatingIps,
      firewalls,
      networks,
      volumes,
      placementGroups,
      snapshots,
      sshKeys,
      loadBalancers,
      certificates,
    ] = await Promise.all([
      this.#list<HcloudServer>("/servers", "servers"),
      this.#list<HcloudPrimaryIp>("/primary_ips", "primary_ips"),
      this.#list<NamedHcloudResource>("/floating_ips", "floating_ips"),
      this.#list<HcloudFirewall>("/firewalls", "firewalls"),
      this.#list<NamedHcloudResource>("/networks", "networks"),
      this.#list<NamedHcloudResource>("/volumes", "volumes"),
      this.#list<NamedHcloudResource>("/placement_groups", "placement_groups"),
      this.#list<HcloudImage>("/images", "images", new URLSearchParams({ type: "snapshot" })),
      this.#list<HcloudSshKey>("/ssh_keys", "ssh_keys"),
      this.#list<NamedHcloudResource>("/load_balancers", "load_balancers"),
      this.#list<NamedHcloudResource>("/certificates", "certificates"),
    ]);
    return {
      servers,
      primaryIps,
      floatingIps,
      firewalls,
      networks,
      volumes,
      placementGroups,
      snapshots,
      sshKeys,
      loadBalancers,
      certificates,
    };
  }

  assertDedicatedProject(
    inventory: ProjectInventory,
    permittedSentinel: { name: string; ownership: OwnershipLabels },
  ): void {
    const acceptableFirewalls = inventory.firewalls.filter(
      (firewall) =>
        firewall.name === permittedSentinel.name &&
        labelsMatchOwnership(firewall.labels, permittedSentinel.ownership),
    );
    const foreignFirewalls = inventory.firewalls.filter(
      (firewall) => !acceptableFirewalls.some((allowed) => allowed.id === firewall.id),
    );
    const occupied = [
      inventory.servers.length,
      inventory.primaryIps.length,
      inventory.floatingIps.length,
      foreignFirewalls.length,
      inventory.networks.length,
      inventory.volumes.length,
      inventory.placementGroups.length,
      inventory.snapshots.length,
      inventory.sshKeys.length,
      inventory.loadBalancers.length,
      inventory.certificates?.length ?? 0,
    ].some((count) => count > 0);
    if (occupied || acceptableFirewalls.length > 1) {
      throw new ProviderServiceError({
        code: "hcloud_project_not_dedicated",
        message: "Hetzner project must be empty except for its Intar firewall sentinel",
        retryable: false,
      });
    }
  }

  async observeCatalog(input: {
    requiredServerTypes: string[];
    permittedLocations: string[];
    systemImage: string;
  }): Promise<CatalogObservation> {
    const [allServerTypes, allLocations, systemImages, pricing] = await Promise.all([
      this.#list<HcloudServerType>("/server_types", "server_types"),
      this.#list<HcloudLocation>("/locations", "locations"),
      this.#list<HcloudImage>(
        "/images",
        "images",
        new URLSearchParams({
          type: "system",
          name: input.systemImage,
          architecture: "x86",
          include_deprecated: "true",
        }),
      ),
      this.#request<{ pricing: unknown }>("GET", "/pricing").then(
        (response) => response.pricing,
      ),
    ]);
    const locations = allLocations.filter((location) => input.permittedLocations.includes(location.name));
    if (locations.length !== new Set(input.permittedLocations).size) {
      throw new ProviderServiceError({
        code: "hcloud_location_unavailable",
        message: "A configured Hetzner location is unavailable",
        retryable: false,
      });
    }

    const supportedServerTypes = allServerTypes.filter((serverType) =>
      supportedX86ServerType(serverType, input.permittedLocations),
    );
    if (input.requiredServerTypes.length === 0 && supportedServerTypes.length === 0) {
      throw new ProviderServiceError({
        code: "hcloud_server_type_unavailable",
        message: "No supported x86 Hetzner server type is available in the permitted locations",
        retryable: false,
      });
    }

    const serverTypes = input.requiredServerTypes.map((name) => {
      const serverType = allServerTypes.find((candidate) => candidate.name === name);
      if (!serverType || !supportedX86ServerType(serverType, input.permittedLocations)) {
        throw new ProviderServiceError({
          code: "hcloud_server_type_unavailable",
          message: `Required Hetzner server type ${redactString(name)} is unavailable`,
          retryable: false,
        });
      }
      return serverType;
    });

    const matchingImage = systemImages.find(
      (image) =>
        image.name === input.systemImage &&
        image.type === "system" &&
        image.status === "available" &&
        image.architecture === "x86" &&
        image.deprecated == null &&
        image.deleted == null,
    );
    if (!matchingImage) {
      throw new ProviderServiceError({
        code: "hcloud_system_image_unavailable",
        message: "Required Hetzner system image is unavailable",
        retryable: false,
      });
    }

    assertPricingCoverage(pricing, serverTypes, input.permittedLocations);

    return {
      observedAt: this.#now().toISOString(),
      // An empty requested list is the organization-connection preflight. It
      // proves the project has at least one usable x86 type without coupling
      // the connection to any workshop's exact immutable type.
      serverTypes: input.requiredServerTypes.length === 0 ? [] : serverTypes,
      locations,
      systemImages: [matchingImage],
      pricing: pricing as HcloudPricing,
    };
  }

  async ensureSentinel(spec: SentinelSpec): Promise<EnsureSentinelResult> {
    assertDeterministicName(spec.name);
    const labels = ownershipToLabels(spec.ownership);
    const rules = sentinelRules(spec.stargateEgressIpv4Cidrs);
    const candidates = await this.#list<HcloudFirewall>(
      "/firewalls",
      "firewalls",
      new URLSearchParams({ name: spec.name }),
    );
    if (candidates.length > 1) {
      throw new ProviderServiceError({
        code: "hcloud_ambiguous_sentinel",
        message: "Multiple firewall sentinel candidates were returned",
        retryable: false,
      });
    }
    const existing = candidates[0];
    if (existing) {
      if (!labelsMatchOwnership(existing.labels, spec.ownership)) {
        throw new ProviderServiceError({
          code: "hcloud_sentinel_ownership_mismatch",
          message: "Hetzner firewall sentinel ownership does not match",
          retryable: false,
        });
      }
      const actions = await this.#setFirewallRules(existing.id, rules);
      return {
        firewall: { ...existing, rules },
        actions: sanitizedActions(actions),
        created: false,
      };
    }

    const response = await this.#request<{
      firewall: HcloudFirewall;
      actions: HcloudAction[];
    }>("POST", "/firewalls", {
      name: spec.name,
      labels,
      rules,
    });
    return {
      firewall: response.firewall,
      actions: sanitizedActions(response.actions),
      created: true,
    };
  }

  async getFirewall(id: number): Promise<HcloudFirewall | null> {
    assertPositiveId(id, "firewall id");
    return this.#getOrNull<{ firewall: HcloudFirewall }>(`/firewalls/${id}`).then(
      (value) => value?.firewall ?? null,
    );
  }

  async proveFirewallWriteAccess(firewall: HcloudFirewall): Promise<HcloudAction[]> {
    return this.#setFirewallRules(firewall.id, firewall.rules);
  }

  async createPrimaryIp(input: {
    name: string;
    location: string;
    ownership: OwnershipLabels;
  }): Promise<CreatePrimaryIpResult> {
    assertDeterministicName(input.name);
    const response = await this.#request<{
      primary_ip: HcloudPrimaryIp;
      action: HcloudAction | null;
    }>("POST", "/primary_ips", {
      name: input.name,
      type: "ipv4",
      assignee_type: "server",
      auto_delete: true,
      location: input.location,
      labels: ownershipToLabels(input.ownership),
    });
    const primaryIp = validatedCreatedPrimaryIp(response.primary_ip, input);
    const resourceCreatedAt = validatedResourceCreatedAt(primaryIp.created);
    return {
      primaryIp,
      action: response.action === null ? null : sanitizedAction(response.action),
      ...(resourceCreatedAt ? { resourceCreatedAt } : {}),
    };
  }

  async createSshKey(input: {
    name: string;
    publicKey: string;
    ownership: OwnershipLabels;
  }): Promise<CreateSshKeyResult> {
    assertDeterministicName(input.name);
    if (
      input.publicKey.length > 16_384 ||
      !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]{16,}={0,2}(?: [^\r\n]{1,256})?$/u.test(
        input.publicKey,
      )
    ) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "Invalid SSH public key",
        retryable: false,
      });
    }
    const response = await this.#request<{ ssh_key: HcloudSshKey }>("POST", "/ssh_keys", {
      name: input.name,
      public_key: input.publicKey,
      labels: ownershipToLabels(input.ownership),
    });
    return { sshKey: validatedCreatedSshKey(response.ssh_key, input) };
  }

  async createServer(input: {
    name: string;
    serverType: string;
    systemImage: string;
    location: string;
    primaryIpv4Id: number;
    sshKeyId: number;
    firewallId: number;
    cloudInit: string;
    ownership: OwnershipLabels;
  }): Promise<CreateServerResult> {
    assertDeterministicName(input.name);
    assertPositiveId(input.primaryIpv4Id, "primary IPv4 id");
    assertPositiveId(input.sshKeyId, "SSH key id");
    assertPositiveId(input.firewallId, "firewall id");
    if (encoder.encode(input.cloudInit).byteLength > MAX_CLOUD_INIT_BYTES) {
      throw new ProviderServiceError({
        code: "hcloud_cloud_init_too_large",
        message: "Cloud-init exceeds the Hetzner 32 KiB limit",
        retryable: false,
      });
    }
    const response = await this.#request<{
      server: HcloudServer;
      action: HcloudAction;
      next_actions: HcloudAction[];
      root_password?: string | null;
    }>("POST", "/servers", {
      name: input.name,
      server_type: input.serverType,
      image: input.systemImage,
      location: input.location,
      ssh_keys: [input.sshKeyId],
      firewalls: [{ firewall: input.firewallId }],
      public_net: {
        enable_ipv4: true,
        enable_ipv6: false,
        ipv4: input.primaryIpv4Id,
      },
      start_after_create: true,
      backups: false,
      automount: false,
      user_data: input.cloudInit,
      labels: ownershipToLabels(input.ownership),
    });
    const server = validatedCreatedServer(response.server, input);
    const resourceCreatedAt = validatedResourceCreatedAt(server.created);
    // Deliberately do not propagate root_password into Intar state or RPC results.
    return {
      server,
      action: sanitizedAction(response.action),
      nextActions: sanitizedActions(response.next_actions),
      ...(resourceCreatedAt ? { resourceCreatedAt } : {}),
    };
  }

  async deleteResource(
    resourceKind: "server" | "primary_ip" | "ssh_key" | "firewall",
    id: number,
  ): Promise<DeleteResourceResult> {
    assertPositiveId(id, `${resourceKind} id`);
    const path =
      resourceKind === "server"
        ? `/servers/${id}`
        : resourceKind === "primary_ip"
          ? `/primary_ips/${id}`
          : resourceKind === "ssh_key"
            ? `/ssh_keys/${id}`
            : `/firewalls/${id}`;
    try {
      if (resourceKind === "server") {
        const response = await this.#request<{ action: HcloudAction }>("DELETE", path);
        return { action: sanitizedAction(response.action), alreadyMissing: false };
      }
      await this.#request<void>("DELETE", path);
      return { action: null, alreadyMissing: false };
    } catch (error) {
      if (error instanceof HcloudApiError && error.shape.providerStatus === 404) {
        return { action: null, alreadyMissing: true };
      }
      throw error;
    }
  }

  async rebootServer(serverId: number): Promise<HcloudAction> {
    assertPositiveId(serverId, "server id");
    const response = await this.#request<{ action: HcloudAction }>(
      "POST",
      `/servers/${serverId}/actions/reboot`,
      {},
    );
    return sanitizedAction(response.action);
  }

  async getAction(actionId: number): Promise<HcloudAction> {
    assertPositiveId(actionId, "action id");
    const response = await this.#request<{ action: HcloudAction }>("GET", `/actions/${actionId}`);
    return sanitizedAction(response.action);
  }

  async waitForAction(actionId: number, maxWaitMs = 0): Promise<HcloudAction> {
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 15_000) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "Action wait must be between 0 and 15000 milliseconds",
        retryable: false,
      });
    }
    const started = Date.now();
    let delayMs = 250;
    do {
      const action = await this.getAction(actionId);
      if (action.status !== "running" || Date.now() - started >= maxWaitMs) return action;
      await this.#delay(Math.min(delayMs, Math.max(0, maxWaitMs - (Date.now() - started))));
      delayMs = Math.min(delayMs * 2, 2_000);
    } while (true);
  }

  async reconcileResource(ref: ReconcileResourceRef): Promise<ResourceObservation> {
    assertDeterministicName(ref.deterministicName);
    const byId = ref.externalId ? await this.#resourceById(ref.resourceKind, ref.externalId) : null;
    if (byId) {
      if (!labelsMatchOwnership(byId.labels, ref.ownership)) {
        return { ref, status: "ownership_mismatch", externalId: byId.id };
      }
      return this.#presentObservation(ref, byId);
    }

    const candidates = await this.#resourcesByName(ref.resourceKind, ref.deterministicName);
    const owned = candidates.filter((candidate) =>
      labelsMatchOwnership(candidate.labels, ref.ownership),
    );
    if (owned.length > 1) return { ref, status: "ambiguous" };
    if (owned.length === 1) return this.#presentObservation(ref, owned[0]!);
    if (candidates.length > 0) return { ref, status: "ownership_mismatch" };
    return { ref, status: "missing" };
  }

  async #getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.#request<T>("GET", path);
    } catch (error) {
      if (error instanceof HcloudApiError && error.shape.providerStatus === 404) return null;
      throw error;
    }
  }

  async #setFirewallRules(id: number, rules: HcloudFirewallRule[]): Promise<HcloudAction[]> {
    assertPositiveId(id, "firewall id");
    const response = await this.#request<{ actions: HcloudAction[] }>(
      "POST",
      `/firewalls/${id}/actions/set_rules`,
      { rules },
    );
    if (!Array.isArray(response.actions)) {
      throw new ProviderServiceError({
        code: "hcloud_invalid_response",
        message: "Hetzner API returned an invalid firewall action response",
        retryable: true,
      });
    }
    return sanitizedActions(response.actions);
  }

  async #resourceById(
    kind: ReconcileResourceRef["resourceKind"],
    id: number,
  ): Promise<(HcloudServer | HcloudPrimaryIp | HcloudSshKey | HcloudFirewall) | null> {
    assertPositiveId(id, `${kind} id`);
    if (kind === "server") {
      return this.#getOrNull<{ server: HcloudServer }>(`/servers/${id}`).then(
        (value) => value?.server ?? null,
      );
    }
    if (kind === "primary_ip") {
      return this.#getOrNull<{ primary_ip: HcloudPrimaryIp }>(`/primary_ips/${id}`).then(
        (value) => value?.primary_ip ?? null,
      );
    }
    if (kind === "ssh_key") {
      return this.#getOrNull<{ ssh_key: HcloudSshKey }>(`/ssh_keys/${id}`).then(
        (value) => value?.ssh_key ?? null,
      );
    }
    return this.getFirewall(id);
  }

  async #resourcesByName(
    kind: ReconcileResourceRef["resourceKind"],
    name: string,
  ): Promise<Array<HcloudServer | HcloudPrimaryIp | HcloudSshKey | HcloudFirewall>> {
    const params = new URLSearchParams({ name });
    if (kind === "server") return this.#list<HcloudServer>("/servers", "servers", params);
    if (kind === "primary_ip") {
      return this.#list<HcloudPrimaryIp>("/primary_ips", "primary_ips", params);
    }
    if (kind === "ssh_key") return this.#list<HcloudSshKey>("/ssh_keys", "ssh_keys", params);
    return this.#list<HcloudFirewall>("/firewalls", "firewalls", params);
  }

  #presentObservation(
    ref: ReconcileResourceRef,
    resource: HcloudServer | HcloudPrimaryIp | HcloudSshKey | HcloudFirewall,
  ): ResourceObservation {
    if (ref.resourceKind === "server") {
      const server = resource as HcloudServer;
      const resourceCreatedAt = validatedResourceCreatedAt(server.created);
      return {
        ref,
        status: "present",
        externalId: server.id,
        ...(resourceCreatedAt ? { resourceCreatedAt } : {}),
        state: server.status,
        publicIpv4: server.public_net.ipv4.ip,
      };
    }
    if (ref.resourceKind === "primary_ip") {
      const primaryIp = resource as HcloudPrimaryIp;
      const resourceCreatedAt = validatedResourceCreatedAt(primaryIp.created);
      return {
        ref,
        status: "present",
        externalId: primaryIp.id,
        ...(resourceCreatedAt ? { resourceCreatedAt } : {}),
        state: primaryIp.assignee_id ? "assigned" : "unassigned",
        publicIpv4: primaryIp.ip,
      };
    }
    return { ref, status: "present", externalId: resource.id };
  }
}

export function inventoryCounts(inventory: ProjectInventory): Record<string, number> {
  return {
    servers: inventory.servers.length,
    primaryIps: inventory.primaryIps.length,
    floatingIps: inventory.floatingIps.length,
    firewalls: inventory.firewalls.length,
    networks: inventory.networks.length,
    volumes: inventory.volumes.length,
    placementGroups: inventory.placementGroups.length,
    snapshots: inventory.snapshots.length,
    sshKeys: inventory.sshKeys.length,
    loadBalancers: inventory.loadBalancers.length,
    certificates: inventory.certificates?.length ?? 0,
  };
}
