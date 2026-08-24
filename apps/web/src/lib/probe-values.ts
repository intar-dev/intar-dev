// Typed rendering layer for the structured probe `value` payload that the
// agent already emits per kind (crates/intar-agent/src/kino_probe.rs
// normalize_probe). It arrives over the wire as camelCase JSON but is typed
// `unknown` in the run state; this module narrows it so the UI can explain
// *why* a probe is failing.

export interface FileExistsValue {
  path: string;
  exists: boolean;
}

export interface FileRegexCaptureValue {
  path: string;
  pattern: string;
  matched: boolean;
  fullMatch: string | null;
  captures: string[];
  fileContent: string | null;
}

export interface PortOpenValue {
  host: string;
  port: number;
  protocol: string;
  open: boolean;
  detail: string | null;
}

export interface ServiceValue {
  service: string;
  desiredState: string;
  actualState: string | null;
  stateSatisfied: boolean;
}

export interface K8sPodStateValue {
  namespace: string;
  selector: string;
  desiredState: string;
  matchedPods: number;
  matchingPodNames: string[];
  stateSatisfied: boolean;
}

export interface CommandJsonPathValue {
  argv: string[];
  jsonPath: string;
  expectedJson: string | null;
  matched: boolean;
  matchedValues: string[];
  stdout: string | null;
  stderr: string | null;
  exitCode: number;
}

export type ProbeValue =
  | { kind: "file_exists"; value: FileExistsValue }
  | { kind: "file_regex_capture"; value: FileRegexCaptureValue }
  | { kind: "port_open"; value: PortOpenValue }
  | { kind: "service"; value: ServiceValue }
  | { kind: "k8s_pod_state"; value: K8sPodStateValue }
  | { kind: "command_json_path"; value: CommandJsonPathValue };

export interface ProbeValueField {
  label: string;
  value: string;
}

// A probe can contain arbitrary command output or legacy values. Keep the
// diagnostic panel useful without letting one failed command dominate the run
// page or the operator console.
export const MAX_PROBE_FAILURE_PREVIEW_BYTES = 4 * 1024;
export const PROBE_FAILURE_PREVIEW_TRUNCATION_MARKER =
  "\n… preview truncated at 4 KiB.";

const MAX_PROBE_FIELD_BYTES = 512;
const PROBE_FIELD_TRUNCATION_MARKER = "… (truncated)";
const MAX_PROBE_LIST_ITEMS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function utf8ByteLength(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function clipUtf8(value: string, maxBytes: number) {
  let usedBytes = 0;
  let clipped = "";

  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (usedBytes + characterBytes > maxBytes) {
      return { value: clipped, truncated: true };
    }
    clipped += character;
    usedBytes += characterBytes;
  }

  return { value: clipped, truncated: false };
}

function truncateUtf8(
  value: string,
  maxBytes: number,
  marker: string,
): string {
  const initial = clipUtf8(value, maxBytes);
  if (!initial.truncated) return initial.value;

  const markerBytes = [...marker].reduce(
    (total, character) => total + utf8ByteLength(character),
    0,
  );
  const content = clipUtf8(value, Math.max(0, maxBytes - markerBytes));
  return `${content.value}${marker}`;
}

function formatField(value: string): string {
  return truncateUtf8(
    value,
    MAX_PROBE_FIELD_BYTES,
    PROBE_FIELD_TRUNCATION_MARKER,
  );
}

function formatStringList(values: string[], empty: string): string {
  if (!values.length) return empty;
  const visible = values
    .slice(0, MAX_PROBE_LIST_ITEMS)
    .map((value) =>
      truncateUtf8(
        value,
        MAX_PROBE_FIELD_BYTES / 2,
        PROBE_FIELD_TRUNCATION_MARKER,
      ),
    );
  const omitted = values.length - visible.length;
  return formatField(
    `${visible.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`,
  );
}

function formatLegacyProbeValue(
  value: unknown,
  maxBytes = MAX_PROBE_FIELD_BYTES,
  seen = new WeakSet<object>(),
  depth = 0,
): string {
  const marker = PROBE_FIELD_TRUNCATION_MARKER;
  try {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return truncateUtf8(value, maxBytes, marker);
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      return String(value);
    }
    if (typeof value !== "object") return `[${typeof value}]`;
    if (seen.has(value)) return "[circular value]";
    if (depth >= 3) return "{…}";

    seen.add(value);
    if (Array.isArray(value)) {
      const entries = value
        .slice(0, MAX_PROBE_LIST_ITEMS)
        .map((entry) =>
          formatLegacyProbeValue(entry, maxBytes, seen, depth + 1),
        );
      const omitted = value.length - entries.length;
      return truncateUtf8(
        `[${entries.join(", ")}${omitted > 0 ? ", …" : ""}]`,
        maxBytes,
        marker,
      );
    }

    const entries: string[] = [];
    let omitted = false;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (entries.length === MAX_PROBE_LIST_ITEMS) {
        omitted = true;
        break;
      }
      const renderedKey = truncateUtf8(key, 96, marker);
      entries.push(
        `${JSON.stringify(renderedKey)}: ${formatLegacyProbeValue(
          (value as Record<string, unknown>)[key],
          maxBytes,
          seen,
          depth + 1,
        )}`,
      );
    }
    return truncateUtf8(
      `{${entries.join(", ")}${omitted ? ", …" : ""}}`,
      maxBytes,
      marker,
    );
  } catch {
    return "[unavailable legacy value]";
  }
}

