import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const workflowPath = resolve(
  repositoryRoot,
  ".github/workflows/image-registry-cleanup.yml",
);
const workflow = readFileSync(workflowPath, "utf8");
/**
 * The status record the resolve step acts on, with the field names and the
 * shape the status step writes. The values are fixture data only: the
 * timestamps, counters, and problems of one stalled sweep. No credential of
 * any kind is present, and the test reads no file outside its own runner
 * directory, so the checks below hold in CI as well as on a workstation.
 */
const observedState: Record<string, any> = {
  schema_version: 1,
  operation: "image-registry-cleanup-state",
  source_sha: "0123456789abcdef0123456789abcdef01234567",
  run_id: "10000000001",
  action: "status",
  observed_at_ms: 1789391410928,
  collector_http_status: 200,
  collector_problem: null,
  collector: {
    mode: "delete",
    mode_valid: true,
    configured_mode: "delete",
    maintenance: "off",
    maintenance_source: "control-plane",
    enforcement: "enforce",
    session_required: true,
    paused: false,
    pause_reason: null,
    sweep_active: true,
    running: true,
    idle: false,
    active_sessions: 0,
    active_writers: 0,
    last_run: {
      state: "running",
      startedAtMs: 1789389744599,
      finishedAtMs: null,
      scannedObjects: 94336,
      deletedObjects: 2400,
      blockedObjects: 0,
      bytesReclaimed: 5844298942,
      error: null,
    },
    observed_at_ms: 1789391410001,
  },
  admission_problem: null,
  admission: {
    enforcement: "enforce",
    admission_state: "sweeping",
    protocol_version: 1,
    epoch: 1,
    sweep_started_at: 1789389744599,
    sweep_heartbeat_at: 1789389864130,
    sweep_expires_at: 1789390164130,
    paused_at: null,
    pause_reason: null,
    updated_at: 1789389864130,
  },
  ledger_problem: null,
  counts: { running_gc_runs: 1, open_sessions: 0, pending_writers: 0 },
  gc_runs: [
    {
      id: "a7ba5a4b-6838-472f-8011-2aa855e40b3f",
      state: "running",
      started_at: 1789389744599,
      heartbeat_at: 1789389864130,
      finished_at: null,
      scanned_objects: 94336,
      deleted_objects: 2400,
      blocked_objects: 0,
      bytes_reclaimed: 5844298942,
      error: null,
      detail_json: null,
      created_at: 1789389744599,
      updated_at: 1789389864130,
    },
  ],
  idle: false,
};
const stalledRunId = "a7ba5a4b-6838-472f-8011-2aa855e40b3f";

/** A fresh copy per call: the refusal cases mutate the record they read. */
function cloneObservedState(): Record<string, any> {
  return JSON.parse(JSON.stringify(observedState)) as Record<string, any>;
}

function stepIndex(name: string): number {
  const index = workflow.indexOf("- name: " + name);
  expect(index, "missing step: " + name).toBeGreaterThan(-1);
  return index;
}

/** The shell body of a step, de-indented, exactly as the runner executes it. */
function runBlock(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === "- name: " + name);
  expect(start, "missing step: " + name).toBeGreaterThan(-1);
  let cursor = start;
  while (lines[cursor]?.trim() !== "run: |") cursor += 1;
  const base = (lines[cursor]?.match(/^ */u)?.[0]?.length ?? 0) + 2;
  const body: string[] = [];
  for (let index = cursor + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const indent = line.match(/^ */u)?.[0]?.length ?? 0;
    if (line.trim() && indent < base && !line.trim().startsWith("#")) break;
    body.push(line.slice(base));
  }
  return body.join("\n");
}

const stateStep = stepIndex("Read the collector status and the shared ledger");

