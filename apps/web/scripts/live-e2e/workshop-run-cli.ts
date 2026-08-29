import {
  intarCliRemoteArgs,
  issueNativeSshRouteRequest,
  runNativeSsh,
  type IssuedNativeSshRoute,
  type NativeSshExecution,
} from "./native-ssh";
import type { ApiClient } from "./api-client";
import { sleep } from "./utils";
import {
  assertSafeHintCompletionAliases,
  bashCompletionProofScript,
  parseBashCompletionCandidates,
} from "./run-cli";

export const DISPOSABLE_WORKSHOP_TEARDOWN_CONFIRMATION =
  "END DISPOSABLE WORKSHOP";

const DEFAULT_PARITY_TIMEOUT_MS = 60_000;
const DEFAULT_PARITY_POLL_MS = 500;

type WorkshopProbeStatus = "pass" | "fail" | "pending" | "unknown";

export interface WorkshopRunCliStatus {
  session: {
    id: string;
    version: number;
    state: "draft" | "lobby" | "live" | "ended" | "cancelled";
    currentModuleId: string | null;
  };
  viewer: {
    role: "participant" | "helper" | "facilitator";
    workspaceEnabled: boolean;
    canFacilitate: boolean;
  };
  modules: Array<{
    id: string;
    released: boolean;
    solutionRevealed: boolean;
    hints: Array<{ id: string; revealed: boolean }>;
    probes: Array<{ id: string; status: WorkshopProbeStatus }>;
  }>;
  workspace: {
    id: string;
    state: string;
    terminalAvailable: boolean;
  } | null;
}

/**
 * The scenario live harness cannot create a workshop session or select a
 * provider. This focused action hook is deliberately usable against either an
 * already-running KVM workshop workspace or a direct-cloud workspace.
 *
 * It uses the same issued-key and strict-host-verification route as scenarios.
 * It deliberately runs a fresh check and reveals one currently available hint,
 * but never reveals a Workshop solution. Run it once for each provider after
 * creating the participant workspace through the normal workshop workflow.
 */
