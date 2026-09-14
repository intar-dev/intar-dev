import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const gateScriptPath = join(repositoryRoot, "tools/deploy/registry-cleanup-gate.sh");
const script = readFileSync(gateScriptPath, "utf8");
const sourceSha = "a".repeat(40);
const activeVersionId = "22222222-3333-4444-8555-666666666666";
const bypassSecret = "test-maintenance-bypass-secret-that-is-long-enough";
const gateUrl = "https://intar.dev/api/maintenance/registry-cleanup";
// Every test here spawns the gate, which itself spawns wrangler and curl, so
// the default timeout is too tight when the whole suite runs in parallel.
const SPAWN_TIMEOUT_MS = 30_000;
const scannedDigest = "1".repeat(64);

/** The controller envelope: {action, result:{...}}, never a flattened copy. */
function nestedEnvelope(action: string, result: unknown): Record<string, unknown> {
  return { action, result };
}

/** The run result the collector nests inside its envelope. */
function innerResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
      completed: true,
      deletedObjects: 5,
      deletedBytes: 500,
      failedObjects: 0,
      skippedObjects: 0,
      wouldDeleteObjects: 5,
      wouldDeleteBytes: 500,
      blockedObjects: 0,
      planSummary: { details: { candidateTotal: 5 } },
      postState: {
        scanned: { objects: 7, bytes: 700, digest: scannedDigest },
        expected: { objects: 7, bytes: 700, digest: scannedDigest },
        unchanged: true,
        truncated: false,
        unrecognizedObjects: 0,
      },
      verifiedDeletedObjects: 5,
      verifiedDeletedBytes: 500,
      unverifiedObjects: 0,
      unverifiedKeys: [],
      deletedKeys: ["image-chunks/v1/zstd6/aa"],
      deletedKeysTruncated: false,
      deletedKeysDigest: "2".repeat(64),
      resumeRequired: false,
      phases: {},
      error: null,
      ...overrides,
  };
}

/** One collector envelope, as the controller nests it. */
function runEnvelope(
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status,
    mode: "delete",
    maintenance: "off",
    maintenanceSource: "control-plane",
    source: "rpc",
    plan: null,
    error: (overrides.error as string | null) ?? null,
    result: innerResult(overrides),
  };
}

/** The final report after a finished campaign: nothing left to delete. */
function reportTextEchoing(echo: string): string {
  return JSON.stringify(nestedEnvelope("plan", { ...zeroCandidateReport(), echo }));
}

/** One report envelope, as the controller nests it, with the maintenance flag. */
function reportEnvelope(overrides: {
  maintenance?: string | null;
  maintenanceSource?: string | null;
  status?: string;
  plan?: unknown;
} = {}): string {
  const base = zeroCandidateReport();
  return JSON.stringify(
    nestedEnvelope("plan", {
      ...base,
      status: overrides.status ?? base.status,
      maintenance:
        overrides.maintenance === undefined ? "off" : overrides.maintenance,
      maintenanceSource:
        overrides.maintenanceSource === undefined
          ? "control-plane"
          : overrides.maintenanceSource,
      plan: overrides.plan === undefined ? base.plan : overrides.plan,
    }),
  );
}

function zeroCandidateReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "report-only",
    mode: "delete",
    maintenance: "off",
    maintenanceSource: "control-plane",
    source: "rpc",
    error: null,
    result: null,
    plan: {
      candidateObjects: [],
      objectsScanned: 7,
      retainedObjects: 7,
      truncated: false,
      details: {
        faults: [],
        deleteAllowedByReferences: true,
        candidateTotal: 0,
        keysets: {
          scanned: { objects: 7, bytes: 700, digest: scannedDigest },
          retained: { objects: 7, bytes: 700, digest: scannedDigest },
          candidates: { objects: 0, bytes: 0, digest: "3".repeat(64) },
        },
      },
      ...overrides,
    },
  };
}

interface RunOptions {
  action?: string;
  targetMode?: string;
  liveMode?: string | null;
  collectorAbsent?: boolean;
  status?: string;
  body?: string;
  /** `nested-held` writes the controller envelope shape, not a flat copy. */
  holdEvidence?: "held" | "clear" | "nested-held" | "none";
  secret?: string | null;
  scriptStatus?: string;
  scriptBody?: string;
  deploymentsFail?: boolean;
  statusBody?: string;
  statusStatus?: string;
  planBody?: string;
  planStatus?: string;
  /** One body per delete pass; the last one answers every later pass. */
  runBodies?: string[];
  runPasses?: number;
}

/**
 * The fake wrangler answers the live-state read the gate script makes first.
 * The fake curl records what it saw and answers with the configured response:
 * the request body arrives on standard input, never from a file.
 */
function fakeBunx(): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    "shift",
    'case "$1 $2" in',
    '  "deployments status")',
    '    if [ "$MOCK_DEPLOYMENTS_FAIL" = true ]; then exit 90; fi',
    '    jq -cn --arg v "$ACTIVE_VERSION_ID" \'{versions:[{version_id:$v,percentage:100}]}\'',
    "    exit 0",
    "    ;;",
    '  "versions view")',
    '    if [ "$MOCK_LIVE_MODE" = none ]; then',
    '      jq -cn --arg id "$3" \'{id:$id,resources:{bindings:[]}}\'',
    "      exit 0",
    "    fi",
    '    jq -cn --arg id "$3" --arg mode "$MOCK_LIVE_MODE" \'{id:$id,resources:{bindings:[{type:"plain_text",name:"REGISTRY_CLEANUP_MODE",text:$mode}]}}\'',
    "    exit 0",
    "    ;;",
    "esac",
    "exit 91",
    "",
  ].join("\n");
}

