import {
  PROVIDER_ADAPTER_OPERATIONS,
  PROVIDER_PROTOCOL_VERSION,
  type ProviderCapabilities,
} from "@intar/provider-contracts";

export function assertProviderCapabilities(
  capabilities: ProviderCapabilities,
  expectedKind: "hetzner_cloud" | "gcp_compute",
): void {
  if (capabilities.protocolVersion !== PROVIDER_PROTOCOL_VERSION) {
    throw new Error("Provider protocol version mismatch");
  }
  if (capabilities.providerKind !== expectedKind) {
    throw new Error("Provider kind mismatch");
  }
  const expected = new Set(PROVIDER_ADAPTER_OPERATIONS);
  const actual = new Set(capabilities.operations);
  if (actual.size !== capabilities.operations.length) {
    throw new Error("Provider capabilities contain duplicate operations");
  }
  for (const operation of expected) {
    if (!actual.has(operation)) {
      throw new Error(`Provider is missing required operation ${operation}`);
    }
  }
  for (const operation of actual) {
    if (!expected.has(operation)) {
      throw new Error(`Provider advertises unknown operation ${operation}`);
    }
  }
}

export function createMockFetcher(
  handler: (request: Request) => Response | Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(new Request(input, init)))) as typeof fetch;
}

export function assertSecretAbsent(value: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (serialized.includes(secret)) throw new Error("Provider result leaked a credential");
  }
}

export function assertRouteLessWorkerConfig(config: Record<string, unknown>): void {
  if (config.workers_dev !== false || config.preview_urls !== false) {
    throw new Error("Provider Worker must disable workers.dev and preview URLs");
  }
  if ("routes" in config && Array.isArray(config.routes) && config.routes.length > 0) {
    throw new Error("Provider Worker must not declare routes");
  }
}
