import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
} from "@/db/schema";
import type {
  DesiredGuestToolsV1,
  HostDesiredStateV2,
  HostStateReportV2,
} from "@/generated/bridge";
import type {
  ImageKey,
  ScenarioManifestV4,
} from "@/generated/catalog";
import {
  loadScenarioGuestToolsPin,
  type ScenarioGuestToolsChannel,
} from "@/lib/scenario-guest-tools";
import {
  hasRegistryPublishToken,
  isSafeBundleRev,
  jsonResponse,
} from "./shared";

type BuildState = "queued" | "building" | "warming" | "ready" | "failed";

export async function handleImageBuildRevisionStatus(
  request: Request,
  env: Cloudflare.Env,
  revision: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  if (!(await hasRegistryPublishToken(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!isSafeBundleRev(revision)) {
    return jsonResponse({ error: "invalid bundle rev" }, 400);
  }
  const toolsChannel = readToolsChannel(new URL(request.url));
  if (!toolsChannel) {
    return jsonResponse({ error: "tools must be stable or candidate" }, 400);
  }

  const db = drizzle(env.DB);
  const bundles = await db
    .select({
      organizationId: imageBuildBundles.organizationId,
      meta: imageBuildBundles.metaJson,
    })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, revision))
    .limit(1);
  const bundle = bundles[0];
  if (!bundle) {
    return jsonResponse({ error: "bundle revision not found" }, 404);
  }

  const expected = bundle.meta.scenarios;
  const contentHashes = [...new Set(expected.map((scenario) => scenario.contentHash))];
  const candidates = contentHashes.length
    ? await db
        .select({
          id: imageBuilds.id,
          scenarioId: imageBuilds.scenarioId,
          arch: imageBuilds.arch,
          contentHash: imageBuilds.contentHash,
          hostId: imageBuilds.hostId,
          status: imageBuilds.status,
          phase: imageBuilds.phase,
          error: imageBuilds.error,
          manifest: imageBuilds.publishedManifestJson,
          updatedAt: imageBuilds.updatedAt,
        })
        .from(imageBuilds)
        .where(inArray(imageBuilds.contentHash, contentHashes))
    : [];
  const builds = expected.map((scenario) => {
    const build = candidates.find(
      (candidate) =>
        candidate.scenarioId === scenario.scenarioId &&
        candidate.arch === scenario.arch &&
        candidate.contentHash === scenario.contentHash,
    );
    return {
      scenario_id: scenario.scenarioId,
      arch: scenario.arch,
      content_hash: scenario.contentHash,
      build_id: build?.id ?? null,
      host_id: build?.hostId ?? null,
      status: build?.status ?? "queued",
      phase: build?.phase ?? "queued",
      error: build?.error ?? null,
      updated_at_unix_ms: build?.updatedAt ?? null,
      manifest: build?.manifest ?? null,
    };
  });
  const requiredImages = builds.flatMap((build) =>
    build.status === "succeeded" && build.manifest
      ? requiredImagesFromManifest(build.manifest)
      : [],
  );

  let desiredTools: DesiredGuestToolsV1;
  try {
    desiredTools = await loadScenarioGuestToolsPin(env, toolsChannel);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "guest-tools pin unavailable" },
      409,
    );
  }

  const hosts = await db
    .select({
      id: agentHosts.id,
      desired: hostDesiredState.docJson,
      actual: hostActualState.reportJson,
    })
    .from(agentHosts)
    .leftJoin(hostDesiredState, eq(hostDesiredState.hostId, agentHosts.id))
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.role, "agent"),
        eq(agentHosts.disabled, false),
        eq(agentHosts.connected, true),
        bundle.organizationId
          ? eq(agentHosts.organizationId, bundle.organizationId)
          : undefined,
      ),
    );
  const cacheReports = hosts
    .map((host) =>
      hostCacheReport(host.id, host.desired, host.actual, requiredImages, desiredTools),
    )
    .filter((host) => host.affected);

  const failedBuild = builds.some(
    (build) => build.status === "failed" || build.status === "stale",
  );
  const buildsReady =
    builds.length === expected.length &&
    builds.every((build) => build.status === "succeeded" && build.manifest);
  const hostsReady =
    cacheReports.length > 0 && cacheReports.every((host) => host.ready);
  const state: BuildState = failedBuild
    ? "failed"
    : buildsReady
      ? hostsReady
        ? "ready"
        : "warming"
      : builds.some((build) => build.status !== "queued")
        ? "building"
        : "queued";

  return jsonResponse({
    ok: state === "ready",
    revision,
    state,
    tools_channel: toolsChannel,
    guest_tools: desiredTools,
    builds: builds.map(({ manifest: _manifest, ...build }) => build),
    images: requiredImages,
    hosts: cacheReports,
  });
}

