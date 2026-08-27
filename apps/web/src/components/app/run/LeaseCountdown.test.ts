import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaseCountdown, startLeaseCountdown } from "./LeaseCountdown";

afterEach(() => {
  vi.useRealTimers();
});

describe("LeaseCountdown", () => {
  it("stops scheduling ticks when the lease expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onTick = vi.fn();

    const stop = startLeaseCountdown(1_500, onTick);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1_499);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1);
    expect(onTick).toHaveBeenLastCalledWith(1_500);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("gives the visible countdown a stable accessible label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const markup = renderToStaticMarkup(
      createElement(LeaseCountdown, { deadlineMs: 66_000 }),
    );

    expect(markup).toContain('role="timer"');
    expect(markup).toContain('aria-label="Time remaining: 01:05"');
    expect(markup).toContain("01:05");
  });
});
