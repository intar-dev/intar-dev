import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ScenarioManifestV3,
  ScenarioVmManifestV3,
} from "../src/generated/catalog";
import type {
  DashboardArchivedRun,
  DashboardRunArtifact,
} from "../src/lib/dashboard-host";
import type { ScenarioRunRecord } from "../src/lib/scenario-runs";
import { selectSequentialHintPair } from "./live-e2e-hints";
import { scenarioStartRequest } from "./live-e2e-start";
import {
  advanceTerminalProbeLifecycle,
  initialTerminalProbeLifecycle,
  inspectReplayProbeOutput,
  terminalProbeCommand,
} from "./live-e2e-terminal";

interface Options {
  baseUrl: string;
  cookie: string;
  scenarioId: string;
  hostId: string | null;
  buildRev: string | null;
  publishToken: string | null;
  manifestPaths: string[];
  imagePathsByVmName: Map<string, string>;
  artifactPathsBySha: Map<string, string>;
  skipPublish: boolean;
  skipTeardown: boolean;
  skipTerminalProbe: boolean;
  allowNoArtifacts: boolean;
  waitCacheMs: number;
  waitBuildMs: number;
  waitReadyMs: number;
  waitCompleteMs: number;
  pollMs: number;
  warmStartBudgetMs: number;
  terminalProbeTimeoutMs: number;
  forbiddenIps: string[];
}

interface LoadedManifest {
  path: string;
  manifest: ScenarioManifestV3;
}

interface RequiredImage {
  image_key: ScenarioVmManifestV3["image_key"];
  image_sha256: string;
}

interface HostSummary {
  id: string;
  disabled: boolean;
  scenarioEnabled: boolean;
  status: {
    connected: boolean;
    lastHeartbeatAt: string | null;
  };
  actualState: {
    appliedDesiredVersion: number;
    observedAt: number;
    capabilities: {
      supports_kvm: boolean;
      supports_vsock: boolean;
      supports_reflink: boolean;
      supports_nftables: boolean;
      arch: string;
    };
    cachedImages: Array<{
      image_key: ScenarioVmManifestV3["image_key"];
      image_sha256: string;
      phase: string;
      error?: string | null;
    }>;
  } | null;
}

interface HostsResponse {
  hosts: HostSummary[];
}

interface HostResponse {
  host: HostSummary;
}

interface HostRunsResponse {
  liveVms: Array<{
    name: string;
    run_id: string | null;
    details: {
      guest_ip: string | null;
      ssh_authorized_key_openssh?: string | null;
    } | null;
  }>;
  archivedRuns: DashboardArchivedRun[];
}

interface AdminBuildsResponse {
  builds: AdminBuildSummary[];
}

interface AdminBuildSummary {
  id: string;
  scenarioId: string;
  arch: RequiredImage["image_key"]["arch"];
  rev: string;
  contentHash: string;
  hostId: string | null;
  status: string;
  phase: string;
  attempt: number;
  error: string | null;
  updatedAt: number;
}

interface AdminScenarioResponse {
  scenario: {
    vms: Array<{
      imageKey: ScenarioVmManifestV3["image_key"] | null;
      imageSha256: string | null;
      imageFormat: string;
      imageVirtualSizeBytes: number;
      kernelSha256: string;
      initrdSha256: string;
      bootCmdline: string;
    }>;
  };
}

interface StartRunResponse {
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}

interface RunResponse {
  run: ScenarioRun;
}

type ScenarioRun = ScenarioRunRecord;
type RunVm = ScenarioRun["vms"][number];
type RunArtifact = ScenarioRun["replayArtifacts"][number];

interface BrowserTerminalSessionResponse {
  routeUsername: string;
  expiresAt: number;
  browser?: {
    websocketUrl: string;
  };
}

interface VerifiedTerminalSession {
  runId: string;
  vmId: string;
  runtimeVmName: string;
  websocketUrl: string;
  probeMarker: string | null;
}

class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.env);
  await runLiveE2e(options);
}

async function runLiveE2e(options: Options): Promise<void> {
  const client = new ApiClient(options.baseUrl, options.cookie);
  const loadedManifests = await loadManifests(options.manifestPaths);
  const manifest = loadedManifests.length
    ? combineManifests(loadedManifests)
    : null;
  let requiredImages: RequiredImage[] = manifest?.vms ?? [];
  const scenarioIdsToVerify = [options.scenarioId];
  const runIdsToTeardown: string[] = [];
  const terminalSessionsByRunId = new Map<string, VerifiedTerminalSession[]>();
  let selectedHostId: string | null = null;
  let mainError: unknown = null;

  try {
    if (!options.skipPublish) {
      if (!manifest) {
        throw new Error("live E2E publish requires at least one --manifest");
      }
      await publishManifest(options, loadedManifests, manifest);
    } else {
      logStep("publish skipped by flag");
    }

    if (options.buildRev) {
      await waitForBuildsSucceeded(
        client,
        options,
        scenarioIdsToVerify,
        requiredImages,
      );
      if (!requiredImages.length) {
        requiredImages = await loadRequiredImagesFromAdminScenarios(
          client,
          scenarioIdsToVerify,
        );
        logStep(
          `loaded ${requiredImages.length} image cache requirement(s) from admin scenarios ${scenarioIdsToVerify.join(",")}`,
        );
      }
    }

    const host = await waitForHostReady(client, options, requiredImages);
    selectedHostId = host.id;
    logStep(`host ready: ${host.id}`);

    const startedAt = Date.now();
    const start = await startRun(client, options, host.id, options.scenarioId);
    const primaryRunId = start.runId;
    runIdsToTeardown.push(primaryRunId);
    logStep(
      `run accepted: ${primaryRunId}${start.reused ? " (reused active run)" : ""}`,
    );

    const readyRun = await waitForRunReady(
      client,
      primaryRunId,
      options.waitReadyMs,
      options.pollMs,
    );
    const primarySameRunPeerIpsByVmName =
      !options.skipTerminalProbe && readyRun.vms.length > 1
        ? await waitForSameRunPeerIps({
            client,
            hostId: host.id,
            run: readyRun,
            timeoutMs: options.waitReadyMs,
            pollMs: options.pollMs,
          })
        : new Map<string, string[]>();
    const readyElapsedMs = Date.now() - startedAt;
    if (readyElapsedMs > options.warmStartBudgetMs) {
      // The budget encodes reflink-speed disk materialization; hosts on
      // filesystems without reflink pay a full sparse copy per VM disk.
      if (host.actualState?.capabilities.supports_reflink) {
        throw new Error(
          `warm start budget exceeded: ${readyElapsedMs}ms > ${options.warmStartBudgetMs}ms`,
        );
      }
      logStep(
        `warm start took ${readyElapsedMs}ms (> ${options.warmStartBudgetMs}ms budget); acceptable without reflink support`,
      );
    } else {
      logStep(`terminal ready in ${readyElapsedMs}ms`);
    }

    await verifyRunContentGating(client, readyRun);
    await verifyDistinctVmTerminalKeys({
      client,
      hostId: host.id,
      run: readyRun,
      timeoutMs: options.waitReadyMs,
      pollMs: options.pollMs,
    });

    terminalSessionsByRunId.set(
      readyRun.id,
      await verifyTerminalSessions(
        client,
        readyRun,
        options,
        options.forbiddenIps,
        primarySameRunPeerIpsByVmName,
      ),
    );
    logStep("terminal routes and isolation probes verified");
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    if (runIdsToTeardown.length && !options.skipTeardown) {
      let teardownFailure: unknown = null;
      try {
        if (!selectedHostId) {
          throw new Error("teardown host is unavailable");
        }
        for (const teardownRunId of [...runIdsToTeardown].reverse()) {
          await teardownAndVerify(
            client,
            selectedHostId,
            teardownRunId,
            options,
            terminalSessionsByRunId.get(teardownRunId) ?? [],
          );
        }
      } catch (teardownError) {
        if (!mainError) {
          teardownFailure = teardownError;
        } else {
          logStep(
            `teardown verification failed after primary error: ${errorMessage(teardownError)}`,
          );
        }
      }
      if (!mainError && teardownFailure) {
        throw teardownFailure;
      }
    } else if (runIdsToTeardown.length) {
      logStep(`teardown skipped for run(s) ${runIdsToTeardown.join(",")}`);
    }
  }
}