function fakeCurl(): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    'output=""',
    'url=""',
    'printf "%s\\n" "$@" > "$MOCK_CURL_ARGS"',
    // The gate call carries its action in the body, so the fake answers the
    // action it was actually asked for.
    'request="$(cat)"',
    'printf "%s" "$request" > "$MOCK_CURL_STDIN"',
    'call_action="$(printf "%s" "$request" | jq -r \'.action // ""\' 2>/dev/null || true)"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --output) output="$2"; shift 2 ;;',
    '    --data-binary) shift 2 ;;',
    "    http*) url=\"$1\"; shift ;;",
    "    *) shift ;;",
    "  esac",
    "done",
    'case "$url" in',
    "  */workers/scripts/*)",
    '    printf "%s" "$MOCK_SCRIPT_BODY" > "$output"',
    '    printf "%s" "$MOCK_SCRIPT_STATUS"',
    "    ;;",
    '  "$MOCK_GATE_URL")',
    '    printf "gate\\n" >> "$MOCK_CURL_GATE"',
    '    case "$call_action" in',
    '      status)',
    '        printf "%s" "$MOCK_STATUS_BODY" > "$output"',
    '        printf "%s" "$MOCK_STATUS_STATUS"',
    '        ;;',
    '      plan)',
    '        printf "%s" "$MOCK_PLAN_BODY" > "$output"',
    '        printf "%s" "$MOCK_PLAN_STATUS"',
    '        ;;',
    '      run)',
    '        index="$(cat "$MOCK_RUN_COUNTER" 2>/dev/null || echo 0)"',
    '        count="$(jq -r "length" "$MOCK_RUN_BODIES")"',
    '        next=$(( index + 1 ))',
    '        printf "%s" "$next" > "$MOCK_RUN_COUNTER"',
    '        if [ "$index" -ge "$count" ]; then index=$(( count - 1 )); fi',
    '        jq -c ".[$index]" "$MOCK_RUN_BODIES" > "$output"',
    '        printf "%s" "$MOCK_RUN_STATUS"',
    '        ;;',
    '      *)',
    '        printf "%s" "$MOCK_GATE_BODY" > "$output"',
    '        printf "%s" "$MOCK_GATE_STATUS"',
    '        ;;',
    '    esac',
    "    ;;",
    "  *) exit 92 ;;",
    "esac",
    "",
  ].join("\n");
}

