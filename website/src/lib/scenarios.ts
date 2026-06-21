import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import type { ScenarioProbeRecord, ScenarioVmRecord } from "@/lib/scenario-model";
import { vmScenarioProbes, vmScenarioVms, vmScenarios } from "@/db/schema";

export interface ScenarioListRecord {
  scenarioId: string;
  description: string;
  probeCount: number;
  vmCount: number;
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
    .orderBy(vmScenarios.scenarioId);

  const output: ScenarioListRecord[] = [];
  for (const scenario of scenarios) {
    const detail = await loadScenario(scenario.scenarioId);
    if (!detail) continue;
    output.push({
      scenarioId: detail.scenarioId,
      description: detail.description,
      probeCount: detail.probeCount,
      vmCount: detail.vmCount,
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
): Promise<ScenarioDetailRecord | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(vmScenarios)
    .where(eq(vmScenarios.scenarioId, scenarioId))
    .limit(1);
  const scenario = rows[0];
  if (!scenario) {
    return null;
  }

  const [vms, probes] = await Promise.all([
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

  if (!vms.length) {
    return null;
  }

  return {
    scenarioId: scenario.scenarioId,
    description: scenario.description,
    probeCount: probes.length,
    vmCount: vms.length,
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
        phase: probe.phase === "boot" ? "boot" : "scenario",
      };
    }),
    vms: vms.map((vm) => ({
      id: vm.id,
      ordinal: vm.ordinal,
      name: vm.vmName,
      image: vm.image,
      cpu: vm.cpu,
      memoryMib: vm.memoryMib,
      diskMib: vm.diskMib,
    })),
  };
}

export async function listEnabledScenarios(): Promise<ScenarioDetailRecord[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(vmScenarios)
    .where(eq(vmScenarios.enabled, true))
    .orderBy(vmScenarios.scenarioId);

  const output: ScenarioDetailRecord[] = [];
  for (const row of rows) {
    const detail = await loadScenario(row.scenarioId);
    if (detail && detail.enabledAt !== null) {
      output.push(detail);
    }
  }

  return output;
}

export async function loadEnabledScenario(
  scenarioId: string,
): Promise<ScenarioDetailRecord | null> {
  const scenario = await loadScenario(scenarioId);
  if (!scenario || !scenario.enabled || scenario.enabledAt === null) {
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