async function publishManifest(
  options: Options,
  loadedManifests: LoadedManifest[],
  manifest: ScenarioManifestV3,
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
    const imagePath =
      options.imagePathsByVmName.get(vm.name) ?? inferredImages.get(vm.name);
    if (!imagePath) {
      throw new Error(`missing image path for manifest VM ${vm.name}`);
    }
    const imageBytes = await readFile(imagePath);
    const imageSha256 = await sha256BytesHex(imageBytes);
    if (imageSha256 !== vm.image_sha256.toLowerCase()) {
      throw new Error(
        `image ${imagePath} sha256 mismatch for VM ${vm.name}: expected ${vm.image_sha256.toLowerCase()}, got ${imageSha256}`,
      );
    }
    logStep(
      `verified image ${vm.name}: ${basename(imagePath)} ${imageBytes.byteLength} bytes sha256=${imageSha256.slice(0, 12)}`,
    );
    form.append(
      `image:${vm.name}`,
      new Blob([copyToArrayBuffer(imageBytes)], {
        type: "application/octet-stream",
      }),
      basename(imagePath),
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

async function waitForHostReady(
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

async function loadRequiredImagesFromAdminScenario(
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
        image_sha256: vm.imageSha256,
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

function assertAdminScenarioDirectBootMetadata(
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

async function loadRequiredImagesFromAdminScenarios(
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

function appendUniqueRequiredImages(
  existing: RequiredImage[],
  next: RequiredImage[],
): RequiredImage[] {
  const images = [...existing];
  for (const image of next) {
    if (
      images.some(
        (candidate) =>
          sameImageKey(candidate.image_key, image.image_key) &&
          candidate.image_sha256.toLowerCase() ===
            image.image_sha256.toLowerCase(),
      )
    ) {
      continue;
    }
    images.push(image);
  }
  return images;
}

async function waitForBuildsSucceeded(
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
    throw new Error("at least one scenario id is required when waiting for builds");
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
    expectedBuilds.map((target) => buildTargetKey(target.scenarioId, target.arch)),
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
      if (missingBuildTargets.length === 0 && builds.every((build) => build.status === "succeeded")) {
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

interface ExpectedBuildTarget {
  scenarioId: string;
  arch: RequiredImage["image_key"]["arch"];
}

function uniqueBuildTargets(
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

function missingExpectedBuildTargets(
  builds: AdminBuildSummary[],
  scenarioIds: string[],
  expectedBuilds: ExpectedBuildTarget[],
): string[] {
  if (expectedBuilds.length === 0) {
    const scenariosWithBuilds = new Set(builds.map((build) => build.scenarioId));
    return scenarioIds
      .filter((scenarioId) => !scenariosWithBuilds.has(scenarioId))
      .map((scenarioId) => `${scenarioId}:any-arch`);
  }

  const buildsByTarget = new Set(
    builds.map((build) => buildTargetKey(build.scenarioId, build.arch)),
  );
  return expectedBuilds
    .filter(
      (target) => !buildsByTarget.has(buildTargetKey(target.scenarioId, target.arch)),
    )
    .map((target) => `${target.scenarioId}:${target.arch}`);
}

function formatExpectedBuildScope(
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

function buildTargetKey(
  scenarioId: string,
  arch: RequiredImage["image_key"]["arch"],
): string {
  return `${scenarioId}\0${arch}`;
}

async function selectBestHost(client: ApiClient): Promise<HostSummary | null> {
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

function hostReadinessProblems(
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
  // Reflink is a performance optimization, not a scheduling requirement: the
  // agent falls back to sparse copies on filesystems without reflink support
  // (e.g. ext4), and the control plane does not gate run placement on it.
  if (!capabilities.supports_reflink) {
    logStep(
      "host does not report reflink support; VM root disks fall back to sparse copies",
    );
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
        image.image_sha256.toLowerCase() === vm.image_sha256.toLowerCase(),
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

async function startRun(
  client: ApiClient,
  options: Options,
  hostId: string,
  scenarioId: string,
): Promise<StartRunResponse> {
  const request = scenarioStartRequest(
    scenarioId,
    options.hostId ? hostId : null,
  );
  return client.json<StartRunResponse>(request.path, request.init);
}

async function waitForRunReady(
  client: ApiClient,
  runId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<ScenarioRun> {
  return waitForRun(client, runId, timeoutMs, pollMs, (run) => {
    if (run.phase === "failed") {
      throw new Error(
        `run failed while waiting for readiness: ${run.vms.map((vm) => vm.phaseDetail).join("; ")}`,
      );
    }
    const problems = run.vms.flatMap((vm) => terminalReadinessProblems(vm));
    return problems.length
      ? { done: false, detail: problems.join("; ") }
      : { done: true, detail: "ready" };
  });
}

async function waitForRunComplete(
  client: ApiClient,
  runId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<ScenarioRun> {
  return waitForRun(client, runId, timeoutMs, pollMs, (run) => {
    if (run.phase === "completed") {
      return { done: true, detail: "completed" };
    }
    if (run.phase === "failed") {
      throw new Error(
        `run failed during teardown: ${run.vms.map((vm) => vm.phaseDetail).join("; ")}`,
      );
    }
    return { done: false, detail: `phase=${run.phase}` };
  });
}

async function waitForRun(
  client: ApiClient,
  runId: string,
  timeoutMs: number,
  pollMs: number,
  check: (
    run: ScenarioRun,
  ) => { done: true; detail: string } | { done: false; detail: string },
): Promise<ScenarioRun> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "run not checked yet";

  while (Date.now() <= deadline) {
    const response = await client.json<RunResponse>(
      `/api/scenarios/runs/${encodeURIComponent(runId)}`,
    );
    const result = check(response.run);
    lastDetail = result.detail;
    if (result.done) {
      return response.run;
    }
    await sleep(pollMs);
  }

  throw new Error(`timed out waiting for run ${runId}: ${lastDetail}`);
}

function terminalReadinessProblems(vm: RunVm): string[] {
  const problems: string[] = [];
  if (!vm.canOpenTerminal || vm.terminalPhase !== "ready") {
    problems.push(`${vm.runtimeVmName} terminal is ${vm.terminalPhase}`);
  }
  if (!vm.terminalTarget.host) {
    problems.push(`${vm.runtimeVmName} missing terminal host`);
  }
  if (!vm.terminalTarget.port) {
    problems.push(`${vm.runtimeVmName} missing terminal port`);
  }
  if (!vm.terminalTarget.hostKeyOpenssh?.startsWith("ssh-")) {
    problems.push(`${vm.runtimeVmName} missing reported SSH host key`);
  }
  return problems;
}

async function verifyRunContentGating(
  client: ApiClient,
  run: ScenarioRun,
): Promise<void> {
  if (run.hints.length === 0) {
    throw new Error("run has no authored hints to verify");
  }

  const { first: firstHint, skipAhead: skipAheadHint } =
    selectSequentialHintPair(run.hints);
  const initialUnlockState = new Map(
    run.hints.map((hint) => [hint.key, hint.unlocked]),
  );

  for (const hint of run.hints) {
    if (hint.revealed) {
      throw new Error(
        `hint ${hint.key} was revealed before the E2E reveal step`,
      );
    }
    if (hint.title !== null || hint.bodyMarkdown !== null) {
      throw new Error(`hint ${hint.key} sealed content was exposed before reveal`);
    }
  }
  if (run.solution.revealed) {
    throw new Error("solution was revealed before the E2E reveal step");
  }
  if (run.solution.bodyMarkdown !== null) {
    throw new Error("solution body was exposed before reveal");
  }
  const preRevealPayloads = [
    {
      label: "initial run payload",
      text: await client.text(`/api/scenarios/runs/${encodeURIComponent(run.id)}`),
    },
  ];
  const expectSolutionAssisted = !run.solution.unlocked;

  await expectHttpErrorCode(
    () =>
      client.json<RunResponse>(
        `/api/scenarios/runs/${encodeURIComponent(run.id)}/hints/reveal`,
        {
          method: "POST",
          json: { hintKey: skipAheadHint.key },
        },
      ),
    409,
    "scenario_hint_not_next",
    `skip-ahead reveal for ${skipAheadHint.key}`,
  );
  const afterSkipAheadText = await client.text(
    `/api/scenarios/runs/${encodeURIComponent(run.id)}`,
  );
  preRevealPayloads.push({
    label: "post skip-ahead rejection run payload",
    text: afterSkipAheadText,
  });
  const afterSkipAhead = parseJsonText<RunResponse>(
    afterSkipAheadText,
    "post skip-ahead run response",
  );
  for (const hint of afterSkipAhead.run.hints) {
    if (hint.revealed || hint.title !== null || hint.bodyMarkdown !== null) {
      throw new Error(
        `skip-ahead hint rejection leaked or revealed ${hint.key}`,
      );
    }
    if (hint.unlocked !== initialUnlockState.get(hint.key)) {
      throw new Error(
        `skip-ahead hint rejection changed unlock state for ${hint.key}`,
      );
    }
  }

  const hintReveal = await client.json<RunResponse>(
    `/api/scenarios/runs/${encodeURIComponent(run.id)}/hints/reveal`,
    {
      method: "POST",
      json: { hintKey: firstHint.key },
    },
  );
  const revealedHint = hintReveal.run.hints.find(
    (hint) => hint.key === firstHint.key,
  );
  if (!revealedHint) {
    throw new Error(`revealed hint ${firstHint.key} missing from response`);
  }
  if (
    !revealedHint.revealed ||
    revealedHint.unlocked ||
    !hasBody(revealedHint.title) ||
    !hasBody(revealedHint.bodyMarkdown)
  ) {
    throw new Error(
      `hint ${revealedHint.key} did not expose sealed content cleanly after reveal`,
    );
  }
  for (const hint of hintReveal.run.hints) {
    if (
      hint.key !== revealedHint.key &&
      (hint.title !== null || hint.bodyMarkdown !== null)
    ) {
      throw new Error(`hint ${hint.key} content was exposed out of order`);
    }
  }
  const advancedHint = hintReveal.run.hints.find(
    (hint) => hint.key === skipAheadHint.key,
  );
  if (!advancedHint?.unlocked) {
    throw new Error(
      `revealing ${firstHint.key} did not unlock ${skipAheadHint.key}`,
    );
  }
  for (const hint of hintReveal.run.hints) {
    if (hint.key === firstHint.key || hint.key === skipAheadHint.key) continue;
    if (hint.unlocked !== initialUnlockState.get(hint.key)) {
      throw new Error(
        `revealing ${firstHint.key} changed an unrelated hint ladder at ${hint.key}`,
      );
    }
  }

  const solutionReveal = await client.json<RunResponse>(
    `/api/scenarios/runs/${encodeURIComponent(run.id)}/solution/reveal`,
    {
      method: "POST",
    },
  );
  if (!solutionReveal.run.solution.revealed) {
    throw new Error("solution was not marked revealed after reveal request");
  }
  if (!hasBody(solutionReveal.run.solution.bodyMarkdown)) {
    throw new Error("solution body was not exposed after reveal");
  }
  for (const payload of preRevealPayloads) {
    assertRawPayloadDoesNotContain(
      payload.text,
      solutionReveal.run.solution.bodyMarkdown,
      payload.label,
    );
  }
  if (expectSolutionAssisted && !solutionReveal.run.solution.assisted) {
    throw new Error(
      "pre-solve solution reveal did not mark the run as assisted",
    );
  }

  logStep(
    `content gating verified: skip-ahead rejected, hint ${revealedHint.key} and solution reveal`,
  );
}

async function verifyTerminalSessions(
  client: ApiClient,
  run: ScenarioRun,
  options: Options,
  forbiddenIps: string[],
  sameRunPeerIpsByVmName: Map<string, string[]>,
): Promise<VerifiedTerminalSession[]> {
  const sessions: VerifiedTerminalSession[] = [];
  for (const vm of [...run.vms].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    const session = await client.json<BrowserTerminalSessionResponse>(
      `/api/scenarios/runs/${encodeURIComponent(run.id)}/ssh`,
      {
        method: "POST",
        json: {
          vmId: vm.id,
          mode: "browser",
        },
      },
    );
    if (!session.browser?.websocketUrl) {
      throw new Error(
        `browser terminal session missing websocket URL for ${vm.runtimeVmName}`,
      );
    }
    const verifiedSession: VerifiedTerminalSession = {
      runId: run.id,
      vmId: vm.id,
      runtimeVmName: vm.runtimeVmName,
      websocketUrl: session.browser.websocketUrl,
      probeMarker: null,
    };
    sessions.push(verifiedSession);
    if (options.skipTerminalProbe) {
      logStep(`terminal probe skipped for ${vm.runtimeVmName}`);
      continue;
    }
    const marker = `INTAR_E2E_${Date.now()}_${vm.ordinal}`;
    verifiedSession.probeMarker = marker;
    const output = await runTerminalProbe({
      websocketUrl: session.browser.websocketUrl,
      origin: new URL(options.baseUrl).origin,
      marker,
      forbiddenIps,
      sameRunPeerIps: sameRunPeerIpsByVmName.get(vm.runtimeVmName) ?? [],
      timeoutMs: options.terminalProbeTimeoutMs,
    });
    assertTerminalProbeOutput(
      output,
      marker,
      forbiddenIps,
      sameRunPeerIpsByVmName.get(vm.runtimeVmName) ?? [],
    );
    logStep(`terminal probe passed for ${vm.runtimeVmName}`);
  }
  return sessions;
}

async function verifyDistinctVmTerminalKeys(input: {
  client: ApiClient;
  hostId: string;
  run: ScenarioRun;
  timeoutMs: number;
  pollMs: number;
}): Promise<void> {
  if (input.run.vms.length < 2) {
    return;
  }
  const expectedVmNames = input.run.vms.map((vm) => vm.runtimeVmName);
  const deadline = Date.now() + input.timeoutMs;
  let lastDetail = "host runs not checked yet";

  while (Date.now() <= deadline) {
    const response = await input.client.json<HostRunsResponse>(
      `/api/agent/hosts/${encodeURIComponent(input.hostId)}/runs`,
    );
    const keysByVmName = sshAuthorizedKeyMapForRun(response, input.run.id);
    const missing = expectedVmNames.filter((name) => !keysByVmName.has(name));
    if (!missing.length) {
      const keys = expectedVmNames.map((name) => keysByVmName.get(name) ?? "");
      const uniqueKeys = new Set(keys);
      if (uniqueKeys.size !== keys.length) {
        throw new Error(
          `same run reused SSH authorized keys across VMs: ${[...keysByVmName.keys()].join(",")}`,
        );
      }
      logStep(
        `distinct per-VM terminal keys verified for ${input.run.id}: ${expectedVmNames.join(",")}`,
      );
      return;
    }
    lastDetail = `missing=${missing.join(",") || "none"} seen=${[
      ...keysByVmName.keys(),
    ].join(",")}`;
    await sleep(input.pollMs);
  }

  throw new Error(`timed out waiting for per-VM terminal keys: ${lastDetail}`);
}

async function runTerminalProbe(input: {
  websocketUrl: string;
  origin: string;
  marker: string;
  forbiddenIps: string[];
  sameRunPeerIps: string[];
  timeoutMs: number;
}): Promise<string> {
  type HeaderWebSocket = new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  const WebSocketWithHeaders =
    globalThis.WebSocket as unknown as HeaderWebSocket;
  const websocket = new WebSocketWithHeaders(input.websocketUrl, {
    headers: { origin: input.origin },
  });
  websocket.binaryType = "arraybuffer";

  const textDecoder = new TextDecoder();
  let output = "";
  let opened = false;
  let settled = false;
  let lifecycle = initialTerminalProbeLifecycle();

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abort(() =>
        reject(
          new Error(
            "terminal probe timed out before recorder exit acknowledgement",
          ),
        ),
      );
    }, input.timeoutMs);

    const cleanup = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      websocket.removeEventListener("open", handleOpen);
      websocket.removeEventListener("message", handleMessage);
      websocket.removeEventListener("error", handleError);
      websocket.removeEventListener("close", handleClose);
      complete();
    };

    const abort = (complete: () => void) => {
      if (settled) return;
      cleanup(() => {
        try {
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({ type: "close" }));
          }
          websocket.close();
        } catch {
          // Best-effort close only.
        }
        complete();
      });
    };

    const handleError = () => {
      abort(() => reject(new Error("terminal websocket failed")));
    };

    const handleClose = () => {
      lifecycle = advanceTerminalProbeLifecycle(lifecycle, { type: "close" });
      const result = lifecycle.result;
      if (result.status === "passed") {
        cleanup(() => resolve(output));
      } else if (result.status === "failed") {
        cleanup(() => reject(new Error(result.message)));
      }
    };

    const handleMessage = (event: MessageEvent<unknown>) => {
      void (async () => {
        if (typeof event.data === "string") {
          const control = parseControlMessage(event.data);
          if (control?.type === "ready" && !opened) {
            opened = true;
            websocket.send(
              new TextEncoder().encode(
                terminalProbeCommand(
                  input.marker,
                  input.forbiddenIps,
                  input.sameRunPeerIps,
                ),
              ),
            );
          } else if (control?.type === "error") {
            abort(() => reject(new Error(control.message)));
          } else if (control?.type === "exit") {
            lifecycle = advanceTerminalProbeLifecycle(lifecycle, control);
          }
          return;
        }

        const chunk = await decodeWebSocketData(event.data, textDecoder);
        if (chunk) {
          output += chunk;
          // Match only the executed printf output (real CR after the
          // marker); the echoed script text is `${marker}_END\n'` with a
          // literal backslash, so echo alone can never satisfy this.
          if (output.includes(`${input.marker}_END\r`)) {
            lifecycle = advanceTerminalProbeLifecycle(lifecycle, {
              type: "marker",
            });
          }
        }
      })().catch((error: unknown) => {
        abort(() => reject(error));
      });
    };

    const handleOpen = () => {
      websocket.send(JSON.stringify({ type: "open", cols: 120, rows: 40 }));
    };

    websocket.addEventListener("open", handleOpen, { once: true });
    websocket.addEventListener("message", handleMessage);
    websocket.addEventListener("error", handleError);
    websocket.addEventListener("close", handleClose);
  });
}

// Executed result lines end with a real CR; the echoed script text quotes
// the same strings but always continues with `"` or a literal backslash, so
// requiring the trailing CR keeps echo from satisfying these assertions.
function probeResultSeen(output: string, resultLine: string): boolean {
  return output.includes(`${resultLine}\r`);
}

function assertTerminalProbeOutput(
  output: string,
  marker: string,
  forbiddenIps: string[],
  sameRunPeerIps: string[],
): void {
  if (!probeResultSeen(output, `${marker}:metadata=blocked`)) {
    throw new Error(
      "metadata endpoint was reachable or probe output was incomplete",
    );
  }
  if (!probeResultSeen(output, `${marker}:host=blocked`)) {
    throw new Error(
      "host gateway endpoint was reachable or not conclusively blocked",
    );
  }
  forbiddenIps.forEach((ip, index) => {
    if (!probeResultSeen(output, `${marker}:forbidden_${index}=blocked`)) {
      throw new Error(
        `forbidden IP ${ip} was reachable or not conclusively blocked`,
      );
    }
  });
  sameRunPeerIps.forEach((ip, index) => {
    if (!probeResultSeen(output, `${marker}:peer_${index}=reachable`)) {
      throw new Error(
        `same-run peer IP ${ip} was not reachable or probe output was incomplete`,
      );
    }
  });
}

async function waitForSameRunPeerIps(input: {
  client: ApiClient;
  hostId: string;
  run: ScenarioRun;
  timeoutMs: number;
  pollMs: number;
}): Promise<Map<string, string[]>> {
  const expectedVmNames = input.run.vms.map((vm) => vm.runtimeVmName);
  const deadline = Date.now() + input.timeoutMs;
  let lastDetail = "host runs not checked yet";

  while (Date.now() <= deadline) {
    const response = await input.client.json<HostRunsResponse>(
      `/api/agent/hosts/${encodeURIComponent(input.hostId)}/runs`,
    );
    const guestIpByVmName = guestIpMapForRun(response, input.run.id);
    const missing = expectedVmNames.filter((name) => !guestIpByVmName.has(name));
    if (!missing.length) {
      const peersByVm = sameRunPeerIpsByVmName(input.run, guestIpByVmName);
      const peerCount = [...peersByVm.values()].reduce(
        (sum, peers) => sum + peers.length,
        0,
      );
      logStep(
        `same-run guest IPs ${[...guestIpByVmName.entries()]
          .map(([name, ip]) => `${name}=${ip}`)
          .join(",")} peer_checks=${peerCount}`,
      );
      return peersByVm;
    }
    lastDetail = `missing=${missing.join(",") || "none"} seen=${[
      ...guestIpByVmName.entries(),
    ]
      .map(([name, ip]) => `${name}=${ip}`)
      .join(",")}`;
    await sleep(input.pollMs);
  }

  throw new Error(`timed out waiting for same-run guest IPs: ${lastDetail}`);
}

function guestIpMapForRun(
  response: HostRunsResponse,
  runId: string,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const vm of response.liveVms) {
    const guestIp = vm.details?.guest_ip?.trim();
    if (vm.run_id === runId && guestIp) {
      values.set(vm.name, guestIp);
    }
  }
  return values;
}

function sshAuthorizedKeyMapForRun(
  response: HostRunsResponse,
  runId: string,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const vm of response.liveVms) {
    const publicKey = vm.details?.ssh_authorized_key_openssh?.trim();
    if (vm.run_id === runId && publicKey) {
      values.set(vm.name, publicKey);
    }
  }
  return values;
}

function sameRunPeerIpsByVmName(
  run: ScenarioRun,
  guestIpByVmName: Map<string, string>,
): Map<string, string[]> {
  const peers = new Map<string, string[]>();
  for (const vm of run.vms) {
    peers.set(
      vm.runtimeVmName,
      run.vms
        .filter((other) => other.id !== vm.id)
        .map((other) => guestIpByVmName.get(other.runtimeVmName))
        .filter((ip): ip is string => typeof ip === "string" && ip.length > 0),
    );
  }
  return peers;
}

async function teardownAndVerify(
  client: ApiClient,
  hostId: string,
  runId: string,
  options: Options,
  terminalSessions: VerifiedTerminalSession[],
): Promise<void> {
  await client.json(
    `/api/scenarios/runs/${encodeURIComponent(runId)}/destroy`,
    {
      method: "POST",
    },
  );
  logStep(`teardown requested: ${runId}`);
  const tearingDown = (
    await client.json<RunResponse>(
      `/api/scenarios/runs/${encodeURIComponent(runId)}`,
    )
  ).run;
  // The destroy response is returned only after Stargate route revocation.
  // Prove revocation now, while the original five-minute token is still live,
  // rather than letting teardown/archive time make token expiry pass the test.
  await assertTerminalSessionsRevoked(
    client,
    tearingDown,
    terminalSessions,
    options,
  );
  let completed = await waitForRunComplete(
    client,
    runId,
    options.waitCompleteMs,
    options.pollMs,
  );
  let archiveArtifacts: DashboardRunArtifact[] = [];
  if (!options.allowNoArtifacts) {
    const archived = await waitForCompletedArchive({
      client,
      hostId,
      runId,
      timeoutMs: 90_000,
      pollMs: options.pollMs,
    });
    archiveArtifacts = archived.artifacts.filter(isUploadedArchiveEvidence);
    const readableArtifact =
      archiveArtifacts.find((artifact) => artifact.sizeBytes > 0) ??
      archiveArtifacts[0];
    if (readableArtifact) {
      await assertArtifactReadable(client, completed.id, readableArtifact);
    }
    completed = (
      await client.json<RunResponse>(
        `/api/scenarios/runs/${encodeURIComponent(runId)}`,
      )
    ).run;
    assertReplayCastsPresent(completed, terminalSessions, archived);
    await assertReplaysContainProbeOutput(client, completed, terminalSessions);
  }
  const replayCount = collectReplayArtifacts(completed).length;
  logStep(
    `teardown complete with ${archiveArtifacts.length} archive artifact(s) and ${replayCount} replay artifact(s)`,
  );
}

async function waitForCompletedArchive(input: {
  client: ApiClient;
  hostId: string;
  runId: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<DashboardArchivedRun> {
  const deadline = Date.now() + input.timeoutMs;
  let lastDetail = "run not present in the host archive";

  while (Date.now() <= deadline) {
    const response = await input.client.json<HostRunsResponse>(
      `/api/agent/hosts/${encodeURIComponent(input.hostId)}/runs`,
    );
    const archived = response.archivedRuns.find(
      (candidate) => candidate.id === input.runId,
    );
    const uploadedArchives =
      archived?.artifacts.filter(isUploadedArchiveEvidence) ?? [];
    if (archived?.uploadStatus === "complete" && uploadedArchives.length > 0) {
      return archived;
    }
    lastDetail = archived
      ? `upload_status=${archived.uploadStatus} artifacts=${archived.artifacts
          .map((artifact) => `${artifact.kind}:${artifact.uploadStatus}`)
          .join(",") || "none"}`
      : lastDetail;
    await sleep(input.pollMs);
  }

  throw new Error(
    `completed run has no uploaded archive artifacts: ${lastDetail}`,
  );
}

function isUploadedArchiveEvidence(artifact: DashboardRunArtifact): boolean {
  return (
    artifact.uploadStatus === "uploaded" &&
    artifact.kind !== "ssh_recording_raw" &&
    artifact.kind !== "ssh_recording_segment"
  );
}

function assertReplayCastsPresent(
  run: ScenarioRun,
  terminalSessions: VerifiedTerminalSession[],
  archived: DashboardArchivedRun,
): void {
  const expectedVmIds = new Set(
    terminalSessions
      .filter((session) => session.probeMarker !== null)
      .map((session) => session.vmId),
  );
  const missing = run.vms
    .filter((vm) => expectedVmIds.has(vm.id))
    .filter(
      (vm) =>
        !vm.replayArtifacts.some((artifact) =>
          artifact.filename.endsWith(".cast"),
        ),
    )
    .map((vm) => vm.runtimeVmName);
  if (!missing.length) return;

  const inventory = archived.artifacts
    .map((artifact) => `${artifact.kind}:${artifact.uploadStatus}`)
    .join(",");
  throw new Error(
    `completed archive has no replay cast for ${missing.join(",")}; artifacts=${inventory || "none"}`,
  );
}

async function assertTerminalSessionsRevoked(
  client: ApiClient,
  run: ScenarioRun,
  terminalSessions: VerifiedTerminalSession[],
  options: Options,
): Promise<void> {
  await assertFreshTerminalSessionsRejected(client, run);
  if (terminalSessions.length) {
    await Promise.all(
      terminalSessions.map((session) =>
        assertOldTerminalWebSocketRejected(session, options),
      ),
    );
  }
  logStep(`terminal session revocation verified for ${run.id}`);
}

async function assertFreshTerminalSessionsRejected(
  client: ApiClient,
  run: ScenarioRun,
): Promise<void> {
  for (const vm of run.vms) {
    const response = await client.raw(
      `/api/scenarios/runs/${encodeURIComponent(run.id)}/ssh`,
      {
        method: "POST",
        json: {
          vmId: vm.id,
          mode: "browser",
        },
      },
    );
    if (response.ok) {
      throw new Error(
        `fresh terminal session was issued after teardown for ${vm.runtimeVmName}`,
      );
    }
    if (response.status < 400 || response.status >= 500) {
      const body = await parseResponseBody(response);
      throw new HttpError(
        `fresh terminal session rejection used unexpected status for ${vm.runtimeVmName}`,
        response.status,
        body,
      );
    }
  }
}

async function assertOldTerminalWebSocketRejected(
  session: VerifiedTerminalSession,
  options: Options,
): Promise<void> {
  type HeaderWebSocket = new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  const WebSocketWithHeaders =
    globalThis.WebSocket as unknown as HeaderWebSocket;
  const websocket = new WebSocketWithHeaders(session.websocketUrl, {
    headers: { origin: new URL(options.baseUrl).origin },
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `old terminal websocket stayed open after teardown for ${session.runtimeVmName}`,
          ),
        ),
      );
    }, Math.min(2_000, options.terminalProbeTimeoutMs));

    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      websocket.removeEventListener("open", handleOpen);
      websocket.removeEventListener("message", handleMessage);
      websocket.removeEventListener("error", handleError);
      websocket.removeEventListener("close", handleClose);
      try {
        websocket.close();
      } catch {
        // Best-effort close only.
      }
      complete();
    };

    const handleOpen = () => {
      websocket.send(JSON.stringify({ type: "open", cols: 80, rows: 24 }));
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === "string") {
        const control = parseControlMessage(event.data);
        if (control?.type === "error") {
          finish(resolve);
          return;
        }
      }
      finish(() =>
        reject(
          new Error(
            `old terminal websocket accepted traffic after teardown for ${session.runtimeVmName}`,
          ),
        ),
      );
    };
    const handleError = () => finish(resolve);
    const handleClose = () => finish(resolve);

    websocket.addEventListener("open", handleOpen);
    websocket.addEventListener("message", handleMessage);
    websocket.addEventListener("error", handleError);
    websocket.addEventListener("close", handleClose);
  });
}

