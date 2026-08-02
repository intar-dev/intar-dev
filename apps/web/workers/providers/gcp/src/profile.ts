import { ProviderServiceError } from "@intar/provider-worker-core";

export const GCP_CERTIFIED_MACHINE_TYPE = "e2-standard-4" as const;
export const GCP_DEBIAN_13_IMAGE_FAMILY =
  "projects/debian-cloud/global/images/family/debian-13" as const;
export const GCP_FRANKFURT_ZONE_FALLBACK = [
  "europe-west3-a",
  "europe-west3-b",
  "europe-west3-c",
] as const;

export function assertCertifiedProfileInput(input: {
  machineType: string;
  imageFamily?: string;
  zones: readonly string[];
}): void {
  if (input.machineType !== GCP_CERTIFIED_MACHINE_TYPE) {
    throw new ProviderServiceError({
      code: "gcp_machine_type_unsupported",
      message: "GCP profile must pin e2-standard-4",
      retryable: false,
    });
  }
  if (
    input.imageFamily !== undefined &&
    input.imageFamily !== GCP_DEBIAN_13_IMAGE_FAMILY
  ) {
    throw new ProviderServiceError({
      code: "gcp_image_unsupported",
      message: "GCP profile must resolve the Debian 13 image family",
      retryable: false,
    });
  }
  if (
    input.zones.length !== GCP_FRANKFURT_ZONE_FALLBACK.length ||
    input.zones.some((zone, index) => zone !== GCP_FRANKFURT_ZONE_FALLBACK[index])
  ) {
    throw new ProviderServiceError({
      code: "gcp_zone_fallback_invalid",
      message: "GCP profile must use the certified Frankfurt zone fallback order",
      retryable: false,
    });
  }
}
