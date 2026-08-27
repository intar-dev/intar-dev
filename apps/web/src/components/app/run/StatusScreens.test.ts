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

    expect(markup).toContain("Stage 2 of 3");
    expect(markup).toContain('aria-label="Startup steps"');
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toContain("Starting services.");
    expect(markup).not.toContain("Checks have not started.");
    expect(markup).toContain("Done");
    expect(markup).toContain("In progress");
    expect(markup).toContain("Up next");
    expect(markup).not.toContain('role="progressbar"');
  });
});
