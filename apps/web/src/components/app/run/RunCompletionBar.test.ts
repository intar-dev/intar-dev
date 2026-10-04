import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RunCompletionBar } from "./RunCompletionBar";

describe("RunCompletionBar", () => {
  it("keeps the solved action visible in the workspace", () => {
    const markup = renderToStaticMarkup(
      createElement(RunCompletionBar, {
        canFinish: true,
        pending: false,
        error: false,
        onFinish: vi.fn(),
      }),
    );

    expect(markup).toContain('data-run-completion-bar="true"');
    expect(markup).toContain("All checks verified");
    expect(markup).toContain("Finish and save");
    expect(markup).not.toMatch(/<button[^>]*\sdisabled(?:=|>)/);
  });

  it("shows readiness, saving, and safe failure states", () => {
    const waiting = renderToStaticMarkup(
      createElement(RunCompletionBar, {
        canFinish: false,
        pending: false,
        error: false,
        onFinish: vi.fn(),
      }),
    );
    const saving = renderToStaticMarkup(
      createElement(RunCompletionBar, {
        canFinish: true,
        pending: true,
        error: false,
        onFinish: vi.fn(),
      }),
    );
    const failed = renderToStaticMarkup(
      createElement(RunCompletionBar, {
        canFinish: true,
        pending: false,
        error: true,
        onFinish: vi.fn(),
      }),
    );

    expect(waiting).toContain("Getting your run ready to save…");
    expect(waiting).toContain("disabled");
    expect(saving).toContain("Saving your run…");
    // Busy keeps focus: aria-disabled, never the native disabled attribute.
    expect(saving).toContain('aria-busy="true"');
    expect(saving).not.toMatch(/<button[^>]*\sdisabled(?:=|>)/);
    expect(failed).toContain(
      "Could not save this run. Your work is still open. Try again.",
    );
    expect(failed).not.toContain("We could not");
  });

  it("rises and pops only when the run just turned solved", () => {
    const render = (animate?: boolean) =>
      renderToStaticMarkup(
        createElement(RunCompletionBar, {
          canFinish: true,
          pending: false,
          error: false,
          onFinish: vi.fn(),
          ...(animate === undefined ? {} : { animate }),
        }),
      );

    for (const still of [render(), render(false)]) {
      expect(still).not.toContain("animate-rise");
      expect(still).not.toContain("animate-pop");
    }
    const live = render(true);
    expect(live).toContain("animate-rise");
    expect(live).toContain("[animation-delay:650ms]");
    expect(live).toContain("animate-pop");
    expect(live).toContain("[animation-delay:770ms]");
  });
});
