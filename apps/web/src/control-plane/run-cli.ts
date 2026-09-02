import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import {
  runtimeExecutions,
  runtimeVmActualState,
  runtimeVms,
  scenarioRuns,
  accessAllowlist,
} from "@/db/schema";
import {
  RUN_CLI_MAX_COMPLETION_ALIASES,
  RUN_CLI_MAX_FRAME_BYTES,
  RUN_CLI_MAX_HINT_ALIAS_BYTES,
  RUN_CLI_MAX_PROBE_IDS,
  RUN_CLI_MAX_RETRY_SCOPE_BYTES,
  RUN_CLI_MAX_REQUEST_ID_BYTES,
  RUN_CLI_PROTOCOL_VERSION,
  type RunCliActionV1,
  type RunCliCheckStatusV1,
  type RunCliCheckV1,
  type RunCliErrorCodeV1,
  type RunCliHintEntryV1,
  type RunCliHintGroupV1,
  type RunCliHintStateV1,
  type RunCliRequestV1,
  type RunCliResponseV1,
  type RunCliResultV1,
  type RunCliRunKindV1,
  type RunCliSolutionStateV1,
  type RunCliViewV1,
} from "@/generated/run-cli";
import { AppError } from "@/lib/app-error";
import {
  revealScenarioRunHintForUser,
  revealScenarioRunSolutionForUser,
  type ScenarioRunCliMutationFence,
} from "@/lib/scenario-hints";
import { getScenarioRunForUser, type ScenarioRunRecord } from "@/lib/scenario-runs";
import { isVerificationPassed } from "@/lib/verification-copy";

/** Keep the HTTP body below the private framed broker limit. */
export const RUN_CLI_MAX_BODY_BYTES = RUN_CLI_MAX_FRAME_BYTES;
const RUN_CLI_MAX_TEXT_BYTES = 64 * 1024;
const RUN_CLI_MAX_HINTS = 512;
const RUN_CLI_MAX_GENERATION_BYTES = 128;
const RUN_CLI_PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
} as const;

type RunCliSubject = {
  kind: "scenario";
  userId: string;
  runId: string;
  runtimeVmName: string;
  mutationFence: ScenarioRunCliMutationFence;
  retryScope: string;
};

interface KvmRunCliFence {
  subject: RunCliSubject;
  executionId: string;
  vmName: string;
  jailGeneration: string;
}

interface KvmRunCliRow {
  executionId: string;
  executionHostId: string | null;
  executionDomainKind: "scenario";
  executionDomainId: string;
  executionUserId: string;
  executionGeneration: number;
  executionState: string;
  runtimeVmId: string;
  runtimeVmName: string;
  actualHostId: string;
  report: unknown;
  scenarioRunId: string | null;
  scenarioRuntimeExecutionId: string | null;
  scenarioUserId: string | null;
  scenarioActiveKey: string | null;
  scenarioDeleteRequestedAt: number | null;
}

/**
 * Private endpoint used by `intar-agent`.  It is intentionally separate from
 * browser routes: the VM provides no cookie or browser origin, and the agent
 * supplies the authenticated host plus the exact jail generation.
 */
