import { ApiClient } from "./api-client";
import type {
  BrowserTerminalSessionResponse,
  HostRunsResponse,
  Options,
  RunResponse,
  RunVm,
  ScenarioRun,
  StartRunResponse,
  VerifiedTerminalSession,
} from "./types";
import { selectSequentialHintPair } from "../live-e2e-hints";
import { scenarioStartRequest } from "../live-e2e-start";
import {
  advanceTerminalProbeLifecycle,
  initialTerminalProbeLifecycle,
  terminalProbeCommand,
} from "../live-e2e-terminal";
import {
  assertRawPayloadDoesNotContain,
  decodeWebSocketData,
  expectHttpErrorCode,
  hasBody,
  logStep,
  parseControlMessage,
  parseJsonText,
  sleep,
} from "./utils";

export async function startRun(
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

export async function waitForRunReady(
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

export async function waitForRunComplete(
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

export async function waitForRun(
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

export function terminalReadinessProblems(vm: RunVm): string[] {
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

export async function verifyRunContentGating(
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
      throw new Error(
        `hint ${hint.key} sealed content was exposed before reveal`,
      );
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
      text: await client.text(
        `/api/scenarios/runs/${encodeURIComponent(run.id)}`,
      ),
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

export async function verifyTerminalSessions(
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

export async function verifyDistinctVmTerminalKeys(input: {
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

export async function runTerminalProbe(input: {
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
export function probeResultSeen(output: string, resultLine: string): boolean {
  return output.includes(`${resultLine}\r`);
}

export function assertTerminalProbeOutput(
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

export async function waitForSameRunPeerIps(input: {
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
    const missing = expectedVmNames.filter(
      (name) => !guestIpByVmName.has(name),
    );
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

export function guestIpMapForRun(
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

export function sshAuthorizedKeyMapForRun(
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

export function sameRunPeerIpsByVmName(
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
