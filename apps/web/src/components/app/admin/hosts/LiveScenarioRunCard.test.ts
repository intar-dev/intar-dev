import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  binaryProbeSummary,
  VerificationCollectionStatus,
} from "./LiveScenarioRunCard";

describe("verification collection status", () => {
  it("keeps a collector failure separate from the two probe results", () => {
    const hiddenError =
      "kubectl stderr: internal probe command and output must not render";
    const markup = renderToStaticMarkup(
      createElement(VerificationCollectionStatus, {
        state: "error",
        generatedAt: null,
        error: hiddenError,
      }),
    );

    expect(markup).toContain("Verification unavailable");
    expect(markup).toContain(
      "We cannot confirm verification progress right now.",
    );
    expect(markup).not.toContain("retrying");
    expect(markup).not.toContain("automatically");
    expect(markup).not.toContain(hiddenError);
    expect(markup).not.toContain("kubectl");
  });

  it("folds unknown and failed checks into one needs-repair count", () => {
    expect(
      binaryProbeSummary({ total: 7, pass: 2, fail: 3, unknown: 2 }),
    ).toEqual({ verified: 2, needsRepair: 5 });
  });

  it("hides the collector status when verification is available", () => {
    const markup = renderToStaticMarkup(
      createElement(VerificationCollectionStatus, {
        state: "complete",
        generatedAt: "2026-08-24T00:00:00Z",
        error: null,
      }),
    );

    expect(markup).toBe("");
  });
});
