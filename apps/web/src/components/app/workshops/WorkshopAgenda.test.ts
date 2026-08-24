import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkshopModuleManual } from "./WorkshopAgenda";
import type { WorkshopModule, WorkshopProbe } from "./types";

describe("WorkshopModuleManual verification", () => {
  it("shows only verified and needs-repair indicators", () => {
    const hiddenProbeDetail = "RAW_PROBE_OUTPUT_MUST_NOT_RENDER";
    const markup = renderToStaticMarkup(
      createElement(WorkshopModuleManual, {
        module: workshopModule({
          verificationUnavailable: true,
          probes: [
            probe({ id: "pass", label: "Service responds", status: "pass" }),
            probe({
              id: "fail",
              label: "Deployment is ready",
              status: "fail",
              detail: hiddenProbeDetail,
            }),
            probe({
              id: "pending",
              label: "Endpoint is owned",
              status: "pending",
              detail: hiddenProbeDetail,
            }),
            probe({
              id: "unknown",
              label: "Config is mounted",
              status: "unknown",
              detail: hiddenProbeDetail,
            }),
          ],
        }),
        busy: false,
        onRevealHint: () => {},
        onCompleteExplainBack: () => {},
      }),
    );

    expect(markup).toContain('aria-label="Verified: 1; needs repair: 3"');
    expect(markup).toContain("1 Verified");
    expect(markup).toContain("3 Needs repair");
    expect(markup).toContain(
      "Verification unavailable. We cannot confirm progress right now.",
    );
    expect(markup).toContain("Verification objective 1");
    expect(markup).toContain("Verification objective 4");
    expect(markup).not.toContain("Service responds");
    expect(markup).not.toContain("Deployment is ready");
    expect(markup).not.toContain("Endpoint is owned");
    expect(markup).not.toContain("Config is mounted");
    expect(markup).toContain(">Verified</span>");
    expect(markup).toContain(">Needs repair</span>");
    expect(markup).not.toContain(hiddenProbeDetail);
    expect(markup).not.toContain("Passing");
    expect(markup).not.toContain("Failing");
    expect(markup).not.toContain("Pending");
    expect(markup).not.toContain("Unknown");
    expect(markup).not.toContain("Retrying");
  });

  it("keeps both counts visible before verification starts", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkshopModuleManual, {
        module: workshopModule(),
        busy: false,
        onRevealHint: () => {},
        onCompleteExplainBack: () => {},
      }),
    );

    expect(markup).toContain('aria-label="Verified: 0; needs repair: 0"');
    expect(markup).toContain("0 Verified");
    expect(markup).toContain("0 Needs repair");
    expect(markup).toContain(
      "Verification checks appear when the workspace is ready.",
    );
  });
});

function workshopModule(
  overrides: Partial<WorkshopModule> = {},
): WorkshopModule {
  return {
    id: "module-1",
    ordinal: 0,
    title: "Repair the service",
    outcome: "Restore the service and verify it.",
    tier: "core",
    durationMinutes: 20,
    dependsOn: [],
    state: "working",
    health: "pending",
    released: true,
    contentMarkdown: null,
    facilitatorNotesMarkdown: null,
    solutionMarkdown: null,
    solutionRevealed: false,
    explainBackPrompt: null,
    explainBackCompletedAt: null,
    verifiedAt: null,
    hints: [],
    probes: [],
    ...overrides,
  };
}

function probe(overrides: Partial<WorkshopProbe> = {}): WorkshopProbe {
  return {
    id: "probe-1",
    label: "Verification objective",
    status: "fail",
    detail: null,
    ...overrides,
  };
}
