import { afterEach, describe, expect, it, vi } from "vitest";
import { appError, errorChainMatches, toErrorResponse } from "./app-error";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errorChainMatches", () => {
  it("matches wrapped database errors without looping through cyclic causes", () => {
    expect(
      errorChainMatches(
        new Error("query failed", {
          cause: new Error("member owner limit reached"),
        }),
        /owner limit reached/,
      ),
    ).toBe(true);

    const cyclic = new Error("outer") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(errorChainMatches(cyclic, /not present/)).toBe(false);
  });
});

describe("toErrorResponse", () => {
  it("preserves intentional public application errors", () => {
    expect(
      toErrorResponse(
        appError(409, "run_conflict", "a run is already active"),
        "failed to start run",
      ),
    ).toEqual({
      status: 409,
      body: {
        error: "a run is already active",
        code: "run_conflict",
      },
    });
  });

  it("logs internal detail without returning it to the caller", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      toErrorResponse(
        new Error("D1_ERROR: no such table oauth_refresh_token"),
        "failed to load session",
      ),
    ).toEqual({
      status: 500,
      body: { error: "failed to load session" },
    });

    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls[0]?.[0]).toContain(
      "D1_ERROR: no such table oauth_refresh_token",
    );
  });
});
