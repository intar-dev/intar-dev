import type { ScenarioRunRecord } from "@/lib/scenario-runs";

export interface ScenarioStartAcceptedResponse {
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
  run: ScenarioRunRecord;
}

/**
 * A refusal that is a known admission conflict rather than a failure. Known
 * admission conflicts can clear while this call waits; the 60-second deadline
 * still applies.
 */
export type ScenarioStartContention = "capacity" | "registry";

const CAPACITY_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_CAPACITY_RETRY_MS = 2_000;
/** Bounded jitter for host capacity contention, to avoid a retry thundering herd. */
const CAPACITY_RETRY_JITTER_MIN_MS = 250;
const CAPACITY_RETRY_JITTER_MAX_MS = 350;
/**
 * Start admission is idempotent on the caller-supplied key, so a bounded
 * transport retry of one attempt is safe even when the first request reached
 * the control plane and its response was lost.
 */
const TRANSPORT_RETRY_ATTEMPTS = 3;

class ScenarioStartRequestError extends Error {
  readonly code: string | null;
  readonly retryAfterMs: number;
  /** True when the response carried no admission decision. */
  readonly retryable: boolean;

  constructor(
    message: string,
    code: string | null,
    retryAfterMs: number,
    retryable = false,
  ) {
    super(message);
    this.name = "ScenarioStartRequestError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

export class ScenarioStartCancelledError extends Error {
  constructor() {
    super("Stopped waiting for the start to be admitted.");
    this.name = "ScenarioStartCancelledError";
  }
}

/**
 * Starts one scenario run, waiting out a known admission conflict.
 *
 * The idempotency key is generated once for this call and reused by every
 * retry inside it, so a retry can never create a second VM set even when the
 * first request was admitted and only its response was lost. A new Start
 * click calls this function again and gets a new key.
 */
export async function requestScenarioStartWithCapacityWait(
  scenarioId: string,
  options: {
    signal: AbortSignal;
    onCapacityWait: (contention: ScenarioStartContention) => void;
    organizationId?: string | null;
    candidateRevision?: string;
    candidateBuildId?: string;
  },
): Promise<ScenarioStartAcceptedResponse> {
  const startedAt = Date.now();
  const idempotencyKey = crypto.randomUUID();
  let requested = false;
  let transportAttempts = 1;
  let contention: ScenarioStartContention | null = null;
  while (true) {
    if (options.signal.aborted) {
      throw new ScenarioStartCancelledError();
    }
    if (requested && Date.now() - startedAt >= CAPACITY_WAIT_TIMEOUT_MS) {
      throw new Error(waitTimeoutMessage(contention));
    }
    try {
      requested = true;
      return await requestScenarioStart(
        scenarioId,
        options.signal,
        {
          idempotencyKey,
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
      if (!(error instanceof ScenarioStartRequestError)) {
        throw error;
      }

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = CAPACITY_WAIT_TIMEOUT_MS - elapsedMs;
      if (remainingMs <= 0) {
        throw new Error(waitTimeoutMessage(contention));
      }

      // Checked before the transport retry below: a conflict can outlast that
      // three-attempt budget, so routing it there would end the wait early.
      const recognized = contentionOf(error.code);
      if (recognized) {
        contention = recognized;
        options.onCapacityWait(recognized);
        await waitForCapacityRetry(
          Math.min(capacityRetryMs(error.retryAfterMs), remainingMs),
          options.signal,
        );
        continue;
      }

      // An unconfirmed transport failure may still have been admitted: the
      // same key makes a repeat call return that same run instead of creating
      // a second one, so a bounded retry is safe. This is not a capacity wait,
      // so the caller keeps its current status while the retry runs.
      if (isRetryableTransportFailure(error) && transportAttempts < TRANSPORT_RETRY_ATTEMPTS) {
        transportAttempts += 1;
        await waitForCapacityRetry(
          Math.min(error.retryAfterMs, remainingMs),
          options.signal,
        );
        continue;
      }

      throw error;
    }
  }
}

/** A recognised contention refusal is a wait, not a failure. */
function contentionOf(code: string | null): ScenarioStartContention | null {
  if (code === "scenario_host_capacity_contended") return "capacity";
  if (code === "registry_busy") return "registry";
  return null;
}

/**
 * The wait is bounded, so the timeout names the refusal it was waiting on.
 * A start that never reached a recognised refusal keeps the capacity wording,
 * which is what an expiry before the first answer has always reported.
 */
function waitTimeoutMessage(
  contention: ScenarioStartContention | null,
): string {
  return contention === "registry"
    ? "The image registry stayed busy for 60 seconds. Try again shortly."
    : "VM capacity did not become available within 60 seconds. Try again shortly or choose another scenario.";
}

/**
 * An unconfirmed transport failure, or a 5xx with no recognised code, carries
 * no admission decision, so the request may have committed and the same key
 * makes a repeat call safe. A 4xx is a decision and is never retried here, and
 * a recognised contention refusal above never reaches this budget.
 */
function isRetryableTransportFailure(error: ScenarioStartRequestError): boolean {
  return error.code === "connectivity_failed" || error.retryable;
}

function capacityRetryMs(retryAfterMs: number): number {
  return Math.max(retryAfterMs, capacityRetryJitterMs());
}

function capacityRetryJitterMs() {
  return Math.floor(
    CAPACITY_RETRY_JITTER_MIN_MS +
      Math.random() *
        (CAPACITY_RETRY_JITTER_MAX_MS - CAPACITY_RETRY_JITTER_MIN_MS + 1),
  );
}

async function requestScenarioStart(
  scenarioId: string,
  signal: AbortSignal,
  options: {
    idempotencyKey: string;
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
        headers: {
          "content-type": "application/json",
          // One key per Start attempt, reused by every retry of that attempt.
          "Idempotency-Key": options.idempotencyKey,
        },
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
      // A 5xx carries no admission decision: the request may have committed,
      // so a same-key retry is safe. A 4xx is a decision and is never retried.
      response.status >= 500,
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
