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
    expect(saving).toContain("disabled");
    expect(failed).toContain(
      "We could not save this run. Your work is still open. Try again.",
    );
  });
});
