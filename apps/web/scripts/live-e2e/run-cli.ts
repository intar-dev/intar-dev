import { isVerificationPassed } from "../../src/lib/verification-copy";
import type {
  IssuedNativeSshRoute,
  NativeSshExecution,
} from "./native-ssh";
import {
  intarCliRemoteArgs,
  issueNativeSshRoute,
  runNativeSsh,
} from "./native-ssh";
import type { ApiClient } from "./api-client";
import type { Options, RunResponse, ScenarioRun, RunVm } from "./types";
import { logStep, sleep } from "./utils";

export interface VerifiedNativeRunCliSession {
  runId: string;
  vmId: string;
  runtimeVmName: string;
  issued: IssuedNativeSshRoute;
}

export interface BashCompletionCandidates {
  staticCandidates: string[];
  hintCandidates: string[];
  solutionCandidates: string[];
}

interface ScenarioStatusResponse {
  status: {
    vms: Array<{
      id: string;
      scenarioProbes: Array<{ id: string; status: string }>;
    }>;
  };
}

/**
 * This is deliberately a real SSH proof, not a direct broker probe. It uses a
 * one-run issued key, the Stargate-provided known-hosts entry, and `ssh -T`
 * for all learner commands. The forced-TTY call is limited to Bash completion.
 */
