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
const gatePath = join(repositoryRoot, "tools/deploy/registry-cleanup-child-gate.sh");
const script = readFileSync(gatePath, "utf8");
// Every test here spawns the gate, which itself spawns wrangler and curl, so
// the default timeout is too tight when the whole suite runs in parallel.
const SPAWN_TIMEOUT_MS = 30_000;
const sourceSha12 = "a".repeat(12);
const activeVersionId = "22222222-3333-4444-8555-666666666666";
const releaseTag = "cleanup-" + sourceSha12 + "-delete";

interface RunOptions {
  operation?: string;
  mode?: string;
  sha12?: string;
  liveMode?: string;
  liveTag?: string;
  collectorAbsent?: boolean;
  probeStatus?: string;
}

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
    '    jq -cn --arg id "$3" --arg mode "$MOCK_LIVE_MODE" --arg tag "$MOCK_LIVE_TAG" \'{id:$id,annotations:{"workers/tag":$tag},resources:{bindings:[{type:"plain_text",name:"REGISTRY_CLEANUP_MODE",text:$mode}]}}\'',
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
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --output) output="$2"; shift 2 ;;',
    "    http*) url=\"$1\"; shift ;;",
    "    *) shift ;;",
    "  esac",
    "done",
    'case "$url" in',
    "  */workers/scripts/*)",
    '    printf "%s" "$MOCK_SCRIPT_BODY" > "$output"',
    '    printf "%s" "$MOCK_SCRIPT_STATUS"',
    "    ;;",
    "  *) exit 92 ;;",
    "esac",
    "",
  ].join("\n");
}

