import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseRetryAfterMs,
  requestScenarioStartWithCapacityWait,
  ScenarioStartCancelledError,
} from "./scenario-start";

// One reset for every describe in this file: timers, globals, and spies.
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scenario capacity waiting", () => {
  it("honors Retry-After before retrying a pending-capacity response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(capacityPending("2"))
      .mockResolvedValueOnce(accepted());
    vi.stubGlobal("fetch", fetchMock);
    const onCapacityWait = vi.fn();

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait,
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ runId: "run-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onCapacityWait).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(request?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(request?.body).toBe("{}");
  });

  it("stops retrying when the user cancels", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(capacityPending("2"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: controller.signal,
      onCapacityWait: vi.fn(),
    });
    await Promise.resolve();
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(ScenarioStartCancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops the attempt when the user cancels during a connection failure", async () => {
    vi.useFakeTimers();
    // Real fetch rejects on abort; the attempt must end here, with no retry
    // going out under the key.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: controller.signal,
      onCapacityWait: vi.fn(),
    });
    // Attach the handler before the abort so the cancellation is not an
    // unhandled rejection.
    const rejection = expect(result).rejects.toBeInstanceOf(
      ScenarioStartCancelledError,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    // The abort ends the attempt: no further request goes out with the key.
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses one Idempotency-Key across every retry of one attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(capacityPending("1"))
      .mockResolvedValueOnce(capacityPending("1"))
      .mockResolvedValueOnce(accepted());
    vi.stubGlobal("fetch", fetchMock);

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ runId: "run-1" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = fetchMock.mock.calls.map(([, request]) =>
      new Headers(request?.headers).get("Idempotency-Key"),
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it("uses a different Idempotency-Key for a new start attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => accepted());
    vi.stubGlobal("fetch", fetchMock);

    await requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });
    await requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });

    const keys = fetchMock.mock.calls.map(([, request]) =>
      new Headers(request?.headers).get("Idempotency-Key"),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("generates the key once per attempt with crypto.randomUUID", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => accepted());
    vi.stubGlobal("fetch", fetchMock);

    await requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });
    const second = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    await second;

    // One generation per attempt, outside the transport retry loop, and a new
    // Start click gets a new key.
    expect(randomUuid).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([, request]) =>
        new Headers(request?.headers).get("Idempotency-Key"),
      ),
    ).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("keeps the key in the header only, out of the request body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => accepted());
    vi.stubGlobal("fetch", fetchMock);

    await requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });

    const [, request] = fetchMock.mock.calls[0] ?? [];
    const key = new Headers(request?.headers).get("Idempotency-Key");
    expect(key).toBeTruthy();
    // The key is a public nonce for admission replay, never a secret, and the
    // body carries only the unchanged start options.
    expect(request?.body).toBe("{}");
    expect(request?.body).not.toContain(key);
    expect(JSON.stringify(request)).not.toContain("secret");
  });

  it("retries a 5xx with the same key because the request may have committed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: "internal error", code: "internal" }, { status: 500 }),
      )
      .mockResolvedValueOnce(accepted());
    vi.stubGlobal("fetch", fetchMock);

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toMatchObject({ runId: "run-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls.map(([, request]) =>
      new Headers(request?.headers).get("Idempotency-Key"),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("times out at 60 seconds without another capacity request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => capacityPending("60"));
    vi.stubGlobal("fetch", fetchMock);

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });
    const rejection = expect(result).rejects.toThrow(
      "VM capacity did not become available within 60 seconds",
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-capacity failures", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { error: "Scenario image is not ready.", code: "image_not_ready" },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onCapacityWait = vi.fn();

    await expect(
      requestScenarioStartWithCapacityWait("pair-ping", {
        signal: new AbortController().signal,
        onCapacityWait,
      }),
    ).rejects.toThrow("Scenario image is not ready.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onCapacityWait).not.toHaveBeenCalled();
  });

  it("does not retry a 403 decision", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: "admin required", code: "admin_required" }, { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onCapacityWait = vi.fn();

    await expect(
      requestScenarioStartWithCapacityWait("pair-ping", {
        signal: new AbortController().signal,
        onCapacityWait,
      }),
    ).rejects.toThrow("admin required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onCapacityWait).not.toHaveBeenCalled();
  });

  it("sends an administrator-selected candidate revision", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(accepted());
    vi.stubGlobal("fetch", fetchMock);

    await requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
      candidateRevision: "image-build-v12-proof",
      candidateBuildId: "candidate-build-1",
    });

    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.body).toBe(
      JSON.stringify({
        candidateRevision: "image-build-v12-proof",
        candidateBuildId: "candidate-build-1",
      }),
    );
  });

  it("does not drop a partial candidate proof identity into a live start", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: "candidateRevision and candidateBuildId are required",
          code: "candidate_proof_identity_incomplete",
        },
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestScenarioStartWithCapacityWait("pair-ping", {
        signal: new AbortController().signal,
        onCapacityWait: vi.fn(),
        candidateRevision: "image-build-v12-proof",
      }),
    ).rejects.toThrow("candidateRevision and candidateBuildId are required");

    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.body).toBe(
      JSON.stringify({ candidateRevision: "image-build-v12-proof" }),
    );
  });

  it("turns connectivity failures into a bounded same-key retry", async () => {
    vi.useFakeTimers();
    const randomUuid = vi.spyOn(crypto, "randomUUID");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const onCapacityWait = vi.fn();

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait,
    });
    const rejection = expect(result).rejects.toThrow(
      "Could not reach the control plane. Check your connection and try starting the scenario again.",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    // Bounded, and every retry repeats the one key: an admitted-but-lost
    // first request can not create a second VM set.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(randomUuid).toHaveBeenCalledTimes(1);
    const keys = fetchMock.mock.calls.map(([, request]) =>
      new Headers(request?.headers).get("Idempotency-Key"),
    );
    expect(new Set(keys).size).toBe(1);
    // A lost connection is not a capacity wait, so the caller keeps its
    // current status instead of showing the waiting-on-capacity state.
    expect(onCapacityWait).not.toHaveBeenCalled();
  });
});

