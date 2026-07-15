import type { HostStateReportV2 } from "@/generated/bridge";
import type { ImageKey } from "@/generated/catalog";

export interface RequiredScenarioImage {
  imageKey: ImageKey;
  imageSha256: string;
}

export function hostHasImagesReady(
  report: HostStateReportV2 | null | undefined,
  required: readonly RequiredScenarioImage[],
): boolean {
  if (required.length === 0) {
    return true;
  }
  if (!report) {
    return false;
  }

  return required.every((image) =>
    report.cached_images.some(
      (cached) =>
        cached.phase === "ready" &&
        cached.image_sha256 === image.imageSha256 &&
        imageKeyIdentity(cached.image_key) === imageKeyIdentity(image.imageKey),
    ),
  );
}

export function imageKeyIdentity(imageKey: ImageKey): string {
  return `${imageKey.scenario}:${imageKey.vm}:${imageKey.arch}`;
}
