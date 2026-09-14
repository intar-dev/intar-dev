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
const deployScriptPath = join(
  repositoryRoot,
  "tools/deploy/deploy-registry-cleanup.sh",
);
const script = readFileSync(deployScriptPath, "utf8");
const sourceSha = "a".repeat(40);
const databaseId = "33333333-4444-4555-8666-777777777777";
const bucketName = "intar-dev-vm-image-registry-20260709";
const parentVersionId = "11111111-2222-4333-8444-555555555555";
const beforeVersionId = "22222222-3333-4444-8555-666666666666";
const deployedVersionId = "44444444-5555-4666-8777-888888888888";
const cleanupCron = "17 */6 * * *";
// One run spawns dozens of fake subprocesses, so the 5 s default is too tight
// when the whole suite runs in parallel.
const DEPLOY_LIVENESS_TIMEOUT_MS = 20_000;

interface RunOptions {
  mode?: string;
  configuredMode?: string;
  configRoutes?: boolean;
  configMigrations?: unknown[];
  configDurableObjects?: { bindings: unknown[] };
  configBucket?: string;
  deployedBucket?: string;
  parentTag?: string;
  parentBinding?: boolean;
  collectorAbsent?: boolean;
  schedule?: string;
  workersDevEnabled?: boolean;
  deploySucceeds?: boolean;
  liveChildMode?: string;
  /** Present only when a test drives the unrelated learner-run CLI flag. */
  parentLearnerFlag?: string;
  admissionEnforcement?: string | null;
  admissionSessionRequired?: boolean;
  admissionOk?: boolean;
  probeStatus?: string;
  holdInventory?: boolean;
}

function fakeBunx(): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    "shift",
    'if [ "$1 $2" = "deployments status" ]; then',
    '  if [ "$4" = "intar-dev" ]; then',
    '    jq -cn --arg v "$PARENT_VERSION_ID" \'{versions:[{version_id:$v,percentage:100}]}\'',
    "    exit 0",
    "  fi",
    '  if [ "$MOCK_DEPLOYMENTS_FAIL" = true ]; then exit 90; fi',
    '  current="$(<"$MOCK_STATE")"',
    '  jq -cn --arg v "$current" \'{versions:[{version_id:$v,percentage:100}]}\'',
    "  exit 0",
    "fi",
    'if [ "$1 $2" = "versions view" ]; then',
    '  if [ "$5" = "intar-dev" ]; then',
    '    if [ "$MOCK_PARENT_BINDING" = true ]; then',
    '      b=\'[{"type":"service","name":"REGISTRY_CLEANUP","service":"intar-dev-image-registry-cleanup","entrypoint":"RegistryCleanup"}]\'',
    "    else",
    "        b='[]'",
    "    fi",
    '    extra="[]"',
    '    if [ -n "$MOCK_PARENT_LEARNER_FLAG" ]; then',
    '      extra="[{\\"type\\":\\"plain_text\\",\\"name\\":\\"LEARNER_RUN_CLI_V1_ENFORCEMENT\\",\\"text\\":\\"$MOCK_PARENT_LEARNER_FLAG\\"}]"',
    '    fi',
    '    jq -cn --arg id "$3" --arg tag "$MOCK_PARENT_TAG" --argjson b "$b" --argjson extra "$extra" \'{id:$id,annotations:{"workers/tag":$tag},resources:{bindings:($b + $extra)}}\'',
    "    exit 0",
    "  fi",
    '  if [ "$3" = "$DEPLOYED_VERSION_ID" ]; then mode="$MOCK_DEPLOYED_MODE"; else mode="$MOCK_LIVE_CHILD_MODE"; fi',
    '  jq -cn --arg id "$3" --arg db "$DATABASE_ID" --arg bucket "$MOCK_DEPLOYED_BUCKET" --arg mode "$mode" \'{id:$id,annotations:{},resources:{bindings:[{type:"d1",name:"DB",id:$db},{type:"r2_bucket",name:"VM_IMAGE_REGISTRY_BUCKET",bucket_name:$bucket},{type:"service",name:"CONTROL_PLANE",service:"intar-dev",entrypoint:"MaintenanceState"},{type:"plain_text",name:"REGISTRY_CLEANUP_MODE",text:$mode}]}}\'',
    "  exit 0",
    "fi",
    'if [ "$1" = "deploy" ]; then',
    '  tag=""',
    '  previous=""',
    '  for argument in "$@"; do',
    '    if [ "$previous" = "--tag" ]; then tag="$argument"; fi',
    '    previous="$argument"',
    "  done",
    '  if [ "$MOCK_DEPLOY_SUCCEEDS" = true ]; then',
    '    printf "%s" "$DEPLOYED_VERSION_ID" > "$MOCK_STATE"',
    '    jq -cn --arg id "$DEPLOYED_VERSION_ID" --arg tag "$tag" \'{type:"deploy",version:1,worker_name:"intar-dev-image-registry-cleanup",worker_name_overridden:false,worker_tag:$tag,version_id:$id,targets:[]}\' > "$WRANGLER_OUTPUT_FILE_PATH"',
    "    exit 0",
    "  fi",
    '  jq -cn \'{type:"command-failed",version:1}\' > "$WRANGLER_OUTPUT_FILE_PATH"',
    "  exit 42",
    "fi",
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
    "  */schedules)",
    '    jq -cn --arg cron "$MOCK_SCHEDULE" \'{success:true,result:[{cron:$cron}]}\' > "$output"',
    "    printf '200'",
    "    ;;",
    "  */subdomain)",
    '    if [ "$MOCK_WORKERS_DEV_ENABLED" = true ]; then enabled=true; else enabled=false; fi',
    '    jq -cn --argjson enabled "$enabled" \'{success:true,result:{enabled:$enabled,previews_enabled:false}}\' > "$output"',
    "    printf '200'",
    "    ;;",
    "  */workers/scripts/*)",
    '    jq -cn --arg status "$MOCK_PROBE_STATUS" \'{success:($status == "200"),errors:(if $status == "404" then [{code:10007,message:"workers.api.error.script_not_found"}] else [] end)}\' > "$output"',
    '    printf "%s" "$MOCK_PROBE_STATUS"',
    "    ;;",
    "  *) exit 92 ;;",
    "esac",
    "",
  ].join("\n");
}