export async function verifyRunCliViaNativeSsh(input: {
  client: ApiClient;
  run: ScenarioRun;
  options: Options;
}): Promise<VerifiedNativeRunCliSession> {
  if (input.run.scenarioId !== "broken-nginx") {
    throw new Error(
      "native SSH run CLI fail-repair-pass proof requires the broken-nginx scenario",
    );
  }
  const vm = selectRunCliVm(input.run);
  const issued = await issueNativeSshRoute({
    client: input.client,
    runId: input.run.id,
    vmId: vm.id,
  });
  const session: VerifiedNativeRunCliSession = {
    runId: input.run.id,
    vmId: vm.id,
    runtimeVmName: vm.runtimeVmName,
    issued,
  };
  const rawProbeIds = vm.scenarioProbes.map((probe) => probe.id);

  const summary = await runCliCommand(session, []);
  expectCliExit(summary, 0, "intar");
  assertPlainCliOutput(summary, "intar", rawProbeIds);
  assertNonEmptyCliOutput(summary, "intar");

  const status = await runCliCommand(session, ["status"]);
  expectCliExit(status, 0, "intar status");
  assertPlainCliOutput(status, "intar status", rawProbeIds);
  assertNonEmptyCliOutput(status, "intar status");

  const help = await runCliCommand(session, ["help"]);
  expectCliExit(help, 0, "intar help");
  assertPlainCliOutput(help, "intar help", rawProbeIds);
  assertNonEmptyCliOutput(help, "intar help");

  const failedCheck = await runCliCommand(session, ["check"]);
  expectCliExit(failedCheck, 1, "initial intar check");
  assertPlainCliOutput(failedCheck, "initial intar check", rawProbeIds);
  assertNonEmptyCliOutput(failedCheck, "initial intar check");
  await waitForBrowserCheckParity({
    client: input.client,
    runId: input.run.id,
    vmId: vm.id,
    expected: "not_all_pass",
    options: input.options,
  });

  const hints = await runCliCommand(session, ["hints"]);
  expectCliExit(hints, 0, "intar hints");
  assertPlainCliOutput(hints, "intar hints", rawProbeIds);
  assertNonEmptyCliOutput(hints, "intar hints");

  // Scenario-level hints always use the learner-safe `general` alias. It
  // remains independent of all probe hint ladders and maps to the existing
  // sequential scenario reveal service.
  const hint = await runCliCommand(session, ["hint", "general"]);
  expectCliExit(hint, 0, "intar hint general");
  assertPlainCliOutput(hint, "intar hint general", rawProbeIds);
  assertNonEmptyCliOutput(hint, "intar hint general");
  const afterHint = await waitForRunView({
    client: input.client,
    runId: input.run.id,
    options: input.options,
    predicate: (run) =>
      run.hints.some(
        (candidate) => candidate.scope === "scenario" && candidate.revealed,
      ),
    description: "browser run API to show the CLI-revealed scenario hint",
  });
  const revealedScenarioHint = afterHint.hints.find(
    (candidate) => candidate.scope === "scenario" && candidate.revealed,
  );
  if (!revealedScenarioHint?.bodyMarkdown) {
    throw new Error("browser run API omitted the CLI-revealed hint body");
  }
  assertOutputDoesNotContain(
    hints.stdout,
    revealedScenarioHint.bodyMarkdown,
    "intar hints",
  );
  assertRenderedMarkdownLine(
    hint.stdout,
    revealedScenarioHint.bodyMarkdown,
    "intar hint general",
  );

  const sealedSolution = await runCliCommand(session, ["solution"]);
  expectCliExit(sealedSolution, 3, "sealed intar solution");
  assertPlainCliOutput(sealedSolution, "sealed intar solution", rawProbeIds);
  assertNonEmptyCliOutput(sealedSolution, "sealed intar solution");

  // The command itself is the deliberate confirmation. This is `ssh -T`, so
  // a prompt, stdin read, or /dev/tty read would hang or fail the proof.
  const revealedSolution = await runCliCommand(session, [
    "solution",
    "reveal",
  ]);
  expectCliExit(revealedSolution, 0, "intar solution reveal");
  assertPlainCliOutput(revealedSolution, "intar solution reveal", rawProbeIds);
  assertNonEmptyCliOutput(revealedSolution, "intar solution reveal");
  const afterSolution = await waitForRunView({
    client: input.client,
    runId: input.run.id,
    options: input.options,
    predicate: (run) =>
      run.solution.revealed &&
      run.solution.assisted &&
      typeof run.solution.bodyMarkdown === "string" &&
      run.solution.bodyMarkdown.length > 0,
    description: "browser run API to show the CLI-revealed assisted solution",
  });
  if (!afterSolution.solution.bodyMarkdown) {
    throw new Error("browser run API omitted the CLI-revealed solution body");
  }
  for (const [label, execution] of [
    ["intar", summary],
    ["intar status", status],
    ["intar help", help],
    ["initial intar check", failedCheck],
    ["intar hints", hints],
    ["intar hint general", hint],
    ["sealed intar solution", sealedSolution],
  ] as const) {
    assertOutputDoesNotContain(
      execution.stdout,
      afterSolution.solution.bodyMarkdown,
      label,
    );
  }
  assertRenderedMarkdownLine(
    revealedSolution.stdout,
    afterSolution.solution.bodyMarkdown,
    "intar solution reveal",
  );

  const repair = await runNativeSsh({
    issued: session.issued,
    remoteArgs: [
      "bash",
      "-lc",
      [
        "sudo systemctl enable --now nginx",
        "sudo ln -sfn /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default",
        "sudo systemctl reload nginx",
      ].join(" && "),
    ],
    timeoutMs: input.options.terminalProbeTimeoutMs,
  });
  expectCliExit(repair, 0, "broken-nginx repair command");

  const passedCheck = await runCliCommand(session, ["check"]);
  expectCliExit(passedCheck, 0, "repaired intar check");
  assertPlainCliOutput(passedCheck, "repaired intar check", rawProbeIds);
  assertNonEmptyCliOutput(passedCheck, "repaired intar check");
  await waitForBrowserCheckParity({
    client: input.client,
    runId: input.run.id,
    vmId: vm.id,
    expected: "all_pass",
    options: input.options,
  });

  await verifyBashCompletion(session, rawProbeIds, input.options);
  logStep(
    `native SSH run CLI verified for ${vm.runtimeVmName}: fail, hint, solution, repair, pass, completion`,
  );
  return session;
}

export async function assertNativeRunCliRouteRevoked(
  session: VerifiedNativeRunCliSession,
  timeoutMs: number,
): Promise<void> {
  const execution = await runCliCommand(session, ["status"], timeoutMs);
  if (execution.exitCode === 0) {
    throw new Error(
      `native SSH route still accepted intar status after teardown for ${session.runtimeVmName}`,
    );
  }
}