function runGate(options: RunOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "intar-registry-cleanup-gate-test-"));
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner");
  const evidence = join(runnerTemp, "evidence.json");
  const curlArgs = join(root, "curl-args");
  const curlStdin = join(root, "curl-stdin");
  const curlGate = join(root, "curl-gate");
  const runBodies = join(root, "run-bodies.json");
  const runCounter = join(root, "run-counter");
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const bunx = join(bin, "bunx");
  writeFileSync(bunx, fakeBunx());
  const curl = join(bin, "curl");
  writeFileSync(curl, fakeCurl());
  for (const executable of [bunx, curl]) chmodSync(executable, 0o755);

  if (options.holdEvidence === "held") {
    writeFileSync(
      join(runnerTemp, "registry-cleanup-hold.json"),
      JSON.stringify({ gate: "answered", paused: true, idle: true }),
    );
  }
  if (options.holdEvidence === "clear") {
    writeFileSync(
      join(runnerTemp, "registry-cleanup-hold.json"),
      JSON.stringify({ gate: "answered", paused: false, idle: true }),
    );
  }
  if (options.holdEvidence === "nested-held") {
    writeFileSync(
      join(runnerTemp, "registry-cleanup-hold.json"),
      JSON.stringify({
        schema_version: 1,
        action: "hold",
        gate: "ok",
        result: {
          paused: true,
          pauseReason: "registry_cleanup_hold",
          idle: true,
          stalled: false,
        },
      }),
    );
  }
  // The run fake answers one body per delete pass, in order, and repeats the
  // last body for any further pass.
  writeFileSync(
    runBodies,
    JSON.stringify(
      options.runBodies ?? [
        nestedEnvelope("run", runEnvelope("pending", { completed: false })),
      ],
    ),
  );

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: bin + ":" + (process.env.PATH ?? ""),
    RUNNER_TEMP: runnerTemp,
    GITHUB_SHA: sourceSha,
    GITHUB_RUN_ID: "12345",
    REGISTRY_CLEANUP_GATE_URL: gateUrl,
    MOCK_GATE_URL: gateUrl,
    MOCK_SCRIPT_STATUS: String(options.scriptStatus ?? (options.collectorAbsent === true ? 404 : 200)),
    MOCK_SCRIPT_BODY:
      options.scriptBody ??
      (options.collectorAbsent === true
        ? '{"success":false,"errors":[{"code":10007,"message":"workers.api.error.script_not_found"}]}'
        : '{"success":true,"result":{"id":"intar-dev-image-registry-cleanup"}}'),
    MOCK_DEPLOYMENTS_FAIL: String(options.deploymentsFail ?? false),
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "token",
    MOCK_LIVE_MODE:
      options.liveMode === null ? "none" : (options.liveMode ?? "report-only"),
    MOCK_GATE_STATUS: options.status ?? "200",
    MOCK_GATE_BODY: options.body ?? '{"paused":true,"idle":true}',
    MOCK_STATUS_STATUS: options.statusStatus ?? "200",
    MOCK_STATUS_BODY:
      options.statusBody ??
      '{"action":"status","result":{"enforcement":"enforce","sessionRequired":true,"paused":false,"sweepActive":false,"activeSessions":0,"activeWriters":0}}',
    MOCK_PLAN_STATUS: options.planStatus ?? "200",
    MOCK_PLAN_BODY:
      options.planBody ??
      // The shape the core builds: a complete, unfaulted plan that allows
      // deletes by reference.
      '{"action":"plan","status":"report-only","plan":{"candidateObjects":[{"key":"image-chunks/v1/zstd6/aa"}],"objectsScanned":42,"truncated":false,"details":{"faults":[],"deleteAllowedByReferences":true,"candidateTotal":1}}}',
    MOCK_RUN_BODIES: runBodies,
    MOCK_RUN_COUNTER: runCounter,
    MOCK_RUN_STATUS: "200",
    REGISTRY_CLEANUP_RUN_PASSES: String(options.runPasses ?? 64),
    REGISTRY_CLEANUP_RUN_SLEEP_S: "0",
    MOCK_CURL_ARGS: curlArgs,
    MOCK_CURL_STDIN: curlStdin,
    MOCK_CURL_GATE: curlGate,
    ACTIVE_VERSION_ID: activeVersionId,
  };
  if (options.secret === null) {
    env.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET = "";
  } else {
    env.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET = options.secret ?? bypassSecret;
  }

  const result = spawnSync(
    "bash",
    [
      gateScriptPath,
      options.action ?? "hold",
      options.targetMode ?? "report-only",
      evidence,
    ],
    { cwd: repositoryRoot, encoding: "utf8", env },
  );
  const runtimeRoot = join(runnerTemp, "intar-registry-cleanup-gate-12345");
  const evidenceText = existsSync(evidence) ? readFileSync(evidence, "utf8") : "";
  return {
    result,
    evidence: evidenceText.trim()
      ? (JSON.parse(evidenceText) as Record<string, unknown>)
      : null,
    evidenceText,
    request: existsSync(curlStdin) ? readFileSync(curlStdin, "utf8") : null,
    curlArgs: existsSync(curlArgs) ? readFileSync(curlArgs, "utf8") : null,
    // True only when the gate itself was called, not when the state probe read
    // the account API.
    curlCalled: existsSync(curlGate),
    // One line per gate call, so a test can prove a single call is one scan.
    gateCalls: existsSync(curlGate)
      ? readFileSync(curlGate, "utf8").trim().split("\n").filter(Boolean).length
      : 0,
    runtimeRoot,
    runtimeRootMode: existsSync(runtimeRoot) ? statSync(runtimeRoot).mode & 0o777 : null,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("registry cleanup delete campaign", () => {
  it("runs bounded passes until the collector proves completion", () => {
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [
        nestedEnvelope("run", runEnvelope("pending", { completed: false, resumeRequired: true })),
        nestedEnvelope("run", runEnvelope("busy", { completed: false })),
        nestedEnvelope("run", runEnvelope("ok")),
      ],
      planBody: JSON.stringify(nestedEnvelope("plan", zeroCandidateReport())),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        action: "run",
        run: {
          ok: true,
          reason: null,
          passes: 3,
          deleted_objects_total: 15,
          verified_deleted_objects_total: 15,
          post_state_digest: scannedDigest,
          final_report: {
            ok: true,
            candidate_total: 0,
            candidate_objects: 0,
            faults: 0,
            truncated: false,
            delete_allowed_by_references: true,
            post_digest_match: true,
            expected_scanned_digest: scannedDigest,
          },
        },
      });
      const campaign = (run.evidence as { run: { campaign: unknown[] } }).run.campaign;
      expect(campaign).toHaveLength(3);
      expect(campaign[0]).toMatchObject({ pass: 1, status: "pending", completed: false });
      expect(campaign[1]).toMatchObject({ pass: 2, status: "busy", completed: false });
      expect(campaign[2]).toMatchObject({ pass: 3, status: "ok", completed: true });
    } finally {
      run.cleanup();
    }
  });

  it("records claimed and verified bytes per pass and as a campaign total", () => {
    // Reclaimed bytes are the operator's number, and the core reports both the
    // bytes the delete calls claimed and the bytes a re-read proved absent.
    // Two passes with different values prove the per-pass fields and the sum.
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [
        nestedEnvelope(
          "run",
          runEnvelope("pending", {
            completed: false,
            resumeRequired: true,
            deletedObjects: 3,
            deletedBytes: 300,
            verifiedDeletedObjects: 2,
            verifiedDeletedBytes: 200,
          }),
        ),
        nestedEnvelope(
          "run",
          runEnvelope("ok", {
            deletedObjects: 4,
            deletedBytes: 450,
            verifiedDeletedObjects: 4,
            verifiedDeletedBytes: 450,
          }),
        ),
      ],
      planBody: JSON.stringify(nestedEnvelope("plan", zeroCandidateReport())),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      const campaign = (run.evidence as { run: { campaign: Record<string, unknown>[] } })
        .run.campaign;
      expect(campaign).toHaveLength(2);
      expect(campaign).toMatchObject([
        { pass: 1, status: "pending", deleted_objects: 3, deleted_bytes: 300,
          verified_deleted_objects: 2, verified_deleted_bytes: 200 },
        { pass: 2, status: "ok", completed: true, deleted_objects: 4, deleted_bytes: 450,
          verified_deleted_objects: 4, verified_deleted_bytes: 450 },
      ]);
      expect(run.evidence).toMatchObject({
        run: {
          ok: true,
          passes: 2,
          deleted_objects_total: 7,
          deleted_bytes_total: 750,
          verified_deleted_objects_total: 6,
          verified_deleted_bytes_total: 650,
        },
      });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a run while the serving collector is report-only", () => {
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "report-only",
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the cleanup campaign did not finish");
      expect(run.evidence).toMatchObject({
        run: { ok: false, passes: 0, campaign: [], final_report: null },
      });
      expect(String((run.evidence as { run: { reason: string } }).run.reason)).toContain(
        "report-only",
      );
      // Report mode never deletes, so no pass was ever sent.
      expect(run.request).not.toContain('"action":"run"');
    } finally {
      run.cleanup();
    }
  });

  it("fails a campaign that ends on a faulted pass", () => {
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [
        nestedEnvelope(
          "run",
          runEnvelope("core-failed", {
            completed: false,
            error: "registry_sweep_refused",
          }),
        ),
      ],
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({ run: { ok: false, passes: 1, final_report: null } });
      expect(String((run.evidence as { run: { reason: string } }).run.reason)).toContain(
        "core-failed",
      );
    } finally {
      run.cleanup();
    }
  });

  it("bounds a campaign that never completes", () => {
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runPasses: 3,
      runBodies: [nestedEnvelope("run", runEnvelope("pending", { completed: false }))],
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({ run: { ok: false, passes: 3, max_passes: 3 } });
      expect(String((run.evidence as { run: { reason: string } }).run.reason)).toContain(
        "status pending",
      );
    } finally {
      run.cleanup();
    }
  });

  it("refuses a campaign whose final report still lists candidates", () => {
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [nestedEnvelope("run", runEnvelope("ok"))],
      planBody: JSON.stringify(
        nestedEnvelope("plan", {
          ...zeroCandidateReport(),
          plan: {
            ...(zeroCandidateReport().plan as Record<string, unknown>),
            candidateObjects: [{ key: "image-chunks/v1/zstd6/left-behind" }],
            details: {
              faults: [],
              deleteAllowedByReferences: true,
              candidateTotal: 3,
              keysets: {
                scanned: { objects: 7, bytes: 700, digest: scannedDigest },
                retained: { objects: 4, bytes: 400, digest: "4".repeat(64) },
                candidates: { objects: 3, bytes: 300, digest: "5".repeat(64) },
              },
            },
          },
        }),
      ),
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({
        run: { ok: false, passes: 1, final_report: { ok: false, candidate_total: 3, candidate_objects: 1 } },
      });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a campaign whose final report keyset moved", () => {
    const moved = zeroCandidateReport();
    const movedPlan = moved.plan as Record<string, unknown>;
    const movedDetails = movedPlan.details as Record<string, unknown>;
    movedDetails.keysets = {
      scanned: { objects: 7, bytes: 700, digest: "6".repeat(64) },
      retained: { objects: 7, bytes: 700, digest: "6".repeat(64) },
      candidates: { objects: 0, bytes: 0, digest: "3".repeat(64) },
    };
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [nestedEnvelope("run", runEnvelope("ok"))],
      planBody: JSON.stringify(nestedEnvelope("plan", moved)),
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({
        run: { ok: false, final_report: { ok: false, post_digest_match: false } },
      });
    } finally {
      run.cleanup();
    }
  });

  it("records the delete set under the evidence key cap", () => {
    const keys = ["image-chunks/v1/zstd6/aa", "image-chunks/v1/zstd6/bb"];
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [nestedEnvelope("run", runEnvelope("ok", { deletedKeys: keys }))],
      planBody: JSON.stringify(nestedEnvelope("plan", zeroCandidateReport())),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      const campaign = (run.evidence as { run: { campaign: Record<string, unknown>[] } })
        .run.campaign;
      expect(campaign[0]).toMatchObject({
        deleted_keys: keys,
        deleted_keys_retained: 2,
        deleted_keys_truncated: false,
      });
      expect(script).toContain("max_evidence_keys=5000");
    } finally {
      run.cleanup();
    }
  });

  it("proves the delete authority from the serving parent before the first pass", () => {
    // A reopen has no hold evidence: its runner is fresh and the cutover that
    // holds the collector is a different run. The campaign takes the same
    // proof itself, from the parent that serves at that moment.
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [nestedEnvelope("run", runEnvelope("ok"))],
      planBody: JSON.stringify(nestedEnvelope("plan", zeroCandidateReport())),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        run: {
          ok: true,
          preflight: {
            admission: { ok: true, enforcement: "enforce", sessionRequired: true },
            inventory: { ok: true, truncated: false, faults: 0, delete_allowed_by_references: true },
          },
        },
      });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a campaign while D1 admission is report_only", () => {
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      statusBody:
        '{"action":"status","result":{"enforcement":"report_only","sessionRequired":false}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({
        run: { ok: false, passes: 0, preflight: null, final_report: null },
      });
      expect(String((run.evidence as { run: { reason: string } }).run.reason)).toContain(
        "the delete campaign needs the D1 admission state",
      );
      expect(String((run.evidence as { run: { reason: string } }).run.reason)).toContain(
        'D1 upload admission enforcement is "report_only"',
      );
      // No delete pass was ever sent: the proof failed first.
      expect(run.request).toContain('"action":"status"');
      expect(run.request).not.toContain('"action":"run"');
    } finally {
      run.cleanup();
    }
  });

  it("refuses a campaign whose preflight inventory is truncated", () => {
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      planBody:
        '{"action":"plan","status":"report-only","plan":{"candidateObjects":[{"key":"aa"}],"objectsScanned":42,"truncated":true,"details":{"faults":[{"code":"listing_truncated"}],"deleteAllowedByReferences":false}}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(String((run.evidence as { run: { reason: string } }).run.reason)).toContain(
        "the delete campaign needs a completed, fault-free report inventory",
      );
      expect(String((run.evidence as { run: { reason: string } }).run.reason)).toContain(
        "the bucket listing was truncated",
      );
      expect(run.request).not.toContain('"action":"run"');
    } finally {
      run.cleanup();
    }
  });

  it("records the delete set under the evidence key cap", () => {
    const keys = ["image-chunks/v1/zstd6/aa", "image-chunks/v1/zstd6/bb"];
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [
        nestedEnvelope("run", runEnvelope("ok", { deletedKeys: keys })),
      ],
      planBody: JSON.stringify(nestedEnvelope("plan", zeroCandidateReport())),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      const campaign = (run.evidence as { run: { campaign: Record<string, unknown>[] } })
        .run.campaign;
      expect(campaign[0]).toMatchObject({
        deleted_keys: keys,
        deleted_keys_retained: 2,
        deleted_keys_truncated: false,
      });
      expect(script).toContain("max_evidence_keys=5000");
    } finally {
      run.cleanup();
    }
  });

  it("never writes the bypass secret into the run evidence", () => {
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [nestedEnvelope("run", runEnvelope("ok"))],
      planBody: JSON.stringify(nestedEnvelope("plan", zeroCandidateReport())),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidenceText).not.toContain(bypassSecret);
      // The script refuses to publish evidence that carries the credential.
      expect(script).toContain("scrub_secret_files");
      expect(script).toContain("removed a file that reflected the machine credential");
    } finally {
      run.cleanup();
    }
  });

  it("destroys every reflected secret before it fails", () => {
    // The controller must never echo the bypass secret, but if any answer does,
    // no uploaded file may keep it: the pass, plan, status and final report
    // bodies are all scanned, the offending files are removed, and the step
    // fails.
    // Every case names the raw file that carried the secret, and whether the
    // evidence embedded that file. The evidence only disappears when it
    // embedded the reflected bytes: a derived record stays when it is clean.
    const cases: {
      label: string;
      options: RunOptions;
      rawFile: string;
      evidenceRemoved: boolean;
    }[] = [
      {
        label: "hold response",
        rawFile: "response.json",
        evidenceRemoved: true,
        options: {
          liveMode: "delete",
          body:
            '{"action":"pause","result":{"paused":true,"idle":true},"echo":"' +
            bypassSecret +
            '"}',
        },
      },
      {
        label: "status response",
        rawFile: "status-response.json",
        evidenceRemoved: true,
        options: {
          targetMode: "delete",
          liveMode: "report-only",
          statusStatus: "502",
          statusBody: '{"code":"registry_cleanup_gate_failed","echo":"' + bypassSecret + '"}',
        },
      },
      {
        label: "plan response",
        rawFile: "plan-response.json",
        evidenceRemoved: true,
        options: {
          targetMode: "delete",
          liveMode: "report-only",
          planBody: reportTextEchoing(bypassSecret),
        },
      },
      {
        label: "delete pass response",
        rawFile: "pass-response.json",
        // The evidence carries only the derived pass record, so it stays clean.
        evidenceRemoved: false,
        options: {
          action: "run",
          targetMode: "delete",
          liveMode: "delete",
          runBodies: [
            nestedEnvelope("run", {
              ...runEnvelope("ok"),
              echo: bypassSecret,
            }),
          ],
          planBody: JSON.stringify(nestedEnvelope("plan", zeroCandidateReport())),
        },
      },
    ];
    for (const testCase of cases) {
      const run = runGate(testCase.options);
      try {
        expect(run.result.status, testCase.label).not.toBe(0);
        expect(run.result.stderr, testCase.label).toContain(
          "reflected the machine credential",
        );
        // Nothing the lane uploads carries the secret, and the runtime
        // directory keeps no file that did.
        const files: string[] = [];
        for (const entry of readdirSync(run.runtimeRoot)) {
          const path = join(run.runtimeRoot, entry);
          if (existsSync(path)) files.push(path);
        }
        for (const file of files) {
          expect(readFileSync(file, "utf8"), `${testCase.label}: ${file}`).not.toContain(
            bypassSecret,
          );
        }
        expect(
          existsSync(join(run.runtimeRoot, testCase.rawFile)),
          `${testCase.label}: ${testCase.rawFile}`,
        ).toBe(false);
        if (testCase.evidenceRemoved) {
          expect(run.evidence, testCase.label).toBeNull();
        } else {
          expect(run.evidence, testCase.label).not.toBeNull();
        }
      } finally {
        run.cleanup();
      }
    }
  }, 60_000);

  it("keeps its clean evidence and response files on a normal run", () => {
    const run = runGate({
      action: "run",
      targetMode: "delete",
      liveMode: "delete",
      runBodies: [nestedEnvelope("run", runEnvelope("ok"))],
      planBody: JSON.stringify(nestedEnvelope("plan", zeroCandidateReport())),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(existsSync(join(run.runtimeRoot, "pass-response.json"))).toBe(true);
      expect(existsSync(join(run.runtimeRoot, "status-response.json"))).toBe(true);
      expect(run.evidence).not.toBeNull();
      for (const entry of readdirSync(run.runtimeRoot)) {
        const path = join(run.runtimeRoot, entry);
        expect(readFileSync(path, "utf8"), path).not.toContain(bypassSecret);
      }
      expect(run.evidenceText).not.toContain(bypassSecret);
    } finally {
      run.cleanup();
    }
  });
}, SPAWN_TIMEOUT_MS);

