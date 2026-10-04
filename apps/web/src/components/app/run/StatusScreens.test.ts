import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScenarioStepScreen } from "./StatusScreens";

describe("ScenarioStepScreen", () => {
  it("presents a finite process as one semantic stage tracker", () => {
    const markup = renderToStaticMarkup(
      createElement(ScenarioStepScreen, {
        title: "Preparing your workspace",
        description: "Your workspace is starting.",
        listLabel: "Startup steps",
        steps: [
          {
            id: "accepted",
            label: "Request accepted",
            detail: "The request was accepted.",
            state: "done",
          },
          {
            id: "starting",
            label: "Starting workspace",
            detail: "Starting services.",
            state: "active",
          },
          {
            id: "checking",
            label: "Checking workspace",
            detail: "Checks have not started.",
            state: "pending",
          },
        ],
      }),
    );

    // The rolling stage number is its own element, so read the text.
    expect(markup.replace(/<[^>]+>/g, "")).toContain("Stage 2 of 3");
    expect(markup).toContain('aria-label="Startup steps"');
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toContain("Starting services.");
    expect(markup).not.toContain("Checks have not started.");
    expect(markup).toContain("Done");
    expect(markup).toContain("In progress");
    expect(markup).toContain("Up next");
    expect(markup.match(/bottom-\[-0\.875rem\]/g)).toHaveLength(2);
    expect(markup).not.toContain('role="progressbar"');
    // Every state word shares one cell, and only the current one is on.
    expect(markup.match(/data-on="true"/g)?.length).toBe(
      // one per marker layer and one per state word, for three steps
      3 + 3,
    );
    expect(markup).toContain("max-w-[36rem]");
    expect(markup).not.toContain("bg-border-strong/35");
  });

  it("keeps the failed stage's own detail and folds the others away", () => {
    const markup = renderToStaticMarkup(
      createElement(ScenarioStepScreen, {
        title: "Preparing your workspace",
        description: "Your workspace is starting.",
        steps: [
          { id: "a", label: "A", detail: "A done.", state: "done" },
          { id: "b", label: "B", detail: "B could not start.", state: "failed" },
          { id: "c", label: "C", detail: "C waits.", state: "pending" },
        ],
        footer: "Try again",
      }),
    );

    expect(markup).toContain("B could not start.");
    expect(markup).not.toContain("C waits.");
    expect(markup.match(/data-open="true"/g)).toHaveLength(1);
    expect(markup.match(/data-run-sequence-detail/g)).toHaveLength(3);
    expect(markup).toContain("data-run-sequence-foot");
  });
});
