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
const workerName = "intar-dev-image-registry-cleanup";
const settingsPath = `/workers/scripts/${workerName}/settings`;
const liveTag = "cleanup-0a1b2c3d4e5f-report-only";
// The settings endpoint answers this document for a present Worker. The API
// returns no secret value: a secret binding carries its name and type only.
const settingsBody = JSON.stringify({
  result: {
    bindings: [
      { type: "plain_text", name: "REGISTRY_CLEANUP_MODE", text: "report-only" },
      { type: "secret_text", name: "CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET" },
      { type: "d1", name: "DB", id: "c53ff120-c555-4702-b3a1-eaab44fd76f6" },
      { type: "r2_bucket", name: "VM_IMAGE_REGISTRY_BUCKET" },
    ],
    compatibility_date: "2026-08-20",
    compatibility_flags: ["global_fetch_strictly_public", "nodejs_compat"],
    placement: { mode: "smart" },
    observability: { enabled: true },
  },
  success: true,
  errors: [],
  messages: [],
});
// The 404 body of the account API for a name that has no Worker. The shape is
// the one recorded by the live rollout evidence of operation 34832131840.
const workerNotFoundBody = JSON.stringify({
  result: null,
  success: false,
  errors: [{ code: 10007, message: "This Worker does not exist on your account." }],
  messages: [],
});
// The bare script endpoint answers this multipart JavaScript source for a
// present Worker. A probe that reads that endpoint can not parse the answer, so
// the success tests below fail if the probe reads it instead of the settings path.
const sourceBody = [
  "--e6f1a1b0c2d3",
  'Content-Disposition: form-data; name="metadata"',
  "",
  '{"main_module":"index.js"}',
  "--e6f1a1b0c2d3",
  'Content-Disposition: form-data; name="index.js"',
  "Content-Type: application/javascript+module",
  "",
  'export default { async fetch() { return new Response("ok"); } };',
  "--e6f1a1b0c2d3--",
].join("\r\n");