export async function handleAgentRunCliRequest(
  request: Request,
  workerEnv: Cloudflare.Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const match = path.match(
    /^\/agent\/runs\/([^/]+)\/vms\/([^/]+)\/cli$/,
  );
  if (!match) return null;

  if (request.method !== "POST") {
    return runCliErrorResponse({
      requestId: "invalid",
      status: 405,
      code: "invalid_request",
      message: "This Intar command is not available.",
      retryable: false,
    });
  }

  const executionId = decodePathSegment(match[1] ?? "");
  const vmName = decodePathSegment(match[2] ?? "");
  if (!isSafeId(executionId) || !isSafeId(vmName)) {
    return runCliErrorResponse({
      requestId: "invalid",
      status: 400,
      code: "invalid_request",
      message: "This Intar command is invalid.",
      retryable: false,
    });
  }

  const authenticated = await requireVerifiedAgentRequest(request, workerEnv);
  if (!authenticated.ok) return authenticated.response;
  if (authenticated.agent.role !== "agent") {
    return runCliErrorResponse({
      requestId: "invalid",
      status: 403,
      code: "unauthorized",
      message: "This Intar command is not authorized.",
      retryable: false,
    });
  }

  const jailGeneration = normalizeGeneration(
    request.headers.get("x-intar-jail-generation"),
  );
  if (!jailGeneration) {
    return runCliErrorResponse({
      requestId: "invalid",
      status: 400,
      code: "invalid_request",
      message: "This Intar command is invalid.",
      retryable: false,
    });
  }

  const parsed = await parseRunCliRequest(request);
  if (!parsed.ok) return parsed.response;

  const fence = await resolveKvmRunCliFence({
    executionId,
    vmName,
    hostId: authenticated.agent.hostId,
    jailGeneration,
  });
  if (!fence) {
    return runCliErrorResponse({
      requestId: parsed.request.request_id,
      // The broker deliberately forwards only successful HTTP responses. A
      // fenced-out but otherwise valid command is a renderable `unavailable`
      // result, not a transport failure.
      status: 200,
      code: "unavailable",
      message: "This workspace is no longer active. Reconnect through Intar.",
      retryable: true,
    });
  }

  const response = await handleRunCliSubjectRequest({
    request: parsed.request,
    subject: fence.subject,
  });
  // The guest cannot race a replacement generation into receiving fresh
  // content. Re-read the exact host/run/VM/jail fence after any service work
  // (including a reveal mutation) and discard the result if it changed.
  const current = await resolveKvmRunCliFence({
    executionId,
    vmName,
    hostId: authenticated.agent.hostId,
    jailGeneration,
  });
  if (!current) {
    return runCliErrorResponse({
        requestId: parsed.request.request_id,
        status: 200,
        code: "unavailable",
        message: "This workspace is no longer active. Reconnect through Intar.",
        retryable: true,
      });
  }
  return response;
}

async function handleRunCliSubjectRequest(input: {
  request: RunCliRequestV1;
  subject: RunCliSubject;
}): Promise<Response> {
  try {
    if (!(await hasActiveCliAccess(input.subject.userId))) {
      throw runCliFailure(
        "unauthorized",
        "This Intar command is no longer authorized.",
        false,
      );
    }
    const result = await dispatchRunCliAction(input);
    return runCliSuccessResponse(
      input.request.request_id,
      input.request.action,
      result,
    );
  } catch (error) {
    return runCliServiceErrorResponse(input.request.request_id, error);
  }

  async function dispatchRunCliAction(params: {
    request: RunCliRequestV1;
  }): Promise<RunCliSuccessResultV1> {
    return dispatchScenarioRunCliAction({
      action: params.request.action,
      subject: input.subject,
    });
  }
}

type RunCliOkResultV1 = Extract<RunCliResultV1, { kind: "ok" }>;
type RunCliCompletionResultV1 = Extract<
  RunCliResultV1,
  { kind: "completion" }
>;
export type RunCliSuccessResultV1 = Exclude<
  RunCliResultV1,
  { kind: "error" }
>;