// Narrow the untyped probe value using the sibling `kind`. Returns null when the
// value is absent (e.g. during boot before the first probe report).
export function parseProbeValue(kind: string, value: unknown): ProbeValue | null {
  if (!isRecord(value)) return null;
  switch (kind) {
    case "file_exists":
      return {
        kind,
        value: { path: str(value.path), exists: bool(value.exists) },
      };
    case "file_regex_capture":
      return {
        kind,
        value: {
          path: str(value.path),
          pattern: str(value.pattern),
          matched: bool(value.matched),
          fullMatch: nullableStr(value.fullMatch),
          captures: strArray(value.captures),
          fileContent: nullableStr(value.fileContent),
        },
      };
    case "port_open":
      return {
        kind,
        value: {
          host: str(value.host),
          port: num(value.port),
          protocol: str(value.protocol),
          open: bool(value.open),
          detail: nullableStr(value.detail),
        },
      };
    case "service":
      return {
        kind,
        value: {
          service: str(value.service),
          desiredState: str(value.desiredState),
          actualState: nullableStr(value.actualState),
          stateSatisfied: bool(value.stateSatisfied),
        },
      };
    case "k8s_pod_state":
      return {
        kind,
        value: {
          namespace: str(value.namespace),
          selector: str(value.selector),
          desiredState: str(value.desiredState),
          matchedPods: num(value.matchedPods),
          matchingPodNames: strArray(value.matchingPodNames),
          stateSatisfied: bool(value.stateSatisfied),
        },
      };
    case "command_json_path":
      return {
        kind,
        value: {
          argv: strArray(value.argv),
          jsonPath: str(value.jsonPath),
          expectedJson: nullableStr(value.expectedJson),
          matched: bool(value.matched),
          matchedValues: strArray(value.matchedValues),
          stdout: nullableStr(value.stdout),
          stderr: nullableStr(value.stderr),
          exitCode: num(value.exitCode),
        },
      };
    default:
      return null;
  }
}

// Structured fields shared by the learner and operator views. In particular,
// command_json_path reports its parsed comparison rather than its JSON source
// document, which is often a large Kubernetes object.
export function formatProbeValueFields(
  kind: string,
  value: unknown,
): ProbeValueField[] {
  const parsed = parseProbeValue(kind, value);
  if (!parsed) {
    return [
      {
        label: "Value",
        value: formatLegacyProbeValue(value),
      },
    ];
  }

  switch (parsed.kind) {
    case "file_exists":
      return [
        {
          label: "Path",
          value: formatField(parsed.value.path || "Not reported"),
        },
        {
          label: "Observed",
          value: parsed.value.exists ? "Exists" : "Missing",
        },
      ];
    case "file_regex_capture":
      return [
        {
          label: "Path",
          value: formatField(parsed.value.path || "Not reported"),
        },
        {
          label: "Pattern",
          value: formatField(parsed.value.pattern || "Not reported"),
        },
        {
          label: "Observed",
          value: parsed.value.matched ? "Matched" : "Did not match",
        },
        ...(parsed.value.fullMatch
          ? [
              {
                label: "Full match",
                value: formatField(parsed.value.fullMatch),
              },
            ]
          : []),
        ...(parsed.value.captures.length
          ? [
              {
                label: "Captures",
                value: formatStringList(parsed.value.captures, "None"),
              },
            ]
          : []),
      ];
    case "port_open":
      return [
        {
          label: "Address",
          value: formatField(`${parsed.value.host}:${parsed.value.port}`),
        },
        {
          label: "Protocol",
          value: formatField(parsed.value.protocol || "Not reported"),
        },
        {
          label: "Observed",
          value: parsed.value.open ? "Open" : "Closed",
        },
      ];
    case "service":
      return [
        {
          label: "Service",
          value: formatField(parsed.value.service || "Not reported"),
        },
        {
          label: "Expected state",
          value: formatField(parsed.value.desiredState || "Not reported"),
        },
        {
          label: "Observed state",
          value: formatField(parsed.value.actualState ?? "Not reported"),
        },
      ];
    case "k8s_pod_state":
      return [
        {
          label: "Namespace",
          value: formatField(parsed.value.namespace || "Not reported"),
        },
        {
          label: "Selector",
          value: formatField(parsed.value.selector || "Not reported"),
        },
        {
          label: "Expected state",
          value: formatField(parsed.value.desiredState || "Not reported"),
        },
        { label: "Matching pods", value: String(parsed.value.matchedPods) },
        ...(parsed.value.matchingPodNames.length
          ? [
              {
                label: "Pod names",
                value: formatStringList(parsed.value.matchingPodNames, "None"),
              },
            ]
          : []),
      ];
    case "command_json_path":
      return [
        {
          label: "Command",
          value: formatStringList(parsed.value.argv, "Not reported"),
        },
        {
          label: "JSONPath",
          value: formatField(parsed.value.jsonPath || "Not reported"),
        },
        {
          label: "Expected",
          value: formatField(parsed.value.expectedJson ?? "Any matching value"),
        },
        {
          label: "Observed",
          value: formatStringList(
            parsed.value.matchedValues,
            "No matching values",
          ),
        },
        { label: "Exit code", value: String(parsed.value.exitCode) },
      ];
  }
}

