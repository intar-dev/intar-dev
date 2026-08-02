import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseRetryAfterMs,
  requestScenarioStartWithCapacityWait,
  ScenarioStartCancelledError,
} from "./scenario-start";

describe("scenario capacity waiting", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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

  it("times out after 60 seconds of capacity responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => capacityPending("60")),
    );

    const result = requestScenarioStartWithCapacityWait("pair-ping", {
      signal: new AbortController().signal,
      onCapacityWait: vi.fn(),
    });
    const rejection = expect(result).rejects.toThrow(
      "VM capacity did not become available within 60 seconds",
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
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

  it("turns connectivity failures into a recoverable next action", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestScenarioStartWithCapacityWait("pair-ping", {
        signal: new AbortController().signal,
        onCapacityWait: vi.fn(),
      }),
    ).rejects.toThrow(
      "Could not reach the control plane. Check your connection and try starting the lab again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("parseRetryAfterMs", () => {
  it("supports delta seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2_000);
  });
});

function capacityPending(retryAfter: string) {
  return Response.json(
    {
      error: "scenario boot CPU capacity is pending; retry shortly",
      code: "boot_capacity_pending",
    },
    { status: 409, headers: { "Retry-After": retryAfter } },
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
