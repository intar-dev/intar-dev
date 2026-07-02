import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ScenarioManifestV1, ScenarioVmManifestV1 } from "../src/generated/catalog";

interface Options {
  baseUrl: string;
  cookie: string;
  scenarioId: string;
  crossRunScenarioId: string | null;
  hostId: string | null;
  publishToken: string | null;
  manifestPaths: string[];
  imagePathsByVmName: Map<string, string>;
  skipPublish: boolean;
  skipTeardown: boolean;
  skipTerminalProbe: boolean;
  allowNoArtifacts: boolean;
  waitCacheMs: number;
  waitReadyMs: number;
  waitCompleteMs: number;
  pollMs: number;
  warmStartBudgetMs: number;
  terminalProbeTimeoutMs: number;
  forbiddenIps: string[];
}

interface LoadedManifest {
  path: string;
  manifest: ScenarioManifestV1;
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
      image_key: ScenarioVmManifestV1["image_key"];
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
    } | null;
  }>;
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

interface ScenarioRun {
  id: string;
  phase: string;
  canOpenTerminal: boolean;
  createdAt: number;
  updatedAt: number;
  replayArtifacts?: RunArtifact[];
  vms: RunVm[];
}

interface RunVm {
  id: string;
  ordinal: number;
  scenarioVmName: string;
  runtimeVmName: string;
  phase: string;
  terminalPhase: string;
  canOpenTerminal: boolean;
  phaseDetail: string;
  replayArtifacts?: RunArtifact[];
  terminalTarget: {
    host: string | null;
    port: number;
    username: string;
    hostKeyOpenssh: string | null;
  };
}

interface RunArtifact {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

interface BrowserTerminalSessionResponse {
  routeUsername: string;
  expiresAt: number;
  browser?: {
    websocketUrl: string;
  };
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

function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.env);
  return runLiveE2e(options);
}