function isValidCommandJsonPathMismatch(
  parsed: Extract<ProbeValue, { kind: "command_json_path" }>,
  error: string | null | undefined,
) {
  return !parsed.value.matched && parsed.value.exitCode === 0 && !error?.trim();
}

// Raw diagnostic data is only useful after a real probe failure. A successful
// command whose JSONPath does not match has already supplied a precise,
// structured expected/observed result above, so never repeat its raw stdout.
export function formatProbeFailurePreview(
  kind: string,
  value: unknown,
  error: string | null | undefined,
): string | null {
  const parsed = parseProbeValue(kind, value);
  if (
    parsed?.kind === "command_json_path" &&
    isValidCommandJsonPathMismatch(parsed, error)
  ) {
    return null;
  }

  const sections: Array<{ label: string; value: string }> = [];
  if (typeof error === "string" && error.trim()) {
    sections.push({ label: "Error", value: error });
  }

  switch (parsed?.kind) {
    case "command_json_path":
      if (parsed.value.stdout) {
        sections.push({ label: "stdout", value: parsed.value.stdout });
      }
      if (parsed.value.stderr) {
        sections.push({ label: "stderr", value: parsed.value.stderr });
      }
      break;
    case "file_regex_capture":
      if (parsed.value.fileContent) {
        sections.push({
          label: "File contents",
          value: parsed.value.fileContent,
        });
      }
      break;
    case "port_open":
      if (parsed.value.detail) {
        sections.push({ label: "Socket detail", value: parsed.value.detail });
      }
      break;
    case undefined:
      if (value !== null && value !== undefined) {
        sections.push({
          label: "Legacy value",
          value: formatLegacyProbeValue(
            value,
            MAX_PROBE_FAILURE_PREVIEW_BYTES,
          ),
        });
      }
      break;
  }

  if (!sections.length) return null;
  const boundedSections = sections.map(
    (section) =>
      `${section.label}:\n${clipUtf8(
        section.value,
        MAX_PROBE_FAILURE_PREVIEW_BYTES,
      ).value}`,
  );
  return truncateUtf8(
    boundedSections.join("\n\n"),
    MAX_PROBE_FAILURE_PREVIEW_BYTES,
    PROBE_FAILURE_PREVIEW_TRUNCATION_MARKER,
  );
}

// A one-line human summary of the probe's current value, for collapsed rows and
// the success overlay.
export function summarizeProbeValue(
  kind: string,
  value: unknown,
): string | null {
  const parsed = parseProbeValue(kind, value);
  if (!parsed) {
    return value === null || value === undefined
      ? null
      : formatLegacyProbeValue(value);
  }
  switch (parsed.kind) {
    case "file_exists":
      return parsed.value.exists
        ? `${formatField(parsed.value.path)} exists`
        : `${formatField(parsed.value.path)} is missing`;
    case "file_regex_capture":
      return parsed.value.matched
        ? `${formatField(parsed.value.pattern)} matched`
        : `${formatField(parsed.value.pattern)} did not match`;
    case "port_open":
      return `${formatField(parsed.value.host)}:${parsed.value.port}/${formatField(parsed.value.protocol)} ${
        parsed.value.open ? "open" : "closed"
      }`;
    case "service":
      return `${formatField(parsed.value.service)}: ${formatField(
        parsed.value.actualState ?? "unknown",
      )} (want ${formatField(parsed.value.desiredState)})`;
    case "k8s_pod_state":
      return `${parsed.value.matchedPods} pod(s) match ${formatField(
        parsed.value.selector,
      )} (want ${formatField(parsed.value.desiredState)})`;
    case "command_json_path":
      return parsed.value.matched
        ? `${formatField(parsed.value.jsonPath)} matched`
        : `${formatField(parsed.value.jsonPath)} did not match (exit ${parsed.value.exitCode})`;
  }
}