describe("scenario registry-busy waiting", () => {
  it("waits out a busy image registry and starts on the same key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(registryBusy())
      .mockResolvedValueOnce(accepted());
    vi.stubGlobal("fetch", fetchMock);
    const onCapacityWait = vi.fn();

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait,
    });
    // No Retry-After on a busy registry, so the existing default delay applies.
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toMatchObject({ runId: "run-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The caller is told which refusal it is waiting on, so the busy UI can
    // name the registry instead of practice-machine capacity.
    expect(onCapacityWait).toHaveBeenCalledTimes(1);
    expect(onCapacityWait).toHaveBeenCalledWith("registry");
    // One key across the wait: a busy refusal never creates a second run.
    const keys = fetchMock.mock.calls.map(([, request]) =>
      new Headers(request?.headers).get("Idempotency-Key"),
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it("keeps waiting past the transport retry budget", async () => {
    // Five refusals is deliberately more than the transport budget of three, so
    // a client that routed this 503 there would stop early and fail here.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(registryBusy())
      .mockResolvedValueOnce(registryBusy())
      .mockResolvedValueOnce(registryBusy())
      .mockResolvedValueOnce(registryBusy())
      .mockResolvedValueOnce(registryBusy())
      .mockResolvedValueOnce(accepted());
    vi.stubGlobal("fetch", fetchMock);

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toMatchObject({ runId: "run-1" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const keys = fetchMock.mock.calls.map(([, request]) =>
      new Headers(request?.headers).get("Idempotency-Key"),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("bounds a permanently busy registry at the wait budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => registryBusy());
    vi.stubGlobal("fetch", fetchMock);

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });
    const rejection = expect(result).rejects.toThrow(
      "The image registry stayed busy for 60 seconds. Try again shortly.",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    // Bounded: far past the three-attempt transport budget, and finite.
    const attempts = fetchMock.mock.calls.length;
    expect(attempts).toBeGreaterThan(3);
    expect(attempts).toBeLessThanOrEqual(31);
    // And the loop has ended: no further request goes out.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length).toBe(attempts);
    const keys = fetchMock.mock.calls.map(([, request]) =>
      new Headers(request?.headers).get("Idempotency-Key"),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("stops a registry wait when the user cancels", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => registryBusy());
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: controller.signal,
      onCapacityWait: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(ScenarioStartCancelledError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("parseRetryAfterMs", () => {
  it("supports delta seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2_000);
  });
});

function capacityPending(
  retryAfter: string,
  code = "scenario_host_capacity_contended",
) {
  return Response.json(
    {
      error: "scenario boot CPU capacity is pending; retry shortly",
      code,
    },
    { status: 409, headers: { "Retry-After": retryAfter } },
  );
}

/**
 * The refusal the control plane sends while a collector sweep holds the shared
 * image-registry gate: HTTP 503 with the `registry_busy` code raised in
 * begin.ts, and, unlike capacity contention, no Retry-After header.
 */
function registryBusy() {
  return Response.json(
    {
      error: "the image registry is busy; retry the start",
      code: "registry_busy",
    },
    { status: 503 },
  );
}

function accepted() {
  return Response.json(
    {
      accepted: true,
      runId: "run-1",
      scenarioId: "pair-ping",
      acceptedAt: 1,
      reused: false,
      run: { id: "run-1" },
    },
    { status: 202 },
  );
}