export async function verifyWorkshopRunCliViaNativeSsh(input: {
  client: ApiClient;
  facilitatorClient: ApiClient;
  sessionId: string;
  providerLabel: "kvm" | "direct-cloud";
  disposableConfirmation: string;
  timeoutMs?: number;
  parityTimeoutMs?: number;
  parityPollMs?: number;
}): Promise<IssuedNativeSshRoute> {
  assertDisposableWorkshopConfirmation(input.disposableConfirmation);
  const initialStatus = await loadWorkshopStatus(input.client, input.sessionId);
  const workspace = requireParticipantWorkspace(
    initialStatus,
    input.providerLabel,
  );
  const issued = await issueWorkshopNativeSshRoute({
    client: input.client,
    sessionId: input.sessionId,
    workspaceId: workspace.id,
  });
  const timeoutMs = input.timeoutMs ?? 30_000;
  const parityTimeoutMs = input.parityTimeoutMs ?? DEFAULT_PARITY_TIMEOUT_MS;
  const parityPollMs = input.parityPollMs ?? DEFAULT_PARITY_POLL_MS;
  const commands: Array<{
    command: string[];
    exits: number[];
    label: string;
  }> = [
    { command: [], exits: [0], label: "intar" },
    { command: ["status"], exits: [0], label: "intar status" },
    { command: ["help"], exits: [0], label: "intar help" },
    { command: ["check"], exits: [0, 1], label: "intar check" },
    { command: ["hints"], exits: [0], label: "intar hints" },
  ];

  let check: NativeSshExecution | null = null;
  for (const command of commands) {
    const execution = await runNativeSsh({
      issued,
      remoteArgs: intarCliRemoteArgs(command.command),
      timeoutMs,
    });
    expectWorkshopCliExit(
      execution,
      command.exits,
      command.label,
      input.providerLabel,
    );
    assertPlainOutput(execution, command.label, input.providerLabel);
    if (command.label === "intar check") check = execution;
  }

  if (!check) throw new Error("workshop run CLI check command was not run");
  await waitForWorkshopCheckParity({
    client: input.client,
    sessionId: input.sessionId,
    providerLabel: input.providerLabel,
    expected: check.exitCode === 0 ? "all_pass" : "not_all_pass",
    timeoutMs: parityTimeoutMs,
    pollMs: parityPollMs,
  });

  const aliases = await workshopHintAliases({
    issued,
    timeoutMs,
    providerLabel: input.providerLabel,
  });
  const hintAlias = aliases[0];
  if (!hintAlias) {
    throw new Error(
      `${input.providerLabel} workshop has no currently available hint alias`,
    );
  }
  const beforeHint = await loadWorkshopStatus(input.client, input.sessionId);
  const hintTarget = requireWorkshopHintTarget(
    beforeHint,
    hintAlias,
    input.providerLabel,
  );
  const revealedHint = await runNativeSsh({
    issued,
    remoteArgs: intarCliRemoteArgs(["hint", hintAlias]),
    timeoutMs,
  });
  expectWorkshopCliExit(
    revealedHint,
    [0],
    `intar hint ${hintAlias}`,
    input.providerLabel,
  );
  assertPlainOutput(
    revealedHint,
    `intar hint ${hintAlias}`,
    input.providerLabel,
  );
  await waitForWorkshopHintParity({
    client: input.client,
    sessionId: input.sessionId,
    providerLabel: input.providerLabel,
    moduleId: hintTarget.moduleId,
    hintId: hintTarget.hintId,
    timeoutMs: parityTimeoutMs,
    pollMs: parityPollMs,
  });

  const beforeSolution = await loadWorkshopStatus(
    input.client,
    input.sessionId,
  );
  const solutionModule = requireCurrentWorkshopModule(
    beforeSolution,
    input.providerLabel,
  );
  const solution = await runNativeSsh({
    issued,
    remoteArgs: intarCliRemoteArgs(["solution"]),
    timeoutMs,
  });
  expectWorkshopCliExit(
    solution,
    [solutionModule.solutionRevealed ? 0 : 3],
    "intar solution",
    input.providerLabel,
  );
  assertPlainOutput(solution, "intar solution", input.providerLabel);
  assertWorkshopSolutionStateUnchanged({
    before: beforeSolution,
    after: await loadWorkshopStatus(input.client, input.sessionId),
    moduleId: solutionModule.id,
    providerLabel: input.providerLabel,
    action: "intar solution",
  });

  const rejectedSolutionReveal = await runNativeSsh({
    issued,
    remoteArgs: intarCliRemoteArgs(["solution", "reveal"]),
    timeoutMs,
  });
  expectWorkshopCliExit(
    rejectedSolutionReveal,
    [3],
    "intar solution reveal",
    input.providerLabel,
  );
  assertPlainOutput(
    rejectedSolutionReveal,
    "intar solution reveal",
    input.providerLabel,
  );
  assertWorkshopSolutionStateUnchanged({
    before: beforeSolution,
    after: await loadWorkshopStatus(input.client, input.sessionId),
    moduleId: solutionModule.id,
    providerLabel: input.providerLabel,
    action: "intar solution reveal",
  });

  await teardownDisposableWorkshopSession({
    learnerClient: input.client,
    facilitatorClient: input.facilitatorClient,
    sessionId: input.sessionId,
    workspaceId: workspace.id,
    issued,
    providerLabel: input.providerLabel,
    timeoutMs,
    parityTimeoutMs,
    parityPollMs,
  });

  return issued;
}