function collectReplayArtifacts(run: ScenarioRun): RunArtifact[] {
  const byId = new Map<string, RunArtifact>();
  for (const artifact of run.replayArtifacts ?? []) {
    byId.set(artifact.id, artifact);
  }
  for (const vm of run.vms) {
    for (const artifact of vm.replayArtifacts ?? []) {
      byId.set(artifact.id, artifact);
    }
  }
  return [...byId.values()];
}

// The probe's executed output shows up in the cast as `<marker>_BEGIN\r\n`
// (a real CR), while the echoed command only ever contains the source text
// `<marker>_BEGIN\n'` with a literal backslash — so this asserts the replay
// captured what the shell actually ran, not just the keystrokes.
async function assertReplaysContainProbeOutput(
  client: ApiClient,
  run: ScenarioRun,
  terminalSessions: VerifiedTerminalSession[],
): Promise<void> {
  for (const session of terminalSessions) {
    const probeMarker = session.probeMarker;
    if (!probeMarker) continue;
    const vm = run.vms.find((candidate) => candidate.id === session.vmId);
    const replays =
      vm?.replayArtifacts.filter((artifact) =>
        artifact.filename.endsWith(".cast"),
      ) ?? [];
    if (!replays.length) {
      throw new Error(
        `no replay cast artifact for ${session.runtimeVmName} after teardown`,
      );
    }
    let matchedReplayId: string | null = null;
    const checkedReplayIds: string[] = [];
    for (const replay of replays) {
      checkedReplayIds.push(replay.id);
      const response = await client.raw(
        `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(replay.id)}/content`,
      );
      if (!response.ok) {
        const body = await parseResponseBody(response);
        throw new HttpError(
          `replay cast ${replay.id} is not readable`,
          response.status,
          body,
        );
      }
      const inspection = inspectReplayProbeOutput(
        await response.text(),
        probeMarker,
      );
      if (inspection.beginSeen && inspection.endSeen) {
        matchedReplayId = replay.id;
        break;
      }
    }
    if (!matchedReplayId) {
      throw new Error(
        `replay casts for ${session.runtimeVmName} are missing the probe's executed output; checked=${checkedReplayIds.join(",")}`,
      );
    }
    logStep(
      `replay cast ${matchedReplayId} verified for ${session.runtimeVmName}`,
    );
  }
}