interface RunOptions {
  workflowStep?: boolean;
  scriptStatus?: string;
  scriptBody?: string;
  mode?: string;
  tag?: string;
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
    '    http*) url="$1"; shift ;;',
    "    *) shift ;;",
    "  esac",
    "done",
    'printf "%s\\n" "$url" >> "$MOCK_URL_LOG"',
    'case "$url" in',
    "  */workers/scripts/*/settings)",
    '    printf "%s" "$MOCK_SCRIPT_BODY" > "$output"',
    '    printf "%s" "$MOCK_SCRIPT_STATUS"',
    "    ;;",
    "  */workers/scripts/*)",
    '    printf "%s" "$MOCK_SOURCE_BODY" > "$output"',
    "    printf '200'",
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
    '    jq -cn --arg id "$3" --arg mode "$MOCK_MODE" --arg tag "$MOCK_TAG" \'{id:$id,annotations:{"workers/tag":$tag},resources:{bindings:(if $mode == "none" then [] else [{type:"plain_text",name:"REGISTRY_CLEANUP_MODE",text:$mode}] end)}}\'',
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
  const urlLog = join(root, "urls.txt");
  const scriptStatus = options.scriptStatus ?? "200";

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: bin + ":" + (process.env.PATH ?? ""),
    MOCK_URL_LOG: urlLog,
    MOCK_SCRIPT_STATUS: scriptStatus,
    MOCK_SCRIPT_BODY:
      options.scriptBody ?? (scriptStatus === "404" ? workerNotFoundBody : settingsBody),
    MOCK_SOURCE_BODY: sourceBody,
    MOCK_MODE: options.mode ?? "report-only",
    MOCK_TAG: options.tag ?? liveTag,
    MOCK_DEPLOYMENTS_FAIL: String(options.deploymentsFail ?? false),
    MOCK_DEPLOYMENTS_BODY:
      options.deploymentsBody ??
      JSON.stringify({ versions: [{ version_id: activeVersionId, percentage: 100 }] }),
    RUNNER_TEMP: root,
    GITHUB_OUTPUT: join(root, "output"),
    GITHUB_ENV: join(root, "environment"),
    GITHUB_STEP_SUMMARY: join(root, "summary"),
    REGISTRY_CLEANUP_INTENT: "preserve",
  };
  if (options.accountId === null) {
    delete env.CLOUDFLARE_ACCOUNT_ID;
  } else {
    env.CLOUDFLARE_ACCOUNT_ID = options.accountId ?? "account";
  }
  if (options.apiToken === null) {
    delete env.CLOUDFLARE_API_TOKEN;
  } else {
    env.CLOUDFLARE_API_TOKEN = options.apiToken ?? "token";
  }

  let args = [probePath, evidence, deployments, version];
  if (options.workflowStep) {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/website-deploy.yml"), "utf8",
    );
    const step = workflow.split("      - name: Inspect the image registry cleanup deployment\n")[1]
      ?.split("\n      - name:")[0];
    const body = step?.split("        run: |\n")[1];
    if (!body) throw new Error("cleanup inspection step is missing");
    args = ["-c", body.replace(/^          /gm, "")];
  }
  const result = spawnSync("bash", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
  // A probe that fails late leaves the shell redirection behind as an empty
  // file, so an empty evidence file is read as no evidence at all; the
  // assertions then report the state problem instead of a parse error.
  const evidenceText = existsSync(evidence) ? readFileSync(evidence, "utf8").trim() : "";
  const modePath = join(root, "registry-cleanup-mode.json");
  return {
    result,
    urls: existsSync(urlLog) ? readFileSync(urlLog, "utf8").trim().split("\n") : [],
    evidence: evidenceText === "" ? null : (JSON.parse(evidenceText) as Record<string, unknown>),
    mode: existsSync(modePath) ? JSON.parse(readFileSync(modePath, "utf8")) : null,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// The probe must read the settings endpoint. The bare script path answers the
// multipart source above with HTTP 200, so a test that silently read that path
// would report a present collector instead of the state it should report.
function expectSettingsProbe(urls: string[]) {
  expect(urls).toHaveLength(1);
  expect(urls[0].endsWith(settingsPath)).toBe(true);
}

describe("registry cleanup live state probe", () => {
  it.each(["delete", "report-only"])("the deployed workflow preserves a proven %s mode", (mode) => {
    const run = runProbe({ workflowStep: true, mode });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.mode).toMatchObject({
        resolved_mode: mode,
        live_mode_proven: true,
        probe: { active_version_id: activeVersionId },
      });
    } finally {
      run.cleanup();
    }
  });

  it("the deployed workflow defaults an absent collector to report mode", () => {
    const run = runProbe({ workflowStep: true, scriptStatus: "404" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.mode).toMatchObject({ resolved_mode: "report-only", child_present: false });
    } finally {
      run.cleanup();
    }
  });

  it("the deployed workflow stops when a present collector has no proven mode", () => {
    const run = runProbe({ workflowStep: true, mode: "none" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("Cannot preserve the cleanup mode");
      expect(run.mode).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("reads the settings endpoint and reports a deployed collector", () => {
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
        tag: liveTag,
        script_response: { success: true },
      });
      expectSettingsProbe(run.urls);
    } finally {
      run.cleanup();
    }
  });

  it("reads the settings endpoint for a missing worker and reports it absent", () => {
    const run = runProbe({ scriptStatus: "404" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        script_present: false,
        script_status: "404",
        active_version_id: null,
        mode: "absent",
        mode_proven: false,
        tag: null,
        script_response: { success: false },
      });
      expectSettingsProbe(run.urls);
    } finally {
      run.cleanup();
    }
  });

  it("stops when a present answer is not settings JSON", () => {
    // The multipart source is the answer of the bare script endpoint; the HTML
    // page is the answer of a proxy that never reached the account API.
    for (const scriptBody of [sourceBody, "<html><body>404 Not Found</body></html>"]) {
      const run = runProbe({ scriptBody });
      try {
        expect(run.result.status).not.toBe(0);
        expect(run.result.stderr).toContain("not a Cloudflare settings answer");
        expect(run.evidence).toBeNull();
      } finally {
        run.cleanup();
      }
    }
  });

  it("stops on a 404 that is not a worker-not-found answer", () => {
    for (const scriptBody of [
      // A routing failure answers 404 without the worker-not-found code.
      JSON.stringify({ result: null, success: false, errors: [{ code: 7003, message: "Could not route" }] }),
      JSON.stringify({ result: null, success: false, errors: [] }),
      "<html><body>404 Not Found</body></html>",
    ]) {
      const run = runProbe({ scriptStatus: "404", scriptBody });
      try {
        expect(run.result.status).not.toBe(0);
        expect(run.result.stderr).toContain("not a Cloudflare worker-not-found answer");
        expect(run.evidence).toBeNull();
      } finally {
        run.cleanup();
      }
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
