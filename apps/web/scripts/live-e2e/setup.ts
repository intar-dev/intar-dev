import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ScenarioManifestV4 } from "../../src/generated/catalog";
import { ApiClient } from "./api-client";
import { inferArtifactPaths, inferImagePaths } from "./manifest";
import { HttpError } from "./types";
import type {
  AdminBuildSummary,
  AdminBuildsResponse,
  AdminScenarioResponse,
  HostResponse,
  HostSummary,
  HostsResponse,
  LoadedManifest,
  Options,
  RequiredImage,
} from "./types";
import { isSha256Hex } from "./options";
import {
  bootArtifactSha256s,
  copyToArrayBuffer,
  errorMessage,
  imageLabel,
  logStep,
  parseResponseBody,
  sameImageKey,
  sha256BytesHex,
  sleep,
  unique,
} from "./utils";

export async function publishManifest(
  options: Options,
  loadedManifests: LoadedManifest[],
  manifest: ScenarioManifestV4,
): Promise<void> {
  if (!options.publishToken) {
    throw new Error(
      "live E2E publish requires --publish-token or INTAR_IMAGE_PUBLISH_TOKEN",
    );
  }
  const inferredImages = inferImagePaths(loadedManifests);
  const inferredArtifacts = await inferArtifactPaths(loadedManifests, manifest);
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));

  for (const vm of manifest.vms) {
    const chunkManifestPath =
      options.imagePathsByVmName.get(vm.name) ?? inferredImages.get(vm.name);
    if (!chunkManifestPath) {
      throw new Error(`missing chunk manifest path for manifest VM ${vm.name}`);
    }
    const chunkManifestBytes = await readFile(chunkManifestPath);
    const chunkManifestSha256 = await sha256BytesHex(chunkManifestBytes);
    if (chunkManifestSha256 !== vm.chunk_manifest_sha256.toLowerCase()) {
      throw new Error(
        `chunk manifest ${chunkManifestPath} sha256 mismatch for VM ${vm.name}`,
      );
    }
    const chunkManifest = JSON.parse(new TextDecoder().decode(chunkManifestBytes)) as {
      image_id: string;
      chunks: Array<{
        index: number;
        raw_size_bytes: number;
        raw_sha256: string;
        encoded_size_bytes: number;
        encoded_sha256: string;
      }>;
    };
    if (chunkManifest.image_id !== vm.image_id) {
      throw new Error(`chunk manifest image_id mismatch for VM ${vm.name}`);
    }
    const chunksDir = join(
      dirname(chunkManifestPath),
      basename(chunkManifestPath, ".chunks.json") + ".chunks",
    );
    for (const chunk of chunkManifest.chunks) {
      const chunkPath = join(
        chunksDir,
        `${String(chunk.index).padStart(8, "0")}.raw.zst`,
      );
      const bytes = await readFile(chunkPath);
      if (
        bytes.byteLength !== chunk.encoded_size_bytes ||
        (await sha256BytesHex(bytes)) !== chunk.encoded_sha256
      ) {
        throw new Error(`encoded chunk verification failed at ${chunkPath}`);
      }
      const response = await fetch(
        `${options.baseUrl}/registry/v1/image-chunks/${chunk.raw_sha256}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${options.publishToken}`,
            "content-type": "application/zstd",
            "x-intar-raw-sha256": chunk.raw_sha256,
            "x-intar-encoded-sha256": chunk.encoded_sha256,
            "x-intar-raw-size": String(chunk.raw_size_bytes),
            "x-intar-encoded-size": String(chunk.encoded_size_bytes),
          },
          body: copyToArrayBuffer(bytes),
        },
      );
      if (!response.ok) {
        throw new Error(`chunk upload failed with HTTP ${response.status}`);
      }
    }
    const manifestUpload = await fetch(
      `${options.baseUrl}/registry/v1/image-manifests/${chunkManifestSha256}.json`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${options.publishToken}`,
          "content-type": "application/json",
          "x-intar-manifest-sha256": chunkManifestSha256,
        },
        body: copyToArrayBuffer(chunkManifestBytes),
      },
    );
    if (!manifestUpload.ok) {
      throw new Error(`chunk manifest upload failed with HTTP ${manifestUpload.status}`);
    }
    logStep(
      `verified chunked image ${vm.name}: ${chunkManifest.chunks.length} non-zero chunks image_id=${vm.image_id.slice(0, 12)}`,
    );
  }
  for (const sha256 of bootArtifactSha256s(manifest)) {
    const artifactPath =
      options.artifactPathsBySha.get(sha256) ?? inferredArtifacts.get(sha256);
    if (!artifactPath) {
      throw new Error(
        `missing boot artifact ${sha256}; pass --artifact ${sha256}=PATH or place it under base-images/ beside the manifest`,
      );
    }
    const artifactBytes = await readFile(artifactPath);
    const artifactSha256 = await sha256BytesHex(artifactBytes);
    if (artifactSha256 !== sha256) {
      throw new Error(
        `boot artifact ${artifactPath} sha256 mismatch: expected ${sha256}, got ${artifactSha256}`,
      );
    }
    logStep(
      `verified boot artifact ${basename(artifactPath)} ${artifactBytes.byteLength} bytes sha256=${artifactSha256.slice(0, 12)}`,
    );
    form.append(
      `artifact:${sha256}`,
      new Blob([copyToArrayBuffer(artifactBytes)], {
        type: "application/octet-stream",
      }),
      `${sha256}.artifact`,
    );
  }

  const response = await fetch(
    new URL("/registry/v1/publish", options.baseUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.publishToken}`,
      },
      body: form,
    },
  );
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new HttpError("registry publish failed", response.status, body);
  }
  logStep(
    `published ${manifest.scenario_id} with ${manifest.vms.length} VM image(s)`,
  );
}