async function runLiveE2e(options: Options): Promise<void> {
  const client = new ApiClient(options.baseUrl, options.cookie);
  const loadedManifests = await loadManifests(options.manifestPaths);
  const manifest = loadedManifests.length ? combineManifests(loadedManifests) : null;
  const requiredImages = manifest?.vms ?? [];
  const runIdsToTeardown: string[] = [];
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

    const host = await waitForHostReady(client, options, requiredImages);
    logStep(`host ready: ${host.id}`);

    const startedAt = Date.now();
    const start = await startRun(client, options, host.id, options.scenarioId);
    const primaryRunId = start.runId;
    runIdsToTeardown.push(primaryRunId);
    logStep(`run accepted: ${primaryRunId}${start.reused ? " (reused active run)" : ""}`);

    const readyRun = await waitForRunReady(
      client,
      primaryRunId,
      options.waitReadyMs,
      options.pollMs,
    );
    const readyElapsedMs = Date.now() - startedAt;
    if (readyElapsedMs > options.warmStartBudgetMs) {
      throw new Error(
        `warm start budget exceeded: ${readyElapsedMs}ms > ${options.warmStartBudgetMs}ms`,
      );
    }
    logStep(`terminal ready in ${readyElapsedMs}ms`);

    let primaryForbiddenIps = options.forbiddenIps;
    let secondaryReadyRun: ScenarioRun | null = null;
    let secondaryForbiddenIps = options.forbiddenIps;
    if (options.crossRunScenarioId) {
      if (options.crossRunScenarioId === options.scenarioId) {
        throw new Error("--cross-run-scenario must differ from --scenario");
      }
      const secondaryStart = await startRun(
        client,
        options,
        host.id,
        options.crossRunScenarioId,
      );
      const secondaryRunId = secondaryStart.runId;
      runIdsToTeardown.push(secondaryRunId);
      logStep(
        `cross-run accepted: ${secondaryRunId}${secondaryStart.reused ? " (reused active run)" : ""}`,
      );
      secondaryReadyRun = await waitForRunReady(
        client,
        secondaryRunId,
        options.waitReadyMs,
        options.pollMs,
      );
      const crossRunIps = await waitForCrossRunGuestIps({
        client,
        hostId: host.id,
        primaryRunId,
        secondaryRunId,
        timeoutMs: options.waitReadyMs,
        pollMs: options.pollMs,
      });
      primaryForbiddenIps = [...options.forbiddenIps, ...crossRunIps.secondaryGuestIps];
      secondaryForbiddenIps = [...options.forbiddenIps, ...crossRunIps.primaryGuestIps];
      logStep(
        `cross-run guest IPs primary=${crossRunIps.primaryGuestIps.join(",")} secondary=${crossRunIps.secondaryGuestIps.join(",")}`,
      );
    }

    await verifyTerminalSessions(client, readyRun, options, primaryForbiddenIps);
    if (secondaryReadyRun) {
      await verifyTerminalSessions(client, secondaryReadyRun, options, secondaryForbiddenIps);
    }
    logStep("terminal routes and isolation probes verified");
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    if (runIdsToTeardown.length && !options.skipTeardown) {
      let teardownFailure: unknown = null;
      try {
        for (const teardownRunId of [...runIdsToTeardown].reverse()) {
          await teardownAndVerify(client, teardownRunId, options);
        }
      } catch (teardownError) {
        if (!mainError) {
          teardownFailure = teardownError;
        } else {
          logStep(`teardown verification failed after primary error: ${errorMessage(teardownError)}`);
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
  manifest: ScenarioManifestV1,
): Promise<void> {
  if (!options.publishToken) {
    throw new Error("live E2E publish requires --publish-token or INTAR_IMAGE_PUBLISH_TOKEN");
  }
  const inferredImages = inferImagePaths(loadedManifests);
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));

  for (const vm of manifest.vms) {
    const imagePath = options.imagePathsByVmName.get(vm.name) ?? inferredImages.get(vm.name);
    if (!imagePath) {
      throw new Error(`missing image path for manifest VM ${vm.name}`);
    }
    const imageBytes = await readFile(imagePath);
    form.append(
      `image:${vm.name}`,
      new Blob([copyToArrayBuffer(imageBytes)], {
        type: "application/octet-stream",
      }),
      basename(imagePath),
    );
  }

  const response = await fetch(new URL("/registry/v1/publish", options.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.publishToken}`,
    },
    body: form,
  });
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new HttpError("registry publish failed", response.status, body);
  }
  logStep(`published ${manifest.scenario_id} with ${manifest.vms.length} VM image(s)`);
}

async function waitForHostReady(
  client: ApiClient,
  options: Options,
  requiredImages: ScenarioVmManifestV1[],
): Promise<HostSummary> {
  const deadline = Date.now() + options.waitCacheMs;
  let lastStatus = "host not checked yet";

  while (Date.now() <= deadline) {
    const host = options.hostId
      ? await client.json<HostResponse>(`/api/agent/hosts/${encodeURIComponent(options.hostId)}`)
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
  requiredImages: ScenarioVmManifestV1[],
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
  if (!capabilities.supports_kvm) problems.push("host does not report KVM support");
  if (!capabilities.supports_vsock) problems.push("host does not report vsock support");
  if (!capabilities.supports_nftables) problems.push("host does not report nftables support");
  if (!capabilities.supports_reflink) problems.push("host does not report reflink support");

  for (const vm of requiredImages) {
    const cached = host.actualState.cachedImages.find(
      (image) =>
        sameImageKey(image.image_key, vm.image_key) &&
        image.image_sha256.toLowerCase() === vm.image_sha256.toLowerCase(),
    );
    if (!cached) {
      problems.push(`image ${imageLabel(vm)} is not reported by cache`);
    } else if (cached.phase !== "ready") {
      problems.push(`image ${imageLabel(vm)} is ${cached.phase}${cached.error ? `: ${cached.error}` : ""}`);
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
  if (options.hostId) {
    return client.json<StartRunResponse>(
      `/api/agent/hosts/${encodeURIComponent(hostId)}/runs`,
      {
        method: "POST",
        json: { scenarioId },
      },
    );
  }

  return client.json<StartRunResponse>(
    `/api/scenarios/${encodeURIComponent(scenarioId)}/start`,
    {
      method: "POST",
    },
  );
}

async function waitForRunReady(
  client: ApiClient,
  runId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<ScenarioRun> {
  return waitForRun(client, runId, timeoutMs, pollMs, (run) => {
    if (run.phase === "failed") {
      throw new Error(`run failed while waiting for readiness: ${run.vms.map((vm) => vm.phaseDetail).join("; ")}`);
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
      throw new Error(`run failed during teardown: ${run.vms.map((vm) => vm.phaseDetail).join("; ")}`);
    }
    return { done: false, detail: `phase=${run.phase}` };
  });
}

async function waitForRun(
  client: ApiClient,
  runId: string,
  timeoutMs: number,
  pollMs: number,
  check: (run: ScenarioRun) => { done: true; detail: string } | { done: false; detail: string },
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

async function verifyTerminalSessions(
  client: ApiClient,
  run: ScenarioRun,
  options: Options,
  forbiddenIps: string[],
): Promise<void> {
  for (const vm of [...run.vms].sort((left, right) => left.ordinal - right.ordinal)) {
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
      throw new Error(`browser terminal session missing websocket URL for ${vm.runtimeVmName}`);
    }
    if (options.skipTerminalProbe) {
      logStep(`terminal probe skipped for ${vm.runtimeVmName}`);
      continue;
    }
    const marker = `INTAR_E2E_${Date.now()}_${vm.ordinal}`;
    const output = await runTerminalProbe({
      websocketUrl: session.browser.websocketUrl,
      origin: new URL(options.baseUrl).origin,
      marker,
      forbiddenIps,
      timeoutMs: options.terminalProbeTimeoutMs,
    });
    assertTerminalProbeOutput(output, marker, forbiddenIps);
    logStep(`terminal probe passed for ${vm.runtimeVmName}`);
  }
}

async function runTerminalProbe(input: {
  websocketUrl: string;
  origin: string;
  marker: string;
  forbiddenIps: string[];
  timeoutMs: number;
}): Promise<string> {
  type HeaderWebSocket = new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  const WebSocketWithHeaders = globalThis.WebSocket as unknown as HeaderWebSocket;
  const websocket = new WebSocketWithHeaders(input.websocketUrl, {
    headers: { origin: input.origin },
  });
  websocket.binaryType = "arraybuffer";

  const textDecoder = new TextDecoder();
  let output = "";
  let opened = false;
  let settled = false;

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("terminal probe timed out")));
    }, input.timeoutMs);

    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      websocket.removeEventListener("message", handleMessage);
      websocket.removeEventListener("error", handleError);
      websocket.removeEventListener("close", handleClose);
      try {
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({ type: "close" }));
        }
        websocket.close();
      } catch {
        // Best-effort close only.
      }
      complete();
    };

    const handleError = () => {
      finish(() => reject(new Error("terminal websocket failed")));
    };

    const handleClose = () => {
      if (!settled) {
        finish(() => reject(new Error("terminal websocket closed before probe completed")));
      }
    };

    const handleMessage = (event: MessageEvent<unknown>) => {
      void (async () => {
        if (typeof event.data === "string") {
          const control = parseControlMessage(event.data);
          if (control?.type === "ready" && !opened) {
            opened = true;
            websocket.send(new TextEncoder().encode(terminalProbeCommand(input.marker, input.forbiddenIps)));
          } else if (control?.type === "error") {
            finish(() => reject(new Error(control.message)));
          }
          return;
        }

        const chunk = await decodeWebSocketData(event.data, textDecoder);
        if (chunk) {
          output += chunk;
          if (output.includes(`${input.marker}_END`)) {
            finish(() => resolve(output));
          }
        }
      })().catch((error: unknown) => {
        finish(() => reject(error));
      });
    };

    websocket.addEventListener("message", handleMessage);
    websocket.addEventListener("error", handleError);
    websocket.addEventListener("close", handleClose);
    websocket.addEventListener(
      "open",
      () => {
        websocket.send(JSON.stringify({ type: "open", cols: 120, rows: 40 }));
      },
      { once: true },
    );
  });
}

function terminalProbeCommand(marker: string, forbiddenIps: string[]): string {
  const lines = [
    `printf '\\n${marker}_BEGIN\\n'`,
    "if command -v curl >/dev/null 2>&1; then",
    `  timeout 4 curl -fsS --connect-timeout 2 --max-time 3 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1 && echo "${marker}:metadata=reachable" || echo "${marker}:metadata=blocked"`,
    "else",
    `  timeout 4 bash -lc ':</dev/tcp/169.254.169.254/80' >/dev/null 2>&1 && echo "${marker}:metadata=reachable" || echo "${marker}:metadata=blocked"`,
    "fi",
    "gateway=\"$(ip route show default 2>/dev/null | awk '/default/ { print $3; exit }')\"",
    "if [ -n \"$gateway\" ]; then",
    `  timeout 4 bash -lc ":</dev/tcp/$gateway/22" >/dev/null 2>&1 && echo "${marker}:host=reachable" || echo "${marker}:host=blocked"`,
    "else",
    `  echo "${marker}:host=unknown"`,
    "fi",
  ];

  forbiddenIps.forEach((ip, index) => {
    const variable = `forbidden_ip_${index}`;
    lines.push(`${variable}=${shellQuote(ip)}`);
    lines.push(
      `timeout 4 bash -lc ":</dev/tcp/\${${variable}}/22" >/dev/null 2>&1 && echo "${marker}:forbidden_${index}=reachable" || echo "${marker}:forbidden_${index}=blocked"`,
    );
  });

  lines.push(`printf '${marker}_END\\n'`);
  return `${lines.join("\n")}\n`;
}

function assertTerminalProbeOutput(
  output: string,
  marker: string,
  forbiddenIps: string[],
): void {
  if (!output.includes(`${marker}:metadata=blocked`)) {
    throw new Error("metadata endpoint was reachable or probe output was incomplete");
  }
  if (!output.includes(`${marker}:host=blocked`)) {
    throw new Error("host gateway endpoint was reachable or not conclusively blocked");
  }
  forbiddenIps.forEach((ip, index) => {
    if (!output.includes(`${marker}:forbidden_${index}=blocked`)) {
      throw new Error(`forbidden IP ${ip} was reachable or not conclusively blocked`);
    }
  });
}

async function waitForCrossRunGuestIps(input: {
  client: ApiClient;
  hostId: string;
  primaryRunId: string;
  secondaryRunId: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<{
  primaryGuestIps: string[];
  secondaryGuestIps: string[];
}> {
  const deadline = Date.now() + input.timeoutMs;
  let lastDetail = "host runs not checked yet";

  while (Date.now() <= deadline) {
    const response = await input.client.json<HostRunsResponse>(
      `/api/agent/hosts/${encodeURIComponent(input.hostId)}/runs`,
    );
    const primaryGuestIps = guestIpsForRun(response, input.primaryRunId);
    const secondaryGuestIps = guestIpsForRun(response, input.secondaryRunId);
    if (primaryGuestIps.length && secondaryGuestIps.length) {
      return { primaryGuestIps, secondaryGuestIps };
    }
    lastDetail = `primary=${primaryGuestIps.join(",") || "none"} secondary=${secondaryGuestIps.join(",") || "none"}`;
    await sleep(input.pollMs);
  }

  throw new Error(`timed out waiting for cross-run guest IPs: ${lastDetail}`);
}

function guestIpsForRun(response: HostRunsResponse, runId: string): string[] {
  return unique(
    response.liveVms
      .filter((vm) => vm.run_id === runId)
      .map((vm) => vm.details?.guest_ip?.trim() ?? "")
      .filter(Boolean),
  );
}

async function teardownAndVerify(
  client: ApiClient,
  runId: string,
  options: Options,
): Promise<void> {
  await client.json(`/api/scenarios/runs/${encodeURIComponent(runId)}/destroy`, {
    method: "POST",
  });
  logStep(`teardown requested: ${runId}`);
  const completed = await waitForRunComplete(
    client,
    runId,
    options.waitCompleteMs,
    options.pollMs,
  );
  const artifacts = collectArtifacts(completed);
  if (!options.allowNoArtifacts && artifacts.length === 0) {
    throw new Error("completed run has no artifacts");
  }
  if (artifacts[0]) {
    await assertArtifactReadable(client, completed.id, artifacts[0]);
  }
  logStep(`teardown complete with ${artifacts.length} artifact(s)`);
}

function collectArtifacts(run: ScenarioRun): RunArtifact[] {
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

async function assertArtifactReadable(
  client: ApiClient,
  runId: string,
  artifact: RunArtifact,
): Promise<void> {
  const response = await client.raw(
    `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}/content`,
    {
      headers: { range: "bytes=0-0" },
    },
  );
  if (!response.ok) {
    const body = await parseResponseBody(response);
    throw new HttpError(`artifact ${artifact.id} is not readable`, response.status, body);
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

function parseManifest(value: unknown, path: string): ScenarioManifestV1 {
  if (!isRecord(value)) {
    throw new Error(`manifest ${path} is not a JSON object`);
  }
  if (value.schema_version !== 1) {
    throw new Error(`manifest ${path} must use schema_version 1`);
  }
  if (typeof value.scenario_id !== "string" || !value.scenario_id) {
    throw new Error(`manifest ${path} is missing scenario_id`);
  }
  if (!Array.isArray(value.vms) || value.vms.length === 0) {
    throw new Error(`manifest ${path} must contain at least one VM`);
  }
  return value as unknown as ScenarioManifestV1;
}

function combineManifests(loaded: LoadedManifest[]): ScenarioManifestV1 {
  const [first, ...rest] = loaded;
  if (!first) {
    throw new Error("cannot combine zero manifests");
  }
  const combined: ScenarioManifestV1 = {
    ...first.manifest,
    vms: [...first.manifest.vms],
  };
  const seenVmNames = new Set(combined.vms.map((vm) => vm.name));

  for (const next of rest) {
    if (
      next.manifest.scenario_id !== combined.scenario_id ||
      next.manifest.name !== combined.name ||
      next.manifest.description !== combined.description
    ) {
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

function stripManifestSuffix(path: string): string {
  return path.endsWith(".manifest.json")
    ? path.slice(0, -".manifest.json".length)
    : path;
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): Options {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : null;
    if (booleanFlags.has(key)) {
      flags.add(key);
      continue;
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

  const baseUrl = last(values, "base-url") ?? env.INTAR_LIVE_BASE_URL ?? "";
  const cookie =
    last(values, "cookie") ??
    env.INTAR_LIVE_COOKIE ??
    "";
  const scenarioId =
    last(values, "scenario") ?? env.INTAR_LIVE_SCENARIO_ID ?? "broken-nginx";
  const crossRunScenarioId =
    last(values, "cross-run-scenario") ??
    env.INTAR_LIVE_CROSS_RUN_SCENARIO_ID ??
    null;
  const hostId = last(values, "host") ?? env.INTAR_LIVE_HOST_ID ?? null;
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
    crossRunScenarioId,
    hostId,
    publishToken,
    manifestPaths,
    imagePathsByVmName: parseImageSpecs(imageSpecs),
    skipPublish: flags.has("skip-publish"),
    skipTeardown: flags.has("skip-teardown"),
    skipTerminalProbe: flags.has("skip-terminal-probe"),
    allowNoArtifacts: flags.has("allow-no-artifacts"),
    waitCacheMs: parseMs(last(values, "wait-cache-ms"), 180_000),
    waitReadyMs: parseMs(last(values, "wait-ready-ms"), 180_000),
    waitCompleteMs: parseMs(last(values, "wait-complete-ms"), 240_000),
    pollMs: parseMs(last(values, "poll-ms"), 2_000),
    warmStartBudgetMs: parseMs(last(values, "warm-start-ms"), 10_000),
    terminalProbeTimeoutMs: parseMs(last(values, "terminal-probe-timeout-ms"), 30_000),
    forbiddenIps: values.get("forbidden-ip") ?? splitEnvList(env.INTAR_LIVE_FORBIDDEN_IPS),
  };
}

const booleanFlags = new Set([
  "skip-publish",
  "skip-teardown",
  "skip-terminal-probe",
  "allow-no-artifacts",
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
    --manifest ../dist/broken-nginx-webserver-amd64.qcow2.manifest.json

Required unless skipped:
  --base-url URL                 Deployed website origin.
  --cookie COOKIE                Authenticated admin browser cookie header.
  --publish-token TOKEN          Registry publish token. Defaults to INTAR_IMAGE_PUBLISH_TOKEN.
  --manifest PATH                Builder manifest JSON. Repeat for multi-VM scenarios.

Useful options:
  --scenario ID                  Scenario to start. Defaults to broken-nginx.
  --cross-run-scenario ID        Optional second scenario for cross-run isolation.
  --host HOST_ID                 Pin the run to a specific host.
  --image VM=PATH                Override inferred qcow2 path for a VM manifest.
  --forbidden-ip IP              Guest-side IP that must be unreachable. Repeatable.
  --skip-publish                 Assume catalog/cache desired state is already published.
  --skip-terminal-probe          Only create Stargate routes; do not open the terminal websocket.
  --skip-teardown                Leave the run active for manual inspection.
  --allow-no-artifacts           Do not fail if teardown produces no artifacts.
  --warm-start-ms MS             Click-to-terminal budget. Defaults to 10000.
`);
}

function sameImageKey(
  left: ScenarioVmManifestV1["image_key"],
  right: ScenarioVmManifestV1["image_key"],
): boolean {
  return (
    left.scenario === right.scenario &&
    left.vm === right.vm &&
    left.arch === right.arch
  );
}

function imageLabel(vm: ScenarioVmManifestV1): string {
  return `${vm.image_key.scenario}/${vm.image_key.vm}/${vm.image_key.arch}@${vm.image_sha256.slice(0, 12)}`;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseControlMessage(raw: string): { type: "ready" } | { type: "error"; message: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    if (parsed.type === "ready") return { type: "ready" };
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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

main().catch((error: unknown) => {
  console.error(`[live-e2e] ${errorMessage(error)}`);
  process.exitCode = 1;
});
