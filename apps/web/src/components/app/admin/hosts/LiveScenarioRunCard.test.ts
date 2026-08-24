import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VerificationCollectionStatus } from "./LiveScenarioRunCard";

describe("verification collection status", () => {
  it("replaces a raw collector error with retry copy", () => {
    const hiddenError =
      "kubectl stderr: internal probe command and output must not render";
    const markup = renderToStaticMarkup(
      createElement(VerificationCollectionStatus, {
        state: "error",
        generatedAt: null,
        error: hiddenError,
      }),
    );

    expect(markup).toContain("Verification service: retrying");
    expect(markup).toContain(
      "Verification is temporarily unavailable. The service will retry automatically.",
    );
    expect(markup).not.toContain(hiddenError);
    expect(markup).not.toContain("kubectl");
  });
});
