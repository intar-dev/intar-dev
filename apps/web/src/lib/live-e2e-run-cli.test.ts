import { describe, expect, it, vi } from "vitest";
import {
  assertSafeHintCompletionAliases,
  bashCompletionProofScript,
  parseBashCompletionCandidates,
  waitForBrowserCheckParity,
} from "../../scripts/live-e2e/run-cli";

describe("live E2E run CLI helpers", () => {
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

  it("accepts browser/API parity when a fresh check has failed", async () => {
    const json = vi.fn().mockResolvedValue({
      status: {
        vms: [
          {
            id: "vm-1",
            scenarioProbes: [
              { id: "internal-1", status: "pass" },
              { id: "internal-2", status: "fail" },
            ],
          },
        ],
      },
    });

    await expect(
      waitForBrowserCheckParity({
        client: { json } as never,
        runId: "run-1",
        vmId: "vm-1",
        expected: "not_all_pass",
        options: { waitReadyMs: 10, pollMs: 1 },
      }),
    ).resolves.toBeUndefined();
    expect(json).toHaveBeenCalledWith("/api/scenarios/runs/run-1/status");
  });

  it("accepts browser/API parity when every repair check is passing", async () => {
    const json = vi.fn().mockResolvedValue({
      status: {
        vms: [
          {
            id: "vm-1",
            scenarioProbes: [
              { id: "internal-1", status: "pass" },
              { id: "internal-2", status: "passed" },
            ],
          },
        ],
      },
    });

    await expect(
      waitForBrowserCheckParity({
        client: { json } as never,
        runId: "run-1",
        vmId: "vm-1",
        expected: "all_pass",
        options: { waitReadyMs: 10, pollMs: 1 },
      }),
    ).resolves.toBeUndefined();
  });
});