export async function waitForHostReady(
  client: ApiClient,
  options: Options,
  requiredImages: RequiredImage[],
): Promise<HostSummary> {
  const deadline = Date.now() + options.waitCacheMs;
  let lastStatus = "host not checked yet";

  while (Date.now() <= deadline) {
    const host = options.hostId
      ? await client
          .json<HostResponse>(
            `/api/agent/hosts/${encodeURIComponent(options.hostId)}`,
          )
          .then((response) => response.host)
          .catch((error: unknown) => {
            lastStatus = errorMessage(error);
            return null;
          })
      : await selectBestHost(client).catch((error: unknown) => {
          lastStatus = errorMessage(error);
          return null;
        });

    if (host) {
      const problems = hostReadinessProblems(host, requiredImages);
      if (!problems.length) {
        return host;
      }
      lastStatus = `${host.id}: ${problems.join("; ")}`;
    }

    await sleep(options.pollMs);
  }

  throw new Error(`timed out waiting for host readiness: ${lastStatus}`);
}

export async function loadRequiredImagesFromAdminScenario(
  client: ApiClient,
  scenarioId: string,
): Promise<RequiredImage[]> {
  const response = await client.json<AdminScenarioResponse>(
    `/api/admin/scenarios/${encodeURIComponent(scenarioId)}`,
  );
  const images = response.scenario.vms.flatMap((vm) => {
    if (!vm.imageKey || !vm.imageSha256) {
      return [];
    }
    assertAdminScenarioDirectBootMetadata(vm, scenarioId);
    return [
      {
        image_key: vm.imageKey,
        image_id: vm.imageSha256,
      },
    ];
  });
  if (!images.length) {
    throw new Error(
      `admin scenario ${scenarioId} has no published image metadata`,
    );
  }
  return images;
}

export function assertAdminScenarioDirectBootMetadata(
  vm: AdminScenarioResponse["scenario"]["vms"][number],
  scenarioId: string,
): void {
  const label = `${scenarioId}/${vm.imageKey?.vm ?? "unknown-vm"}`;
  if (vm.imageFormat !== "raw_zstd") {
    throw new Error(
      `admin scenario ${label} is not raw_zstd: ${vm.imageFormat}`,
    );
  }
  if (
    !Number.isSafeInteger(vm.imageVirtualSizeBytes) ||
    vm.imageVirtualSizeBytes <= 0
  ) {
    throw new Error(
      `admin scenario ${label} has invalid imageVirtualSizeBytes: ${vm.imageVirtualSizeBytes}`,
    );
  }
  if (!isSha256Hex(vm.kernelSha256)) {
    throw new Error(
      `admin scenario ${label} has invalid kernelSha256: ${vm.kernelSha256}`,
    );
  }
  if (!isSha256Hex(vm.initrdSha256)) {
    throw new Error(
      `admin scenario ${label} has invalid initrdSha256: ${vm.initrdSha256}`,
    );
  }
  if (!vm.bootCmdline.includes("root=/dev/vda")) {
    throw new Error(
      `admin scenario ${label} boot cmdline does not direct-boot /dev/vda: ${vm.bootCmdline}`,
    );
  }
}