async function hasActiveCliAccess(userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM access_allowlist
     WHERE user_id = ? AND state = 'active'
     LIMIT 1`,
  )
    .bind(userId)
    .first();
  return Boolean(row);
}

async function dispatchScenarioRunCliAction(input: {
  action: RunCliActionV1;
  subject: Extract<RunCliSubject, { kind: "scenario" }>;
}): Promise<RunCliSuccessResultV1> {
  let run = await getScenarioRunForUser({
    runId: input.subject.runId,
    userId: input.subject.userId,
  });
  if (!run.active || run.deleteRequestedAt !== null) {
    throw runCliFailure(
      "unavailable",
      "This workspace is no longer active. Reconnect through Intar.",
      true,
    );
  }
  const vm = requireScenarioVm(run, input.subject.runtimeVmName);

  if (input.action.kind === "completion") {
    return {
      kind: "completion",
      aliases: scenarioCompletionAliases(run, vm),
    };
  }

  if (input.action.kind === "hint_reveal") {
    const target = scenarioHintForAliasOrdinal(
      run,
      vm.runtimeVmName,
      input.action.alias,
      input.action.expected_ordinal,
    );
    if (!target || (!target.revealed && !target.unlocked)) {
      throw runCliFailure(
        "locked",
        "No hint is ready for that check.",
        false,
      );
    }
    // A lost response is safe to retry: the caller supplies the immutable
    // ordinal it saw, so an already revealed target returns the same view and
    // never consumes the next hint in the ladder.
    if (!target.revealed) {
      run = await revealScenarioRunHintForUser({
        runId: input.subject.runId,
        userId: input.subject.userId,
        hintKey: target.key,
        mutationFence: input.subject.mutationFence,
      });
    }
  } else if (input.action.kind === "solution_reveal") {
    run = await revealScenarioRunSolutionForUser({
      runId: input.subject.runId,
      userId: input.subject.userId,
      mutationFence: input.subject.mutationFence,
    });
  }

  return {
    kind: "ok",
    view: scenarioRunCliView(
      run,
      input.subject.runtimeVmName,
      input.subject.retryScope,
    ),
  };
}

/**
 * Completion is deliberately a smaller projection than `scenarioRunCliView`.
 * It never serializes labels, titles, bodies, probe IDs, or solution state.
 */
function scenarioCompletionAliases(
  run: ScenarioRunRecord,
  vm: ScenarioRunRecord["vms"][number],
): string[] {
  if (run.hints.length > RUN_CLI_MAX_HINTS) {
    throw runCliFailure(
      "unavailable",
      "Hints are unavailable for this run.",
      true,
    );
  }
  if (vm.scenarioProbes.length > RUN_CLI_MAX_PROBE_IDS) {
    throw runCliFailure(
      "unavailable",
      "Checks are unavailable for this run.",
      true,
    );
  }

  const aliases: string[] = [];
  if (
    run.hints.some(
      (hint) => hint.scope === "scenario" && hint.unlocked && !hint.revealed,
    )
  ) {
    aliases.push("general");
  }
  const prefix = `probe:${vm.scenarioVmName}:`;
  for (const [ordinal, probe] of vm.scenarioProbes.entries()) {
    if (
      run.hints.some(
        (hint) =>
          hint.scope === "probe" &&
          hint.key.startsWith(prefix) &&
          hint.probeName === probe.id &&
          hint.unlocked &&
          !hint.revealed,
      )
    ) {
      aliases.push(`check-${ordinal + 1}`);
    }
  }
  return boundedCompletionAliases(aliases);
}

function boundedCompletionAliases(aliases: Iterable<string>): string[] {
  const sorted = [...new Set(aliases)].sort();
  // All callers construct aliases from public, fixed prefixes. Keep the
  // guard here so a future caller cannot accidentally turn completion into a
  // content transport.
  if (!sorted.every(validHintAlias)) {
    throw runCliFailure(
      "internal",
      "Intar could not complete that command. Try again.",
      true,
    );
  }
  return sorted.slice(0, RUN_CLI_MAX_COMPLETION_ALIASES);
}

function scenarioRunCliView(
  run: ScenarioRunRecord,
  runtimeVmName: string,
  retryScope: string,
): RunCliViewV1 {
  const vm = requireScenarioVm(run, runtimeVmName);
  if (run.hints.length > RUN_CLI_MAX_HINTS) {
    throw runCliFailure(
      "unavailable",
      "Hints are unavailable for this run.",
      true,
    );
  }
  if (vm.scenarioProbes.length > RUN_CLI_MAX_PROBE_IDS) {
    throw runCliFailure(
      "unavailable",
      "Checks are unavailable for this run.",
      true,
    );
  }
  assertViewTextBudget([
    run.title,
    vm.scenarioVmName,
    ...vm.scenarioProbes.map((probe) => probe.label),
    ...run.hints.flatMap((hint) =>
      hint.revealed
        ? [hint.title ?? "", hint.bodyMarkdown ?? ""]
        : [],
    ),
    ...(run.solution.revealed && run.solution.bodyMarkdown
      ? [run.solution.bodyMarkdown]
      : []),
  ]);
  const checks = boundedChecks(vm.scenarioProbes.map((probe, ordinal) => ({
    probe_id: probe.id,
    alias: `check-${ordinal + 1}`,
    label: safeSingleLine(probe.label, `Check ${ordinal + 1}`),
    status: scenarioCheckStatus(probe.status),
  })) satisfies RunCliCheckV1[]);
  const hintGroups = scenarioHintGroups(run, vm, checks);
  return boundedView({
    retry_scope: retryScope,
    run: {
      kind: "scenario" satisfies RunCliRunKindV1,
      title: safeSingleLine(run.title, "Intar run"),
      context: safeSingleLine(vm.scenarioVmName, "Workspace"),
    },
    checks,
    hint_groups: hintGroups,
    solution: {
      state: run.solution.revealed
        ? ("revealed" satisfies RunCliSolutionStateV1)
        : ("sealed" satisfies RunCliSolutionStateV1),
      assisted: run.solution.assisted,
      ...(run.solution.revealed && run.solution.bodyMarkdown !== null
        ? { body_markdown: safeMarkdown(run.solution.bodyMarkdown) }
        : {}),
    },
  });
}

function scenarioHintGroups(
  run: ScenarioRunRecord,
  vm: ScenarioRunRecord["vms"][number],
  checks: readonly RunCliCheckV1[],
): RunCliHintGroupV1[] {
  const groups: RunCliHintGroupV1[] = [];
  const scenarioHints = run.hints.filter((hint) => hint.scope === "scenario");
  if (scenarioHints.length) {
    groups.push(
      projectScenarioHintGroup("general", "General guidance", scenarioHints),
    );
  }
  const prefix = `probe:${vm.scenarioVmName}:`;
  for (const [ordinal, check] of checks.entries()) {
    const hints = run.hints.filter(
      (hint) =>
        hint.scope === "probe" &&
        hint.key.startsWith(prefix) &&
        hint.probeName === check.probe_id,
    );
    if (!hints.length) continue;
    // The full objective label already appears in `checks`; keeping this
    // repeated group label fixed prevents one hostile label multiplying by
    // every hint group in the response.
    groups.push(
      projectScenarioHintGroup(check.alias, `Check ${ordinal + 1}`, hints),
    );
  }
  return groups;
}

function projectScenarioHintGroup(
  alias: string,
  label: string,
  hints: ScenarioRunRecord["hints"],
): RunCliHintGroupV1 {
  const entries = hints.map((hint, ordinal) => ({
    ordinal: ordinal + 1,
    state: hint.revealed
      ? ("revealed" satisfies RunCliHintStateV1)
      : hint.unlocked
        ? ("ready" satisfies RunCliHintStateV1)
        : ("locked" satisfies RunCliHintStateV1),
    ...(hint.revealed && hint.title !== null
      ? { title: safeSingleLine(hint.title, `Hint ${ordinal + 1}`) }
      : {}),
    ...(hint.revealed && hint.bodyMarkdown !== null
      ? { body_markdown: safeMarkdown(hint.bodyMarkdown) }
      : {}),
  })) satisfies RunCliHintEntryV1[];
  return {
    alias,
    label: safeSingleLine(label, "Hints"),
    revealed_count: countRevealed(entries),
    total_count: toU16(entries.length),
    can_reveal: entries.some((entry) => entry.state === "ready"),
    entries,
  };
}

function scenarioHintForAliasOrdinal(
  run: ScenarioRunRecord,
  runtimeVmName: string,
  alias: string,
  expectedOrdinal: number,
): ScenarioRunRecord["hints"][number] | null {
  if (!Number.isSafeInteger(expectedOrdinal) || expectedOrdinal < 1) return null;
  if (alias === "general") {
    return (
      run.hints.filter((hint) => hint.scope === "scenario")[
        expectedOrdinal - 1
      ] ?? null
    );
  }
  const ordinal = checkOrdinal(alias);
  if (ordinal === null) return null;
  const vm = requireScenarioVm(run, runtimeVmName);
  const probe = vm.scenarioProbes[ordinal];
  if (!probe) return null;
  const prefix = `probe:${vm.scenarioVmName}:`;
  return (
    run.hints
      .filter(
      (hint) =>
        hint.scope === "probe" &&
        hint.key.startsWith(prefix) &&
        hint.probeName === probe.id,
      )[expectedOrdinal - 1] ?? null
  );
}

function scenarioCheckStatus(status: string): RunCliCheckStatusV1 {
  if (isVerificationPassed(status)) return "pass";
  return failedStatus(status) ? "fail" : "unknown";
}


function failedStatus(status: string): boolean {
  return ["fail", "failed", "error", "errored"].includes(
    status.trim().toLowerCase(),
  );
}

function boundedChecks(checks: RunCliCheckV1[]): RunCliCheckV1[] {
  if (checks.length > RUN_CLI_MAX_PROBE_IDS) {
    throw runCliFailure(
      "unavailable",
      "Checks are unavailable for this run.",
      true,
    );
  }
  return checks;
}

function assertViewTextBudget(values: Iterable<string>): void {
  let used = 0;
  for (const value of values) {
    used += byteLength(value);
    if (used > RUN_CLI_MAX_BODY_BYTES - 2048) {
      throw runCliFailure(
        "frame_too_large",
        "This Intar response is too large to display safely.",
        false,
      );
    }
  }
}

function requireScenarioVm(run: ScenarioRunRecord, runtimeVmName: string) {
  const vm = run.vms.find((candidate) => candidate.runtimeVmName === runtimeVmName);
  if (!vm) {
    throw runCliFailure(
      "unavailable",
      "This workspace is no longer active. Reconnect through Intar.",
      true,
    );
  }
  return vm;
}

async function resolveKvmRunCliFence(input: {
  executionId: string;
  vmName: string;
  hostId: string;
  jailGeneration: string;
}): Promise<KvmRunCliFence | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      executionId: runtimeExecutions.id,
      executionHostId: runtimeExecutions.hostId,
      executionDomainKind: runtimeExecutions.domainKind,
      executionDomainId: runtimeExecutions.domainId,
      executionUserId: runtimeExecutions.userId,
      executionGeneration: runtimeExecutions.generation,
      executionState: runtimeExecutions.state,
      runtimeVmId: runtimeVms.id,
      runtimeVmName: runtimeVms.runtimeVmName,
      actualHostId: runtimeVmActualState.hostId,
      report: runtimeVmActualState.reportJson,
      scenarioRunId: scenarioRuns.runId,
      scenarioRuntimeExecutionId: scenarioRuns.runtimeExecutionId,
      scenarioUserId: scenarioRuns.userId,
      scenarioActiveKey: scenarioRuns.activeKey,
      scenarioDeleteRequestedAt: scenarioRuns.deleteRequestedAt,
    })
    .from(runtimeExecutions)
    .innerJoin(runtimeVms, eq(runtimeVms.executionId, runtimeExecutions.id))
    .innerJoin(
      accessAllowlist,
      and(
        eq(accessAllowlist.userId, runtimeExecutions.userId),
        eq(accessAllowlist.state, "active"),
      ),
    )
    .innerJoin(
      runtimeVmActualState,
      and(
        eq(runtimeVmActualState.runtimeVmId, runtimeVms.id),
        eq(runtimeVmActualState.executionId, runtimeExecutions.id),
      ),
    )
    .leftJoin(
      scenarioRuns,
      and(
        eq(scenarioRuns.runId, runtimeExecutions.domainId),
        eq(scenarioRuns.runtimeExecutionId, runtimeExecutions.id),
      ),
    )
    .where(
      and(
        eq(runtimeExecutions.id, input.executionId),
        eq(runtimeExecutions.hostId, input.hostId),
        eq(runtimeExecutions.providerKind, "agent_kvm"),
        eq(runtimeVms.runtimeVmName, input.vmName),
        eq(runtimeVmActualState.hostId, input.hostId),
      ),
    )
    .limit(1);
  const row = rows[0] as KvmRunCliRow | undefined;
  if (!row || !isCurrentKvmRunCliRow(row, input)) return null;

  if (row.executionDomainKind === "scenario") {
    if (
      row.scenarioRunId !== row.executionDomainId ||
      row.scenarioRuntimeExecutionId !== row.executionId ||
      row.scenarioUserId !== row.executionUserId ||
      row.scenarioActiveKey !== row.executionUserId ||
      row.scenarioDeleteRequestedAt !== null
    ) {
      return null;
    }
    return {
      executionId: row.executionId,
      vmName: row.runtimeVmName,
      jailGeneration: input.jailGeneration,
      subject: {
        kind: "scenario",
        userId: row.executionUserId,
        runId: row.executionDomainId,
        runtimeVmName: row.runtimeVmName,
        mutationFence: {
          executionId: row.executionId,
          hostId: input.hostId,
          runtimeVmName: row.runtimeVmName,
          jailGeneration: input.jailGeneration,
          userId: row.executionUserId,
        },
        retryScope: await opaqueRetryScope([
          "scenario",
          row.executionId,
          row.runtimeVmName,
          input.jailGeneration,
        ]),
      },
    };
  }
  return null;
}

function isCurrentKvmRunCliRow(
  row: KvmRunCliRow,
  input: Pick<KvmRunCliFence, "executionId" | "jailGeneration"> & {
    vmName: string;
    hostId: string;
  },
): boolean {
  if (
    row.executionId !== input.executionId ||
    row.executionHostId !== input.hostId ||
    row.actualHostId !== input.hostId ||
    row.runtimeVmName !== input.vmName ||
    row.executionState !== "ready"
  ) {
    return false;
  }
  const report = isRecord(row.report) ? row.report : null;
  const constraints = report && isRecord(report.runtime_constraints)
    ? report.runtime_constraints
    : null;
  return (
    report?.run_id === input.executionId &&
    report.vm_name === input.vmName &&
    constraints?.generation === input.jailGeneration
  );
}

function boundedView(view: RunCliViewV1): RunCliViewV1 {
  const bytes = textEncoder.encode(JSON.stringify(view)).byteLength;
  if (bytes > RUN_CLI_MAX_BODY_BYTES - 2048) {
    throw runCliFailure(
      "frame_too_large",
      "This Intar response is too large to display safely.",
      false,
    );
  }
  return view;
}

/**
 * The producer boundary for successful broker results. A completion lookup is
 * never allowed to serialize a full view, even if a future dispatch branch
 * accidentally returns one. Conversely, normal commands never serialize an
 * alias-only completion result.
 */
export function runCliSuccessResponse(
  requestId: string,
  action: RunCliActionV1,
  result: RunCliSuccessResultV1,
): Response {
  if (action.kind === "completion") {
    if (result.kind !== "completion") {
      return runCliUnexpectedSuccessResultResponse(requestId);
    }
    const completion: RunCliCompletionResultV1 = {
      kind: "completion",
      aliases: boundedCompletionAliases(result.aliases),
    };
    return runCliResponse({
      protocol_version: RUN_CLI_PROTOCOL_VERSION,
      request_id: requestId,
      result: completion,
    });
  }
  if (result.kind !== "ok") {
    return runCliUnexpectedSuccessResultResponse(requestId);
  }
  const ok: RunCliOkResultV1 = {
    kind: "ok",
    view: boundedView(result.view),
  };
  return runCliResponse({
    protocol_version: RUN_CLI_PROTOCOL_VERSION,
    request_id: requestId,
    result: ok,
  });
}

function runCliUnexpectedSuccessResultResponse(requestId: string): Response {
  return runCliErrorResponse({
    requestId,
    status: 200,
    code: "internal",
    message: "Intar could not complete that command. Try again.",
    retryable: true,
  });
}

function runCliErrorResponse(input: {
  requestId: string;
  status: number;
  code: RunCliErrorCodeV1;
  message: string;
  retryable: boolean;
}): Response {
  const result: RunCliResultV1 = {
    kind: "error",
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable,
    },
  };
  return runCliResponse(
    {
      protocol_version: RUN_CLI_PROTOCOL_VERSION,
      request_id: validResponseRequestId(input.requestId),
      result,
    },
    input.status,
  );
}

function runCliResponse(body: RunCliResponseV1, status = 200): Response {
  const serialized = JSON.stringify(body);
  if (textEncoder.encode(serialized).byteLength > RUN_CLI_MAX_BODY_BYTES) {
    // The static fallback is deliberately too small to fail this second bound.
    return new Response(
      JSON.stringify({
        protocol_version: RUN_CLI_PROTOCOL_VERSION,
        request_id: "invalid",
        result: {
          kind: "error",
          error: {
            code: "frame_too_large",
            message: "This Intar response is too large to display safely.",
            retryable: false,
          },
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...RUN_CLI_PRIVATE_HEADERS,
        },
      },
    );
  }
  return new Response(serialized, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...RUN_CLI_PRIVATE_HEADERS,
    },
  });
}

function runCliServiceErrorResponse(requestId: string, error: unknown): Response {
  if (error instanceof RunCliFailure) {
    return runCliErrorResponse({
      requestId,
      status: 200,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error instanceof AppError) {
    const classification = classifyAppError(error);
    return runCliErrorResponse({
      requestId,
      status: 200,
      ...classification,
    });
  }
  // Do not log an untrusted broker payload or a potentially sensitive
  // downstream error. The caller gets a small stable retry signal instead.
  return runCliErrorResponse({
    requestId,
    status: 200,
    code: "internal",
    message: "Intar could not complete that command. Try again.",
    retryable: true,
  });
}

function classifyAppError(error: AppError): {
  code: RunCliErrorCodeV1;
  message: string;
  retryable: boolean;
} {
  if (error.status === 404) {
    return {
      code: "unavailable",
      message: "This workspace is no longer available.",
      retryable: false,
    };
  }
  if (error.status === 401 || error.status === 403) {
    return {
      code: "unauthorized",
      message: "This Intar command is no longer authorized.",
      retryable: false,
    };
  }
  if (error.status === 409) {
    return {
      code: "conflict",
      message: "This workspace changed. Run the command again.",
      retryable: true,
    };
  }
  if (error.status >= 500) {
    return {
      code: "internal",
      message: "Intar could not complete that command. Try again.",
      retryable: true,
    };
  }
  return {
    code: "invalid_request",
    message: "This Intar command is invalid.",
    retryable: false,
  };
}

class RunCliFailure extends Error {
  constructor(
    readonly code: RunCliErrorCodeV1,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function runCliFailure(
  code: RunCliErrorCodeV1,
  message: string,
  retryable: boolean,
): RunCliFailure {
  return new RunCliFailure(code, message, retryable);
}

type ParsedRunCliRequest =
  | { ok: true; request: RunCliRequestV1 }
  | { ok: false; response: Response };

async function parseRunCliRequest(request: Request): Promise<ParsedRunCliRequest> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return {
      ok: false,
      response: runCliErrorResponse({
        requestId: "invalid",
        status: 400,
        code: "invalid_request",
        message: "This Intar command is invalid.",
        retryable: false,
      }),
    };
  }
  const body = await readBoundedJson(request, RUN_CLI_MAX_BODY_BYTES);
  if (!body.ok) {
    return {
      ok: false,
      response: runCliErrorResponse({
        requestId: "invalid",
        status: body.tooLarge ? 413 : 400,
        code: body.tooLarge ? "frame_too_large" : "invalid_request",
        message: body.tooLarge
          ? "This Intar command is too large."
          : "This Intar command is invalid.",
        retryable: false,
      }),
    };
  }
  const parsed = validateRunCliRequest(body.value);
  if (!parsed.ok) {
    return {
      ok: false,
      response: runCliErrorResponse({
        requestId: parsed.requestId,
        status: parsed.protocolMismatch ? 426 : 400,
        code: parsed.protocolMismatch ? "protocol_mismatch" : "invalid_request",
        message: parsed.protocolMismatch
          ? "This Intar command uses an unsupported protocol version."
          : "This Intar command is invalid.",
        retryable: false,
      }),
    };
  }
  return { ok: true, request: parsed.request };
}

function validateRunCliRequest(
  value: unknown,
):
  | { ok: true; request: RunCliRequestV1 }
  | { ok: false; requestId: string; protocolMismatch: boolean } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["protocol_version", "request_id", "action"])) {
    return { ok: false, requestId: "invalid", protocolMismatch: false };
  }
  const requestId =
    typeof value.request_id === "string" && validRequestId(value.request_id)
      ? value.request_id
      : null;
  if (requestId === null) {
    return { ok: false, requestId: "invalid", protocolMismatch: false };
  }
  if (!Number.isSafeInteger(value.protocol_version)) {
    return { ok: false, requestId, protocolMismatch: false };
  }
  if (value.protocol_version !== RUN_CLI_PROTOCOL_VERSION) {
    return { ok: false, requestId, protocolMismatch: true };
  }
  const action = validateRunCliAction(value.action);
  if (!action) return { ok: false, requestId, protocolMismatch: false };
  return {
    ok: true,
    request: {
      protocol_version: RUN_CLI_PROTOCOL_VERSION,
      request_id: requestId,
      action,
    },
  };
}

function validateRunCliAction(value: unknown): RunCliActionV1 | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "completion":
    case "status":
    case "hints":
    case "solution":
    case "solution_reveal":
    case "check_sync":
      return hasOnlyKeys(value, ["kind"])
        ? ({ kind: value.kind } as RunCliActionV1)
        : null;
    case "hint_reveal": {
      const alias = value.alias;
      return hasOnlyKeys(value, ["kind", "alias", "expected_ordinal"]) &&
        typeof alias === "string" &&
        validHintAlias(alias) &&
        typeof value.expected_ordinal === "number" &&
        Number.isSafeInteger(value.expected_ordinal) &&
        value.expected_ordinal >= 1 &&
        value.expected_ordinal <= 0xffff
        ? {
            kind: "hint_reveal",
            alias,
            expected_ordinal: value.expected_ordinal,
          }
        : null;
    }
    default:
      return null;
  }
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  const declared = request.headers.get("content-length");
  let declaredBytes: number | null = null;
  if (declared !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declared)) {
      return { ok: false, tooLarge: false };
    }
    declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) {
      return { ok: false, tooLarge: true };
    }
    if (declaredBytes > maxBytes) return { ok: false, tooLarge: true };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, tooLarge: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The body is already bounded; a cancellation failure changes
          // neither the result nor the error body.
        }
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (declaredBytes !== null && declaredBytes !== total) {
    return { ok: false, tooLarge: false };
  }
  try {
    return { ok: true, value: JSON.parse(textDecoder.decode(bytes)) as unknown };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

function safeSingleLine(value: string | null | undefined, fallback: string): string {
  const clean = sanitizeText(value ?? "", false).trim();
  return clean || fallback;
}

function safeMarkdown(value: string): string {
  const clean = sanitizeText(value, true);
  if (byteLength(clean) > RUN_CLI_MAX_TEXT_BYTES) {
    throw runCliFailure(
      "frame_too_large",
      "This Intar response is too large to display safely.",
      false,
    );
  }
  return clean;
}

function sanitizeText(value: string, preserveNewlines: boolean): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    // Remove complete terminal escape sequences before removing bare control
    // bytes, so a colour sequence cannot leave misleading `[31m` fragments.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    // ESC, C0/C1 controls, and bidi controls cannot be trusted in a terminal.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u001b\u202a-\u202e\u2066-\u2069]/g, "");
  return preserveNewlines
    ? normalized
    : normalized.replace(/\n+/g, " ").replace(/\s+/g, " ");
}

function normalizeGeneration(value: string | null): string | null {
  if (!value || byteLength(value) > RUN_CLI_MAX_GENERATION_BYTES) return null;
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function isSafeId(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{1,128}$/.test(value));
}

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("/") || decoded.includes("\\") ? null : decoded;
  } catch {
    return null;
  }
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;|$)/i.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkOrdinal(alias: string): number | null {
  const match = /^check-([1-9]\d*)$/.exec(alias);
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal - 1 : null;
}

function countRevealed(entries: readonly RunCliHintEntryV1[]): number {
  return toU16(entries.filter((entry) => entry.state === "revealed").length);
}

function toU16(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw runCliFailure(
      "frame_too_large",
      "This Intar response is too large to display safely.",
      false,
    );
  }
  return value;
}

function validResponseRequestId(value: string): string {
  return validRequestId(value) ? value : "invalid";
}

function validRequestId(value: string): boolean {
  return (
    byteLength(value) > 0 &&
    byteLength(value) <= RUN_CLI_MAX_REQUEST_ID_BYTES &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function validHintAlias(value: string): boolean {
  return (
    byteLength(value) > 0 &&
    byteLength(value) <= RUN_CLI_MAX_HINT_ALIAS_BYTES &&
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(value)
  );
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/**
 * Retry state lives in a learner-controlled guest. Give it a non-rendered
 * digest rather than a raw run/workspace identity, and include the generation
 * in the digest so a replacement cannot reuse a pending reveal.
 */
async function opaqueRetryScope(parts: readonly string[]): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      textEncoder.encode(`intar-run-cli-retry-v1\0${parts.join("\0")}`),
    ),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const scope = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  if (byteLength(scope) > RUN_CLI_MAX_RETRY_SCOPE_BYTES) {
    throw new Error("run CLI retry scope exceeded its contract bound");
  }
  return scope;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
