import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScenarioVmSelector } from "./ScenarioVmSelector";
import type { ScenarioRunVmRecord } from "./run-types";

describe("scenario VM selector", () => {
  it.each([
    { label: "zero", vms: [] },
    { label: "one", vms: [vm("vm-1", "control-plane", "Running")] },
  ])(
    "does not add a machine selector when there are $label selectable machines",
    ({ vms }) => {
      const markup = renderToStaticMarkup(
        createElement(ScenarioVmSelector, {
          vms,
          selectedVmId: vms[0]?.id ?? null,
          onSelect: () => undefined,
        }),
      );

      expect(markup).toBe("");
    },
  );

  it("renders a compact, accessible switcher when multiple machines exist", () => {
    const markup = renderToStaticMarkup(
      createElement(ScenarioVmSelector, {
        vms: [
          vm("vm-1", "control-plane", "Running"),
          vm("vm-2", "worker", "Booting", "booting"),
        ],
        selectedVmId: "vm-1",
        onSelect: () => undefined,
      }),
    );

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Machines"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("control-plane");
    expect(markup).toContain("Running");
    expect(markup).toContain("worker");
    expect(markup).toContain("Booting");
    expect(markup).not.toContain("control-plane.intar.test");
    expect(markup).not.toContain("worker.intar.test");
    expect(markup).toContain("min-h-10");
    expect(markup).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(markup).toContain("border-b-2");
    expect(markup).toContain("rounded-full");
    expect(markup).not.toContain("rounded-xl");
    expect(markup).not.toContain("shadow-xs");
    expect(markup).not.toContain("bg-muted p-1");
  });
});

function vm(
  id: string,
  scenarioVmName: string,
  phaseTitle: string,
  phase: ScenarioRunVmRecord["phase"] = "running",
): ScenarioRunVmRecord {
  return {
    id,
    ordinal: 1,
    scenarioVmId: `${id}-scenario`,
    scenarioVmName,
    runtimeVmName: scenarioVmName,
    hostname: `${scenarioVmName}.intar.test`,
    phase,
    phaseTitle,
    phaseDetail: phaseTitle,
    progressPercent: 100,
    terminalPhase: "ready",
    canOpenTerminal: true,
    bootProbes: [],
    scenarioProbes: [],
    replayArtifacts: [],
    sessionTimeline: null,
    provisioning: {
      image: null,
      imageKey: null,
      imageSha256: null,
      resources: {
        cpuMillis: 1_000,
        vcpuCount: 1,
        memoryMib: 512,
        diskMib: 8_192,
      },
      leaseDurationSeconds: 3_600,
      groupName: null,
      groupId: null,
      setupKeyId: null,
      status: "provisioning",
      error: null,
    },
    terminalTarget: {
      host: null,
      port: 22,
      username: "ubuntu",
      hostKeyOpenssh: null,
      checkedAt: null,
    },
  };
}
