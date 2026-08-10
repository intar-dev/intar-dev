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
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  fileURLToPath(new URL("./activate-web-version.sh", import.meta.url)),
  "utf8",
);
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const beforeVersionId = "11111111-2222-4333-8444-555555555555";
const uploadedVersionId = "22222222-3333-4444-8555-666666666666";
const databaseId = "33333333-4444-4555-8666-777777777777";
const sessionNamespaceId = "87ad9df7e37e4ced900553aa1a7775a1";

function runAmbiguousActivation(
  restoreFailures: number,
  beforeMaintenance = false,
  targetMaintenance = false,
) {
  const root = mkdtempSync(join(tmpdir(), "intar-web-activation-test-"));
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner");
  const state = join(root, "state");
  const restoreCount = join(root, "restore-count");
  const config = join(root, "wrangler.json");
  const secrets = join(root, "secrets.json");
  const evidence = join(root, "evidence.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(state, beforeVersionId);
  writeFileSync(restoreCount, "0");
  writeFileSync(
    secrets,
    '{"BETA_MAINTENANCE_BYPASS_SECRET":"test-maintenance-secret-at-least-forty-three-characters","STARGATE_EGRESS_IPV4_CIDRS":"192.0.2.1/32"}\n',
  );
  writeFileSync(
    config,
    JSON.stringify({
      name: "intar-dev",
      d1_databases: [{ binding: "DB", database_id: databaseId }],
      kv_namespaces: [{ binding: "SESSION", id: sessionNamespaceId }],
      vars: {
        BETA_ACCESS_MAINTENANCE: targetMaintenance ? "on" : "off",
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["AgentBridgeDO"] },
        {
          tag: "v2",
          new_sqlite_classes: [
            "ScenarioWorkflowDO",
            "ScenarioWorkflowSchedulerDO",
          ],
        },
        { tag: "v3", new_sqlite_classes: ["HostRuntimeDO"] },
        {
          tag: "v4",
          deleted_classes: [
            "AgentBridgeDO",
            "ScenarioWorkflowDO",
            "ScenarioWorkflowSchedulerDO",
          ],
        },
      ],
    }),
  );

  const bunx = join(bin, "bunx");
  writeFileSync(
    bunx,
    `#!/usr/bin/env bash
set -u
shift
if [ "$1 $2" = "deployments status" ]; then
  current="$(<"$MOCK_STATE")"
  if [ "$current" = "$UPLOADED_VERSION_ID" ]; then deployment="$UPLOADED_DEPLOYMENT_ID"; else deployment="$BEFORE_DEPLOYMENT_ID"; fi
  jq -cn --arg id "$deployment" --arg version "$current" '{id:$id,versions:[{version_id:$version,percentage:100}]}'
  exit 0
fi
if [ "$1 $2" = "versions view" ]; then
  version="$3"
  if [ "$version" = "$BEFORE_VERSION_ID" ]; then maintenance="$BEFORE_MAINTENANCE"; else maintenance="$TARGET_MAINTENANCE"; fi
  jq -cn --arg id "$version" --arg db "$DATABASE_ID" --arg kv "$SESSION_NAMESPACE_ID" --arg do_id "$DO_NAMESPACE_ID" --arg maintenance "$maintenance" '{id:$id,resources:{bindings:([{type:"d1",name:"DB",id:$db},{type:"kv_namespace",name:"SESSION",namespace_id:$kv},{type:"durable_object_namespace",name:"HOST_RUNTIME",namespace_id:$do_id,class_name:"HostRuntimeDO"},{type:"secret_text",name:"STARGATE_EGRESS_IPV4_CIDRS"},{type:"secret_text",name:"BETA_MAINTENANCE_BYPASS_SECRET"}] + (if $maintenance == "true" then [{type:"plain_text",name:"BETA_ACCESS_MAINTENANCE",text:"on"}] else [{type:"plain_text",name:"BETA_ACCESS_MAINTENANCE",text:"off"}] end)),script_runtime:{migration_tag:"v4"}}}'
  exit 0
fi
if [ "$1 $2" = "versions upload" ]; then
  jq -cn --arg id "$UPLOADED_VERSION_ID" '{type:"version-upload",version:1,worker_name:"intar-dev",worker_name_overridden:false,version_id:$id}' > "$WRANGLER_OUTPUT_FILE_PATH"
  exit 0
fi
if [ "$1 $2" = "versions deploy" ]; then
  target="\${3%@*}"
  if [ "$target" = "$UPLOADED_VERSION_ID" ]; then
    printf '%s' "$UPLOADED_VERSION_ID" > "$MOCK_STATE"
    jq -cn '{type:"command-failed",version:1}' > "$WRANGLER_OUTPUT_FILE_PATH"
    exit 42
  fi
  count="$(( $(<"$MOCK_RESTORE_COUNT") + 1 ))"
  printf '%s' "$count" > "$MOCK_RESTORE_COUNT"
  if [ "$count" -le "$MOCK_RESTORE_FAILURES" ]; then
    jq -cn '{type:"command-failed",version:1}' > "$WRANGLER_OUTPUT_FILE_PATH"
    exit 43
  fi
  printf '%s' "$BEFORE_VERSION_ID" > "$MOCK_STATE"
  jq -cn --arg id "$RESTORE_DEPLOYMENT_ID" '{type:"version-deploy",version:1,worker_name:"intar-dev",deployment_id:$id}' > "$WRANGLER_OUTPUT_FILE_PATH"
  exit 0
fi
exit 90
`,
  );

  const bun = join(bin, "bun");
  writeFileSync(
    bun,
    `#!/usr/bin/env bash
set -u
case "$1" in
  *wrangler-output.ts)
    if [ "$2" = "version-upload" ]; then
      jq -cn --arg id "$UPLOADED_VERSION_ID" '{versionId:$id}'
    else
      jq -cn --arg id "$RESTORE_DEPLOYMENT_ID" '{deploymentId:$id}'
    fi
    ;;
  *worker-version.ts) exit 0 ;;
  *) exit 91 ;;
esac
`,
  );

  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
set -u
output=""
headers=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
current="$(<"$MOCK_STATE")"
if [ "$current" = "$BEFORE_VERSION_ID" ]; then maintenance="$BEFORE_MAINTENANCE"; else maintenance="$TARGET_MAINTENANCE"; fi
if [ -n "$headers" ]; then : > "$headers"; fi
if [ "$url" = "https://intar.dev/api/cutover-maintenance-probe" ]; then
  if [ "$maintenance" = true ]; then
    if [ -n "$output" ]; then printf '%s' '{"code":"maintenance"}' > "$output"; fi
    printf '503'
  else
    if [ -n "$output" ]; then printf '%s' '{"code":"not-found"}' > "$output"; fi
    printf '404'
  fi
elif [ "$maintenance" = true ]; then
  if [ -n "$output" ]; then printf '%s' '<h1>Beta access is under maintenance</h1>' > "$output"; fi
  printf '503'
else
  if [ -n "$output" ]; then printf '%s' '<h1>intar.dev</h1>' > "$output"; fi
  printf '200'
fi
`,
  );
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  for (const executable of [bunx, bun, curl, join(bin, "sleep")]) {
    chmodSync(executable, 0o755);
  }

  const result = spawnSync(
    "bash",
    [
      join(repositoryRoot, "tools/deploy/activate-web-version.sh"),
      config,
      databaseId,
      sessionNamespaceId,
      secrets,
      evidence,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
        MOCK_STATE: state,
        MOCK_RESTORE_COUNT: restoreCount,
        MOCK_RESTORE_FAILURES: String(restoreFailures),
        BEFORE_VERSION_ID: beforeVersionId,
        UPLOADED_VERSION_ID: uploadedVersionId,
        DATABASE_ID: databaseId,
        SESSION_NAMESPACE_ID: sessionNamespaceId,
        DO_NAMESPACE_ID: "667e00c5c90a4a68b08676230cbb6e5c",
        BEFORE_DEPLOYMENT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        UPLOADED_DEPLOYMENT_ID: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        RESTORE_DEPLOYMENT_ID: "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa",
        BEFORE_MAINTENANCE: String(beforeMaintenance),
        TARGET_MAINTENANCE: String(targetMaintenance),
      },
    },
  );
  const runtime = join(runnerTemp, "intar-web-deploy-12345");
  const rollbackPath = join(runtime, "rollback-evidence.json");
  if (!existsSync(rollbackPath)) {
    throw new Error(
      `activation script did not reach rollback evidence (status ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return {
    result,
    state: readFileSync(state, "utf8"),
    rollback: JSON.parse(
      readFileSync(rollbackPath, "utf8"),
    ) as Record<string, unknown>,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("exact web-version activation", () => {
  it("uploads and proves an inert exact version before activating it at 100 percent", () => {
    const upload = script.indexOf("bunx wrangler versions upload");
    const uploadedBindingProof = script.indexOf("version-runtime-bindings");
    const deploy = script.indexOf(
      'bunx wrangler versions deploy "${uploaded_version_id}@100%"',
    );
    const activeBindingProof = script.indexOf("active-runtime-bindings", deploy);
    expect(upload).toBeGreaterThan(-1);
    expect(uploadedBindingProof).toBeGreaterThan(upload);
    expect(deploy).toBeGreaterThan(uploadedBindingProof);
    expect(activeBindingProof).toBeGreaterThan(deploy);
    expect(script).toContain("--strict");
    expect(script).toContain("--experimental-provision=false");
    expect(script).toContain('--secrets-file "${secrets_file}"');
    expect(script).toContain('.name == "STARGATE_EGRESS_IPV4_CIDRS"');
    expect(script).toContain('.name == "BETA_MAINTENANCE_BYPASS_SECRET"');
    expect(script).toContain("runtime_secret_binding_proven: true");
  });

  it("never mutates routes, crons, or Durable Object lifecycle", () => {
    const versionDeployCommands = script.match(
      /bunx wrangler versions deploy[\s\S]*?--yes/g,
    );
    expect(versionDeployCommands).toHaveLength(2);
    for (const command of versionDeployCommands ?? []) {
      expect(command).not.toContain("--config");
    }
    expect(script).not.toMatch(/bunx wrangler deploy(?:\s|\\)/);
    expect(script).not.toContain("wrangler triggers deploy");
    expect(script).toContain("def durable_object_bindings:");
    expect(script).toContain("durable_object_binding_set_unchanged: true");
    expect(script).toContain("durable_object_migration_tag_unchanged: true");
    expect(script).toContain("durable_object_lifecycle_mutated: false");
    expect(script).toContain("routes_mutated: false");
    expect(script).toContain("crons_mutated: false");
  });

  it("restores the exact prior version after any ambiguous or failed activation", () => {
    const armRestore = script.indexOf("restore_required=true");
    const deploy = script.indexOf(
      'bunx wrangler versions deploy "${uploaded_version_id}@100%"',
    );
    expect(armRestore).toBeGreaterThan(-1);
    expect(armRestore).toBeLessThan(deploy);
    expect(script).toContain("trap restore_previous_on_exit EXIT");
    expect(script).toContain(
      'bunx wrangler versions deploy "${before_version_id}@100%"',
    );
    expect(script).toContain("rollback_proven: $rollback_proven");
  });

  it("uses the current active version as the binding and lifecycle reference", () => {
    expect(script).toContain(
      'active-runtime-bindings "${before_deployment}" "${before_version}"',
    );
    expect(script).toContain('"${before_version}" "${uploaded_version}"');
    expect(script).toContain("current_active_version_used_as_reference: true");
  });

  it("requires the expected open or exact maintenance state before and after activation", () => {
    expect(script).toContain("before_health_mode");
    expect(script).toContain("target_health_mode");
    expect(script).toContain("https://intar.dev/api/cutover-maintenance-probe");
    expect(script).toContain('"${maintenance_code}" = maintenance');
    expect(script).toContain('https://intar.dev/');
    expect(script).toContain("before_health_proven: true");
    expect(script).toContain("after_health_proven: true");
  });

  it("accepts the exact maintenance fence as the active rollback health state", () => {
    const run = runAmbiguousActivation(0, true, true);
    try {
      expect(run.result.status).toBe(42);
      expect(run.state).toBe(beforeVersionId);
      expect(run.rollback).toMatchObject({
        rollback_control_plane_proven: true,
        rollback_health_proven: true,
        rollback_proven: true,
        before_health: {
          expected_mode: "maintenance",
          root_status: "503",
          maintenance_status: "503",
          maintenance_code: "maintenance",
          healthy: true,
        },
      });
    } finally {
      run.cleanup();
    }
  });

  it("reconciles an ambiguous activation and retries exact restore through public propagation", () => {
    const run = runAmbiguousActivation(1);
    try {
      expect(run.result.status).toBe(42);
      expect(run.state).toBe(beforeVersionId);
      expect(run.rollback).toMatchObject({
        original_exit_status: 42,
        before_version_id: beforeVersionId,
        attempted_version_id: uploadedVersionId,
        rollback_command_attempts: 2,
        rollback_control_plane_proven: true,
        rollback_health_proven: true,
        rollback_propagation_observed_attempt: 1,
        rollback_proven: true,
      });
      expect(String(run.rollback.rollback_attempts_ndjson)).toContain(
        '"command_status":43',
      );
      expect(String(run.rollback.rollback_attempts_ndjson)).toContain(
        '"exact_previous_version_active":true',
      );
      expect(String(run.rollback.rollback_propagation_attempts_ndjson)).toContain(
        '"root_healthy":true',
      );
    } finally {
      run.cleanup();
    }
  });

  it("retains explicit evidence after bounded restore exhaustion", () => {
    const run = runAmbiguousActivation(99);
    try {
      expect(run.result.status).toBe(42);
      expect(run.state).toBe(uploadedVersionId);
      expect(run.rollback).toMatchObject({
        rollback_command_attempts: 6,
        rollback_reconcile_attempts: 7,
        rollback_control_plane_proven: false,
        rollback_health_proven: false,
        rollback_proven: false,
      });
    } finally {
      run.cleanup();
    }
  });
});
