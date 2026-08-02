function encodedWorkshopAssetUrl(input: {
  sessionId: string;
  assetPath: string;
}): string {
  const encodedPath = input.assetPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/workshops/${encodeURIComponent(input.sessionId)}/assets/${encodedPath}`;
}

/**
 * Treat the canonical room projection as the asset ACL. It already removes
 * unreleased slides, module content, hints, solutions, and presenter notes for
 * each role, so asset authorization cannot drift from the content that refers
 * to an image.
 */
export function workshopProjectionReferencesAsset(
  projection: unknown,
  input: { sessionId: string; assetPath: string },
): boolean {
  const expectedUrl = encodedWorkshopAssetUrl(input);
  const pending: unknown[] = [projection];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      let offset = value.indexOf(expectedUrl);
      while (offset !== -1) {
        const boundary = value[offset + expectedUrl.length];
        if (boundary === undefined || boundary === ")" || /\s/.test(boundary)) {
          return true;
        }
        offset = value.indexOf(expectedUrl, offset + expectedUrl.length);
      }
      continue;
    }
    if (value === null || typeof value !== "object" || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
    } else {
      pending.push(...Object.values(value));
    }
  }
  return false;
}