export async function issueWorkshopNativeSshRoute(input: {
  client: ApiClient;
  sessionId: string;
  workspaceId: string;
}): Promise<IssuedNativeSshRoute> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error("workshop session ID is required");
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) throw new Error("workshop workspace ID is required");
  return issueNativeSshRouteRequest({
    client: input.client,
    path: `/api/workshops/${encodeURIComponent(sessionId)}/terminal`,
    body: { workspaceId },
    keyComment: `live-e2e-workshop-${sessionId}`,
  });
}

export function assertDisposableWorkshopConfirmation(value: string): void {
  if (value !== DISPOSABLE_WORKSHOP_TEARDOWN_CONFIRMATION) {
    throw new Error(
      `set the disposable workshop confirmation to ${DISPOSABLE_WORKSHOP_TEARDOWN_CONFIRMATION}`,
    );
  }
}

export async function loadWorkshopStatus(
  client: ApiClient,
  sessionId: string,
): Promise<WorkshopRunCliStatus> {
  return client.json<WorkshopRunCliStatus>(
    `/api/workshops/${encodeURIComponent(sessionId)}/status`,
  );
}

export function requireParticipantWorkspace(
  status: WorkshopRunCliStatus,
  providerLabel: string,
): NonNullable<WorkshopRunCliStatus["workspace"]> {
  if (
    status.session.state !== "lobby" &&
    status.session.state !== "live"
  ) {
    throw new Error(`${providerLabel} workshop session is not open`);
  }
  if (
    status.viewer.role !== "participant" ||
    !status.viewer.workspaceEnabled ||
    status.viewer.canFacilitate
  ) {
    throw new Error(
      `${providerLabel} workshop proof needs a participant-only learner cookie`,
    );
  }
  const workspace = status.workspace;
  if (!workspace?.terminalAvailable || workspace.state !== "ready") {
    throw new Error(
      `${providerLabel} workshop participant workspace is not terminal-ready`,
    );
  }
  return workspace;
}

export function requireCurrentWorkshopModule(
  status: WorkshopRunCliStatus,
  providerLabel: string,
): WorkshopRunCliStatus["modules"][number] {
  const focused = status.session.currentModuleId;
  const module =
    (focused
      ? status.modules.find(
          (candidate) => candidate.id === focused && candidate.released,
        )
      : undefined) ?? status.modules.find((candidate) => candidate.released);
  if (!module) {
    throw new Error(`${providerLabel} workshop has no released module`);
  }
  return module;
}

export function requireWorkshopHintTarget(
  status: WorkshopRunCliStatus,
  alias: string,
  providerLabel: string,
): { moduleId: string; hintId: string } {
  const match = /^hint-([1-9][0-9]*)$/.exec(alias);
  if (!match) {
    throw new Error(`${providerLabel} workshop returned an invalid hint alias`);
  }
  const ordinal = Number(match[1]);
  const module = requireCurrentWorkshopModule(status, providerLabel);
  const hint = module.hints[ordinal - 1];
  if (!hint || hint.revealed) {
    throw new Error(
      `${providerLabel} workshop completion returned a hint that is not ready`,
    );
  }
  return { moduleId: module.id, hintId: hint.id };
}

export async function waitForWorkshopCheckParity(input: {
  client: ApiClient;
  sessionId: string;
  providerLabel: string;
  expected: "all_pass" | "not_all_pass";
  timeoutMs: number;
  pollMs: number;
}): Promise<WorkshopRunCliStatus> {
  const initial = await loadWorkshopStatus(input.client, input.sessionId);
  const moduleId = requireCurrentWorkshopModule(
    initial,
    input.providerLabel,
  ).id;
  return waitForWorkshopStatus({
    ...input,
    description: "fresh check browser parity",
    predicate: (status) => {
      const module = status.modules.find(
        (candidate) => candidate.id === moduleId,
      );
      const probes = module?.probes ?? [];
      if (
        probes.length === 0 ||
        probes.some(
          (probe) => probe.status !== "pass" && probe.status !== "fail",
        )
      ) {
        return false;
      }
      return input.expected === "all_pass"
        ? probes.every((probe) => probe.status === "pass")
        : probes.some((probe) => probe.status === "fail");
    },
  });
}

