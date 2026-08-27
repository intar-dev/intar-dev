const CANONICAL_RESOURCE_ID_SEGMENT =
  /^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*$/;

/**
 * Resource IDs in these routes are minted by the server from CUID2 values,
 * ordinals, and structural colons. Colons are legal canonical path bytes and
 * must stay literal: the Worker rejects percent-encoded path bytes before
 * Astro route matching.
 */
export function scenarioRunArtifactContentPath(
  runId: string,
  artifactId: string,
): string {
  return `/api/runs/${canonicalResourceIdSegment(runId)}/artifacts/${canonicalResourceIdSegment(artifactId)}/content`;
}

export function adminScenarioRunArtifactContentPath(
  runId: string,
  artifactId: string,
): string {
  const run = canonicalResourceIdSegment(runId);
  const artifact = canonicalResourceIdSegment(artifactId);
  return `/api/admin/runs/${run}/artifacts/${artifact}/content`;
}

export function workshopArtifactContentPath(
  sessionId: string,
  artifactId: string,
): string {
  return `/api/workshops/${canonicalResourceIdSegment(sessionId)}/artifacts/${canonicalResourceIdSegment(artifactId)}/content`;
}

export function workshopTerminalTranscriptPath(
  sessionId: string,
  terminalSessionId: string,
): string {
  return `/api/workshops/${canonicalResourceIdSegment(sessionId)}/terminal-sessions/${canonicalResourceIdSegment(terminalSessionId)}/transcript`;
}

function canonicalResourceIdSegment(value: string): string {
  if (!CANONICAL_RESOURCE_ID_SEGMENT.test(value)) {
    throw new TypeError("resource id is not a canonical path segment");
  }
  return value;
}
