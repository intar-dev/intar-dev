import type { ServiceErrorShape } from "./contracts";
import {
  ProviderServiceError,
  redactString,
  safeProviderError,
} from "@intar/provider-worker-core";

export { ProviderServiceError, redactString };

export function safeUnknownError(error: unknown): ServiceErrorShape {
  return safeProviderError(error, {
    code: "provider_internal_error",
    message: "Hetzner provider operation failed",
  });
}
