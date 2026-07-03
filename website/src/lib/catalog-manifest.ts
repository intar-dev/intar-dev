import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { vmScenarioProbes, vmScenarioVms, vmScenarios } from "@/db/schema";
import type {
  ImageFormat,
  ImageKey,
  ScenarioManifestV2,
} from "@/generated/catalog";

export interface CatalogScenarioRows {
  scenario: typeof vmScenarios.$inferInsert;
  vms: Array<typeof vmScenarioVms.$inferInsert>;
  probes: Array<typeof vmScenarioProbes.$inferInsert>;
}

export function catalogRowsFromScenarioManifest(
  manifest: ScenarioManifestV2,
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
      image: imageName(vm.image_key, vm.image_format),
      imageKeyJson: vm.image_key,
      imageSha256: vm.image_sha256,
      imageFormat: vm.image_format,
      imageVirtualSizeBytes: vm.image_virtual_size_bytes,
      kernelSha256: vm.boot.kernel_sha256,
      initrdSha256: vm.boot.initrd_sha256,
      bootCmdline: vm.boot.cmdline,
      cpu: vm.cpu_count,
      memoryMib: vm.memory_mib,
      diskMib: vm.disk_mib,
    } satisfies typeof vmScenarioVms.$inferInsert;
  });

  return {
    scenario: {
      scenarioId,
      title: manifest.title,
      description: manifest.description,
      difficulty: manifest.difficulty,
      estimatedMinutes: manifest.estimated_minutes,
      tagsJson: manifest.tags,
      briefingMarkdown: manifest.briefing_markdown,
      solutionMarkdown: manifest.solution_markdown,
      hintsJson: manifest.hints,
      enabled,
      enabledAt: enabled ? options.nowUnixMs : null,
      createdAt: options.nowUnixMs,
      updatedAt: options.nowUnixMs,
    },
    vms,
    probes: manifest.vms.flatMap((vm) => {
      const scenarioVmId = scenarioVmRowId(scenarioId, vm.name);
      return vm.probes.map(
        (probe, index) =>
          ({
            id: scenarioProbeRowId(scenarioVmId, probe.id),
            scenarioId,
            scenarioVmId,
            ordinal: index,
            name: probe.id,
            description: probe.display_name,
            title: probe.title ?? null,
            bodyMarkdown: probe.body_markdown ?? null,
            hintsJson: probe.hints,
            phase: probe.phase,
          }) satisfies typeof vmScenarioProbes.$inferInsert,
      );
    }),
  };
}

export async function seedScenarioManifest(
  db: DrizzleD1Database,
  manifest: ScenarioManifestV2,
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
        title: rows.scenario.title,
        description: rows.scenario.description,
        difficulty: rows.scenario.difficulty,
        estimatedMinutes: rows.scenario.estimatedMinutes,
        tagsJson: rows.scenario.tagsJson,
        briefingMarkdown: rows.scenario.briefingMarkdown,
        solutionMarkdown: rows.scenario.solutionMarkdown,
        hintsJson: rows.scenario.hintsJson,
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

function imageName(imageKey: ImageKey, format: ImageFormat): string {
  const extension =
    format === "raw_zstd" ? "raw.zst" : exhaustiveFormat(format);
  return `${imageKey.scenario}-${imageKey.vm}-${imageKey.arch}.${extension}`;
}

function exhaustiveFormat(format: never): never {
  throw new Error(`unsupported image format '${format}'`);
}
