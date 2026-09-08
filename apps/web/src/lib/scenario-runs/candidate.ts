import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { aliasedTable } from "drizzle-orm/alias";
import {
  imageBuildBundles,
  imageBuilds,
  scenarioCatalogCandidates,
} from "@/db/schema";
import {
  aggregateScenarioRequiredResources,
  normalizeScenarioVmDirectBootMetadata,
  parseScenarioDifficulty,
  type ScenarioProbeRecord,
  type ScenarioVmRecord,
} from "@/lib/scenario-model";
import type { ScenarioDetailRecord } from "@/lib/scenarios";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import { validateManifest } from "@/control-plane/image-registry/publish-payload";
import {
  scenarioRunLaunchSourceFromDetail,
  type ScenarioRunLaunchSource,
} from "./storage";

const candidateBundles = aliasedTable(
  imageBuildBundles,
  "candidate_proof_bundles",
);
const sourceBundles = aliasedTable(
  imageBuildBundles,
  "candidate_proof_source_bundles",
);

export async function loadCandidateScenarioRunSource(
  db: DrizzleD1Database,
  input: {
    revision: string;
    buildId: string;
    scenarioId: string;
    organizationId: string | null;
  },
): Promise<ScenarioRunLaunchSource | null> {
  const scope = input.organizationId
    ? and(
        eq(scenarioCatalogCandidates.organizationId, input.organizationId),
        eq(imageBuilds.organizationId, input.organizationId),
        eq(candidateBundles.organizationId, input.organizationId),
        eq(sourceBundles.organizationId, input.organizationId),
      )
    : and(
        isNull(scenarioCatalogCandidates.organizationId),
        isNull(imageBuilds.organizationId),
        isNull(candidateBundles.organizationId),
        isNull(sourceBundles.organizationId),
      );
  const [candidate] = await db
    .select({
      manifest: scenarioCatalogCandidates.manifestJson,
      candidateBuildId: scenarioCatalogCandidates.buildId,
      candidateCreatedAt: scenarioCatalogCandidates.createdAt,
      candidateUpdatedAt: scenarioCatalogCandidates.updatedAt,
      buildArch: imageBuilds.arch,
      buildContentHash: imageBuilds.contentHash,
      buildManifest: imageBuilds.publishedManifestJson,
      candidateBundleMeta: candidateBundles.metaJson,
      sourceBundleMeta: sourceBundles.metaJson,
    })
    .from(scenarioCatalogCandidates)
    .innerJoin(
      imageBuilds,
      and(
        eq(imageBuilds.id, scenarioCatalogCandidates.buildId),
        eq(imageBuilds.id, input.buildId),
      ),
    )
    .innerJoin(
      candidateBundles,
      eq(candidateBundles.rev, scenarioCatalogCandidates.revision),
    )
    .innerJoin(sourceBundles, eq(sourceBundles.rev, imageBuilds.rev))
    .where(
      and(
        eq(scenarioCatalogCandidates.revision, input.revision),
        eq(scenarioCatalogCandidates.buildId, input.buildId),
        eq(scenarioCatalogCandidates.scenarioId, input.scenarioId),
        eq(imageBuilds.scenarioId, input.scenarioId),
        eq(imageBuilds.status, "succeeded"),
        scope,
      ),
    )
    .limit(1);
  if (
    !candidate ||
    candidate.candidateBuildId !== input.buildId ||
    !hasExactBundleScenario(candidate.candidateBundleMeta, {
      scenarioId: input.scenarioId,
      arch: candidate.buildArch,
      contentHash: candidate.buildContentHash,
      requireCandidateChannel: true,
    }) ||
    !hasExactBundleScenario(candidate.sourceBundleMeta, {
      scenarioId: input.scenarioId,
      arch: candidate.buildArch,
      contentHash: candidate.buildContentHash,
      requireCandidateChannel: false,
    }) ||
    !candidate.buildManifest ||
    !isReadyCandidateManifest(candidate.manifest, candidate.buildManifest, input.scenarioId) ||
    !candidate.manifest.vms.every(
      (vm) => vm.image_key.arch === candidate.buildArch,
    )
  ) {
    return null;
  }

  return candidateSourceFromManifest({
    manifest: candidate.manifest,
    organizationId: input.organizationId,
    createdAt: candidate.candidateCreatedAt,
    updatedAt: candidate.candidateUpdatedAt,
    candidateSource: {
      revision: input.revision,
      buildId: candidate.candidateBuildId,
    },
  });
}

