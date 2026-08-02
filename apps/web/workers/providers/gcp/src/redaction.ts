import type { ServiceErrorShape } from "@intar/provider-contracts";
import { safeProviderError } from "@intar/provider-worker-core";

export function safeUnknownError(error: unknown): ServiceErrorShape {
  return safeProviderError(error, {
    code: "provider_internal_error",
    message: "GCP provider operation failed",
  });
}
