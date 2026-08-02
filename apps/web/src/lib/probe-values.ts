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

// A one-line human summary of the probe's current value, for collapsed rows and
// the success overlay.
export function summarizeProbeValue(
  kind: string,
  value: unknown,
): string | null {
  const parsed = parseProbeValue(kind, value);
  if (!parsed) return null;
  switch (parsed.kind) {
    case "file_exists":
      return parsed.value.exists
        ? `${parsed.value.path} exists`
        : `${parsed.value.path} is missing`;
    case "file_regex_capture":
      return parsed.value.matched
        ? `${parsed.value.pattern} matched`
        : `${parsed.value.pattern} did not match`;
    case "port_open":
      return `${parsed.value.host}:${parsed.value.port}/${parsed.value.protocol} ${
        parsed.value.open ? "open" : "closed"
      }`;
    case "service":
      return `${parsed.value.service}: ${parsed.value.actualState ?? "unknown"} (want ${parsed.value.desiredState})`;
    case "k8s_pod_state":
      return `${parsed.value.matchedPods} pod(s) match ${parsed.value.selector} (want ${parsed.value.desiredState})`;
    case "command_json_path":
      return parsed.value.matched
        ? `${parsed.value.jsonPath} matched`
        : `${parsed.value.jsonPath} did not match (exit ${parsed.value.exitCode})`;
    default:
      return null;
  }
}
