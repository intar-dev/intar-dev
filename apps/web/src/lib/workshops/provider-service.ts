import { env } from "cloudflare:workers";
import type {
  ProviderCapabilities,
  ProviderOperationResult,
  ProviderRpcResult,
  ServiceErrorShape,
} from "@intar/provider-contracts";
import type { RuntimeProviderKind } from "@intar/workshop-contracts";
import { appError } from "@/lib/app-error";
import {
  assertProviderCapabilities,
  type DirectCloudProviderKind,
} from "./provider-capabilities";

export interface ProviderServiceBinding {
  capabilities():
    | ProviderCapabilities<DirectCloudProviderKind>
    | Promise<ProviderCapabilities<DirectCloudProviderKind>>;
  connectProject<T = unknown>(request: unknown): Promise<ProviderRpcResult<T>>;
  rotateCredential<T = unknown>(request: unknown): Promise<ProviderRpcResult<T>>;
  runOperation(
    request: unknown,
  ): Promise<ProviderRpcResult<ProviderOperationResult>>;
}

export interface ProviderServiceEnvironment {
  HETZNER_PROVIDER_SERVICE?: ProviderServiceBinding;
  GCP_PROVIDER_SERVICE?: ProviderServiceBinding;
}

export async function requireProviderService(
  providerKind: DirectCloudProviderKind,
  environment: ProviderServiceEnvironment = env as unknown as ProviderServiceEnvironment,
): Promise<ProviderServiceBinding> {
  const binding = providerServiceBinding(providerKind, environment);
  let capabilities: unknown;
  try {
    capabilities = await binding.capabilities();
  } catch {
    throw serviceUnavailable(providerKind);
  }
  try {
    assertProviderCapabilities(providerKind, capabilities);
  } catch {
    throw appError(
      503,
      "runtime_provider_contract_incompatible",
      `${providerLabel(providerKind)} provider service contract is incompatible`,
    );
  }
  return binding;
}

export async function invokeProviderOperation<T = ProviderOperationResult>(
  providerKind: DirectCloudProviderKind,
  invocation: (binding: ProviderServiceBinding) => Promise<ProviderRpcResult<T>>,
  environment?: ProviderServiceEnvironment,
): Promise<T> {
  const binding = await requireProviderService(providerKind, environment);
  let result: ProviderRpcResult<T>;
  try {
    result = await invocation(binding);
  } catch {
    // A lost RPC response is ambiguous for create/delete calls. The generic
    // lifecycle persists its deterministic request before calling the service
    // and reconciles by provider ownership instead of blindly retrying.
    throw serviceUnavailable(providerKind);
  }
  if (result.ok) return result.value;
  throw providerServiceError(providerKind, result.error);
}

export function providerServiceBinding(
  providerKind: DirectCloudProviderKind,
  environment: ProviderServiceEnvironment = env as unknown as ProviderServiceEnvironment,
): ProviderServiceBinding {
  const binding =
    providerKind === "hetzner_cloud"
      ? environment.HETZNER_PROVIDER_SERVICE
      : environment.GCP_PROVIDER_SERVICE;
  if (!binding) throw serviceUnavailable(providerKind);
  return binding;
}

function providerServiceError(
  providerKind: DirectCloudProviderKind,
  error: ServiceErrorShape,
) {
  const status = error.providerStatus === 429 ? 429 : error.retryable ? 503 : 409;
  const code = /^[a-z0-9_]{3,80}$/u.test(error.code)
    ? error.code
    : "runtime_provider_error";
  const message =
    typeof error.message === "string" && error.message.length <= 300
      ? error.message
      : `${providerLabel(providerKind)} provider operation failed`;
  return appError(status, code, message);
}

function serviceUnavailable(providerKind: DirectCloudProviderKind) {
  return appError(
    503,
    "runtime_provider_service_unavailable",
    `${providerLabel(providerKind)} provider service is unavailable`,
  );
}

function providerLabel(providerKind: Exclude<RuntimeProviderKind, "agent_kvm">) {
  return providerKind === "hetzner_cloud" ? "Hetzner" : "GCP";
}