describe("image registry cleanup operator workflow", () => {
  it("offers the operator actions and gates each one on its confirmation", () => {
    for (const action of ["status", "plan", "run", "resolve"]) {
      expect(workflow).toContain("          - " + action);
    }
    expect(workflow).toContain("default: status");
    expect(workflow).toContain("Type RUN IMAGE REGISTRY CLEANUP for run");
    expect(workflow).toContain(
      "if [ \"${CONFIRMATION}\" != 'RUN IMAGE REGISTRY CLEANUP' ];",
    );
    expect(workflow).toContain(
      "if [ \"${CONFIRMATION}\" != 'RESOLVE STALLED IMAGE CLEANUP' ];",
    );
    // No public surface and nothing beyond the existing secrets.
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("pull_request_target");
  });

  it("keeps status and resolve curl-only and installs locked dependencies for plan and run", () => {
    const setup = workflow.slice(0, stateStep);
    // Only plan and run delegate to the gate script, which resolves wrangler
    // through the locked dependency tree. status and resolve never install.
    expect(
      setup.match(/if: inputs\.action == 'plan' \|\| inputs\.action == 'run'/gu)?.length,
    ).toBe(3);
    expect(setup).toContain("bun install --frozen-lockfile");
    expect(setup).toContain("node-version-file: apps/web/.node-version");
    expect(setup).toContain("bun-version: 1.3.14");
    // A locked install is what keeps `bunx wrangler` from fetching a latest.
    expect(setup).not.toContain("bunx wrangler@");
    expect(setup).not.toContain("npx ");
  });

  it("delegates plan and run to the gate script so every check stays in one place", () => {
    const plan = runBlock("List the candidate set");
    expect(plan).toContain('jq -e \'.idle == true\' "${evidence_dir}/state.json"');
    expect(plan).toContain("tools/deploy/registry-cleanup-gate.sh plan delete");
    const run = runBlock("Run the delete campaign");
    expect(run).toContain("tools/deploy/registry-cleanup-gate.sh run delete");
    expect(run).toContain(".counts.running_gc_runs == 0");
    expect(run).toContain(".counts.open_sessions == 0");
    expect(run).toContain(".counts.pending_writers == 0");
    // The campaign's own deadline, inside the job's 75 minutes.
    const runStep = workflow.slice(
      stepIndex("Run the delete campaign"),
      stepIndex("Resolve one stalled sweep"),
    );
    expect(runStep).toContain('REGISTRY_CLEANUP_RUN_DEADLINE_MS: "3600000"');
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
    // Counters and times only: no writer of any kind.
    expect(state).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REAP)\b/u);
    // The read step itself never resolves a lease; only the resolve step does.
    expect(state).not.toContain("admission/reap");
    expect(state).not.toContain("resolve_stalled_sweeps");
    // Per-run tokens stay in the database.
    expect(state).not.toContain("sweep_token,");
    expect(state).not.toContain("owner,");
  });

  it("proves the secret never reaches the summary or an artifact", () => {
    const append = workflow.indexOf('cat "${evidence_dir}/state-summary.jsonl"');
    expect(append).toBeGreaterThan(-1);
    // The scrub covers both machine credentials and runs before any summary is
    // appended, in the state step and again after the run and resolve steps.
    expect(workflow).toContain("CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET:-}");
    expect(workflow).toContain("INTAR_IMAGE_PUBLISH_TOKEN:-}");
    expect(workflow).toContain("removed a file that reflected a machine credential");
    // The credential travels through the environment into the body on stdin.
    expect(workflow).toContain('BYPASS_SECRET="${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}"');
    expect(workflow).toContain("--data-binary @-");
    expect(workflow).not.toContain('--arg secret "${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}"');
  });
});

interface ResolveOptions {
  state?: Record<string, unknown>;
  gcRunId?: string;
  reapBody?: string;
  reapStatus?: string;
  postBody?: string;
}

function fakeCurl(): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    'output=""; url=""',
    // Every call records its endpoint and the Authorization header it sent, so a
    // future copy that sends the registry token to the Cloudflare API, or the
    // Cloudflare token to the registry, fails instead of passing.
    'auth=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --output) output="$2"; shift 2 ;;',
    '    --data-binary) shift 2 ;;',
    '    --header) case "$2" in Authorization:*) auth="$2" ;; esac; shift 2 ;;',
    "    http*) url=\"$1\"; shift ;; ",
    "    *) shift ;; ",
    "  esac",
    "done",
    'case "$url" in',
    "  *admission/reap)",
    '    printf "reap %s\\n" "$auth" >> "$MOCK_AUTH_LOG"',
    '    printf "%s" "$MOCK_REAP_BODY" > "$output"; printf "%s" "$MOCK_REAP_STATUS" ;;',
    "  *d1/database/*)",
    '    case "$url" in',
    '      *api.cloudflare.com*) printf "d1-cloudflare %s\\n" "$auth" >> "$MOCK_AUTH_LOG" ;;',
    '      *) printf "d1-unknown-host %s\\n" "$auth" >> "$MOCK_AUTH_LOG" ;;',
    '    esac',
    '    printf "%s" "$MOCK_POST_BODY" > "$output"; printf "%s" "$MOCK_POST_STATUS" ;;',
    "  *) exit 92 ;;",
    "esac",
    "",
  ].join("\n");
}

