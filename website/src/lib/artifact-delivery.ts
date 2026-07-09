const SAFE_INLINE_CONTENT_TYPES = new Map([
  ["text/plain", "text/plain; charset=utf-8"],
  ["application/json", "application/json; charset=utf-8"],
  ["application/x-asciicast", "application/x-asciicast; charset=utf-8"],
  [
    "application/vnd.asciicast+json",
    "application/vnd.asciicast+json; charset=utf-8",
  ],
]);

const ARTIFACT_CSP =
  "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";

export interface ArtifactDeliveryOptions {
  contentType: string;
  filename: string;
  forceDownload: boolean;
}

export function applyArtifactDeliveryHeaders(
  headers: Headers,
  options: ArtifactDeliveryOptions,
): void {
  const safeInlineContentType = SAFE_INLINE_CONTENT_TYPES.get(
    mediaType(options.contentType),
  );
  const disposition =
    options.forceDownload || !safeInlineContentType ? "attachment" : "inline";

  headers.set(
    "content-type",
    safeInlineContentType ?? "application/octet-stream",
  );
  headers.set(
    "content-disposition",
    buildContentDisposition(disposition, options.filename),
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", ARTIFACT_CSP);
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cache-control", "private, no-store");
}

function mediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function buildContentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
): string {
  const filenameWithoutControls = filename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const safeFilename = filenameWithoutControls || "artifact";
  const asciiFilename = safeFilename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encodedFilename = encodeURIComponent(safeFilename).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}