async function assertArtifactReadable(
  client: ApiClient,
  runId: string,
  artifact: { id: string; sizeBytes: number },
): Promise<void> {
  const response = await client.raw(
    `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}/content`,
    artifact.sizeBytes > 0 ? { headers: { range: "bytes=0-0" } } : {},
  );
  if (!response.ok) {
    const body = await parseResponseBody(response);
    throw new HttpError(
      `artifact ${artifact.id} is not readable`,
      response.status,
      body,
    );
  }
}

class ApiClient {
  private readonly baseUrl: string;
  private readonly cookie: string;

  constructor(baseUrl: string, cookie: string) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.cookie = cookie;
  }

  async json<T = unknown>(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      json?: unknown;
    } = {},
  ): Promise<T> {
    const response = await this.raw(path, init);
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new HttpError(`request failed: ${path}`, response.status, body);
    }
    return body as T;
  }

  async text(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      json?: unknown;
    } = {},
  ): Promise<string> {
    const response = await this.raw(path, init);
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(
        `request failed: ${path}`,
        response.status,
        parseResponseText(text),
      );
    }
    return text;
  }

  raw(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      json?: unknown;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", this.cookie);
    headers.set("accept", "application/json");
    // Astro's CSRF protection rejects form-like POSTs without a same-site
    // Origin; bodyless mutations (e.g. run destroy) need it explicitly.
    if ((init.method ?? "GET") !== "GET") {
      headers.set("origin", new URL(this.baseUrl).origin);
    }
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const requestInit: RequestInit = {
      method: init.method ?? "GET",
      headers,
    };
    if (body !== undefined) {
      requestInit.body = body;
    }
    return fetch(new URL(path, this.baseUrl), requestInit);
  }
}

