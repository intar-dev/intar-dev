import { isRecord } from "@/control-plane/image-registry/shared";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function workshopPresentationAssetPaths(
  compiledManifest: Record<string, unknown>,
): string[] {
  const manifest = isRecord(compiledManifest.manifest)
    ? compiledManifest.manifest
    : null;
  const presentation =
    manifest && isRecord(manifest.presentation) ? manifest.presentation : null;
  const assets = presentation?.assets;
  if (!Array.isArray(assets)) return [];
  return assets.flatMap((asset) =>
    typeof asset === "string" && isSafeWorkshopAssetPath(asset) ? [asset] : [],
  );
}

export function workshopAssetObjectKey(input: {
  organizationId: string;
  contentHash: string;
  assetPath: string;
}): string {
  if (!isSafeWorkshopAssetPath(input.assetPath)) {
    throw new Error("invalid workshop asset path");
  }
  return `workshops/assets/${input.organizationId}/${input.contentHash}/${input.assetPath}`;
}

export function isSafeWorkshopAssetPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every(
    (part) => part !== "." && part !== ".." && SAFE_SEGMENT.test(part),
  );
}

export function workshopAssetContentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