function runGate(options: RunOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "intar-registry-cleanup-child-test-"));
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner");
  const evidence = join(root, "child.json");
  const summary = join(root, "summary.md");
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const bunx = join(bin, "bunx");
  const curl = join(bin, "curl");
  writeFileSync(bunx, fakeBunx());
  writeFileSync(curl, fakeCurl());
  for (const executable of [bunx, curl]) chmodSync(executable, 0o755);
  const probeStatus = options.probeStatus ?? (options.collectorAbsent === true ? "404" : "200");

  const result = spawnSync(
    "bash",
    [
      gatePath,
      options.operation ?? "reopen",
      options.mode ?? "delete",
      options.sha12 ?? sourceSha12,
      evidence,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...(process.env as Record<string, string>),
        PATH: bin + ":" + (process.env.PATH ?? ""),
        RUNNER_TEMP: runnerTemp,
        GITHUB_RUN_ID: "12345",
        GITHUB_STEP_SUMMARY: summary,
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
        MOCK_DEPLOYMENTS_FAIL: "false",
        MOCK_SCRIPT_STATUS: probeStatus,
        MOCK_SCRIPT_BODY:
          probeStatus === "404"
            ? '{"success":false,"errors":[{"code":10007,"message":"workers.api.error.script_not_found"}]}'
            : '{"success":true,"result":{"id":"intar-dev-image-registry-cleanup"}}',
        MOCK_LIVE_MODE: options.liveMode ?? "delete",
        MOCK_LIVE_TAG: options.liveTag ?? releaseTag,
        ACTIVE_VERSION_ID: activeVersionId,
      },
    },
  );
  const evidenceText = existsSync(evidence) ? readFileSync(evidence, "utf8") : "";
  return {
    result,
    evidenceText,
    evidence: evidenceText.trim()
      ? (JSON.parse(evidenceText) as Record<string, unknown>)
      : null,
    summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("registry cleanup child gate", () => {
  it("keeps the collector a reopen already runs at this revision and mode", () => {
    const run = runGate({ operation: "reopen", mode: "delete", liveMode: "delete" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.result.stdout).toContain("skip=true");
      expect(run.result.stdout).toContain("reason=same_source_and_mode");
      expect(run.evidence).toMatchObject({
        operation: "registry-cleanup-child-gate",
        request: { operation: "reopen", mode: "delete" },
        skip: true,
        reason: "same_source_and_mode",
        live_mode: "delete",
        live_mode_proven: true,
        live_tag: releaseTag,
        expected_tag: releaseTag,
        active_version_id: activeVersionId,
      });
      expect(run.summary).toContain("same_source_and_mode");
    } finally {
      run.cleanup();
    }
  });

  it("keeps a report-only collector a reopen already runs", () => {
    const run = runGate({
      operation: "reopen",
      mode: "report-only",
      liveMode: "report-only",
      liveTag: "cleanup-" + sourceSha12 + "-report-only",
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({ skip: true, reason: "same_source_and_mode" });
    } finally {
      run.cleanup();
    }
  });

  it("refuses a reopen that would replace a delete-capable collector", () => {
    // The deadlock this gate exists for: a fresh runner holds no inventory,
    // and a fenced control plane can not produce one. The refusal names the
    // operation that can.
    const run = runGate({
      operation: "reopen",
      mode: "delete",
      liveMode: "delete",
      liveTag: "cleanup-" + "b".repeat(12) + "-delete",
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "a reopen can not replace the delete-capable registry cleanup worker (source_differs)",
      );
      expect(run.result.stderr).toContain("Run the Website cutover operation");
      expect(run.evidence).toMatchObject({ skip: false, reason: "source_differs" });
      expect(run.result.stdout).not.toContain("skip=true");
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode on a reopen while report-only serves", () => {
    const run = runGate({
      operation: "reopen",
      mode: "delete",
      liveMode: "report-only",
      liveTag: "cleanup-" + sourceSha12 + "-report-only",
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("(live_mode_differs)");
      expect(run.result.stderr).toContain("registry_cleanup_mode delete");
      expect(run.evidence).toMatchObject({
        skip: false,
        reason: "live_mode_differs",
        live_mode: "report-only",
      });
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode on a reopen when no collector answers", () => {
    const run = runGate({ operation: "reopen", mode: "delete", collectorAbsent: true });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("(no_collector_version)");
      expect(run.evidence).toMatchObject({ skip: false, reason: "no_collector_version" });
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode on a reopen when the live mode is unreadable", () => {
    const run = runGate({ operation: "reopen", mode: "delete", liveMode: "staging" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("(live_mode_unproven)");
      expect(run.evidence).toMatchObject({ skip: false, reason: "live_mode_unproven" });
    } finally {
      run.cleanup();
    }
  });

  it("deploys the collector on a reopen in report-only mode", () => {
    // No delete authority is at stake, so the reopen deploys as usual.
    const run = runGate({
      operation: "reopen",
      mode: "report-only",
      liveMode: "report-only",
      liveTag: "cleanup-" + "c".repeat(12) + "-report-only",
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.result.stdout).toContain("skip=false");
      expect(run.result.stdout).toContain("reason=source_differs");
    } finally {
      run.cleanup();
    }
  });

  it("deploys the collector on a first rollout", () => {
    const run = runGate({ operation: "reopen", mode: "report-only", collectorAbsent: true });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        skip: false,
        reason: "no_collector_version",
        script_present: false,
        live_tag: null,
      });
    } finally {
      run.cleanup();
    }
  });

  it("does not refuse a cutover that replaces a delete-capable collector", () => {
    // The cutover holds and inventories before it closes the plane, so the
    // child deploy has the evidence it needs and the gate never refuses.
    const run = runGate({
      operation: "cutover",
      mode: "delete",
      liveMode: "delete",
      liveTag: "cleanup-" + "b".repeat(12) + "-delete",
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.result.stdout).toContain("skip=false");
      expect(run.evidence).toMatchObject({ skip: false, reason: "source_differs" });
    } finally {
      run.cleanup();
    }
  });

  it("stops when the state probe can not be read at all", () => {
    const run = runGate({ operation: "reopen", mode: "delete", probeStatus: "403" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("could not read the worker");
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses an unknown operation or mode", () => {
    const operation = runGate({ operation: "deploy" });
    const mode = runGate({ mode: "preserve" });
    try {
      expect(operation.result.status).not.toBe(0);
      expect(operation.result.stderr).toContain("operation must be cutover or reopen");
      expect(mode.result.status).not.toBe(0);
      expect(mode.result.stderr).toContain("mode must be report-only or delete");
      expect(operation.evidence).toBeNull();
    } finally {
      operation.cleanup();
      mode.cleanup();
    }
  });

  it("reads the deployed source revision from the Cloudflare version", () => {
    // The deploy tag carries the revision and the mode of the deployed build.
    const probe = readFileSync(
      join(repositoryRoot, "tools/deploy/registry-cleanup-state.sh"),
      "utf8",
    );
    expect(probe).toContain('annotations[\"workers/tag\"]');
    expect(script).toContain("expected_tag=\"cleanup-${source_tag_suffix}-${mode}\"");
    expect(script).toContain("registry-cleanup-state.sh");
    expect(script).not.toContain("LEARNER_RUN_CLI_V1_ENFORCEMENT");
  });
}, SPAWN_TIMEOUT_MS);