async function loadManifests(paths: string[]): Promise<LoadedManifest[]> {
  const loaded: LoadedManifest[] = [];
  for (const path of paths) {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    loaded.push({ path, manifest: parseManifest(parsed, path) });
  }
  return loaded;
}

export function parseManifest(value: unknown, path: string): ScenarioManifestV3 {
  if (!isRecord(value)) {
    throw new Error(`manifest ${path} is not a JSON object`);
  }
  if (value.schema_version !== 3) {
    throw new Error(`manifest ${path} must use schema_version 3`);
  }
  if (typeof value.scenario_id !== "string" || !value.scenario_id) {
    throw new Error(`manifest ${path} is missing scenario_id`);
  }
  if (!Array.isArray(value.vms) || value.vms.length === 0) {
    throw new Error(`manifest ${path} must contain at least one VM`);
  }
  value.vms.forEach((vm, index) =>
    assertManifestVmDirectBootMetadata(vm, path, index),
  );
  return value as unknown as ScenarioManifestV3;
}

function assertManifestVmDirectBootMetadata(
  value: unknown,
  path: string,
  index: number,
): void {
  if (!isRecord(value)) {
    throw new Error(`manifest ${path} VM ${index} is not an object`);
  }
  const name = typeof value.name === "string" && value.name ? value.name : index;
  if (value.image_format !== "raw_zstd") {
    throw new Error(
      `manifest ${path} VM ${name} must use image_format raw_zstd`,
    );
  }
  const virtualSize = value.image_virtual_size_bytes;
  if (!Number.isSafeInteger(virtualSize) || Number(virtualSize) <= 0) {
    throw new Error(
      `manifest ${path} VM ${name} has invalid image_virtual_size_bytes`,
    );
  }
  if (typeof value.image_sha256 !== "string" || !isSha256Hex(value.image_sha256)) {
    throw new Error(`manifest ${path} VM ${name} has invalid image_sha256`);
  }
  if (!isRecord(value.image_key)) {
    throw new Error(`manifest ${path} VM ${name} is missing image_key`);
  }
  if (!isImageArchitecture(value.image_key.arch)) {
    throw new Error(`manifest ${path} VM ${name} has invalid image_key.arch`);
  }
  if (!isRecord(value.boot)) {
    throw new Error(`manifest ${path} VM ${name} is missing boot metadata`);
  }
  if (
    typeof value.boot.kernel_sha256 !== "string" ||
    !isSha256Hex(value.boot.kernel_sha256)
  ) {
    throw new Error(`manifest ${path} VM ${name} has invalid kernel_sha256`);
  }
  if (
    typeof value.boot.initrd_sha256 !== "string" ||
    !isSha256Hex(value.boot.initrd_sha256)
  ) {
    throw new Error(`manifest ${path} VM ${name} has invalid initrd_sha256`);
  }
  if (
    typeof value.boot.cmdline !== "string" ||
    !value.boot.cmdline.includes("root=/dev/vda")
  ) {
    throw new Error(
      `manifest ${path} VM ${name} boot cmdline does not direct-boot /dev/vda`,
    );
  }
}

