import type { ScenarioRunRecord } from "@/lib/scenario-runs";

export interface ScenarioStartAcceptedResponse {
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
  run: ScenarioRunRecord;
}

const CAPACITY_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_CAPACITY_RETRY_MS = 2_000;
const ALLOCATION_BUSY_RETRY_MIN_MS = 250;
const ALLOCATION_BUSY_RETRY_MAX_MS = 350;

class ScenarioStartRequestError extends Error {
  readonly code: string | null;
  readonly retryAfterMs: number;

  constructor(message: string, code: string | null, retryAfterMs: number) {
    super(message);
    this.name = "ScenarioStartRequestError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ScenarioStartCancelledError extends Error {
  constructor() {
    super("Stopped waiting for VM capacity.");
    this.name = "ScenarioStartCancelledError";
  }
}

export async function requestScenarioStartWithCapacityWait(
  scenarioId: string,
  options: {
    signal: AbortSignal;
    onCapacityWait: () => void;
    organizationId?: string | null;
    candidateRevision?: string;
    candidateBuildId?: string;
  },
): Promise<ScenarioStartAcceptedResponse> {
  const startedAt = Date.now();
  let requested = false;
  while (true) {
    if (options.signal.aborted) {
      throw new ScenarioStartCancelledError();
    }
    if (requested && Date.now() - startedAt >= CAPACITY_WAIT_TIMEOUT_MS) {
      throw new Error(
        "VM capacity did not become available within 60 seconds. Try again shortly or choose another scenario.",
      );
    }
    try {
      requested = true;
      return await requestScenarioStart(
        scenarioId,
        options.signal,
        {
          organizationId: options.organizationId ?? null,
          ...(options.candidateRevision
            ? { candidateRevision: options.candidateRevision }
            : {}),
          ...(options.candidateBuildId
            ? { candidateBuildId: options.candidateBuildId }
            : {}),
        },
      );
    } catch (error) {
      if (options.signal.aborted) {
        throw new ScenarioStartCancelledError();
      }
      if (
        !(error instanceof ScenarioStartRequestError) ||
        (error.code !== "boot_capacity_pending" &&
          error.code !== "runtime_allocation_busy")
      ) {
        throw error;
      }

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = CAPACITY_WAIT_TIMEOUT_MS - elapsedMs;
      if (remainingMs <= 0) {
        throw new Error(
          "VM capacity did not become available within 60 seconds. Try again shortly or choose another scenario.",
        );
      }
      options.onCapacityWait();
      await waitForCapacityRetry(
        Math.min(
          error.code === "runtime_allocation_busy"
            ? allocationBusyRetryMs()
            : error.retryAfterMs,
          remainingMs,
        ),
        options.signal,
      );
    }
  }
}

function allocationBusyRetryMs() {
  return Math.floor(
    ALLOCATION_BUSY_RETRY_MIN_MS +
      Math.random() *
        (ALLOCATION_BUSY_RETRY_MAX_MS - ALLOCATION_BUSY_RETRY_MIN_MS + 1),
  );
}

async function requestScenarioStart(
  scenarioId: string,
  signal: AbortSignal,
  options: {
    organizationId: string | null;
    candidateRevision?: string;
    candidateBuildId?: string;
  },
): Promise<ScenarioStartAcceptedResponse> {
  let response: Response;
  try {
    response = await fetch(
      `/api/scenarios/${encodeURIComponent(scenarioId)}/start`,
      {
        method: "POST",
        credentials: "include",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(options.organizationId
            ? { organizationId: options.organizationId }
            : {}),
          ...(options.candidateRevision
            ? { candidateRevision: options.candidateRevision }
            : {}),
          ...(options.candidateBuildId
            ? { candidateBuildId: options.candidateBuildId }
            : {}),
        }),
      },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ScenarioStartRequestError(
      "Could not reach the control plane. Check your connection and try starting the scenario again.",
      "connectivity_failed",
      DEFAULT_CAPACITY_RETRY_MS,
    );
  }

  const body = (await response.json().catch(() => null)) as
    | ScenarioStartAcceptedResponse
    | { error?: string; code?: string }
    | null;

  if (
    !response.ok ||
    !body ||
    !("accepted" in body) ||
    body.accepted !== true ||
    typeof body.runId !== "string" ||
    !("run" in body) ||
    !body.run
  ) {
    throw new ScenarioStartRequestError(
      body && "error" in body && typeof body.error === "string"
        ? body.error
        : "Failed to start scenario",
      body && "code" in body && typeof body.code === "string"
        ? body.code
        : null,
      parseRetryAfterMs(response.headers.get("retry-after")),
    );
  }

  return body;
}

export function parseRetryAfterMs(value: string | null): number {
  if (!value) return DEFAULT_CAPACITY_RETRY_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(250, Math.round(seconds * 1_000));
  }
  const at = Date.parse(value);
  return Number.isFinite(at)
    ? Math.max(250, at - Date.now())
    : DEFAULT_CAPACITY_RETRY_MS;
}

function waitForCapacityRetry(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new ScenarioStartCancelledError());
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