export async function waitForBrowserCheckParity(input: {
  client: ApiClient;
  runId: string;
  vmId: string;
  expected: "not_all_pass" | "all_pass";
  options: Pick<Options, "waitReadyMs" | "pollMs">;
}): Promise<void> {
  const deadline = Date.now() + input.options.waitReadyMs;
  let lastState = "scenario probes not checked";

  while (Date.now() <= deadline) {
    const response = await input.client.json<ScenarioStatusResponse>(
      `/api/scenarios/runs/${encodeURIComponent(input.runId)}/status`,
    );
    const vm = response.status.vms.find(
      (candidate) => candidate.id === input.vmId,
    );
    const probes = vm?.scenarioProbes ?? [];
    const passed =
      probes.length > 0 &&
      probes.every((probe) => isVerificationPassed(probe.status));
    if (
      (input.expected === "all_pass" && passed) ||
      (input.expected === "not_all_pass" && probes.length > 0 && !passed)
    ) {
      return;
    }
    lastState = probes.length
      ? probes.map((probe) => probe.status).join(",")
      : "no scenario probes reported";
    await sleep(input.options.pollMs);
  }

  throw new Error(
    `timed out waiting for browser/API ${input.expected} parity: ${lastState}`,
  );
}

export async function verifyBashCompletion(
  session: VerifiedNativeRunCliSession,
  rawProbeIds: string[],
  options: Pick<Options, "terminalProbeTimeoutMs">,
): Promise<void> {
  const completion = await runNativeSsh({
    issued: session.issued,
    tty: true,
    timeoutMs: options.terminalProbeTimeoutMs,
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
  expectCliExit(completion, 0, "bash completion proof");
  assertNoTerminalEscapes(completion.stdout, "bash completion proof");
  assertNoInternalProbeIds(completion.stdout, rawProbeIds, "bash completion proof");

  const candidates = parseBashCompletionCandidates(completion.stdout);
  if (!candidates.staticCandidates.includes("hints")) {
    throw new Error("Bash completion did not offer the static hints command");
  }
  assertSafeHintCompletionAliases(candidates.hintCandidates);
  if (!candidates.hintCandidates.includes("general")) {
    throw new Error(
      "Bash completion did not offer the allowed general hint alias",
    );
  }
  if (!candidates.solutionCandidates.includes("reveal")) {
    throw new Error("Bash completion did not offer solution reveal");
  }
}

export function bashCompletionProofScript(): string {
  return [
    "set -e",
    "declaration=$(complete -p intar)",
    'case "$declaration" in',
    '  *" -F "*) function_name=${declaration#* -F }; function_name=${function_name%% *} ;;',
    '  *) echo "intar completion must use a Bash function" >&2; exit 70 ;;',
    "esac",
    'case "$function_name" in',
    '  [a-zA-Z_][a-zA-Z0-9_]*) ;;',
    '  *) echo "intar completion function name is unsafe" >&2; exit 71 ;;',
    "esac",
    "COMP_WORDS=(intar hi)",
    "COMP_CWORD=1",
    "COMPREPLY=()",
    '"$function_name"',
    "printf '__INTAR_STATIC__%s\\n' \"${COMPREPLY[@]}\"",
    "COMP_WORDS=(intar hint '')",
    "COMP_CWORD=2",
    "COMPREPLY=()",
    '"$function_name"',
    "printf '__INTAR_HINT__%s\\n' \"${COMPREPLY[@]}\"",
    "COMP_WORDS=(intar solution re)",
    "COMP_CWORD=2",
    "COMPREPLY=()",
    '"$function_name"',
    "printf '__INTAR_SOLUTION__%s\\n' \"${COMPREPLY[@]}\"",
  ].join("\n");
}

export function parseBashCompletionCandidates(
  output: string,
): BashCompletionCandidates {
  const lines = output.split(/\r?\n/);
  return {
    staticCandidates: lines
      .filter((line) => line.startsWith("__INTAR_STATIC__"))
      .map((line) => line.slice("__INTAR_STATIC__".length)),
    hintCandidates: lines
      .filter((line) => line.startsWith("__INTAR_HINT__"))
      .map((line) => line.slice("__INTAR_HINT__".length)),
    solutionCandidates: lines
      .filter((line) => line.startsWith("__INTAR_SOLUTION__"))
      .map((line) => line.slice("__INTAR_SOLUTION__".length)),
  };
}

export function assertSafeHintCompletionAliases(aliases: string[]): void {
  if (
    aliases.some(
      (alias) => !/^[a-z0-9][a-z0-9-]*$/.test(alias) || alias.length > 128,
    )
  ) {
    throw new Error("Bash completion returned an unsafe hint alias");
  }
}

function selectRunCliVm(run: ScenarioRun): RunVm {
  const vm = [...run.vms].sort((left, right) => left.ordinal - right.ordinal)[0];
  if (!vm) {
    throw new Error("run has no VM for native SSH run CLI verification");
  }
  if (!vm.canOpenTerminal || vm.terminalPhase !== "ready") {
    throw new Error(`run CLI VM ${vm.runtimeVmName} is not terminal-ready`);
  }
  return vm;
}

async function runCliCommand(
  session: VerifiedNativeRunCliSession,
  command: string[],
  timeoutMs?: number,
): Promise<NativeSshExecution> {
  return runNativeSsh({
    issued: session.issued,
    remoteArgs: intarCliRemoteArgs(command),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function waitForRunView(input: {
  client: ApiClient;
  runId: string;
  options: Pick<Options, "waitReadyMs" | "pollMs">;
  predicate: (run: ScenarioRun) => boolean;
  description: string;
}): Promise<ScenarioRun> {
  const deadline = Date.now() + input.options.waitReadyMs;
  while (Date.now() <= deadline) {
    const response = await input.client.json<RunResponse>(
      `/api/scenarios/runs/${encodeURIComponent(input.runId)}`,
    );
    if (input.predicate(response.run)) return response.run;
    await sleep(input.options.pollMs);
  }
  throw new Error(`timed out waiting for ${input.description}`);
}

function expectCliExit(
  execution: NativeSshExecution,
  expectedExitCode: number,
  label: string,
): void {
  if (execution.exitCode !== expectedExitCode) {
    throw new Error(
      `${label} exited ${execution.exitCode}, expected ${expectedExitCode}`,
    );
  }
}

function assertPlainCliOutput(
  execution: NativeSshExecution,
  label: string,
  rawProbeIds: string[],
): void {
  assertNoTerminalEscapes(execution.stdout, label);
  assertNoTerminalEscapes(execution.stderr, label);
  assertNoInternalProbeIds(execution.stdout, rawProbeIds, label);
}

function assertNonEmptyCliOutput(
  execution: NativeSshExecution,
  label: string,
): void {
  if (!execution.stdout.trim()) {
    throw new Error(`${label} returned no learner-facing stdout`);
  }
}

function assertNoTerminalEscapes(output: string, label: string): void {
  if (/\u001b|[\u0080-\u009f]/.test(output)) {
    throw new Error(
      `${label} emitted terminal escape/control bytes in plain mode`,
    );
  }
}

function assertNoInternalProbeIds(
  output: string,
  rawProbeIds: string[],
  label: string,
): void {
  for (const id of rawProbeIds) {
    if (id && output.includes(id)) {
      throw new Error(`${label} exposed an internal probe ID`);
    }
  }
}

function assertOutputDoesNotContain(
  output: string,
  secret: string,
  label: string,
): void {
  if (secret && output.includes(secret)) {
    throw new Error(`${label} exposed sealed content before its reveal`);
  }
}

function assertRenderedMarkdownLine(
  output: string,
  markdown: string,
  label: string,
): void {
  const line = markdown
    .split("\n")
    .map((candidate) => candidate.replace(/[`*_>#]/g, "").trim())
    .find((candidate) => candidate.length >= 8 && !candidate.startsWith("```"));
  if (
    !line ||
    !normalizeWhitespace(output).includes(normalizeWhitespace(line))
  ) {
    throw new Error(`${label} did not print the newly available learner content`);
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