function combineManifests(loaded: LoadedManifest[]): ScenarioManifestV3 {
  const [first, ...rest] = loaded;
  if (!first) {
    throw new Error("cannot combine zero manifests");
  }
  const combined: ScenarioManifestV3 = {
    ...first.manifest,
    vms: [...first.manifest.vms],
  };
  const seenVmNames = new Set(combined.vms.map((vm) => vm.name));

  for (const next of rest) {
    const nextHeader = { ...next.manifest, vms: [] };
    const combinedHeader = { ...combined, vms: [] };
    if (JSON.stringify(nextHeader) !== JSON.stringify(combinedHeader)) {
      throw new Error("cannot combine manifests for different scenarios");
    }
    for (const vm of next.manifest.vms) {
      if (seenVmNames.has(vm.name)) {
        throw new Error(`duplicate VM manifest name ${vm.name}`);
      }
      seenVmNames.add(vm.name);
      combined.vms.push(vm);
    }
  }

  return combined;
}

function inferImagePaths(loaded: LoadedManifest[]): Map<string, string> {
  const images = new Map<string, string>();
  for (const item of loaded) {
    const [vm] = item.manifest.vms;
    if (item.manifest.vms.length === 1 && vm) {
      images.set(vm.name, stripManifestSuffix(item.path));
    }
  }
  return images;
}

