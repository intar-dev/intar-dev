import { describe, expect, it } from "vitest";
import type { VmLabV1, VmStateV3, VmTaskV1 } from "@/generated/contracts/bridge-message-v9";
import type { RevisionTaskV1 } from "@/generated/contracts/scenario-revision-v1";
import { applyVmStateV3ToRunState, revisionVmId } from "@/lib/run-lifecycle";
import { buildInitialRunState, buildInitialVmState, recomputeRunState, type RunStateDocument } from "@/lib/run-state";
import {
  initialRunTasks,
  LAB_FAILED_TEXT,
  mergeReportedTasks,
  taskViews,
  tasksSolved,
} from "@/lib/run-tasks";

function task(id: string, machine: string, extra: Partial<RevisionTaskV1> = {}): RevisionTaskV1 {
  return { id, title: id, machine, needs: [], optional: false, ordinal: 0, hints: [], ...extra };
}
function report(id: string, status: VmTaskV1["status"]): VmTaskV1 {
  return { id, status, message: `${id} ${status}` };
}

const defs = [
  task("install", "web", { ordinal: 0 }),
  task("serve", "web", { ordinal: 1, needs: ["install"] }),
  task("probe", "client", { ordinal: 2, needs: ["serve"] }),
  task("bonus", "client", { ordinal: 3, optional: true }),
];

describe("task projection", () => {
  it.each([
    {
      name: "needs across machines gate availability",
      reports: [["client", [report("probe", "pass")]]] as const,
      available: { install: true, serve: false, probe: false, bonus: true },
      complete: { install: false, serve: false, probe: false, bonus: false },
      solved: false,
    },
    {
      name: "a pass before its needs completes once they do",
      reports: [
        ["client", [report("probe", "pass")]],
        ["web", [report("install", "pass"), report("serve", "pass")]],
      ] as const,
      available: { install: true, serve: true, probe: true, bonus: true },
      complete: { install: true, serve: true, probe: true, bonus: false },
      solved: true,
    },
    {
      name: "optional tasks never block solved",
      reports: [
        ["web", [report("install", "pass"), report("serve", "pass")]],
        ["client", [report("probe", "pass"), report("bonus", "fail")]],
      ] as const,
      available: { install: true, serve: true, probe: true, bonus: true },
      complete: { install: true, serve: true, probe: true, bonus: false },
      solved: true,
    },
    {
      name: "a pass latches through a later failure",
      reports: [
        ["web", [report("install", "pass")]],
        ["web", [report("install", "fail"), report("serve", "error")]],
      ] as const,
      available: { install: true, serve: true, probe: false, bonus: true },
      complete: { install: true, serve: false, probe: false, bonus: false },
      solved: false,
    },
    {
      name: "a machine reports only its own tasks",
      reports: [["client", [report("install", "pass"), report("serve", "pass")]]] as const,
      available: { install: true, serve: false, probe: false, bonus: true },
      complete: { install: false, serve: false, probe: false, bonus: false },
      solved: false,
    },
  ])("$name", ({ reports, available, complete, solved }) => {
    let tasks = initialRunTasks(defs);
    for (const [machine, reported] of reports) tasks = mergeReportedTasks(tasks, machine, reported, 100);
    const views = taskViews(tasks);
    expect(Object.fromEntries(views.map((view) => [view.id, view.available]))).toEqual(available);
    expect(Object.fromEntries(views.map((view) => [view.id, view.complete]))).toEqual(complete);
    expect(tasksSolved(tasks)).toBe(solved);
  });

  it("never completes a cycle, and a run of optional tasks only is never solved", () => {
    const cycle = initialRunTasks([task("a", "m", { needs: ["b"] }), task("b", "m", { needs: ["a"] })]);
    const passed = mergeReportedTasks(cycle, "m", [report("a", "pass"), report("b", "pass")], 1);
    expect(taskViews(passed).map((view) => view.complete)).toEqual([false, false]);
    expect(tasksSolved(mergeReportedTasks(initialRunTasks([task("x", "m", { optional: true })]), "m",
      [report("x", "pass")], 1))).toBe(false);
  });
});

describe("bridge 9 VM state on a task run", () => {
  const runId = "run1";
  function run(): RunStateDocument {
    const vms = ["web", "client"].map((name, ordinal) => ({
      ...buildInitialVmState({
        id: `vm-${name}`, ordinal, scenarioVmId: name, scenarioVmName: name,
        runtimeVmName: revisionVmId(name, runId), hostname: name,
        launchSummary: { scenarioVmName: name, hostname: name, probePhaseMap: {}, probeDescriptors: [] },
      }),
    }));
    return recomputeRunState({ ...buildInitialRunState({ vms: [] }), phase: "provisioning", vms, tasks: initialRunTasks(defs) });
  }
  function vm(name: string, at: number, lab: VmLabV1, phase: VmStateV3["phase"] = "ready"): VmStateV3 {
    return {
      name, run_id: runId, runtime_execution_id: runId, owner_user_id: "u", generation: 1, phase,
      ssh_host_keys_openssh: [], updated_at_unix_ms: at,
      terminal: { state: "pending", observed_at_unix_ms: at },
      lab,
    };
  }
  const lab = (state: "preparing" | "ready" | "failed", tasks: VmTaskV1[] = [], failure: string | null = null) =>
    ({ state, kino_version: "1", ready: [{ name: "svc", status: "pass" as const, tail: "secret tail" }], tasks, timings_ms: {}, failure });

  it("holds a VM below ready until its lab is ready", () => {
    let state = applyVmStateV3ToRunState({ runId, current: run(), vm: vm("web", 1, lab("preparing")) });
    expect(state.vms[0]?.phase).toBe("booting");
    state = applyVmStateV3ToRunState({ runId, current: state, vm: vm("web", 2, lab("ready")) });
    state = applyVmStateV3ToRunState({ runId, current: state, vm: vm("client", 2, lab("ready")) });
    expect(state.vms.map((entry) => entry.phase)).toEqual(["ready", "ready"]);
    expect(state.phase).toBe("active_full");
  });

  it("solves the run from tasks across machines", () => {
    let state = run();
    state = applyVmStateV3ToRunState({ runId, current: state, vm: vm("web", 1,
      lab("ready", [report("install", "pass"), report("serve", "pass")])) });
    state = applyVmStateV3ToRunState({ runId, current: state, vm: vm("client", 1, lab("ready", [report("probe", "pass")])) });
    expect(state.phase).toBe("solved");
  });

  it("fails the run on a failed lab with the fixed text and keeps the failure admin-only", () => {
    const state = applyVmStateV3ToRunState({ runId, current: run(), vm: vm("web", 1, lab("failed", [], "setup.sh: exit 3")) });
    expect(state.phase).toBe("failed");
    expect(state.phaseDetail).toBe(LAB_FAILED_TEXT);
    expect(state.vms[0]?.terminalReason).toBe(LAB_FAILED_TEXT);
    expect(state.vms[0]?.lab).toEqual({ state: "failed", ready: [{ name: "svc", status: "pass" }], failure: "setup.sh: exit 3" });
  });

  it("ignores another run's VM and a stale report", () => {
    const current = run();
    expect(applyVmStateV3ToRunState({ runId, current, vm: { ...vm("web", 1, lab("ready")), run_id: "other" } })).toBe(current);
    const later = applyVmStateV3ToRunState({ runId, current, vm: vm("web", 5, lab("ready", [report("install", "pass")])) });
    const stale = applyVmStateV3ToRunState({ runId, current: later, vm: vm("web", 4, lab("failed")) });
    expect(stale.phase).not.toBe("failed");
  });
});
