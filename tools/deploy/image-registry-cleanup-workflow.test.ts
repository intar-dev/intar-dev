import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/image-registry-cleanup.yml"),
  "utf8",
);

function stepIndex(name: string): number {
  const index = workflow.indexOf("- name: " + name);
  expect(index, "missing step: " + name).toBeGreaterThan(-1);
  return index;
}

const stateStep = stepIndex("Read the collector status and the shared ledger");

describe("image registry cleanup operator workflow", () => {
  it("offers the three actions and gates run on the exact confirmation", () => {
    for (const action of ["status", "plan", "run"]) {
      expect(workflow).toContain("          - " + action);
    }
    expect(workflow).toContain("default: status");
    expect(workflow).toContain("Type RUN IMAGE REGISTRY CLEANUP to allow the run action");
    expect(workflow).toContain(
      "if [ \"${CONFIRMATION}\" != 'RUN IMAGE REGISTRY CLEANUP' ];",
    );
    // No public surface and nothing beyond the existing secrets.
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("pull_request_target");
  });

  it("keeps status curl-only and installs locked dependencies for plan and run", () => {
    const setup = workflow.slice(0, stateStep);
    // The dependency steps are gated, so status never installs anything.
    expect(setup.match(/if: inputs\.action != 'status'/gu)?.length).toBe(3);
    expect(setup).toContain("bun install --frozen-lockfile");
    expect(setup).toContain("node-version-file: apps/web/.node-version");
    expect(setup).toContain("bun-version: 1.3.14");
    // A locked install is what keeps `bunx wrangler` from fetching a latest.
    expect(setup).not.toContain("bunx wrangler@");
    expect(setup).not.toContain("npx ");
  });

  it("delegates plan and run to the gate script so every check stays in one place", () => {
    const plan = workflow.slice(
      stepIndex("List the candidate set"),
      stepIndex("Run the delete campaign"),
    );
    expect(plan).toContain('jq -e \'.idle == true\' "${evidence_dir}/state.json"');
    expect(plan).toContain("tools/deploy/registry-cleanup-gate.sh plan delete");
    const run = workflow.slice(
      stepIndex("Run the delete campaign"),
      stepIndex("Remove any response that reflected the machine credential"),
    );
    expect(run).toContain("tools/deploy/registry-cleanup-gate.sh run delete");
    expect(run).toContain(".counts.running_gc_runs == 0");
    expect(run).toContain(".counts.open_sessions == 0");
    expect(run).toContain(".counts.pending_writers == 0");
    // The campaign's own deadline, inside the job's 75 minutes.
    expect(run).toContain('REGISTRY_CLEANUP_RUN_DEADLINE_MS: "3600000"');
    expect(workflow).toContain("timeout-minutes: 75");
  });

  it("reads the ledger with SELECT only and never resolves a lease", () => {
    const state = workflow.slice(stateStep, stepIndex("List the candidate set"));
    // admission row, GC ledger window, and the three outstanding counts.
    const selects = state.match(/query_ledger /gu)?.length ?? 0;
    expect(selects).toBe(3);
    for (const table of [
      "image_registry_admission",
      "image_registry_gc_runs",
      "image_registry_upload_sessions",
      "image_registry_operation_writers",
    ]) {
      expect(state).toContain(table);
    }
    // Counters and times only: no lease-resolution, no writer of any kind.
    expect(state).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REAP)\b/u);
    expect(workflow).not.toContain("admission/reap");
    expect(workflow).not.toContain("resolve_stalled_sweeps");
    // Per-run tokens stay in the database.
    expect(state).not.toContain("sweep_token,");
    expect(state).not.toContain("owner,");
  });

  it("proves the secret never reaches the summary or an artifact", () => {
    const summary = workflow.indexOf("${GITHUB_STEP_SUMMARY}");
    const scrub = workflow.indexOf(
      "removed a file that reflected the machine credential",
    );
    const append = workflow.indexOf('cat "${evidence_dir}/state-summary.jsonl"');
    // The scrub runs before the summary is appended, so a reflected secret can
    // not be published by a later cleanup.
    expect(scrub).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(scrub);
    expect(summary).toBeGreaterThan(-1);
    // The credential travels through the environment into the body on stdin.
    expect(workflow).toContain('BYPASS_SECRET="${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}"');
    expect(workflow).toContain("--data-binary @-");
    expect(workflow).not.toContain('--arg secret "${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}"');
    expect(workflow).not.toContain('echo "${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}"');
  });
});