async function inferArtifactPaths(
  loaded: LoadedManifest[],
  manifest: ScenarioManifestV3,
): Promise<Map<string, string>> {
  const required = new Set(bootArtifactSha256s(manifest));
  const inferred = new Map<string, string>();
  const dirs = new Set<string>();
  for (const item of loaded) {
    const dir = dirname(item.path);
    dirs.add(dir);
    dirs.add(join(dir, "base-images"));
  }

  for (const dir of dirs) {
    for (const path of await listCandidateArtifactFiles(dir)) {
      if (inferred.size === required.size) return inferred;
      const sha256 = await sha256FileHex(path);
      if (required.has(sha256) && !inferred.has(sha256)) {
        inferred.set(sha256, path);
      }
    }
  }
  return inferred;
}

async function listCandidateArtifactFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.includes("vmlinuz") ||
        name.includes("initrd") ||
        name.endsWith(".artifact"),
    )
    .map((name) => join(dir, name));
}

function stripManifestSuffix(path: string): string {
  return path.endsWith(".manifest.json")
    ? path.slice(0, -".manifest.json".length)
    : path;
}

export function parseOptions(
  argv: string[],
  env: Readonly<Record<string, string | undefined>>,
): Options {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    printHelp();
    process.exit(0);
  }
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : null;
    if (booleanFlags.has(key)) {
      if (inlineValue !== null) {
        throw new Error(`--${key} does not accept a value`);
      }
      flags.add(key);
      continue;
    }
    if (!valueOptions.has(key)) {
      throw new Error(`unknown option: --${key}`);
    }
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    if (inlineValue === null) {
      index += 1;
    }
    const list = values.get(key) ?? [];
    list.push(value);
    values.set(key, list);
  }

  if (env.INTAR_LIVE_CROSS_RUN_SCENARIO_ID) {
    throw new Error(
      "INTAR_LIVE_CROSS_RUN_SCENARIO_ID was removed: cross-run proof requires a multi-session harness with two authenticated users and concurrent runs on the same agent host",
    );
  }

  const baseUrl = last(values, "base-url") ?? env.INTAR_LIVE_BASE_URL ?? "";
  const cookie = last(values, "cookie") ?? env.INTAR_LIVE_COOKIE ?? "";
  const scenarioId =
    last(values, "scenario") ?? env.INTAR_LIVE_SCENARIO_ID ?? "pair-ping";
  const hostId = last(values, "host") ?? env.INTAR_LIVE_HOST_ID ?? null;
  const buildRev =
    last(values, "build-rev") ?? env.INTAR_LIVE_BUILD_REV ?? null;
  const publishToken =
    last(values, "publish-token") ?? env.INTAR_IMAGE_PUBLISH_TOKEN ?? null;
  const manifestPaths = [
    ...splitEnvList(env.INTAR_LIVE_MANIFESTS),
    ...(values.get("manifest") ?? []),
  ];
  const imageSpecs = [
    ...splitEnvList(env.INTAR_LIVE_IMAGES),
    ...(values.get("image") ?? []),
  ];
  const artifactSpecs = [
    ...splitEnvList(env.INTAR_LIVE_ARTIFACTS),
    ...(values.get("artifact") ?? []),
  ];

  if (!baseUrl) {
    throw new Error("--base-url or INTAR_LIVE_BASE_URL is required");
  }
  if (!cookie) {
    throw new Error("--cookie or INTAR_LIVE_COOKIE is required");
  }

  return {
    baseUrl,
    cookie,
    scenarioId,
    hostId,
    buildRev,
    publishToken,
    manifestPaths,
    imagePathsByVmName: parseImageSpecs(imageSpecs),
    artifactPathsBySha: parseArtifactSpecs(artifactSpecs),
    skipPublish: flags.has("skip-publish"),
    skipTeardown: flags.has("skip-teardown"),
    skipTerminalProbe: flags.has("skip-terminal-probe"),
    allowNoArtifacts: flags.has("allow-no-artifacts"),
    waitCacheMs: parseMs(last(values, "wait-cache-ms"), 180_000),
    waitBuildMs: parseMs(last(values, "wait-build-ms"), 900_000),
    waitReadyMs: parseMs(last(values, "wait-ready-ms"), 180_000),
    waitCompleteMs: parseMs(last(values, "wait-complete-ms"), 240_000),
    pollMs: parseMs(last(values, "poll-ms"), 2_000),
    warmStartBudgetMs: parseMs(last(values, "warm-start-ms"), 10_000),
    terminalProbeTimeoutMs: parseMs(
      last(values, "terminal-probe-timeout-ms"),
      30_000,
    ),
    forbiddenIps:
      values.get("forbidden-ip") ?? splitEnvList(env.INTAR_LIVE_FORBIDDEN_IPS),
  };
}

