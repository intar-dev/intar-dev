import { env } from "cloudflare:workers";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import type {
  ScenarioDifficulty,
  ScenarioProbeRecord,
  ScenarioRequiredResources,
  ScenarioVmRecord,
} from "@/lib/scenario-model";
import {
  aggregateScenarioRequiredResources,
  normalizeScenarioVmDirectBootMetadata,
  parseScenarioDifficulty,
} from "@/lib/scenario-model";
import type { ScenarioHintManifestV3 } from "@/generated/catalog";
import { vmScenarioProbes, vmScenarioVms, vmScenarios } from "@/db/schema";

export interface ScenarioListRecord {
  scenarioId: string;
  organizationId: string | null;
  title: string;
  category: string;
  description: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  tags: string[];
  briefingMarkdown: string;
  solutionMarkdown: string;
  hints: ScenarioHintManifestV3[];
  probeCount: number;
  vmCount: number;
  requiredResources: ScenarioRequiredResources;
  enabled: boolean;
  enabledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScenarioDetailRecord extends ScenarioListRecord {
  probes: ScenarioProbeRecord[];
  vms: ScenarioVmRecord[];
}

export async function listScenarios(): Promise<ScenarioListRecord[]> {
  const db = drizzle(env.DB);
  const scenarios = await db
    .select()
    .from(vmScenarios)
    .where(isNull(vmScenarios.organizationId))
    .orderBy(vmScenarios.scenarioId);

  const output: ScenarioListRecord[] = [];
  for (const scenario of scenarios) {
    const detail = await loadScenario(scenario.scenarioId);
    if (!detail) continue;
    output.push({
      scenarioId: detail.scenarioId,
      organizationId: detail.organizationId,
      title: detail.title,
      category: detail.category,
      description: detail.description,
      difficulty: detail.difficulty,
      estimatedMinutes: detail.estimatedMinutes,
      tags: detail.tags,
      briefingMarkdown: detail.briefingMarkdown,
      solutionMarkdown: detail.solutionMarkdown,
      hints: detail.hints,
      probeCount: detail.probeCount,
      vmCount: detail.vmCount,
      requiredResources: detail.requiredResources,
      enabled: detail.enabled,
      enabledAt: detail.enabledAt,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    });
  }

  return output;
}

export async function loadScenario(
  scenarioId: string,
  options?: { organizationId?: string | null },
): Promise<ScenarioDetailRecord | null> {
  const db = drizzle(env.DB);
  const organizationId = options?.organizationId ?? null;
  const [rows, vms, probes] = await db.batch([
    db
      .select()
      .from(vmScenarios)
      .where(
        and(
          eq(vmScenarios.scenarioId, scenarioId),
          organizationId
            ? or(
                isNull(vmScenarios.organizationId),
                eq(vmScenarios.organizationId, organizationId),
              )
            : isNull(vmScenarios.organizationId),
        ),
      )
      .limit(1),
    db
      .select()
      .from(vmScenarioVms)
      .where(eq(vmScenarioVms.scenarioId, scenarioId))
      .orderBy(asc(vmScenarioVms.ordinal)),
    db
      .select()
      .from(vmScenarioProbes)
      .where(eq(vmScenarioProbes.scenarioId, scenarioId))
      .orderBy(asc(vmScenarioProbes.ordinal)),
  ]);
  const scenario = rows[0];
  if (!scenario) {
    return null;
  }

  if (!vms.length) {
    return null;
  }

  const scenarioVms: ScenarioVmRecord[] = vms.map((vm) => {
    const directBoot = normalizeScenarioVmDirectBootMetadata({
      imageFormat: vm.imageFormat,
      imageVirtualSizeBytes: vm.imageVirtualSizeBytes,
      kernelSha256: vm.kernelSha256,
      initrdSha256: vm.initrdSha256,
      bootCmdline: vm.bootCmdline,
    });
    if (!directBoot) {
      invalidDirectBootMetadata(vm);
    }
    return {
      id: vm.id,
      ordinal: vm.ordinal,
      name: vm.vmName,
      image: vm.image,
      imageKey: vm.imageKeyJson ?? null,
      imageSha256:
        typeof vm.imageSha256 === "string" && vm.imageSha256.trim()
          ? vm.imageSha256.trim()
          : null,
      ...directBoot,
      cpuMillis: vm.cpuMillis,
      vcpuCount: vm.vcpuCount,
      memoryMib: vm.memoryMib,
      diskMib: vm.diskMib,
    };
  });

  return {
    scenarioId: scenario.scenarioId,
    organizationId: scenario.organizationId,
    title: scenario.title,
    category: scenario.category,
    description: scenario.description,
    difficulty: scenarioDifficulty(scenario.scenarioId, scenario.difficulty),
    estimatedMinutes: scenario.estimatedMinutes,
    tags: scenario.tagsJson,
    briefingMarkdown: scenario.briefingMarkdown,
    solutionMarkdown: scenario.solutionMarkdown,
    hints: scenario.hintsJson,
    probeCount: probes.length,
    vmCount: scenarioVms.length,
    requiredResources: aggregateScenarioRequiredResources(scenarioVms),
    enabled: scenario.enabled,
    enabledAt: scenario.enabledAt,
    createdAt: scenario.createdAt,
    updatedAt: scenario.updatedAt,
    probes: probes.map((probe) => {
      const vm = vms.find((candidate) => candidate.id === probe.scenarioVmId);
      return {
        scenarioVmId: probe.scenarioVmId,
        scenarioVmName: vm?.vmName ?? probe.scenarioVmId,
        ordinal: probe.ordinal,
        name: probe.name,
        description: probe.description,
        title: probe.title,
        bodyMarkdown: probe.bodyMarkdown,
        hints: probe.hintsJson,
        phase: probe.phase === "boot" ? "boot" : "scenario",
        kind: probe.kind,
      };
    }),
    vms: scenarioVms,
  };
}

function scenarioDifficulty(
  scenarioId: string,
  value: string,
): ScenarioDifficulty {
  const parsed = parseScenarioDifficulty(value);
  if (parsed) {
    return parsed;
  }
  throw appError(
    500,
    "scenario_catalog_invalid",
    `scenario ${scenarioId} has invalid difficulty`,
  );
}

function invalidDirectBootMetadata(
  vm: typeof vmScenarioVms.$inferSelect,
): never {
  throw appError(
    500,
    "scenario_catalog_invalid",
    `scenario VM ${vm.scenarioId}/${vm.vmName} has invalid direct-boot image metadata`,
  );
}

export async function listEnabledScenarios(options?: {
  organizationId?: string | null;
}): Promise<ScenarioDetailRecord[]> {
  const db = drizzle(env.DB);
  const organizationId = options?.organizationId ?? null;
  const rows = await db
    .select()
    .from(vmScenarios)
    .where(
      and(
        eq(vmScenarios.enabled, true),
        organizationId
          ? or(
              isNull(vmScenarios.organizationId),
              eq(vmScenarios.organizationId, organizationId),
            )
          : isNull(vmScenarios.organizationId),
      ),
    )
    .orderBy(vmScenarios.scenarioId);

  const output: ScenarioDetailRecord[] = [];
  for (const row of rows) {
    const detail = await loadScenario(row.scenarioId, { organizationId });
    if (detail && detail.enabledAt !== null) {
      output.push(detail);
    }
  }

  return output;
}

export async function loadEnabledScenario(
  scenarioId: string,
  options?: { organizationId?: string | null },
): Promise<ScenarioDetailRecord | null> {
  const organizationId = options?.organizationId ?? null;
  const scenario = await loadScenario(scenarioId, { organizationId });
  if (!scenario || !scenario.enabled || scenario.enabledAt === null) {
    return null;
  }
  if (
    scenario.organizationId !== null &&
    scenario.organizationId !== organizationId
  ) {
    return null;
  }
  return scenario;
}

export async function enableScenario(params: {
  scenarioId: string;
}): Promise<ScenarioDetailRecord> {
  const scenario = await loadScenario(params.scenarioId);
  if (!scenario) {
    throw appError(404, "scenario_not_found", "scenario not found");
  }

  const nowMs = Date.now();
  const db = drizzle(env.DB);
  await db
    .update(vmScenarios)
    .set({
      enabled: true,
      enabledAt: nowMs,
      updatedAt: nowMs,
    })
    .where(eq(vmScenarios.scenarioId, params.scenarioId));

  const updated = await loadScenario(params.scenarioId);
  if (!updated) {
    throw appError(500, "scenario_reload_failed", "failed to reload scenario");
  }
  return updated;
}

export async function disableScenario(params: {
  scenarioId: string;
}): Promise<ScenarioDetailRecord> {
  const scenario = await loadScenario(params.scenarioId);
  if (!scenario) {
    throw appError(404, "scenario_not_found", "scenario not found");
  }

  const nowMs = Date.now();
  const db = drizzle(env.DB);
  await db
    .update(vmScenarios)
    .set({
      enabled: false,
      enabledAt: null,
      updatedAt: nowMs,
    })
    .where(eq(vmScenarios.scenarioId, params.scenarioId));

  const updated = await loadScenario(params.scenarioId);
  if (!updated) {
    throw appError(500, "scenario_reload_failed", "failed to reload scenario");
  }
  return updated;
}
