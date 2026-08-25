import { describe, expect, it } from "vitest";
import {
  probeStatusSignature,
  probeTransitionVms,
} from "./run-probe-history";
import {
  buildInitialRunState,
  type RunStateDocument,
  type ScenarioProbeStatus,
} from "./run-state";

function probe(
  id: string,
  status: string,
  phase: "boot" | "scenario" = "scenario",
): ScenarioProbeStatus {
  return {
    id,
    label: id,
    kind: "file_exists",
    phase,
    status,
    error: null,
    value: null,
  };
}

function baseState(vmIds: string[]): RunStateDocument {
  return buildInitialRunState({
    vms: vmIds.map((id, ordinal) => ({
      id,
      ordinal,
      scenarioVmId: id,
      scenarioVmName: id,
      runtimeVmName: `rt-${id}`,
      hostname: id,
      launchSummary: {
        scenarioVmName: id,
        hostname: id,
        probePhaseMap: {},
        probeDescriptors: [],
      },
    })),
  });
}

function withProbes(
  state: RunStateDocument,
  vmId: string,
  probes: ScenarioProbeStatus[],
): RunStateDocument {
  return {
    ...state,
    vms: state.vms.map((vm) =>
      vm.id === vmId
        ? {
            ...vm,
            bootProbes: probes.filter((p) => p.phase === "boot"),
            scenarioProbes: probes.filter((p) => p.phase === "scenario"),
          }
        : vm,
    ),
  };
}

describe("probeStatusSignature", () => {
  it("is order-independent and ignores value and raw error-message churn", () => {
    const a = withProbes(baseState(["a"]), "a", [
      { ...probe("p1", "fail"), error: "first outage detail" },
      probe("p2", "pass"),
    ]).vms[0]!;
    const b = withProbes(baseState(["a"]), "a", [
      { ...probe("p2", "pass"), value: { changed: true } },
      { ...probe("p1", "fail"), error: "different outage detail" },
    ]).vms[0]!;
    expect(probeStatusSignature(a)).toBe(probeStatusSignature(b));
  });

  it("differs when a status flips", () => {
    const a = withProbes(baseState(["a"]), "a", [probe("p1", "fail")]).vms[0]!;
    const b = withProbes(baseState(["a"]), "a", [probe("p1", "pass")]).vms[0]!;
    expect(probeStatusSignature(a)).not.toBe(probeStatusSignature(b));
  });

  it("ignores a probe error because the report still arrived", () => {
    const available = withProbes(baseState(["a"]), "a", [
      probe("p1", "fail"),
    ]).vms[0]!;
    const unavailable = withProbes(baseState(["a"]), "a", [
      { ...probe("p1", "fail"), error: "collector unavailable" },
    ]).vms[0]!;

    expect(probeStatusSignature(available)).toBe(
      probeStatusSignature(unavailable),
    );
  });

});

describe("probeTransitionVms", () => {
  it("returns only VMs whose status vector changed", () => {
    let current = baseState(["a", "b"]);
    current = withProbes(current, "a", [probe("p1", "fail")]);
    current = withProbes(current, "b", [probe("p2", "pass")]);
    let next = baseState(["a", "b"]);
    next = withProbes(next, "a", [probe("p1", "pass")]);
    next = withProbes(next, "b", [probe("p2", "pass")]);
    expect(probeTransitionVms(current, next).map((v) => v.id)).toEqual(["a"]);
  });

  it("records a VM's first probe report", () => {
    const current = baseState(["a"]);
    const next = withProbes(baseState(["a"]), "a", [probe("p1", "unknown")]);
    expect(probeTransitionVms(current, next).map((v) => v.id)).toEqual(["a"]);
  });

  it("skips VMs with no probes at all", () => {
    const current = baseState([]);
    const next = baseState(["a"]);
    expect(probeTransitionVms(current, next)).toEqual([]);
  });

  it("returns nothing when statuses are unchanged", () => {
    const probes = [probe("p1", "fail"), probe("p2", "pass", "boot")];
    const current = withProbes(baseState(["a"]), "a", probes);
    const next = withProbes(baseState(["a"]), "a", probes);
    expect(probeTransitionVms(current, next)).toEqual([]);
  });

  it("ignores probe-error churn without changing the binary result", () => {
    const current = withProbes(baseState(["a"]), "a", [
      probe("p1", "fail"),
    ]);
    const next = withProbes(baseState(["a"]), "a", [
      { ...probe("p1", "fail"), error: "collector unavailable" },
    ]);

    expect(probeTransitionVms(current, next)).toEqual([]);
  });

});