export async function loadRequiredImagesFromAdminScenarios(
  client: ApiClient,
  scenarioIds: string[],
): Promise<RequiredImage[]> {
  let images: RequiredImage[] = [];
  for (const scenarioId of scenarioIds) {
    images = appendUniqueRequiredImages(
      images,
      await loadRequiredImagesFromAdminScenario(client, scenarioId),
    );
  }
  return images;
}

export function appendUniqueRequiredImages(
  existing: RequiredImage[],
  next: RequiredImage[],
): RequiredImage[] {
  const images = [...existing];
  for (const image of next) {
    if (
      images.some(
        (candidate) =>
          sameImageKey(candidate.image_key, image.image_key) &&
          candidate.image_id.toLowerCase() ===
            image.image_id.toLowerCase(),
      )
    ) {
      continue;
    }
    images.push(image);
  }
  return images;
}

export async function waitForBuildsSucceeded(
  client: ApiClient,
  options: Options,
  scenarioIds: string[],
  requiredImages: RequiredImage[],
): Promise<AdminBuildSummary[]> {
  const buildRev = options.buildRev;
  if (!buildRev) {
    return [];
  }
  if (scenarioIds.length === 0) {
    throw new Error(
      "at least one scenario id is required when waiting for builds",
    );
  }

  const deadline = Date.now() + options.waitBuildMs;
  let lastStatus = "builds not checked yet";
  const scenarioIdSet = new Set(scenarioIds);
  const expectedBuilds = uniqueBuildTargets(
    requiredImages
      .filter((image) => scenarioIdSet.has(image.image_key.scenario))
      .map((image) => ({
        scenarioId: image.image_key.scenario,
        arch: image.image_key.arch,
      })),
  );
  const expectedBuildKeys = new Set(
    expectedBuilds.map((target) =>
      buildTargetKey(target.scenarioId, target.arch),
    ),
  );

  while (Date.now() <= deadline) {
    const response =
      await client.json<AdminBuildsResponse>("/api/admin/builds");
    const builds = response.builds.filter(
      (build) =>
        build.rev === buildRev &&
        scenarioIdSet.has(build.scenarioId) &&
        (expectedBuildKeys.size === 0 ||
          expectedBuildKeys.has(buildTargetKey(build.scenarioId, build.arch))),
    );
    if (builds.length) {
      const terminalFailure = builds.find(
        (build) => build.status === "failed" || build.status === "stale",
      );
      if (terminalFailure) {
        throw new Error(
          `build ${terminalFailure.id} for rev ${buildRev} ${terminalFailure.scenarioId}/${terminalFailure.arch} is ${terminalFailure.status}/${terminalFailure.phase}: ${terminalFailure.error ?? "no error"}`,
        );
      }
      const missingBuildTargets = missingExpectedBuildTargets(
        builds,
        scenarioIds,
        expectedBuilds,
      );
      if (
        missingBuildTargets.length === 0 &&
        builds.every((build) => build.status === "succeeded")
      ) {
        logStep(
          `build rev ${buildRev} succeeded for ${formatExpectedBuildScope(scenarioIds, expectedBuilds)}: ${builds.map((build) => `${build.id}:${build.arch}/${build.contentHash.slice(0, 12)}${build.hostId ? `@${build.hostId}` : ""}`).join(",")}`,
        );
        return builds;
      }
      lastStatus = [
        ...builds.map(
          (build) =>
            `${build.scenarioId}/${build.arch}/${build.id}:${build.status}/${build.phase}`,
        ),
        ...missingBuildTargets.map((target) => `${target}:missing`),
      ].join(", ");
    } else {
      lastStatus = `no builds found for ${formatExpectedBuildScope(scenarioIds, expectedBuilds)} rev=${buildRev}`;
    }

    await sleep(options.pollMs);
  }

  throw new Error(`timed out waiting for build rev ${buildRev}: ${lastStatus}`);
}

export interface ExpectedBuildTarget {
  scenarioId: string;
  arch: RequiredImage["image_key"]["arch"];
}

export function uniqueBuildTargets(
  targets: ExpectedBuildTarget[],
): ExpectedBuildTarget[] {
  const seen = new Set<string>();
  const uniqueTargets: ExpectedBuildTarget[] = [];
  for (const target of targets) {
    const key = buildTargetKey(target.scenarioId, target.arch);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTargets.push(target);
  }
  return uniqueTargets;
}