describe("registry cleanup deployment gate", () => {
  it("holds a live collector and waits for an idle worker", () => {
    const run = runGate({ liveMode: "delete" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.request).toContain('"action":"pause"');
      expect(run.request).toContain(bypassSecret);
      expect(run.request).toContain('"wait_ms":60000');
      expect(run.curlArgs).toContain("Origin: https://intar.dev");
      expect(run.evidence).toMatchObject({
        operation: "registry-cleanup-gate",
        action: "hold",
        gate: "ok",
        live_mode: "delete",
        http_status: "200",
        child_present: true,
        active_version_id: activeVersionId,
        paused: true,
        idle: true,
        enforced: true,
        admission: {
          ok: true,
          enforcement: "enforce",
          sessionRequired: true,
        },
      });
    } finally {
      run.cleanup();
    }
  });

  it("takes a report inventory before it lets a collector delete", () => {
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      // The plan travels before the pause, and the hold records what it listed.
      expect(run.request).toContain('"action":"pause"');
      expect(run.evidence).toMatchObject({
        target_mode: "delete",
        paused: true,
        idle: true,
        inventory: {
          ok: true,
          status: "report-only",
          plan_present: true,
          candidates: 1,
          scanned_objects: 42,
          truncated: false,
          delete_allowed_by_references: true,
          faults: 0,
          fault_codes: [],
        },
      });
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode when the collector lists no plan", () => {
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      planBody: '{"action":"plan","status":"report-only"}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "the collector listed no plan",
      );
      // Nothing was held: the refusal happens before the pause.
      expect(run.curlCalled).toBe(true);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses a truncated report inventory", () => {
    // A bounded listing proves nothing about the delete set, so the authority
    // to delete stays off even though the envelope is otherwise healthy.
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      planBody:
        '{"action":"plan","status":"report-only","plan":{"candidateObjects":[{"key":"aa"}],"objectsScanned":42,"truncated":true,"details":{"faults":[{"code":"listing_truncated"}],"deleteAllowedByReferences":false}}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the bucket listing was truncated");
      expect(run.result.stderr).toContain("deletes stay off");
      expect(run.request).not.toContain('"action":"pause"');
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses a faulted report inventory", () => {
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      planBody:
        '{"action":"plan","status":"report-only","plan":{"candidateObjects":[],"objectsScanned":42,"truncated":false,"details":{"faults":[{"code":"retention_projection_failed"}],"deleteAllowedByReferences":false}}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "the plan carries 1 fault(s): retention_projection_failed",
      );
    } finally {
      run.cleanup();
    }
  });

  it("refuses an inventory that withheld deletes by reference", () => {
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      planBody:
        '{"action":"plan","status":"report-only","plan":{"candidateObjects":[],"objectsScanned":42,"truncated":false,"details":{"faults":[],"deleteAllowedByReferences":false}}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the plan withheld deletes by reference");
    } finally {
      run.cleanup();
    }
  });

  it("refuses an inventory whose plan carries no completeness flags", () => {
    // A plan without the completeness fields proves nothing, so a missing
    // field refuses instead of being read as consent.
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      planBody:
        '{"action":"plan","status":"report-only","plan":{"candidateObjects":[],"truncated":false}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the plan carries no fault list");
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode when the inventory fails", () => {
    for (const planBody of [
      '{"action":"plan","status":"core-failed","plan":{"candidateObjects":[]}}',
      '{"action":"plan","status":"fenced","plan":{"candidateObjects":[]}}',
    ]) {
      const run = runGate({ targetMode: "delete", liveMode: "report-only", planBody });
      try {
        expect(run.result.status).not.toBe(0);
        expect(run.result.stderr).toContain(
          "the collector status is",
        );
      } finally {
        run.cleanup();
      }
    }
  }, 30_000);

  it("refuses delete mode when the inventory call can not reach the gate", () => {
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      planStatus: "503",
      planBody: '{"error":"maintenance","code":"maintenance"}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "the delete mode needs a completed, fault-free report inventory",
      );
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("skips the gate when no collector version exists", () => {
    const run = runGate({ collectorAbsent: true });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.result.stdout).toContain(
        "no registry cleanup version is deployed; the migration runs without a hold.",
      );
      // No HTTP call: the serving parent may not publish the route yet, and a
      // 503 from its maintenance fence is not an absent gate.
      expect(run.curlCalled).toBe(false);
      expect(run.evidence).toMatchObject({
        action: "hold",
        gate: "skipped",
        live_mode: "absent",
        child_present: false,
        active_version_id: null,
        skipped_reason: "no_collector_version",
        paused: null,
        idle: null,
        enforced: false,
      });
    } finally {
      run.cleanup();
    }
  });

  it("stops when the collector state can not be read at all", () => {
    // An expired token, a forbidden account, or a network failure must never
    // look like a first rollout: that would skip the hold before a migration.
    for (const scriptStatus of ["401", "403", "500", "000"]) {
      const run = runGate({ scriptStatus, scriptBody: "" });
      try {
        expect(run.result.status, scriptStatus).not.toBe(0);
        expect(run.result.stderr).toContain(
          "the registry cleanup state probe failed, so the gate can not decide.",
        );
        // The gate itself is never called: an indeterminate probe must not
        // reach the collector through a guess.
        expect(run.curlCalled).toBe(false);
        expect(run.evidence).toBeNull();
      } finally {
        run.cleanup();
      }
    }
  });

  it("stops when a present worker can not report its deployments", () => {
    const run = runGate({ deploymentsFail: true });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("could not read the deployments");
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("never writes the bypass secret into the uploaded runtime directory", () => {
    const run = runGate({ liveMode: "delete" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      const entries = readdirSync(run.runtimeRoot);
      expect(entries).not.toContain("request.json");
      for (const entry of entries) {
        const contents = readFileSync(join(run.runtimeRoot, entry), "utf8");
        expect(contents).not.toContain(bypassSecret);
      }
    } finally {
      run.cleanup();
    }
  });

  it("fails closed when a delete-capable collector has no gate", () => {
    // The contract has no 404 on this path, and an absent binding answers 503
    // with its own code. Both mean the same thing to the hold.
    const run = runGate({
      liveMode: "delete",
      status: "503",
      body: '{"code":"registry_cleanup_unavailable"}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "A delete-capable collector must be held before a D1 migration.",
      );
      expect(run.evidence).toMatchObject({
        gate: "unavailable",
        gate_code: "registry_cleanup_unavailable",
        enforced: false,
      });
    } finally {
      run.cleanup();
    }
  });

  it("treats an unreadable live mode as delete-capable", () => {
    const run = runGate({ liveMode: null, status: "404", body: "" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({ live_mode: "delete" });
    } finally {
      run.cleanup();
    }
  });

  it("requires the gate for a delete target even while report-only serves", () => {
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      status: "404",
      body: "",
    });
    try {
      expect(run.result.status).not.toBe(0);
    } finally {
      run.cleanup();
    }
  });

  it("records an absent gate for a report-only collector", () => {
    const run = runGate({
      liveMode: "report-only",
      status: "503",
      body: '{"code":"registry_cleanup_unavailable"}',
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        gate: "unavailable",
        enforced: false,
        live_mode: "report-only",
      });
    } finally {
      run.cleanup();
    }
  });

  it("fails when the maintenance fence answers instead of the gate", () => {
    const run = runGate({
      liveMode: "delete",
      status: "503",
      body: '{"error":"control-plane maintenance is in progress","code":"maintenance"}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the gate is fenced");
      expect(run.result.stderr).toContain(
        "Hold the collector before maintenance closes",
      );
    } finally {
      run.cleanup();
    }
  });

  it("refuses an unexpected gate status", () => {
    const run = runGate({ liveMode: "delete", status: "500", body: "" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "the registry cleanup deployment gate answered HTTP 500",
      );
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode while D1 admission enforcement is report_only", () => {
    // The learner-run CLI rollout variable is unrelated to this decision; the
    // only authority is the shared D1 admission row the collector reports.
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      statusBody:
        '{"action":"status","result":{"enforcement":"report_only","sessionRequired":false}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("delete mode needs the D1 admission state");
      expect(run.result.stderr).toContain(
        'D1 upload admission enforcement is "report_only"',
      );
      // The status read happened; the hold and the inventory did not.
      expect(run.request).toContain('"action":"status"');
      expect(run.request).not.toContain('"action":"pause"');
      expect(run.request).not.toContain('"action":"plan"');
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode when the collector does not require a session", () => {
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      statusBody:
        '{"action":"status","result":{"enforcement":"enforce","sessionRequired":false}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("sessionRequired=false");
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode when the collector status is unreadable", () => {
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      statusStatus: "502",
      statusBody: '{"code":"registry_cleanup_gate_failed"}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the collector status is unreadable");
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode when the status carries no admission fields", () => {
    // A collector build that predates the admission report proves nothing, so
    // the delete gate refuses instead of reading a missing field as consent.
    const run = runGate({
      targetMode: "delete",
      liveMode: "report-only",
      statusBody: '{"action":"status","result":{"paused":false}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("carries no enforcement field");
    } finally {
      run.cleanup();
    }
  });

  it("refuses a parent with no usable gate secret", () => {
    const run = runGate({
      liveMode: "delete",
      status: "503",
      body: '{"code":"registry_cleanup_gate_unconfigured"}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("no usable bypass secret");
    } finally {
      run.cleanup();
    }
  });

  it("refuses a gate that denies the deployment secret", () => {
    const run = runGate({
      liveMode: "delete",
      status: "403",
      body: '{"error":"registry cleanup gate denied"}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("refused the request (HTTP 403)");
      expect(run.result.stderr).toContain("CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET");
    } finally {
      run.cleanup();
    }
  });

  it("refuses a hold that can not prove an idle collector", () => {
    const run = runGate({
      liveMode: "delete",
      body: '{"paused":true,"idle":false}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({ paused: true, idle: false });
    } finally {
      run.cleanup();
    }
  });

  it("keeps an unreadable collector answer unreadable", () => {
    const run = runGate({ liveMode: "delete", body: '{"ok":true}' });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({ paused: null, idle: null });
    } finally {
      run.cleanup();
    }
  });

  it("reads a nested collector result", () => {
    const run = runGate({
      liveMode: "delete",
      body: '{"action":"pause","result":{"paused":true,"idle":true}}',
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
    } finally {
      run.cleanup();
    }
  });

  it("reads a nested false as false, not as a missing flag", () => {
    // The controller answers {action, result:{paused:false, idle:false}}. jq
    // `//` treats false as absent, so a naive `.result.paused // .paused` reads
    // this as null and fails a release that actually succeeded.
    const run = runGate({
      action: "release",
      liveMode: "delete",
      body: '{"action":"resume","result":{"paused":false,"pauseReason":null,"idle":false,"stalled":false}}',
      holdEvidence: "nested-held",
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({ action: "release", paused: false });
      // idle is a boolean here too: false must not be recorded as null.
      expect((run.evidence as Record<string, unknown>).idle).toBe(false);
      // The recorded hold came from the nested controller shape as well.
      expect(run.evidence).toMatchObject({ hold_leave: "left" });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a hold whose nested idle is false", () => {
    const run = runGate({
      liveMode: "delete",
      body: '{"action":"pause","result":{"paused":true,"idle":false,"stalled":false}}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({ paused: true, idle: false });
    } finally {
      run.cleanup();
    }
  });

  it("releases the collector with a resume", () => {
    const run = runGate({
      action: "release",
      liveMode: "delete",
      body: '{"paused":false,"idle":true}',
      holdEvidence: "held",
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.request).toContain('"action":"resume"');
      expect(run.evidence).toMatchObject({
        action: "release",
        paused: false,
        enforced: true,
        hold_leave: "left",
      });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a release that leaves the collector held", () => {
    const run = runGate({
      action: "release",
      liveMode: "delete",
      body: '{"paused":true,"idle":false}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toMatchObject({ paused: true });
    } finally {
      run.cleanup();
    }
  });

  it("refuses an unreachable release that leaves a recorded hold", () => {
    const run = runGate({
      action: "release",
      liveMode: "report-only",
      status: "404",
      body: "",
      holdEvidence: "held",
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "this rollout holds the registry cleanup worker",
      );
      expect(run.evidence).toMatchObject({ gate: "unavailable", hold_leave: "left" });
    } finally {
      run.cleanup();
    }
  });

  it("tolerates an absent gate on a release that placed no hold", () => {
    const run = runGate({ action: "release", status: "404", body: "" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        gate: "unavailable",
        enforced: false,
        hold_leave: "none",
      });
    } finally {
      run.cleanup();
    }
  });

  it("keeps a release that finds a cleared hold clean", () => {
    const run = runGate({
      action: "release",
      status: "404",
      body: "",
      holdEvidence: "clear",
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({ hold_leave: "none" });
    } finally {
      run.cleanup();
    }
  });

  it("skips a release when no collector version exists", () => {
    const run = runGate({ action: "release", collectorAbsent: true });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.curlCalled).toBe(false);
      expect(run.evidence).toMatchObject({ gate: "skipped" });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a missing secret when a collector answers", () => {
    const run = runGate({ liveMode: "delete", secret: null });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET");
      expect(run.curlCalled).toBe(false);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses an unknown action or target mode", () => {
    const action = runGate({ action: "stop" });
    const target = runGate({ targetMode: "apply" });
    try {
      expect(action.result.status).not.toBe(0);
      expect(target.result.status).not.toBe(0);
      expect(action.evidence).toBeNull();
    } finally {
      action.cleanup();
      target.cleanup();
    }
  });

  it("travels through the maintenance surface of the parent worker", () => {
    expect(script).toContain(gateUrl);
    expect(script).toContain("CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET");
    expect(script).toContain("max-time 120");
    expect(script).toContain("--data-binary @-");
    expect(script).not.toContain("@${request}");
    expect(script).not.toContain("hold_ms");
    expect(script).toContain("chmod 700");
    expect(script).not.toContain("/registry/v1/cleanup");
  });
}, SPAWN_TIMEOUT_MS);

describe("registry cleanup report preview", () => {
  it("proves the report child binding with one plan call", () => {
    // The report-only rollout verification: the parent serves with maintenance
    // off, the collector read that flag from the control plane version that
    // serves traffic, and its plan is complete and fault free.
    const run = runGate({
      action: "plan",
      targetMode: "report-only",
      liveMode: "report-only",
      planBody: reportEnvelope(),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        action: "plan",
        preview: {
          maintenance: "off",
          maintenance_source: "control-plane",
          status: "report-only",
          maintenance_off: true,
          maintenance_source_control_plane: true,
          problem: null,
          ok: true,
          inventory: { ok: true, truncated: false, faults: 0, delete_allowed_by_references: true },
        },
      });
      // One plan call, one bucket scan: the envelope in hand is evaluated, not
      // requested again.
      expect(run.gateCalls).toBe(1);
      expect(run.result.stdout).toContain("the report preview is clean");
    } finally {
      run.cleanup();
    }
  });

  it("refuses a closed control plane", () => {
    // A collector that reads a closed parent is not the report-only proof, even
    // when the gate itself answered.
    const run = runGate({
      action: "plan",
      targetMode: "report-only",
      liveMode: "report-only",
      planBody: reportEnvelope({ maintenance: "on" }),
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        // The stderr line is JSON, so the quoted value arrives escaped.
        "the serving control plane reports maintenance",
      );
      expect(run.evidence).toMatchObject({
        preview: { maintenance_off: false, ok: false },
      });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a collector that could not read the parent", () => {
    // A missing CONTROL_PLANE binding reports the source as unavailable, and
    // the collector fences itself: the gate is reachable but the child is not
    // reading the live flag, which is exactly what this step exists to catch.
    const run = runGate({
      action: "plan",
      targetMode: "report-only",
      liveMode: "report-only",
      planBody: reportEnvelope({
        maintenance: "on",
        maintenanceSource: "unavailable",
        status: "fenced",
        plan: null,
      }),
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the serving control plane reports maintenance");
      expect(run.evidence).toMatchObject({
        preview: { maintenance_source: "unavailable", ok: false },
      });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a faulted, truncated, or absent plan", () => {
    const faulted = zeroCandidateReport();
    (faulted.plan as Record<string, unknown>).details = {
      faults: [{ code: "retention_projection_failed" }],
      deleteAllowedByReferences: false,
      candidateTotal: 0,
      keysets: {},
    };
    const truncated = zeroCandidateReport();
    (truncated.plan as Record<string, unknown>).truncated = true;
    for (const testCase of [
      { label: "faulted", plan: faulted.plan, expected: "the plan carries 1 fault(s)" },
      { label: "truncated", plan: truncated.plan, expected: "the bucket listing was truncated" },
      { label: "absent", plan: null, expected: "the collector listed no plan" },
      {
        label: "fenced",
        plan: null,
        status: "fenced",
        // The stderr line is JSON, so the quoted status arrives escaped.
        expected: "the collector status is",
      },
    ]) {
      const run = runGate({
        action: "plan",
        targetMode: "report-only",
        liveMode: "report-only",
        planBody: reportEnvelope({
          plan: testCase.plan,
          ...(testCase.status === undefined ? {} : { status: testCase.status }),
        }),
      });
      try {
        expect(run.result.status, testCase.label).not.toBe(0);
        expect(run.result.stderr, testCase.label).toContain(testCase.expected);
        expect(run.evidence, testCase.label).toMatchObject({ preview: { ok: false } });
      } finally {
        run.cleanup();
      }
    }
  }, 60_000);

  it("refuses a preview when no collector version answers", () => {
    const run = runGate({
      action: "plan",
      targetMode: "report-only",
      collectorAbsent: true,
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "no registry cleanup version is deployed; there is no report to read.",
      );
      expect(run.evidence).toMatchObject({ preview: null, child_present: false });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a preview when the parent can not reach the collector", () => {
    const run = runGate({
      action: "plan",
      targetMode: "report-only",
      liveMode: "report-only",
      planStatus: "503",
      planBody: '{"code":"registry_cleanup_unavailable"}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "the deployment gate is unavailable, so the collector can not be reached through the parent.",
      );
    } finally {
      run.cleanup();
    }
  });

  it("refuses a preview behind the maintenance fence and still writes evidence", () => {
    const run = runGate({
      action: "plan",
      targetMode: "report-only",
      liveMode: "report-only",
      planStatus: "503",
      planBody: '{"error":"control-plane maintenance is in progress","code":"maintenance"}',
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("the gate is fenced");
      // A read reports through the evidence, so the fenced body is kept.
      expect(run.evidence).toMatchObject({
        gate: "fence",
        // A fenced body carries no envelope, so the maintenance flag stays
        // unreadable rather than guessed.
        preview: {
          ok: false,
          maintenance: null,
          problem: "the serving control plane reports maintenance \"unreadable\"",
        },
      });
    } finally {
      run.cleanup();
    }
  });
}, SPAWN_TIMEOUT_MS);