function readToolsChannel(url: URL): ScenarioGuestToolsChannel | null {
  const value = url.searchParams.get("tools") ?? "stable";
  return value === "stable" || value === "candidate" ? value : null;
}

interface RequiredImage {
  image_key: ImageKey;
  image_id: string;
}

function requiredImagesFromManifest(manifest: ScenarioManifestV4): RequiredImage[] {
  return manifest.vms.map((vm) => ({
    image_key: vm.image_key,
    image_id: vm.image_id,
  }));
}

function hostCacheReport(
  hostId: string,
  desired: HostDesiredStateV2 | null,
  actual: HostStateReportV2 | null,
  requiredImages: RequiredImage[],
  guestTools: DesiredGuestToolsV1,
) {
  const arch = actual?.capabilities.arch ?? null;
  const hostImages = arch
    ? requiredImages.filter((image) => image.image_key.arch === arch)
    : requiredImages;
  const desiredImagesReady = Boolean(
    desired &&
      hostImages.every((image) =>
        desired.cached_images.some(
          (candidate) => imageIdentity(candidate.image_key, candidate.image_id) ===
            imageIdentity(image.image_key, image.image_id),
        ),
      ),
  );
  const actualImagesReady = Boolean(
    actual &&
      hostImages.every((image) =>
        actual.cached_images.some(
          (candidate) =>
            candidate.phase === "ready" &&
            imageIdentity(candidate.image_key, candidate.image_id) ===
              imageIdentity(image.image_key, image.image_id),
        ),
      ),
  );
  const desiredToolsReady = Boolean(
    desired?.cached_guest_tools?.some((pin) => toolsIdentity(pin) === toolsIdentity(guestTools)),
  );
  const actualToolsReady = Boolean(
    actual?.cached_guest_tools?.some(
      (state) =>
        state.phase === "ready" &&
        toolsIdentity(state.guest_tools) === toolsIdentity(guestTools),
    ),
  );
  const versionApplied = Boolean(
    desired && actual && actual.applied_desired_version >= desired.version,
  );
  return {
    host_id: hostId,
    arch,
    desired_version: desired?.version ?? null,
    applied_desired_version: actual?.applied_desired_version ?? null,
    affected: arch === null || hostImages.length > 0,
    desired_images_ready: desiredImagesReady,
    actual_images_ready: actualImagesReady,
    desired_guest_tools_ready: desiredToolsReady,
    actual_guest_tools_ready: actualToolsReady,
    ready:
      hostImages.length > 0 &&
      desiredImagesReady &&
      actualImagesReady &&
      desiredToolsReady &&
      actualToolsReady &&
      versionApplied,
  };
}

function imageIdentity(imageKey: ImageKey, imageId: string): string {
  return `${imageKey.scenario}:${imageKey.vm}:${imageKey.arch}:${imageId}`;
}

function toolsIdentity(pin: DesiredGuestToolsV1): string {
  return `${pin.tools_disk_sha256}:${pin.tools_disk_size_bytes}:${pin.kino_sha256}:${pin.bootstrap_abi}`;
}