export async function waitForWorkshopHintParity(input: {
  client: ApiClient;
  sessionId: string;
  providerLabel: string;
  moduleId: string;
  hintId: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<WorkshopRunCliStatus> {
  return waitForWorkshopStatus({
    ...input,
    description: "CLI hint browser parity",
    predicate: (status) =>
      status.modules
        .find((module) => module.id === input.moduleId)
        ?.hints.find((hint) => hint.id === input.hintId)?.revealed === true,
  });
}

export function assertWorkshopSolutionStateUnchanged(input: {
  before: WorkshopRunCliStatus;
  after: WorkshopRunCliStatus;
  moduleId: string;
  providerLabel: string;
  action: string;
}): void {
  const before = input.before.modules.find(
    (module) => module.id === input.moduleId,
  );
  const after = input.after.modules.find(
    (module) => module.id === input.moduleId,
  );
  if (!before || !after || before.solutionRevealed !== after.solutionRevealed) {
    throw new Error(
      `${input.providerLabel} workshop ${input.action} changed facilitator solution state`,
    );
  }
}

export async function teardownDisposableWorkshopSession(input: {
  learnerClient: ApiClient;
  facilitatorClient: ApiClient;
  sessionId: string;
  workspaceId: string;
  issued: IssuedNativeSshRoute;
  providerLabel: string;
  timeoutMs: number;
  parityTimeoutMs: number;
  parityPollMs: number;
}): Promise<void> {
  await endDisposableWorkshopSession({
    learnerClient: input.learnerClient,
    facilitatorClient: input.facilitatorClient,
    sessionId: input.sessionId,
    providerLabel: input.providerLabel,
    timeoutMs: input.parityTimeoutMs,
    pollMs: input.parityPollMs,
  });
  await assertFreshWorkshopTerminalRejected({
    client: input.learnerClient,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    providerLabel: input.providerLabel,
  });
  await assertWorkshopNativeRouteRevoked({
    issued: input.issued,
    providerLabel: input.providerLabel,
    timeoutMs: input.timeoutMs,
  });
}

export async function endDisposableWorkshopSession(input: {
  learnerClient: ApiClient;
  facilitatorClient: ApiClient;
  sessionId: string;
  providerLabel: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<void> {
  const facilitatorStatus = await loadWorkshopStatus(
    input.facilitatorClient,
    input.sessionId,
  );
  if (!facilitatorStatus.viewer.canFacilitate) {
    throw new Error(
      `${input.providerLabel} workshop teardown needs a facilitator cookie`,
    );
  }
  if (
    facilitatorStatus.session.state !== "lobby" &&
    facilitatorStatus.session.state !== "live"
  ) {
    throw new Error(
      `${input.providerLabel} workshop session is already closed before teardown`,
    );
  }

  await input.facilitatorClient.json(
    `/api/workshops/${encodeURIComponent(input.sessionId)}/actions`,
    {
      method: "POST",
      json: {
        action: "end_session",
        version: facilitatorStatus.session.version,
      },
    },
  );

  await waitForWorkshopStatus({
    client: input.learnerClient,
    sessionId: input.sessionId,
    providerLabel: input.providerLabel,
    timeoutMs: input.timeoutMs,
    pollMs: input.pollMs,
    description: "session teardown",
    predicate: (status) => status.session.state === "ended",
  });
}

export async function assertFreshWorkshopTerminalRejected(input: {
  client: ApiClient;
  sessionId: string;
  workspaceId: string;
  providerLabel: string;
}): Promise<void> {
  const response = await input.client.raw(
    `/api/workshops/${encodeURIComponent(input.sessionId)}/terminal`,
    {
      method: "POST",
      json: { workspaceId: input.workspaceId, mode: "browser" },
    },
  );
  await response.text();
  if (response.ok || response.status < 400 || response.status >= 500) {
    throw new Error(
      `${input.providerLabel} workshop issued a fresh terminal route after teardown`,
    );
  }
}

export async function assertWorkshopNativeRouteRevoked(input: {
  issued: IssuedNativeSshRoute;
  providerLabel: string;
  timeoutMs: number;
}): Promise<void> {
  const execution = await runNativeSsh({
    issued: input.issued,
    remoteArgs: intarCliRemoteArgs(["status"]),
    timeoutMs: input.timeoutMs,
  });
  if (execution.exitCode === 0) {
    throw new Error(
      `${input.providerLabel} workshop native SSH route still accepted intar status after teardown`,
    );
  }
}

async function waitForWorkshopStatus(input: {
  client: ApiClient;
  sessionId: string;
  providerLabel: string;
  timeoutMs: number;
  pollMs: number;
  description: string;
  predicate: (status: WorkshopRunCliStatus) => boolean;
}): Promise<WorkshopRunCliStatus> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() <= deadline) {
    const status = await loadWorkshopStatus(input.client, input.sessionId);
    if (input.predicate(status)) return status;
    await sleep(input.pollMs);
  }
  throw new Error(
    `${input.providerLabel} workshop timed out waiting for ${input.description}`,
  );
}

async function workshopHintAliases(input: {
  issued: IssuedNativeSshRoute;
  timeoutMs: number;
  providerLabel: string;
}): Promise<string[]> {
  const completion = await runNativeSsh({
    issued: input.issued,
    tty: true,
    timeoutMs: input.timeoutMs,
    remoteArgs: [
      "env",
      "TERM=xterm-256color",
      "LANG=C.UTF-8",
      "NO_COLOR=1",
      "bash",
      "-ic",
      bashCompletionProofScript(),
    ],
  });
  expectWorkshopCliExit(
    completion,
    [0],
    "Bash completion",
    input.providerLabel,
  );
  assertPlainOutput(completion, "Bash completion", input.providerLabel);
  if (!completion.stdout.includes("complete -F ")) {
    throw new Error(
      `${input.providerLabel} workshop Bash did not load intar completion`,
    );
  }
  try {
    return workshopHintAliasesFromCompletionOutput(completion.stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid aliases";
    throw new Error(`${input.providerLabel} workshop completion ${reason}`);
  }
}

export function workshopHintAliasesFromCompletionOutput(output: string): string[] {
  const candidates = parseBashCompletionCandidates(output);
  if (!candidates.staticCandidates.includes("hints")) {
    throw new Error("did not offer the static hints command");
  }
  if (!candidates.solutionCandidates.includes("reveal")) {
    throw new Error("did not offer solution reveal completion");
  }
  assertSafeHintCompletionAliases(candidates.hintCandidates);
  if (
    candidates.hintCandidates.some(
      (alias) => !/^hint-[1-9][0-9]*$/.test(alias),
    )
  ) {
    throw new Error("exposed a non-workshop hint alias");
  }
  return candidates.hintCandidates;
}

function expectWorkshopCliExit(
  execution: NativeSshExecution,
  allowed: number[],
  label: string,
  providerLabel: string,
): void {
  if (!allowed.includes(execution.exitCode)) {
    throw new Error(
      `${providerLabel} workshop ${label} exited ${execution.exitCode}, expected ${allowed.join(" or ")}`,
    );
  }
}

function assertPlainOutput(
  execution: NativeSshExecution,
  label: string,
  providerLabel: string,
): void {
  if (!execution.stdout.trim()) {
    throw new Error(`${providerLabel} workshop ${label} returned no stdout`);
  }
  if (/\u001b|[\u0080-\u009f]/.test(execution.stdout + execution.stderr)) {
    throw new Error(
      `${providerLabel} workshop ${label} emitted terminal escapes`,
    );
  }
}
