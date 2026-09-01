import { describe, expect, it } from "vitest";
import {
  assertSafeHintCompletionAliases,
  bashCompletionProofScript,
  parseBashCompletionCandidates,
} from "../../scripts/workshop-run-cli/completion";

describe("workshop run CLI completion helpers", () => {
  it("uses Bash completion without a prompt, stdin, or /dev/tty", () => {
    const script = bashCompletionProofScript();

    expect(script).toContain("complete -p intar");
    expect(script).toContain("COMP_WORDS=(intar hi)");
    expect(script).toContain("COMP_WORDS=(intar hint '')");
    expect(script).toContain("COMP_WORDS=(intar solution re)");
    expect(script).toContain("__INTAR_STATIC__");
    expect(script).toContain("__INTAR_HINT__");
    expect(script).toContain("__INTAR_SOLUTION__");
    expect(script).not.toMatch(/\bread\b|\/dev\/tty/);
  });

  it("extracts only explicit completion markers and rejects unsafe aliases", () => {
    expect(
      parseBashCompletionCandidates(
        [
          "noise",
          "__INTAR_STATIC__hints",
          "__INTAR_HINT__general",
          "__INTAR_HINT__check-1",
          "__INTAR_SOLUTION__reveal",
        ].join("\n"),
      ),
    ).toEqual({
      staticCandidates: ["hints"],
      hintCandidates: ["general", "check-1"],
      solutionCandidates: ["reveal"],
    });
    expect(() =>
      assertSafeHintCompletionAliases(["general", "$(whoami)"]),
    ).toThrow("unsafe hint alias");
  });

});
