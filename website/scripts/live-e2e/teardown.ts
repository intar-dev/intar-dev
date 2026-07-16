import type {
  DashboardArchivedRun,
  DashboardRunArtifact,
} from "../../src/lib/dashboard-host";
import { inspectReplayProbeOutput } from "../live-e2e-terminal";
import { ApiClient } from "./api-client";
import {
  HttpError,
  type HostRunsResponse,
  type Options,
  type RunArtifact,
  type RunResponse,
  type ScenarioRun,
  type VerifiedTerminalSession,
} from "./types";
import { waitForRunComplete } from "./terminal";
import {
  logStep,
  parseControlMessage,
  parseResponseBody,
  sleep,
} from "./utils";

export async function teardownAndVerify(
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

export async function waitForCompletedArchive(input: {
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
      ? `upload_status=${archived.uploadStatus} artifacts=${
          archived.artifacts
            .map((artifact) => `${artifact.kind}:${artifact.uploadStatus}`)
            .join(",") || "none"
        }`
      : lastDetail;
    await sleep(input.pollMs);
  }

  throw new Error(
    `completed run has no uploaded archive artifacts: ${lastDetail}`,
  );
}

export function isUploadedArchiveEvidence(
  artifact: DashboardRunArtifact,
): boolean {
  return (
    artifact.uploadStatus === "uploaded" &&
    artifact.kind !== "ssh_recording_raw" &&
    artifact.kind !== "ssh_recording_segment"
  );
}

export function assertReplayCastsPresent(
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

export async function assertTerminalSessionsRevoked(
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

export async function assertFreshTerminalSessionsRejected(
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

export async function assertOldTerminalWebSocketRejected(
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
    const timeout = setTimeout(
      () => {
        finish(() =>
          reject(
            new Error(
              `old terminal websocket stayed open after teardown for ${session.runtimeVmName}`,
            ),
          ),
        );
      },
      Math.min(2_000, options.terminalProbeTimeoutMs),
    );

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

export function collectReplayArtifacts(run: ScenarioRun): RunArtifact[] {
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
export async function assertReplaysContainProbeOutput(
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

export async function assertArtifactReadable(
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
