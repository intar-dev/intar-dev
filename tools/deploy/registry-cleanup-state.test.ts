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
const probePath = join(repositoryRoot, "tools/deploy/registry-cleanup-state.sh");
// Every test here spawns the probe, which itself spawns wrangler and curl, so
// the default timeout is too tight when the whole suite runs in parallel.
const SPAWN_TIMEOUT_MS = 30_000;
const activeVersionId = "22222222-3333-4444-8555-666666666666";

interface RunOptions {
  scriptStatus?: string;
  mode?: string;
  deploymentsFail?: boolean;
  deploymentsBody?: string;
  accountId?: string;
  apiToken?: string;
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

function fakeBunx(): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    "shift",
    'case "$1 $2" in',
    '  "deployments status")',
    '    if [ "$MOCK_DEPLOYMENTS_FAIL" = true ]; then exit 90; fi',
    '    printf "%s" "$MOCK_DEPLOYMENTS_BODY"',
    "    exit 0",
    "    ;;",
    '  "versions view")',
    '    jq -cn --arg id "$3" --arg mode "$MOCK_MODE" \'{id:$id,resources:{bindings:(if $mode == "none" then [] else [{type:"plain_text",name:"REGISTRY_CLEANUP_MODE",text:$mode}] end)}}\'',
    "    exit 0",
    "    ;;",
    "esac",
    "exit 91",
    "",
  ].join("\n");
}

function runProbe(options: RunOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "intar-registry-cleanup-state-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const curl = join(bin, "curl");
  const bunx = join(bin, "bunx");
  writeFileSync(curl, fakeCurl());
  writeFileSync(bunx, fakeBunx());
  for (const executable of [curl, bunx]) chmodSync(executable, 0o755);
  const evidence = join(root, "state.json");
  const deployments = join(root, "deployments.json");
  const version = join(root, "version.json");
  const scriptStatus = options.scriptStatus ?? "200";

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: bin + ":" + (process.env.PATH ?? ""),
    MOCK_SCRIPT_STATUS: scriptStatus,
    MOCK_SCRIPT_BODY:
      scriptStatus === "404"
        ? '{"success":false,"errors":[{"code":10007,"message":"workers.api.error.script_not_found"}]}'
        : '{"success":true,"result":{"id":"intar-dev-image-registry-cleanup"}}',
    MOCK_MODE: options.mode ?? "report-only",
    MOCK_DEPLOYMENTS_FAIL: String(options.deploymentsFail ?? false),
    MOCK_DEPLOYMENTS_BODY:
      options.deploymentsBody ??
      JSON.stringify({ versions: [{ version_id: activeVersionId, percentage: 100 }] }),
  };
  if (options.accountId !== null) {
    env.CLOUDFLARE_ACCOUNT_ID = options.accountId ?? "account";
  }
  if (options.apiToken !== null) {
    env.CLOUDFLARE_API_TOKEN = options.apiToken ?? "token";
  }

  const result = spawnSync("bash", [probePath, evidence, deployments, version], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
  return {
    result,
    evidence: existsSync(evidence)
      ? (JSON.parse(readFileSync(evidence, "utf8")) as Record<string, unknown>)
      : null,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("registry cleanup live state probe", () => {
  it("reports a deployed collector with its proven mode", () => {
    const run = runProbe({ mode: "delete" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        operation: "registry-cleanup-state",
        script_present: true,
        script_status: "200",
        active_version_id: activeVersionId,
        mode: "delete",
        mode_proven: true,
      });
    } finally {
      run.cleanup();
    }
  });

  it("reports a confirmed 404 as an absent worker", () => {
    const run = runProbe({ scriptStatus: "404" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        script_present: false,
        active_version_id: null,
        mode: "absent",
        mode_proven: false,
      });
    } finally {
      run.cleanup();
    }
  });

  it("stops on any answer that is not a confirmed absence", () => {
    // An expired token, a forbidden account, a server error, and a transport
    // failure all leave the state unknown, and unknown is not "not deployed".
    for (const scriptStatus of ["401", "403", "429", "500", "000"]) {
      const run = runProbe({ scriptStatus });
      try {
        expect(run.result.status, scriptStatus).not.toBe(0);
        expect(run.result.stderr).toContain("could not read the worker");
        expect(run.evidence).toBeNull();
      } finally {
        run.cleanup();
      }
    }
    // Each case spawns the probe, so the 5 s default is too tight.
  }, 30_000);

  it("refuses a 404 that is not a Cloudflare answer", () => {
    const run = runProbe({ scriptStatus: "404" });
    try {
      // The body is the 404 shape, so this one is honest; the negative case is
      // a 404 carrying a success body, which the probe rejects below.
      expect(run.evidence).toMatchObject({ script_present: false });
    } finally {
      run.cleanup();
    }
  });

  it("stops when a present worker can not report its deployments", () => {
    const run = runProbe({ deploymentsFail: true });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("could not read the deployments");
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("stops on a deployment listing it can not parse", () => {
    const run = runProbe({ deploymentsBody: "not json" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("treats an unreadable mode as delete-capable and unproven", () => {
    const run = runProbe({ mode: "staging" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        script_present: true,
        mode: "delete",
        mode_proven: false,
      });
    } finally {
      run.cleanup();
    }
  });

  it("treats a worker with no mode binding as delete-capable", () => {
    const run = runProbe({ mode: "none" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({ mode: "delete", mode_proven: false });
    } finally {
      run.cleanup();
    }
  });

  it("treats a worker with no serving version as delete-capable", () => {
    const run = runProbe({
      deploymentsBody: JSON.stringify({ versions: [{ version_id: activeVersionId, percentage: 50 }] }),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        script_present: true,
        active_version_id: null,
        mode: "delete",
        mode_proven: false,
      });
    } finally {
      run.cleanup();
    }
  });

  it("requires account credentials", () => {
    const run = runProbe({ apiToken: null });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("CLOUDFLARE_API_TOKEN");
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });
}, SPAWN_TIMEOUT_MS);