function runDeployment(options: RunOptions = {}) {
  const mode = options.mode ?? "report-only";
  const root = mkdtempSync(join(tmpdir(), "intar-registry-cleanup-deploy-test-"));
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner");
  const cleanupDir = join(root, "dist", "intar_dev_image_registry_cleanup");
  const state = join(root, "state");
  const config = join(cleanupDir, "wrangler.json");
  const evidence = join(root, "evidence.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(cleanupDir, { recursive: true });
  writeFileSync(state, options.collectorAbsent === true ? "absent" : beforeVersionId);
  writeFileSync(
    config,
    JSON.stringify({
      name: "intar-dev-image-registry-cleanup",
      main: "entry.mjs",
      // The shape below is the one Wrangler emits for this auxiliary worker:
      // normalised empty arrays and objects, not absent keys.
      migrations: options.configMigrations ?? [],
      durable_objects: options.configDurableObjects ?? { bindings: [] },
      assets: null,
      routes: options.configRoutes === true
        ? [{ pattern: "cleanup.intar.dev", custom_domain: true }]
        : null,
      workers_dev: false,
      preview_urls: false,
      vars: { REGISTRY_CLEANUP_MODE: options.configuredMode ?? mode },
      triggers: { crons: [cleanupCron] },
      d1_databases: [{ binding: "DB", database_id: databaseId }],
      r2_buckets: [
        {
          binding: "VM_IMAGE_REGISTRY_BUCKET",
          bucket_name: options.configBucket ?? bucketName,
          jurisdiction: "eu",
        },
      ],
      services: [
        {
          binding: "CONTROL_PLANE",
          service: "intar-dev",
          entrypoint: "MaintenanceState",
        },
      ],
    }),
  );

  const bunx = join(bin, "bunx");
  writeFileSync(bunx, fakeBunx());
  const bun = join(bin, "bun");
  writeFileSync(
    bun,
    [
      "#!/usr/bin/env bash",
      "set -u",
      'case "$1" in',
      '  *wrangler-output.ts) jq -cn --arg id "$DEPLOYED_VERSION_ID" \'{versionId:$id}\' ;;',
      "  *worker-version.ts) exit 0 ;;",
      "  *) exit 91 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  const curl = join(bin, "curl");
  writeFileSync(curl, fakeCurl());
  const sleep = join(bin, "sleep");
  writeFileSync(sleep, "#!/usr/bin/env bash\nexit 0\n");
  for (const executable of [bunx, bun, curl, sleep]) {
    chmodSync(executable, 0o755);
  }

  // Delete mode needs the report inventory the hold step records: a live plan
  // of the candidate set taken while the control plane still served.
  const holdInventory = options.holdInventory ?? mode === "delete";
  if (holdInventory) {
    writeFileSync(
      join(runnerTemp, "registry-cleanup-hold.json"),
      JSON.stringify({
        schema_version: 1,
        operation: "registry-cleanup-gate",
        action: "hold",
        gate: "ok",
        paused: true,
        idle: true,
        admission: {
          ok: options.admissionOk ?? true,
          http_status: "200",
          enforcement: options.admissionEnforcement ?? "enforce",
          sessionRequired: options.admissionSessionRequired ?? true,
        },
        inventory: { ok: true, status: "report-only", candidates: 5, scanned_objects: 42 },
      }),
    );
  }

  const result = spawnSync(
    "bash",
    [deployScriptPath, config, databaseId, bucketName, mode, evidence],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + ":" + (process.env.PATH ?? ""),
        RUNNER_TEMP: runnerTemp,
        GITHUB_SHA: sourceSha,
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
        MOCK_PROBE_STATUS: String(
          options.probeStatus ?? (options.collectorAbsent === true ? 404 : 200),
        ),
        MOCK_DEPLOYMENTS_FAIL: "false",
        MOCK_STATE: state,
        MOCK_DEPLOY_SUCCEEDS: String(options.deploySucceeds ?? true),
        MOCK_PARENT_TAG:
          options.parentTag ?? "web-" + sourceSha.slice(0, 12) + "-standard",
        MOCK_PARENT_BINDING: String(options.parentBinding ?? true),
        MOCK_PARENT_LEARNER_FLAG: options.parentLearnerFlag ?? "",
        MOCK_DEPLOYED_BUCKET: options.deployedBucket ?? bucketName,
        MOCK_DEPLOYED_MODE: options.configuredMode ?? mode,
        MOCK_LIVE_CHILD_MODE:
          options.liveChildMode ?? (options.collectorAbsent === true ? "absent" : "report-only"),
        MOCK_SCHEDULE: options.schedule ?? cleanupCron,
        MOCK_WORKERS_DEV_ENABLED: String(options.workersDevEnabled ?? false),
        PARENT_VERSION_ID: parentVersionId,
        DEPLOYED_VERSION_ID: deployedVersionId,
        DATABASE_ID: databaseId,
      },
    },
  );
  return {
    result,
    state: readFileSync(state, "utf8"),
    evidence: existsSync(evidence)
      ? (JSON.parse(readFileSync(evidence, "utf8")) as Record<string, unknown>)
      : null,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("image registry cleanup deployment", () => {
  it("deploys the built auxiliary worker and proves its private surface", () => {
    const run = runDeployment();
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.state).toBe(deployedVersionId);
      expect(run.evidence).toMatchObject({
        operation: "deploy-registry-cleanup",
        worker_name: "intar-dev-image-registry-cleanup",
        cleanup_mode: "report-only",
        deploy_tag: "cleanup-" + sourceSha.slice(0, 12) + "-report-only",
        first_deployment: false,
        before_version_id: beforeVersionId,
        deployed_version_id: deployedVersionId,
        exact_version_active: true,
        schedule_proven: true,
        bindings_proven: true,
        private_access_proven: true,
        tested_source_proven: true,
        phase: "child",
        parent_revision_proven: true,
        parent_binding_present: true,
        parent_capability_proven: true,
        previous_mode: "report-only",
      });
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("treats a first rollout as an absent collector", () => {
    const run = runDeployment({ collectorAbsent: true });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        first_deployment: true,
        before_version_id: null,
      });
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("refuses a public route on the cleanup worker", () => {
    const run = runDeployment({ configRoutes: true });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.state).toBe(beforeVersionId);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("accepts the normalised empty migrations and durable objects of the built config", () => {
    // Wrangler emits "migrations": [] and {"bindings": []} for this worker. A
    // check that compares either to null refuses the artifact the build makes.
    const run = runDeployment();
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).not.toBeNull();
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("refuses a cleanup worker that owns schema migrations", () => {
    const run = runDeployment({
      configMigrations: [{ tag: "v1", new_sqlite_classes: ["CleanupDO"] }],
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses a cleanup worker that binds a durable object", () => {
    const run = runDeployment({
      configDurableObjects: {
        bindings: [{ name: "CLEANUP", class_name: "CleanupDO" }],
      },
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses a configuration whose mode is not the requested mode", () => {
    const run = runDeployment({ configuredMode: "delete" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses a first deployment that would delete", () => {
    const run = runDeployment({ mode: "delete", collectorAbsent: true });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "the first deployment of the collector cannot delete",
      );
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode without any preview state in production", () => {
    const run = runDeployment({ mode: "delete", liveChildMode: "absent" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "the live collector mode is unreadable, so no preview can be proven",
      );
      expect(run.result.stderr).toContain("previous_mode=delete");
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses delete mode without a report inventory from the hold step", () => {
    const run = runDeployment({
      mode: "delete",
      liveChildMode: "report-only",
      holdInventory: false,
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "delete mode needs the hold evidence from the deployment gate",
      );
      expect(run.state).toBe(beforeVersionId);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("stops when the collector state can not be read at all", () => {
    // An expired token or a forbidden account must not look like a first
    // deployment: that would let a delete-capable collector deploy unproven.
    const run = runDeployment({ probeStatus: "403" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "the registry cleanup state probe failed, so this deployment can not decide.",
      );
      expect(run.state).toBe(beforeVersionId);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("keeps delete mode after the preview established it", () => {
    const run = runDeployment({ mode: "delete", liveChildMode: "delete" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        cleanup_mode: "delete",
        previous_mode: "delete",
      });
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("refuses delete mode while the D1 admission state is not enforcing", () => {
    const run = runDeployment({
      mode: "delete",
      admissionEnforcement: "report_only",
      admissionSessionRequired: false,
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "admission enforcement must be on before the collector can delete",
      );
      expect(run.result.stderr).toContain("D1 upload admission enforcement is not enforce");
      expect(run.result.stderr).toContain("image_registry_admission.enforcement");
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("deploys delete mode when the learner-run CLI flag is off and D1 admission enforces", () => {
    // The learner-run CLI rollout variable is unrelated to registry admission.
    // Only the shared D1 admission row decides whether a delete pass may run.
    const run = runDeployment({ mode: "delete", parentLearnerFlag: "off" });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        cleanup_mode: "delete",
        previous_mode: "report-only",
        deploy_tag: "cleanup-" + sourceSha.slice(0, 12) + "-delete",
      });
      expect(run.evidence).not.toHaveProperty("parent_enforcement");
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("refuses delete mode when the learner-run CLI flag is on but D1 admission is report_only", () => {
    const run = runDeployment({
      mode: "delete",
      parentLearnerFlag: "on",
      admissionEnforcement: "report_only",
      admissionSessionRequired: false,
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "admission enforcement must be on before the collector can delete",
      );
      expect(run.result.stderr).toContain("D1 upload admission enforcement is not enforce");
      expect(run.state).toBe(beforeVersionId);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("never reads the learner-run CLI rollout variable", () => {
    expect(script).not.toContain("LEARNER_RUN_CLI_V1_ENFORCEMENT");
    expect(script).toContain("image_registry_admission.enforcement");
  });

  it("refuses another bucket than the parent image registry", () => {
    const run = runDeployment({
      configBucket: "intar-dev-vm-run-artifacts-20260709",
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("refuses a deployed version without the parent bucket", () => {
    const run = runDeployment({
      deployedBucket: "intar-dev-vm-run-artifacts-20260709",
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("refuses a schedule that is not the six-hourly cleanup tick", () => {
    const run = runDeployment({ schedule: "* * * * *" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("refuses a worker that is reachable on workers.dev", () => {
    const run = runDeployment({ workersDevEnabled: true });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("accepts a parent from this feature that already carries the binding", () => {
    // A later rollout updates the collector while the previous feature-era
    // parent still serves: the binding is live, so the fence and the gate route
    // answer.
    const run = runDeployment({
      parentTag: "web-" + "b".repeat(12) + "-standard",
      parentBinding: true,
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        parent_revision_proven: false,
        parent_binding_present: true,
        parent_capability_proven: true,
      });
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("refuses a parent that can not serve the cleanup fence", () => {
    const run = runDeployment({
      parentTag: "web-" + "b".repeat(12) + "-standard",
      parentBinding: false,
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "the live control plane can not serve the image registry cleanup fence",
      );
      expect(run.state).toBe(beforeVersionId);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("proves the bootstrap parent: this revision, binding still absent", () => {
    const run = runDeployment({ parentBinding: false });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.evidence).toMatchObject({
        phase: "child",
        parent_revision_proven: true,
        parent_binding_present: false,
        parent_capability_proven: true,
      });
    } finally {
      run.cleanup();
    }
  }, DEPLOY_LIVENESS_TIMEOUT_MS);

  it("deploys the built configuration with no rollback path", () => {
    expect(script).toContain("bunx wrangler deploy");
    expect(script).toContain("tools/deploy/wrangler-output.ts");
    expect(script).toContain("--experimental-provision=false");
    expect(script).toContain("--autoconfig=false");
    expect(script).toMatch(/--config "\$\{config\}"/u);
    expect(script).toMatch(/--tag "\$\{deploy_tag\}"/u);
    expect(script).not.toMatch(/rollback|restore_previous/iu);
  });
});