function hasExactBundleScenario(
  meta: typeof imageBuildBundles.$inferSelect["metaJson"],
  input: {
    scenarioId: string;
    arch: typeof imageBuilds.$inferSelect["arch"];
    contentHash: string;
    requireCandidateChannel: boolean;
  },
): boolean {
  const value = meta as unknown;
  if (!isRecord(value) || value.buildFormatVersion !== IMAGE_BUILD_FORMAT_VERSION) {
    return false;
  }
  const scenarios = value.scenarios;
  if (!Array.isArray(scenarios)) return false;
  return (
    (!input.requireCandidateChannel || value.catalogChannel === "candidate") &&
    scenarios.some(
      (scenario) =>
        isRecord(scenario) &&
        scenario.scenarioId === input.scenarioId &&
        scenario.arch === input.arch &&
        scenario.contentHash === input.contentHash,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadyCandidateManifest(
  candidate: typeof scenarioCatalogCandidates.$inferSelect["manifestJson"],
  published: NonNullable<typeof imageBuilds.$inferSelect["publishedManifestJson"]>,
  scenarioId: string,
): boolean {
  if (
    validateManifest(candidate) ||
    validateManifest(published) ||
    candidate.scenario_id !== scenarioId ||
    published.scenario_id !== scenarioId ||
    candidate.vms.length !== published.vms.length ||
    candidate.solution_markdown !== published.solution_markdown ||
    JSON.stringify(candidate.hints) !== JSON.stringify(published.hints)
  ) {
    return false;
  }

  return candidate.vms.every((vm, index) => {
    const publishedVm = published.vms[index];
    return (
      publishedVm !== undefined &&
      vm.name === publishedVm.name &&
      JSON.stringify(vm.image_key) === JSON.stringify(publishedVm.image_key) &&
      vm.image_id === publishedVm.image_id &&
      vm.image_format === publishedVm.image_format &&
      vm.image_virtual_size_bytes === publishedVm.image_virtual_size_bytes &&
      vm.chunk_manifest_sha256 === publishedVm.chunk_manifest_sha256 &&
      vm.guest_bootstrap_abi === publishedVm.guest_bootstrap_abi &&
      vm.boot.kernel_sha256 === publishedVm.boot.kernel_sha256 &&
      vm.boot.initrd_sha256 === publishedVm.boot.initrd_sha256 &&
      vm.boot.cmdline === publishedVm.boot.cmdline &&
      vm.cpu_millis === publishedVm.cpu_millis &&
      vm.vcpu_count === publishedVm.vcpu_count &&
      vm.memory_mib === publishedVm.memory_mib &&
      vm.disk_mib === publishedVm.disk_mib &&
      JSON.stringify(vm.probes) === JSON.stringify(publishedVm.probes)
    );
  });
}

function candidateSourceFromManifest(input: {
  manifest: typeof scenarioCatalogCandidates.$inferSelect["manifestJson"];
  organizationId: string | null;
  createdAt: number;
  updatedAt: number;
  candidateSource: NonNullable<ScenarioRunLaunchSource["candidateSource"]>;
}): ScenarioRunLaunchSource | null {
  const { manifest } = input;
  const difficulty = parseScenarioDifficulty(manifest.difficulty);
  if (!difficulty) return null;

  const vms = manifest.vms.flatMap((vm, ordinal) => {
    if (
      vm.image_format !== "raw_chunks_v1" ||
      vm.guest_bootstrap_abi !== 1
    ) {
      return [];
    }
    const directBoot = normalizeScenarioVmDirectBootMetadata({
      imageFormat: vm.image_format,
      imageVirtualSizeBytes: vm.image_virtual_size_bytes,
      chunkManifestSha256: vm.chunk_manifest_sha256,
      guestBootstrapAbi: vm.guest_bootstrap_abi,
      kernelSha256: vm.boot.kernel_sha256,
      initrdSha256: vm.boot.initrd_sha256,
      bootCmdline: vm.boot.cmdline,
    });
    if (!directBoot) return [];
    return [
      {
        id: candidateVmId(manifest.scenario_id, vm.name),
        ordinal,
        name: vm.name,
        image: candidateImageName(vm.image_key),
        imageKey: vm.image_key,
        imageSha256: vm.image_id,
        ...directBoot,
        cpuMillis: vm.cpu_millis,
        vcpuCount: vm.vcpu_count,
        memoryMib: vm.memory_mib,
        diskMib: vm.disk_mib,
      } satisfies ScenarioVmRecord,
    ];
  });
  if (vms.length !== manifest.vms.length) return null;

  const vmNames = new Map(vms.map((vm) => [vm.id, vm.name]));
  const probes = manifest.vms.flatMap((vm) => {
    const scenarioVmId = candidateVmId(manifest.scenario_id, vm.name);
    const scenarioVmName = vmNames.get(scenarioVmId);
    if (!scenarioVmName) return [];
    return vm.probes.map(
      (probe, ordinal) =>
        ({
          scenarioVmId,
          scenarioVmName,
          ordinal,
          name: probe.id,
          description: probe.display_name,
          title: probe.title ?? null,
          bodyMarkdown: probe.body_markdown ?? null,
          hints: probe.hints,
          phase: probe.phase,
          kind: probe.kind,
        }) satisfies ScenarioProbeRecord,
    );
  });

  const scenario: ScenarioDetailRecord = {
    scenarioId: manifest.scenario_id,
    organizationId: input.organizationId,
    title: manifest.title,
    category: manifest.category,
    description: manifest.description,
    difficulty,
    estimatedMinutes: manifest.estimated_minutes,
    tags: manifest.tags,
    briefingMarkdown: manifest.briefing_markdown,
    solutionMarkdown: manifest.solution_markdown,
    hints: manifest.hints,
    probeCount: probes.length,
    vmCount: vms.length,
    requiredResources: aggregateScenarioRequiredResources(vms),
    enabled: false,
    enabledAt: null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    probes,
    vms,
  };
  return {
    ...scenarioRunLaunchSourceFromDetail(scenario),
    candidateSource: input.candidateSource,
  };
}

function candidateVmId(scenarioId: string, vmName: string): string {
  return `${scenarioId}:${vmName}`;
}

function candidateImageName(input: { scenario: string; vm: string; arch: string }): string {
  return `${input.scenario}-${input.vm}-${input.arch}.chunks.json`;
}
