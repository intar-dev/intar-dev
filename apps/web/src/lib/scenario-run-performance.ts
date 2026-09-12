import { nonEchoNonceCommand, scanRemoteTerminalFrame } from "./vm-boot-nonce";

export interface ScenarioRunBootEvidence {
  runId: string;
  scenarioId: string;
  startUnixMs: number;
  terminalConnectedUnixMs?: number;
  terminalFirstOutputUnixMs?: number;
  benchmark?: boolean;
  benchmarkAttemptId?: string;
  stages: Record<string, number>;
}

interface PendingScenarioRunBootEvidence {
  scenarioId: string;
  startUnixMs: number;
  benchmark?: boolean;
  stages: Record<string, number>;
}

export const VM_BOOT_MARK_PREFIX = "intar:vm-boot:";

function pendingKey(scenarioId: string) {
  return `${VM_BOOT_MARK_PREFIX}pending:${scenarioId}`;
}

function runKey(runId: string) {
  return `${VM_BOOT_MARK_PREFIX}${runId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function read<T>(key: string): T | null {
  try {
    const value = storage()?.getItem(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  const target = storage();
  if (!target) return false;
  try {
    target.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function nowUnixMs() {
  try {
    if (
      typeof performance !== "undefined" &&
      Number.isFinite(performance.timeOrigin) &&
      Number.isFinite(performance.now())
    ) {
      return Math.round(performance.timeOrigin + performance.now());
    }
  } catch {
    // Wall-clock time is a fallback for restricted browser environments.
  }
  return Date.now();
}

function emitMark(
  stage: string,
  evidence: ScenarioRunBootEvidence,
  unixMs: number,
) {
  try {
    const startTime = Math.min(
      performance.now(),
      Math.max(0, unixMs - performance.timeOrigin),
    );
    performance.mark(`${VM_BOOT_MARK_PREFIX}${stage}`, {
      startTime,
      detail: {
        runId: evidence.runId,
        scenarioId: evidence.scenarioId,
        startUnixMs: evidence.startUnixMs,
        unixMs,
      },
    });
  } catch {
    // Performance entries are diagnostic only.
  }
}

function addStage<T extends { stages: Record<string, number> }>(
  evidence: T,
  stage: string,
  unixMs: number,
): T {
  if (evidence.stages[stage] !== undefined) return evidence;
  return {
    ...evidence,
    stages: { ...evidence.stages, [stage]: unixMs },
  };
}

/** Starts one timing record before the run id is available. */
export function beginScenarioRunBootEvidence(
  scenarioId: string,
  startStage = "start-click",
): number {
  const existing = read<PendingScenarioRunBootEvidence>(pendingKey(scenarioId));
  if (existing?.scenarioId === scenarioId && existing.startUnixMs > 0) {
    return existing.startUnixMs;
  }
  clearPreviousScenarioRunBootEvidence();
  const startUnixMs = nowUnixMs();
  write(pendingKey(scenarioId), {
    scenarioId,
    startUnixMs,
    stages: { [startStage]: startUnixMs },
    ...(startStage === "start-click" && typeof window !== "undefined" &&
      new URLSearchParams(window.location?.search).get("bootBenchmark") === "1"
      ? { benchmark: true } : {}),
  } satisfies PendingScenarioRunBootEvidence);
  return startUnixMs;
}

export function markPendingScenarioRunBootStage(
  scenarioId: string,
  stage: string,
  unixMs = nowUnixMs(),
) {
  const key = pendingKey(scenarioId);
  const current = read<PendingScenarioRunBootEvidence>(key);
  if (!current || current.scenarioId !== scenarioId) return null;
  const next = addStage(current, stage, unixMs);
  write(key, next);
  return next;
}

/** Associates the persisted click time with the accepted scenario run. */
export function associateScenarioRunBootEvidence(input: {
  runId: string;
  scenarioId: string;
  reused?: boolean;
}): ScenarioRunBootEvidence | null {
  const key = runKey(input.runId);
  const existing = read<ScenarioRunBootEvidence>(key);
  if (existing?.runId === input.runId) {
    return existing;
  }
  const pending = read<PendingScenarioRunBootEvidence>(pendingKey(input.scenarioId));
  if (!pending || pending.scenarioId !== input.scenarioId) return null;
  const evidence: ScenarioRunBootEvidence = {
    runId: input.runId,
    scenarioId: input.scenarioId,
    startUnixMs: pending.startUnixMs,
    stages: pending.stages,
    ...(pending.benchmark && input.reused === false ? { benchmark: true } : {}),
  };
  if (!write(key, evidence)) return null;
  try {
    storage()?.removeItem(pendingKey(input.scenarioId));
  } catch {
    // The completed record is enough for the benchmark reader.
  }
  for (const [stage, unixMs] of Object.entries(evidence.stages)) {
    emitMark(stage, evidence, unixMs);
  }
  return evidence;
}

export function markScenarioRunBootStage(input: {
  runId: string;
  scenarioId: string;
  stage: string;
  unixMs?: number;
}): ScenarioRunBootEvidence | null {
  const current = readScenarioRunBootEvidence(input.runId);
  if (!current || current.scenarioId !== input.scenarioId) return null;
  const unixMs = input.unixMs ?? nowUnixMs();
  const next = addStage(current, input.stage, unixMs);
  if (next === current) return current;
  const evidence: ScenarioRunBootEvidence = {
    ...next,
    ...(input.stage === "terminal-connected"
      ? { terminalConnectedUnixMs: unixMs }
      : {}),
    ...(input.stage === "terminal-first-output"
      ? { terminalFirstOutputUnixMs: unixMs }
      : {}),
  };
  if (!write(runKey(input.runId), evidence)) return null;
  emitMark(input.stage, evidence, unixMs);
  return evidence;
}

export function readScenarioRunBootEvidence(
  runId: string,
): ScenarioRunBootEvidence | null {
  const evidence = read<ScenarioRunBootEvidence>(runKey(runId));
  return evidence?.runId === runId ? evidence : null;
}

export function clearPendingScenarioRunBootEvidence(scenarioId: string) {
  try {
    storage()?.removeItem(pendingKey(scenarioId));
  } catch {
    // Storage is optional browser diagnostic state.
  }
}

function clearPreviousScenarioRunBootEvidence() {
  const target = storage();
  if (target) {
    try {
      for (let index = target.length - 1; index >= 0; index -= 1) {
        const key = target.key(index);
        if (key?.startsWith(VM_BOOT_MARK_PREFIX)) {
          target.removeItem(key);
        }
      }
    } catch {
      // Storage is optional browser diagnostic state.
    }
  }
  try {
    for (const entry of performance.getEntriesByType("mark")) {
      if (entry.name.startsWith(VM_BOOT_MARK_PREFIX)) {
        performance.clearMarks(entry.name);
      }
    }
  } catch {
    // Performance entries are optional browser diagnostic state.
  }
}

/** Opt-in, one-command check for a fresh run. Only remote output may complete it. */
export function startScenarioRunBootBenchmark(input: {
  runId: string;
  scenarioId: string;
  vmName: string;
  isCurrent: () => boolean;
}) {
  const evidence = readScenarioRunBootEvidence(input.runId);
  if (!input.isCurrent() || !evidence?.benchmark || evidence.benchmarkAttemptId ||
      evidence.scenarioId !== input.scenarioId ||
      evidence.stages["start-click"] === undefined || !evidence.terminalConnectedUnixMs) return null;
  let nonce: string;
  try {
    nonce = `intar-bench-${crypto.randomUUID().replaceAll("-", "")}`;
  } catch {
    return null;
  }
  const startedUnixMs = nowUnixMs();
  if (!write(runKey(input.runId), { ...evidence, benchmarkAttemptId: nonce })) return null;
  let tail = "";
  let complete = false;
  const isCurrent = () => input.isCurrent() &&
    readScenarioRunBootEvidence(input.runId)?.benchmarkAttemptId === nonce;
  return {
    command: `${nonEchoNonceCommand(nonce)}\r`,
    observe(payload: Uint8Array) {
      if (complete || !isCurrent()) return;
      const result = scanRemoteTerminalFrame({ needle: nonce, previousTail: tail, payload });
      tail = result.nextTail;
      if (!result.matches) return;
      complete = true;
      const successUnixMs = nowUnixMs();
      void (async () => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
        if (!isCurrent()) return;
        const nonceSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        console.info("intar:boot-benchmark", JSON.stringify({
          schemaVersion: 1,
          runId: evidence.runId,
          scenarioId: evidence.scenarioId,
          vmName: input.vmName,
          startBoundary: "learner-start-link-click",
          startUnixMs: evidence.startUnixMs,
          terminalConnectedUnixMs: evidence.terminalConnectedUnixMs,
          firstCommand: { startedUnixMs, successUnixMs, nonceSha256, outputObservedAfterCommand: true },
          stages: evidence.stages,
        }));
      })().catch(() => { /* Diagnostic failure cannot affect the terminal. */ });
    },
  };
}
