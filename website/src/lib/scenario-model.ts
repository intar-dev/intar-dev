export type ScenarioDifficulty = "easy" | "medium" | "hard";

export interface ScenarioProbeRecord {
  scenarioVmId: string;
  scenarioVmName: string;
  ordinal: number;
  name: string;
  description: string;
  phase: "boot" | "scenario";
}

export interface ScenarioVmRecord {
  id: string;
  ordinal: number;
  name: string;
  image: string;
  cpu: number;
  memoryMib: number;
  diskMib: number;
}

export interface ScenarioBriefing {
  title: string;
  tagline: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  briefingMarkdown: string;
  objectives: string[];
}

export interface ScenarioLaunchProbeDescriptor {
  id: string;
  label: string;
  kind: string;
  phase: "boot" | "scenario";
}

export interface ScenarioLaunchSummary {
  scenarioVmName: string;
  hostname: string;
  probePhaseMap: Record<string, "boot" | "scenario">;
  probeDescriptors: ScenarioLaunchProbeDescriptor[];
}

export interface ScenarioLaunchSpec {
  scenarioVmId: string;
  scenarioVmName: string;
  runtimeVmNamePrefix: string;
  image: string;
  hostname: string;
  resources: {
    vcpus: number;
    memoryMib: number;
    diskMib: number;
  };
  leaseDurationSeconds: number;
  summary: ScenarioLaunchSummary;
}

const DEFAULT_VM_LEASE_DURATION_SECONDS = 3600;
const DEFAULT_SCENARIO_TAGLINE = "";

export function deriveScenarioBriefing(input: {
  scenarioId: string;
  description: string;
  probes: ScenarioProbeRecord[];
}): ScenarioBriefing {
  const title = input.scenarioId.trim() || "Untitled scenario";
  const description = normalizeMultilineText(input.description);
  const tagline = firstNonEmptyLine(description);
  const multiVm = new Set(input.probes.map((probe) => probe.scenarioVmId)).size > 1;
  const objectives = input.probes
    .filter((probe) => probe.phase === "scenario")
    .map((probe) => {
      const detail = probe.description.trim() || probe.name.trim();
      if (!detail) {
        return "";
      }
      return multiVm ? `${probe.scenarioVmName}: ${detail}` : detail;
    })
    .filter(Boolean);

  return {
    title,
    tagline: tagline || DEFAULT_SCENARIO_TAGLINE,
    difficulty: "easy",
    estimatedMinutes: Math.max(10, objectives.length * 5 || 15),
    briefingMarkdown: description,
    objectives,
  };
}

export function buildScenarioLaunchSpecs(input: {
  scenarioId: string;
  probes: ScenarioProbeRecord[];
  vms: ScenarioVmRecord[];
}): ScenarioLaunchSpec[] {
  const scenarioSlug = slugify(input.scenarioId);

  return input.vms.map((vm) => {
    const scenarioVmName = slugify(vm.name);
    const probeDescriptors = input.probes
      .filter((probe) => probe.scenarioVmId === vm.id)
      .map((probe) => ({
        id: buildScenarioProbeRuntimeId(probe),
        label:
          probe.description.trim() ||
          probe.name.trim() ||
          `Probe ${probe.ordinal + 1}`,
        kind: "probe",
        phase: probe.phase,
      }));
    const probePhaseMap = Object.fromEntries(
      probeDescriptors.map((probe) => [probe.id, probe.phase]),
    );

    return {
      scenarioVmId: vm.id,
      scenarioVmName,
      runtimeVmNamePrefix: slugify(`${scenarioSlug}-${scenarioVmName}`),
      image: vm.image.trim(),
      hostname: scenarioVmName,
      resources: {
        vcpus: vm.cpu,
        memoryMib: vm.memoryMib,
        diskMib: vm.diskMib,
      },
      leaseDurationSeconds: DEFAULT_VM_LEASE_DURATION_SECONDS,
      summary: {
        scenarioVmName,
        hostname: scenarioVmName,
        probePhaseMap,
        probeDescriptors,
      },
    };
  });
}

export function parseScenarioLaunchSummary(
  value: string | null | undefined,
): ScenarioLaunchSummary | null {
  const parsed = parseJson<Record<string, unknown>>(value ?? null, null);
  if (!parsed) {
    return null;
  }

  const scenarioVmName =
    typeof parsed.scenarioVmName === "string" ? parsed.scenarioVmName : null;
  const hostname = typeof parsed.hostname === "string" ? parsed.hostname : null;
  if (!scenarioVmName || !hostname) {
    return null;
  }

  const probePhaseMap =
    typeof parsed.probePhaseMap === "object" &&
    parsed.probePhaseMap !== null &&
    !Array.isArray(parsed.probePhaseMap)
      ? Object.fromEntries(
          Object.entries(parsed.probePhaseMap as Record<string, unknown>).filter(
            ([, phase]) => phase === "boot" || phase === "scenario",
          ),
        )
      : {};
  const probeDescriptors = Array.isArray(parsed.probeDescriptors)
    ? parsed.probeDescriptors.flatMap((item) => {
        if (
          typeof item !== "object" ||
          item === null ||
          Array.isArray(item) ||
          typeof item.id !== "string" ||
          typeof item.label !== "string" ||
          typeof item.kind !== "string" ||
          (item.phase !== "boot" && item.phase !== "scenario")
        ) {
          return [];
        }

        return [
          {
            id: item.id,
            label: item.label,
            kind: item.kind,
            phase: item.phase,
          } satisfies ScenarioLaunchProbeDescriptor,
        ];
      })
    : [];
  return {
    scenarioVmName,
    hostname,
    probePhaseMap: probePhaseMap as Record<string, "boot" | "scenario">,
    probeDescriptors,
  };
}

function buildScenarioProbeRuntimeId(probe: ScenarioProbeRecord) {
  return (
    probe.name.trim().slice(0, 63) ||
    `scenario-probe-${probe.ordinal + 1}`.slice(0, 63)
  );
}

function normalizeMultilineText(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function firstNonEmptyLine(value: string) {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseJson<T>(value: string | null, fallback: T | null): T | null {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function slugify(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "scenario";
}
