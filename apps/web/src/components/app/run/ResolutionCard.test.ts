import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResolutionCard } from "./ResolutionCard";

describe("resolution card", () => {
  it("keeps one flat resolved section with one finish action", () => {
    const markup = renderToStaticMarkup(
      createElement(ResolutionCard, {
        scenarioTitle: "Restore Deployment Replicas",
        solveDurationMs: 95_000,
        assisted: true,
        pending: false,
        onEndScenario: () => undefined,
      }),
    );

    expect(markup).toContain("Resolved");
    expect(markup).toContain("Restore Deployment Replicas");
    expect(markup).toContain("Solved with assistance");
    expect(markup).toContain("01:35");
    expect(markup).toContain("Finish run");
    expect(markup).toContain("w-full");
    expect(markup).not.toContain('data-slot="card"');
    expect(markup).not.toContain('data-slot="badge"');
    expect(markup).not.toContain("Restore the web rollout");
    expect(markup).not.toContain("hints");
  });

  it("keeps the finish action clear while it is pending", () => {
    const markup = renderToStaticMarkup(
      createElement(ResolutionCard, {
        scenarioTitle: "Restore Deployment Replicas",
        solveDurationMs: null,
        assisted: false,
        pending: true,
        onEndScenario: () => undefined,
      }),
    );

    expect(markup).toContain("Solved");
    expect(markup).toContain("Finishing run…");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("01:");
  });
});