export function missingExpectedBuildTargets(
  builds: AdminBuildSummary[],
  scenarioIds: string[],
  expectedBuilds: ExpectedBuildTarget[],
): string[] {
  if (expectedBuilds.length === 0) {
    const scenariosWithBuilds = new Set(
      builds.map((build) => build.scenarioId),
    );
    return scenarioIds
      .filter((scenarioId) => !scenariosWithBuilds.has(scenarioId))
      .map((scenarioId) => `${scenarioId}:any-arch`);
  }

  const buildsByTarget = new Set(
    builds.map((build) => buildTargetKey(build.scenarioId, build.arch)),
  );
  return expectedBuilds
    .filter(
      (target) =>
        !buildsByTarget.has(buildTargetKey(target.scenarioId, target.arch)),
    )
    .map((target) => `${target.scenarioId}:${target.arch}`);
}

export function formatExpectedBuildScope(
  scenarioIds: string[],
  expectedBuilds: ExpectedBuildTarget[],
): string {
  if (expectedBuilds.length === 0) {
    return scenarioIds.map((scenarioId) => `${scenarioId}:any-arch`).join(",");
  }
  return expectedBuilds
    .map((target) => `${target.scenarioId}:${target.arch}`)
    .join(",");
}

export function buildTargetKey(
  scenarioId: string,
  arch: RequiredImage["image_key"]["arch"],
): string {
  return `${scenarioId}\0${arch}`;
}

export async function selectBestHost(
  client: ApiClient,
): Promise<HostSummary | null> {
  const response = await client.json<HostsResponse>("/api/agent/hosts");
  return (
    response.hosts.find(
      (host) =>
        !host.disabled &&
        host.scenarioEnabled &&
        host.status.connected &&
        host.actualState !== null,
    ) ??
    response.hosts.find((host) => !host.disabled && host.scenarioEnabled) ??
    null
  );
}

export function hostReadinessProblems(
  host: HostSummary,
  requiredImages: RequiredImage[],
): string[] {
  const problems: string[] = [];
  if (host.disabled) problems.push("host is disabled");
  if (!host.scenarioEnabled) problems.push("scenario runs are disabled");
  if (!host.status.connected) problems.push("host is not connected");
  if (!host.actualState) {
    problems.push("host has not reported actual state");
    return problems;
  }

  const capabilities = host.actualState.capabilities;
  if (!capabilities.supports_kvm)
    problems.push("host does not report KVM support");
  if (!capabilities.supports_vsock)
    problems.push("host does not report vsock support");
  if (!capabilities.supports_nftables)
    problems.push("host does not report nftables support");
  if (!capabilities.supports_reflink)
    problems.push("host does not report mandatory reflink support");
  if (!capabilities.supports_jailer_v2)
    problems.push("host does not report jailer-v2 support");
  if (!capabilities.supports_boot_cpu_lease)
    problems.push("host does not report boot CPU lease support");
  if (!capabilities.supports_template_backed_launch)
    problems.push("host does not report template-backed launch support");
  if (!capabilities.fast_template_store)
    problems.push("host has not attested the fast template store");
  if (!capabilities.supports_hard_cpu_quota)
    problems.push("host does not report hard CPU quota support");
  if (!capabilities.supports_landlock)
    problems.push("host does not report Landlock support");
  if (!capabilities.supports_cgroup_v2)
    problems.push("host does not report cgroup-v2 support");
  if (capabilities.boot_cpu_millis !== 2_000)
    problems.push(
      `host boot CPU allocation is ${capabilities.boot_cpu_millis ?? "missing"}m, expected 2000m`,
    );
  if (capabilities.boot_cpu_lease_ms !== 45_000)
    problems.push(
      `host boot CPU lease is ${capabilities.boot_cpu_lease_ms ?? "missing"}ms, expected 45000ms`,
    );
  if (
    typeof capabilities.cloud_hypervisor_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(capabilities.cloud_hypervisor_sha256)
  ) {
    problems.push("host does not report a pinned Cloud Hypervisor SHA-256");
  }

  const requiredArchitectures = unique(
    requiredImages.map((image) => image.image_key.arch),
  );
  if (
    requiredArchitectures.length > 0 &&
    !requiredArchitectures.includes(capabilities.arch)
  ) {
    problems.push(
      `host architecture ${capabilities.arch} does not match required image architecture(s) ${requiredArchitectures.join(",")}`,
    );
  }

  for (const vm of requiredImages) {
    const cached = host.actualState.cachedImages.find(
      (image) =>
        sameImageKey(image.image_key, vm.image_key) &&
        image.image_id.toLowerCase() === vm.image_id.toLowerCase(),
    );
    if (!cached) {
      problems.push(`image ${imageLabel(vm)} is not reported by cache`);
    } else if (cached.phase !== "ready") {
      problems.push(
        `image ${imageLabel(vm)} is ${cached.phase}${cached.error ? `: ${cached.error}` : ""}`,
      );
    }
  }

  return problems;
}