const booleanFlags = new Set([
  "skip-publish",
  "skip-teardown",
  "skip-terminal-probe",
  "allow-no-artifacts",
]);

const valueOptions = new Set([
  "base-url",
  "cookie",
  "scenario",
  "host",
  "build-rev",
  "publish-token",
  "manifest",
  "image",
  "artifact",
  "forbidden-ip",
  "wait-cache-ms",
  "wait-build-ms",
  "wait-ready-ms",
  "wait-complete-ms",
  "poll-ms",
  "warm-start-ms",
  "terminal-probe-timeout-ms",
]);

function parseImageSpecs(specs: string[]): Map<string, string> {
  const images = new Map<string, string>();
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0) {
      throw new Error(`image spec must be vmName=path: ${spec}`);
    }
    images.set(spec.slice(0, eq), spec.slice(eq + 1));
  }
  return images;
}

function parseArtifactSpecs(specs: string[]): Map<string, string> {
  const artifacts = new Map<string, string>();
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0) {
      throw new Error(`artifact spec must be sha256=path: ${spec}`);
    }
    const sha256 = spec.slice(0, eq).trim().toLowerCase();
    if (!isSha256Hex(sha256)) {
      throw new Error(`artifact spec has invalid sha256: ${spec}`);
    }
    artifacts.set(sha256, spec.slice(eq + 1));
  }
  return artifacts;
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isImageArchitecture(value: unknown): value is RequiredImage["image_key"]["arch"] {
  return value === "x86_64" || value === "aarch64";
}

function parseMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid millisecond value: ${raw}`);
  }
  return parsed;
}

function last(values: Map<string, string[]>, key: string): string | undefined {
  return values.get(key)?.at(-1);
}

function splitEnvList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function printHelp(): void {
  console.log(`Usage:
  bun run e2e:live -- --base-url https://intar.dev --cookie 'better-auth.session_token=...' \\
    --manifest ../dist/broken-nginx-webserver-amd64.raw.zst.manifest.json

Required unless skipped:
  --base-url URL                 Deployed website origin.
  --cookie COOKIE                Authenticated admin browser cookie header.
  --publish-token TOKEN          Registry publish token. Defaults to INTAR_IMAGE_PUBLISH_TOKEN.
  --manifest PATH                Builder manifest JSON. Repeat for multi-VM scenarios.

Useful options:
  --scenario ID                  Scenario to start. Defaults to pair-ping.
  --host HOST_ID                 Pin the run to a specific host.
  --build-rev REV                Wait for admin image build rows for this bundle revision.
  --image VM=PATH                Override inferred raw.zst path for a VM manifest.
  --artifact SHA=PATH            Override inferred kernel/initrd boot artifact path.
  --forbidden-ip IP              Guest-side IP that must be unreachable. Repeatable.
  --skip-publish                 Assume catalog/cache desired state is already published.
  --skip-terminal-probe          Only create Stargate routes; do not open the terminal websocket.
  --skip-teardown                Leave the run active for manual inspection.
  --allow-no-artifacts           Do not fail if teardown produces no artifacts.
  --wait-build-ms MS             Builder queue timeout. Defaults to 900000.
  --warm-start-ms MS             Click-to-terminal budget. Defaults to 10000.
`);
}

function sameImageKey(
  left: RequiredImage["image_key"],
  right: RequiredImage["image_key"],
): boolean {
  return (
    left.scenario === right.scenario &&
    left.vm === right.vm &&
    left.arch === right.arch
  );
}

function imageLabel(vm: RequiredImage): string {
  return `${vm.image_key.scenario}/${vm.image_key.vm}/${vm.image_key.arch}@${vm.image_sha256.slice(0, 12)}`;
}

function bootArtifactSha256s(manifest: ScenarioManifestV3): string[] {
  const values = new Set<string>();
  for (const vm of manifest.vms) {
    values.add(vm.boot.kernel_sha256.toLowerCase());
    values.add(vm.boot.initrd_sha256.toLowerCase());
  }
  return [...values].sort();
}

async function sha256FileHex(path: string): Promise<string> {
  const bytes = await readFile(path);
  return sha256BytesHex(bytes);
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copyToArrayBuffer(bytes),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  return parseResponseText(text);
}

function parseResponseText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseJsonText<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${errorMessage(error)}`);
  }
}

function assertRawPayloadDoesNotContain(
  payload: string,
  forbidden: string,
  label: string,
): void {
  const variants = unique([
    forbidden,
    JSON.stringify(forbidden).slice(1, -1),
  ]).filter((value) => value.length > 0);
  for (const variant of variants) {
    if (payload.includes(variant)) {
      throw new Error(`${label} leaked solution body before reveal`);
    }
  }
}

function parseControlMessage(
  raw: string,
):
  | { type: "ready" }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }
  | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    if (parsed.type === "ready") return { type: "ready" };
    if (parsed.type === "exit" && Number.isSafeInteger(parsed.code)) {
      return { type: "exit", code: parsed.code as number };
    }
    if (parsed.type === "error" && typeof parsed.message === "string") {
      return { type: "error", message: parsed.message };
    }
  } catch {
    return null;
  }
  return null;
}

async function decodeWebSocketData(
  data: unknown,
  textDecoder: TextDecoder,
): Promise<string | null> {
  if (data instanceof ArrayBuffer) {
    return textDecoder.decode(data, { stream: true });
  }
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(data, { stream: true });
  }
  if (data instanceof Blob) {
    return textDecoder.decode(await data.arrayBuffer(), { stream: true });
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasBody(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function expectHttpErrorCode(
  action: () => Promise<unknown>,
  status: number,
  code: string,
  description: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.status === status &&
      errorBodyCode(error.body) === code
    ) {
      return;
    }
    throw new Error(
      `${description} returned unexpected error: ${errorMessage(error)}`,
    );
  }
  throw new Error(`${description} unexpectedly succeeded`);
}

function errorBodyCode(body: unknown): string | null {
  return isRecord(body) && typeof body.code === "string" ? body.code : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(message: string): void {
  console.log(`[live-e2e] ${message}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    return `${error.message} (${error.status}): ${JSON.stringify(error.body)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[live-e2e] ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
