import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  agentHosts,
  hostActualState,
  imageBuilds,
  scenarioCatalogCandidates,
} from "@/db/schema";
import type { ImageBuildBundleMeta } from "@/db/schema";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { upsertDesiredCachedImage } from "@/lib/desired-state";

export async function stageCandidateScenarioManifest(
  db: DrizzleD1Database,
  input: {
    revision: string;
    organizationId: string | null;
    buildId: string;
    manifest: ScenarioManifestV4;
    nowUnixMs: number;
  },
): Promise<void> {
  const id = candidateScenarioId(
    input.organizationId,
    input.revision,
    input.manifest.scenario_id,
  );
  await db
    .insert(scenarioCatalogCandidates)
    .values({
      id,
      revision: input.revision,
      organizationId: input.organizationId,
      scenarioId: input.manifest.scenario_id,
      buildId: input.buildId,
      manifestJson: input.manifest,
      createdAt: input.nowUnixMs,
      updatedAt: input.nowUnixMs,
    })
    .onConflictDoUpdate({
      target: scenarioCatalogCandidates.id,
      set: {
        buildId: input.buildId,
        manifestJson: input.manifest,
        updatedAt: input.nowUnixMs,
      },
    });
}

export async function warmCandidateScenarioManifest(
  db: DrizzleD1Database,
  input: {
    organizationId: string | null;
    manifest: ScenarioManifestV4;
    nowUnixMs: number;
    wakeHost: (hostId: string) => Promise<void>;
  },
): Promise<string[]> {
  const hosts = await db
    .select({
      id: agentHosts.id,
      arch: sql<unknown>`json_extract(${hostActualState.reportJson}, '$.capabilities.arch')`,
    })
    .from(agentHosts)
    .innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.role, "agent"),
        eq(agentHosts.disabled, false),
        input.organizationId
          ? eq(agentHosts.organizationId, input.organizationId)
          : undefined,
      ),
    );
  const warmed: string[] = [];
  for (const host of hosts) {
    const images = input.manifest.vms.filter(
      (vm) => vm.image_key.arch === host.arch,
    );
    if (images.length === 0) continue;
    await mutateStoredHostDesiredState(
      db,
      host.id,
      input.nowUnixMs,
      (draft) => {
        for (const vm of images) {
          upsertDesiredCachedImage(draft, {
            image_key: vm.image_key,
            image_id: vm.image_id,
          });
        }
      },
    );
    await input.wakeHost(host.id);
    warmed.push(host.id);
  }
  return warmed.sort();
}

export function candidateScenarioId(
  organizationId: string | null,
  revision: string,
  scenarioId: string,
): string {
  return `${organizationId ?? "public"}:${revision}:${scenarioId}`;
}

export async function stageReusableCandidateManifests(
  db: DrizzleD1Database,
  input: {
    revision: string;
    organizationId: string | null;
    meta: ImageBuildBundleMeta;
    nowUnixMs: number;
    wakeHost: (hostId: string) => Promise<void>;
  },
): Promise<string[]> {
  if (input.meta.catalogChannel !== "candidate") return [];
  const hashes = [...new Set(input.meta.scenarios.map((item) => item.contentHash))];
  if (hashes.length === 0) return [];
  const builds = await db
    .select({
      id: imageBuilds.id,
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      contentHash: imageBuilds.contentHash,
      status: imageBuilds.status,
      manifest: imageBuilds.publishedManifestJson,
    })
    .from(imageBuilds)
    .where(inArray(imageBuilds.contentHash, hashes));
  const staged: string[] = [];
  for (const expected of input.meta.scenarios) {
    const build = builds.find(
      (candidate) =>
        candidate.scenarioId === expected.scenarioId &&
        candidate.arch === expected.arch &&
        candidate.contentHash === expected.contentHash &&
        candidate.status === "succeeded" &&
        candidate.manifest,
    );
    if (!build?.manifest) continue;
    await stageCandidateScenarioManifest(db, {
      revision: input.revision,
      organizationId: input.organizationId,
      buildId: build.id,
      manifest: build.manifest,
      nowUnixMs: input.nowUnixMs,
    });
    await warmCandidateScenarioManifest(db, {
      organizationId: input.organizationId,
      manifest: build.manifest,
      nowUnixMs: input.nowUnixMs,
      wakeHost: input.wakeHost,
    });
    staged.push(expected.scenarioId);
  }
  return staged.sort();
}
