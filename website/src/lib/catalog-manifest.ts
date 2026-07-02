import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { vmScenarioProbes, vmScenarioVms, vmScenarios } from "@/db/schema";
import type { ImageKey, ScenarioManifestV1 } from "@/generated/catalog";

export interface CatalogScenarioRows {
  scenario: typeof vmScenarios.$inferInsert;
  vms: Array<typeof vmScenarioVms.$inferInsert>;
  probes: Array<typeof vmScenarioProbes.$inferInsert>;
}

export function catalogRowsFromScenarioManifest(
  manifest: ScenarioManifestV1,
  options: { nowUnixMs: number; enabled?: boolean } = { nowUnixMs: Date.now() },
): CatalogScenarioRows {
  const enabled = options.enabled ?? true;
  const scenarioId = manifest.scenario_id.trim();
  const vms = manifest.vms.map((vm, index) => {
    const scenarioVmId = scenarioVmRowId(scenarioId, vm.name);
    return {
      id: scenarioVmId,
      scenarioId,
      ordinal: index,
      vmName: vm.name,
      image: legacyImageName(vm.image_key),
      imageKeyJson: vm.image_key,
      imageSha256: vm.image_sha256,
      cpu: vm.cpu_count,
      memoryMib: vm.memory_mib,
      diskMib: vm.disk_mib,
    } satisfies typeof vmScenarioVms.$inferInsert;
  });

  return {
    scenario: {
      scenarioId,
      description: manifest.description,
      enabled,
      enabledAt: enabled ? options.nowUnixMs : null,
      createdAt: options.nowUnixMs,
      updatedAt: options.nowUnixMs,
    },
    vms,
    probes: manifest.vms.flatMap((vm) => {
      const scenarioVmId = scenarioVmRowId(scenarioId, vm.name);
      return vm.probes.map((probe, index) => ({
        id: scenarioProbeRowId(scenarioVmId, probe.id),
        scenarioId,
        scenarioVmId,
        ordinal: index,
        name: probe.id,
        description: probe.display_name,
        phase: probe.phase,
      }) satisfies typeof vmScenarioProbes.$inferInsert);
    }),
  };
}

export async function seedScenarioManifest(
  db: DrizzleD1Database,
  manifest: ScenarioManifestV1,
  options: { nowUnixMs?: number; enabled?: boolean } = {},
): Promise<CatalogScenarioRows> {
  const rowOptions: { nowUnixMs: number; enabled?: boolean } = {
    nowUnixMs: options.nowUnixMs ?? Date.now(),
  };
  if (options.enabled !== undefined) {
    rowOptions.enabled = options.enabled;
  }
  const rows = catalogRowsFromScenarioManifest(manifest, rowOptions);

  await db
    .insert(vmScenarios)
    .values(rows.scenario)
    .onConflictDoUpdate({
      target: vmScenarios.scenarioId,
      set: {
        description: rows.scenario.description,
        enabled: rows.scenario.enabled,
        enabledAt: rows.scenario.enabledAt,
        updatedAt: rows.scenario.updatedAt,
      },
    });

  await db
    .delete(vmScenarioProbes)
    .where(eq(vmScenarioProbes.scenarioId, rows.scenario.scenarioId));
  await db
    .delete(vmScenarioVms)
    .where(eq(vmScenarioVms.scenarioId, rows.scenario.scenarioId));

  if (rows.vms.length) {
    await db.insert(vmScenarioVms).values(rows.vms);
  }
  if (rows.probes.length) {
    await db.insert(vmScenarioProbes).values(rows.probes);
  }

  return rows;
}

function scenarioVmRowId(scenarioId: string, vmName: string): string {
  return `${scenarioId}:${vmName}`;
}

function scenarioProbeRowId(scenarioVmId: string, probeId: string): string {
  return `${scenarioVmId}:${probeId}`;
}

function legacyImageName(imageKey: ImageKey): string {
  return `${imageKey.scenario}-${imageKey.vm}-${imageKey.arch}.qcow2`;
}