/**
 * Runs the resolve step exactly as the runner does: the block is executed as a
 * file, so a command reading standard input can not consume the rest of it.
 */
function runResolve(options: ResolveOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "intar-cleanup-resolve-test-"));
  const evidence = join(root, "intar-image-registry-cleanup");
  const bin = join(root, "bin");
  mkdirSync(evidence, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const state = options.state ?? cloneObservedState();
  writeFileSync(join(evidence, "state.json"), JSON.stringify(state));
  const curl = join(bin, "curl");
  writeFileSync(curl, fakeCurl());
  chmodSync(curl, 0o755);
  const authLog = join(root, "auth-log");
  const stepPath = join(root, "step.sh");
  writeFileSync(stepPath, runBlock("Resolve one stalled sweep") + "\n");
  const gcRunId = options.gcRunId ?? stalledRunId;
  const reapBody =
    options.reapBody ??
    JSON.stringify({
      ok: true,
      reaped_sessions: [],
      reaped_writers: [],
      resolved_sweeps: [gcRunId],
      compacted_sessions: 0,
      active: { sessions: 0, writers: 0 },
      sweep_active: false,
      sweep_stalled: false,
    });
  const postRow = {
    gc_state: "aborted",
    gc_finished_at: 1789391500000,
    scanned_objects: 94336,
    deleted_objects: 2400,
    blocked_objects: 0,
    bytes_reclaimed: 5844298942,
    admission_state: "open",
    sweep_started_at: null,
    sweep_heartbeat_at: null,
    sweep_expires_at: null,
    running_gc_runs: 0,
  };
  const postBody =
    options.postBody ??
    JSON.stringify({ success: true, result: [{ success: true, results: [postRow] }] });
  const result = spawnSync("bash", [stepPath], {
    encoding: "utf8",
    env: {
      ...(process.env as Record<string, string>),
      PATH: bin + ":" + (process.env.PATH ?? ""),
      RUNNER_TEMP: root,
      EXPECTED_GC_RUN_ID: gcRunId,
      STALE_MS: "600000",
      INTAR_IMAGE_PUBLISH_TOKEN: "test-publish-token-value",
      // A distinct value per credential: the workflow must send the registry
      // token to the registry and the Cloudflare token to the Cloudflare API.
      CLOUDFLARE_API_TOKEN: "test-cloudflare-api-token-value",
      CLOUDFLARE_ACCOUNT_ID: "account",
      DATABASE_ID: "db",
      REAP_URL: "https://intar.dev/registry/v1/admission/reap",
      MOCK_REAP_BODY: reapBody,
      MOCK_REAP_STATUS: options.reapStatus ?? "200",
      MOCK_POST_BODY: postBody,
      MOCK_POST_STATUS: "200",
      MOCK_AUTH_LOG: authLog,
      GITHUB_STEP_SUMMARY: join(root, "summary.md"),
    },
  });
  return {
    result,
    evidence,
    authLog: existsSync(authLog) ? readFileSync(authLog, "utf8") : "",
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withLiveState(mutate: (state: Record<string, any>) => void) {
  const state = cloneObservedState();
  mutate(state);
  return state;
}

describe("image registry cleanup stalled-sweep resolution", () => {
  it("resolves the one abandoned sweep the observed state shows", () => {
    const run = runResolve();
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      // The aborted row keeps the counters the abandoned pass had claimed.
      const post = JSON.parse(
        readFileSync(join(run.evidence, "stalled-sweep-post-state.json"), "utf8"),
      ) as { result: { results: Record<string, unknown>[] }[] };
      expect(post.result[0]!.results[0]).toMatchObject({
        gc_state: "aborted",
        running_gc_runs: 0,
        admission_state: "open",
        sweep_started_at: null,
        sweep_expires_at: null,
        scanned_objects: 94336,
        deleted_objects: 2400,
        bytes_reclaimed: 5844298942,
      });
    } finally {
      run.cleanup();
    }
  });

  it("sends each machine credential only to its own endpoint", () => {
    const run = runResolve();
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      // The registry endpoint takes the publish token; the Cloudflare API takes
      // the Cloudflare token. A copy that swaps them fails here.
      expect(run.authLog).toContain(
        "reap Authorization: Bearer test-publish-token-value",
      );
      expect(run.authLog).toContain(
        "d1-cloudflare Authorization: Bearer test-cloudflare-api-token-value",
      );
      expect(run.authLog).not.toContain(
        "d1-cloudflare Authorization: Bearer test-publish-token-value",
      );
      expect(run.authLog).not.toContain(
        "reap Authorization: Bearer test-cloudflare-api-token-value",
      );
      // Every D1 read must go to the Cloudflare API, never anywhere else.
      expect(run.authLog).not.toContain("d1-unknown-host");
    } finally {
      run.cleanup();
    }
  });

  it("tolerates completed history and still resolves the one running sweep", () => {
    // The ledger window is bounded history: a finished pass from an earlier run
    // sits beside the stalled one, and only the running rows are the guard.
    const state = withLiveState((draft) => {
      draft.gc_runs.push({
        id: "3f1c8b7e-0000-4000-8000-000000000000",
        state: "completed",
        started_at: 1789380000000,
        heartbeat_at: 1789380100000,
        finished_at: 1789380200000,
        scanned_objects: 500,
        deleted_objects: 5,
        blocked_objects: 0,
        bytes_reclaimed: 1000,
        error: null,
        detail_json: null,
        created_at: 1789380000000,
        updated_at: 1789380200000,
      });
    });
    const run = runResolve({ state });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
    } finally {
      run.cleanup();
    }
  });

  it("refuses two running sweeps even when history is present", () => {
    const state = withLiveState((draft) => {
      draft.gc_runs.push({
        id: "4a2d9c8f-0000-4000-8000-000000000000",
        state: "running",
        started_at: 1789389700000,
        heartbeat_at: 1789389750000,
        finished_at: null,
        scanned_objects: 1,
        deleted_objects: 0,
        blocked_objects: 0,
        bytes_reclaimed: 0,
        error: null,
        detail_json: null,
        created_at: 1789389700000,
        updated_at: 1789389750000,
      });
      draft.counts.running_gc_runs = 2;
    });
    const run = runResolve({ state });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("preconditions do not hold");
    } finally {
      run.cleanup();
    }
  });

  it("refuses when the named run id is not the stalled one", () => {
    const run = runResolve({ gcRunId: "11111111-2222-4333-8444-555555555555" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("preconditions do not hold");
    } finally {
      run.cleanup();
    }
  });

  it("refuses every precondition that must still hold", () => {
    const cases: { label: string; state: Record<string, unknown> }[] = [
      {
        label: "two running sweeps",
        state: withLiveState((state) => { state.counts.running_gc_runs = 2; }),
      },
      {
        label: "a heartbeat inside the grace window",
        state: withLiveState((state) => {
          state.gc_runs[0].heartbeat_at = state.observed_at_ms - 300_000;
        }),
      },
      {
        label: "a lease that has not expired far enough",
        state: withLiveState((state) => {
          state.admission.sweep_expires_at = state.observed_at_ms - 60_000;
        }),
      },
      {
        label: "an open upload session",
        state: withLiveState((state) => { state.counts.open_sessions = 1; }),
      },
      {
        label: "an unresolved writer",
        state: withLiveState((state) => { state.counts.pending_writers = 1; }),
      },
      {
        label: "a child that is not deleting",
        state: withLiveState((state) => { state.collector.mode = "report-only"; }),
      },
      {
        label: "enforcement that is off",
        state: withLiveState((state) => { state.collector.enforcement = "report_only"; }),
      },
      {
        label: "a parent under maintenance",
        state: withLiveState((state) => { state.collector.maintenance = "on"; }),
      },
      {
        label: "an admission row that is not sweeping",
        state: withLiveState((state) => { state.admission.admission_state = "open"; }),
      },
      {
        label: "an unreadable status",
        state: withLiveState((state) => {
          state.collector_http_status = 503;
          state.collector_problem = "unreadable";
        }),
      },
    ];
    for (const testCase of cases) {
      const run = runResolve({ state: testCase.state });
      try {
        expect(run.result.status, testCase.label).not.toBe(0);
        expect(run.result.stderr, testCase.label).toContain(
          "preconditions do not hold",
        );
      } finally {
        run.cleanup();
      }
    }
  }, 60_000);

  it("refuses a resolution that did more or less than the one sweep", () => {
    const variants: { label: string; reapBody: Record<string, unknown>; reapStatus?: string }[] = [
      {
        label: "a reaped session",
        reapBody: { reaped_sessions: ["session-1"], reaped_writers: [], resolved_sweeps: [stalledRunId] },
      },
      {
        label: "a reaped writer",
        reapBody: { reaped_sessions: [], reaped_writers: ["writer-1"], resolved_sweeps: [stalledRunId] },
      },
      {
        label: "two resolved sweeps",
        reapBody: { reaped_sessions: [], reaped_writers: [], resolved_sweeps: [stalledRunId, "other"] },
      },
      {
        label: "no resolved sweep",
        reapBody: { reaped_sessions: [], reaped_writers: [], resolved_sweeps: [] },
      },
      {
        label: "a sweep still active",
        reapBody: {
          reaped_sessions: [],
          reaped_writers: [],
          resolved_sweeps: [stalledRunId],
          sweep_active: true,
        },
      },
      {
        label: "a refusal from the endpoint",
        reapBody: {},
        reapStatus: "403",
      },
    ];
    for (const testCase of variants) {
      const run = runResolve({
        reapBody: JSON.stringify({
          ok: true,
          compacted_sessions: 0,
          active: { sessions: 0, writers: 0 },
          sweep_active: false,
          sweep_stalled: false,
          ...testCase.reapBody,
        }),
        ...(testCase.reapStatus === undefined ? {} : { reapStatus: testCase.reapStatus }),
      });
      try {
        expect(run.result.status, testCase.label).not.toBe(0);
      } finally {
        run.cleanup();
      }
    }
  }, 60_000);

  it("refuses a post state that is not the aborted sweep", () => {
    const row = {
      gc_state: "aborted",
      gc_finished_at: 1789391500000,
      scanned_objects: 94336,
      deleted_objects: 2400,
      blocked_objects: 0,
      bytes_reclaimed: 5844298942,
      admission_state: "open",
      sweep_started_at: null,
      sweep_heartbeat_at: null,
      sweep_expires_at: null,
      running_gc_runs: 0,
    };
    const cases: { label: string; post: Record<string, unknown> }[] = [
      { label: "a row still running", post: { ...row, gc_state: "running", running_gc_runs: 1 } },
      { label: "an admission row still sweeping", post: { ...row, admission_state: "sweeping" } },
      { label: "a lease field that was not cleared", post: { ...row, sweep_expires_at: 1 } },
      { label: "claimed counters that moved", post: { ...row, deleted_objects: 9999 } },
      { label: "claimed bytes that moved", post: { ...row, bytes_reclaimed: 1 } },
      { label: "an unfinished row", post: { ...row, gc_finished_at: null } },
    ];
    for (const testCase of cases) {
      const run = runResolve({
        postBody: JSON.stringify({ success: true, result: [{ success: true, results: [testCase.post] }] }),
      });
      try {
        expect(run.result.status, testCase.label).not.toBe(0);
        expect(run.result.stderr, testCase.label).toContain(
          "is not the expected state, or its counters moved",
        );
      } finally {
        run.cleanup();
      }
    }
  }, 60_000);

  it("reaps through the existing operator endpoint and mutates no row itself", () => {
    const step = runBlock("Resolve one stalled sweep");
    const stepText = workflow.slice(
      stepIndex("Resolve one stalled sweep"),
      stepIndex("Remove any response that reflected the machine credential"),
    );
    expect(stepText).toContain("REAP_URL: https://intar.dev/registry/v1/admission/reap");
    expect(step).toContain("resolve_stalled_sweeps: true");
    expect(step).toContain("grace_ms: $grace");
    expect(stepText).toContain('STALE_MS: "600000"');
    expect(step).toContain("Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}");
    // The run id reaches SQL as a bound parameter, never interpolated.
    expect(step).toContain("params: [$id]");
    // No direct mutation: the endpoint call and a read-only SELECT only.
    expect(step).not.toMatch(/\b(INSERT INTO|UPDATE image_registry|DELETE FROM)\b/u);
    expect(workflow).not.toContain("sweep_token = NULL");
  });

  it("is an explicit operator action, never an automatic one", () => {
    expect(workflow).toContain("if: inputs.action == 'resolve'");
    // The run and plan steps never resolve anything, and this lane has no schedule.
    const plan = runBlock("List the candidate set");
    const run = runBlock("Run the delete campaign");
    for (const block of [plan, run]) {
      expect(block).not.toContain("admission/reap");
      expect(block).not.toContain("resolve_stalled_sweeps");
    }
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    // plan stays available for an idle collector, the state after a resolution.
    expect(plan).toContain('.idle == true');
  });
});
