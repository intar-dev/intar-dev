import type { ImageKey, ScenarioHintManifestV3 } from "@/generated/catalog";

export type ScenarioDifficulty = "easy" | "medium" | "hard";

export function parseScenarioDifficulty(
  value: string,
): ScenarioDifficulty | null {
  return value === "easy" || value === "medium" || value === "hard"
    ? value
    : null;
}

export interface ScenarioProbeRecord {
  scenarioVmId: string;
  scenarioVmName: string;
  ordinal: number;
  name: string;
  description: string;
  title: string | null;
  bodyMarkdown: string | null;
  hints: ScenarioHintManifestV3[];
  phase: "boot" | "scenario";
  kind: string;
}

export interface ScenarioVmRecord {
  id: string;
  ordinal: number;
  name: string;
  image: string;
  imageKey: ImageKey | null;
  imageSha256: string | null;
  imageFormat: "raw_zstd";
  imageVirtualSizeBytes: number;
  kernelSha256: string;
  initrdSha256: string;
  bootCmdline: string;
  cpuMillis: number;
  vcpuCount: number;
  memoryMib: number;
  diskMib: number;
}

export type ScenarioVmDirectBootMetadata = Pick<
  ScenarioVmRecord,
  | "imageFormat"
  | "imageVirtualSizeBytes"
  | "kernelSha256"
  | "initrdSha256"
  | "bootCmdline"
>;

export function normalizeScenarioVmDirectBootMetadata(input: {
  imageFormat: string;
  imageVirtualSizeBytes: number;
  kernelSha256: string;
  initrdSha256: string;
  bootCmdline: string;
}): ScenarioVmDirectBootMetadata | null {
  if (input.imageFormat !== "raw_zstd") {
    return null;
  }
  if (
    !Number.isSafeInteger(input.imageVirtualSizeBytes) ||
    input.imageVirtualSizeBytes <= 0
  ) {
    return null;
  }
  const kernelSha256 = normalizeSha256Hex(input.kernelSha256);
  const initrdSha256 = normalizeSha256Hex(input.initrdSha256);
  const bootCmdline = input.bootCmdline.trim();
  if (
    !kernelSha256 ||
    !initrdSha256 ||
    !bootCmdline.split(/\s+/).includes("root=/dev/vda")
  ) {
    return null;
  }

  return {
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: input.imageVirtualSizeBytes,
    kernelSha256,
    initrdSha256,
    bootCmdline,
  };
}

export interface ScenarioBriefing {
  title: string;
  tagline: string;
  category: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  briefingMarkdown: string;
  tags: string[];
  objectives: ScenarioObjective[];
}

export interface ScenarioObjective {
  probeName: string;
  vmName: string;
  label: string;
  title: string | null;
  bodyMarkdown: string | null;
  hintCount: number;
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
  imageKey: ImageKey | null;
  imageSha256: string | null;
  hostname: string;
  resources: {
    cpuMillis: number;
    vcpuCount: number;
    memoryMib: number;
    diskMib: number;
  };
  leaseDurationSeconds: number;
  summary: ScenarioLaunchSummary;
}

const DEFAULT_VM_LEASE_DURATION_SECONDS = 3600;
export function deriveScenarioBriefing(input: {
  scenarioId: string;
  title: string;
  category: string;
  description: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  tags: string[];
  briefingMarkdown: string;
  probes: ScenarioProbeRecord[];
}): ScenarioBriefing {
  const objectives = input.probes
    .filter((probe) => probe.phase === "scenario")
    .map((probe, index) => ({
      probeName: probe.name,
      vmName: probe.scenarioVmName,
      label: probe.description.trim() || `Repair objective ${index + 1}`,
      title: probe.title,
      bodyMarkdown: probe.bodyMarkdown,
      hintCount: probe.hints.length,
    }));

  return {
    title: input.title.trim(),
    tagline: input.description.trim(),
    category: input.category.trim(),
    difficulty: input.difficulty,
    estimatedMinutes: input.estimatedMinutes,
    briefingMarkdown: normalizeMultilineText(input.briefingMarkdown),
    tags: input.tags,
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
    let bootCheckIndex = 0;
    let repairObjectiveIndex = 0;
    const probeDescriptors = input.probes
      .filter((probe) => probe.scenarioVmId === vm.id)
      .map((probe) => {
        const fallbackLabel =
          probe.phase === "boot"
            ? `Startup check ${++bootCheckIndex}`
            : `Repair objective ${++repairObjectiveIndex}`;
        return {
          id: buildScenarioProbeRuntimeId(probe),
          label: probe.description.trim() || fallbackLabel,
          kind: probe.kind,
          phase: probe.phase,
        };
      });
    const probePhaseMap = Object.fromEntries(
      probeDescriptors.map((probe) => [probe.id, probe.phase]),
    );

    return {
      scenarioVmId: vm.id,
      scenarioVmName,
      runtimeVmNamePrefix: slugify(`${scenarioSlug}-${scenarioVmName}`),
      image: vm.image.trim(),
      imageKey: vm.imageKey,
      imageSha256: vm.imageSha256,
      hostname: scenarioVmName,
      resources: {
        cpuMillis: vm.cpuMillis,
        vcpuCount: vm.vcpuCount,
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

function normalizeSha256Hex(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
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
