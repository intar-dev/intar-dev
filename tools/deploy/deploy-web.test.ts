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

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const deployScriptPath = join(repositoryRoot, "tools/deploy/deploy-web.sh");
const script = readFileSync(deployScriptPath, "utf8");
const beforeVersionId = "11111111-2222-4333-8444-555555555555";
const deployedVersionId = "22222222-3333-4444-8555-666666666666";
const databaseId = "33333333-4444-4555-8666-777777777777";
const sessionNamespaceId = "87ad9df7e37e4ced900553aa1a7775a1";

interface RunOptions {
  beforeMaintenance?: boolean;
  deploySucceeds?: boolean;
  targetHealthFailures?: number;
  targetMaintenance?: boolean;
}

function runDeployment(options: RunOptions = {}) {
  const beforeMaintenance = options.beforeMaintenance ?? false;
  const deploySucceeds = options.deploySucceeds ?? true;
  const targetHealthFailures = options.targetHealthFailures ?? 0;
  const targetMaintenance = options.targetMaintenance ?? false;
  const root = mkdtempSync(join(tmpdir(), "intar-web-deploy-test-"));
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner");
  const serverDir = join(root, "dist", "server");
  const clientDir = join(root, "dist", "client");
  const state = join(root, "state");
  const targetHealthCount = join(root, "target-health-count");
  const config = join(serverDir, "wrangler.json");
  const favicon = join(clientDir, "favicon.svg");
  const secrets = join(root, "secrets.json");
  const evidence = join(root, "evidence.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(state, beforeVersionId);
  writeFileSync(targetHealthCount, "0");
  writeFileSync(favicon, '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFileSync(
    secrets,
    '{"CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET":"test-maintenance-secret-at-least-forty-three-characters","OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1":"test-oidc-config-encryption-key","STARGATE_EGRESS_IPV4_CIDRS":"192.0.2.1/32"}\n',
  );
  writeFileSync(
    config,
    JSON.stringify({
      name: "intar-dev",
      d1_databases: [{ binding: "DB", database_id: databaseId }],
      kv_namespaces: [{ binding: "SESSION", id: sessionNamespaceId }],
      assets: { directory: "../client", run_worker_first: ["/api/*"] },
      vars: {
        CONTROL_PLANE_MAINTENANCE: targetMaintenance ? "on" : "off",
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["AgentBridgeDO"] },
        { tag: "v4", deleted_classes: ["AgentBridgeDO"] },
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
  if [ "$current" = "$DEPLOYED_VERSION_ID" ]; then deployment="$AFTER_DEPLOYMENT_ID"; else deployment="$BEFORE_DEPLOYMENT_ID"; fi
  jq -cn --arg id "$deployment" --arg version "$current" '{id:$id,versions:[{version_id:$version,percentage:100}]}'
  exit 0
fi
if [ "$1 $2" = "versions view" ]; then
  version="$3"
  if [ "$version" = "$BEFORE_VERSION_ID" ]; then maintenance="$BEFORE_MAINTENANCE"; else maintenance="$TARGET_MAINTENANCE"; fi
  jq -cn --arg id "$version" --arg db "$DATABASE_ID" --arg kv "$SESSION_NAMESPACE_ID" --arg do_id "$DO_NAMESPACE_ID" --arg maintenance "$maintenance" '{id:$id,resources:{bindings:[{type:"d1",name:"DB",id:$db},{type:"kv_namespace",name:"SESSION",namespace_id:$kv},{type:"durable_object_namespace",name:"HOST_RUNTIME",namespace_id:$do_id,class_name:"HostRuntimeDO"},{type:"secret_text",name:"STARGATE_EGRESS_IPV4_CIDRS"},{type:"secret_text",name:"CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET"},{type:"secret_text",name:"OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1"},{type:"plain_text",name:"CONTROL_PLANE_MAINTENANCE",text:(if $maintenance == "true" then "on" else "off" end)}],script_runtime:{migration_tag:"v4"}}}'
  exit 0
fi
if [ "$1" = "deploy" ]; then
  printf '%s' "$DEPLOYED_VERSION_ID" > "$MOCK_STATE"
  if [ "$MOCK_DEPLOY_SUCCEEDS" = true ]; then
    jq -cn --arg id "$DEPLOYED_VERSION_ID" '{type:"deploy",version:1,worker_name:"intar-dev",worker_name_overridden:false,worker_tag:"worker-tag",version_id:$id,targets:["https://intar.dev"]}' > "$WRANGLER_OUTPUT_FILE_PATH"
    exit 0
  fi
  jq -cn '{type:"command-failed",version:1}' > "$WRANGLER_OUTPUT_FILE_PATH"
  exit 42
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
  *wrangler-output.ts) jq -cn --arg id "$DEPLOYED_VERSION_ID" '{versionId:$id}' ;;
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
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
current="$(<"$MOCK_STATE")"
unhealthy=false
if [ "$current" = "$BEFORE_VERSION_ID" ]; then
  maintenance="$BEFORE_MAINTENANCE"
else
  count="$(<"$MOCK_TARGET_HEALTH_COUNT")"
  if [ "$url" = "https://intar.dev/" ]; then
    count="$((count + 1))"
    printf '%s' "$count" > "$MOCK_TARGET_HEALTH_COUNT"
  fi
  if [ "$count" -le "$MOCK_TARGET_HEALTH_FAILURES" ]; then unhealthy=true; fi
  maintenance="$TARGET_MAINTENANCE"
fi
if [ "$unhealthy" = true ]; then
  : > "$output"
  printf '502'
  exit 0
fi
case "$url" in
  https://intar.dev/api/control-plane-maintenance-probe)
    if [ "$maintenance" = true ]; then printf '%s' '{"code":"maintenance"}' > "$output"; printf '503'; else printf '%s' '{"code":"not-found"}' > "$output"; printf '404'; fi
    ;;
  https://intar.dev/api/health)
    if [ "$maintenance" = true ]; then printf '%s' '{"code":"maintenance"}' > "$output"; printf '503'; else printf '%s' '{"status":"ok"}' > "$output"; printf '200'; fi
    ;;
  https://intar.dev/favicon.svg)
    cp "$MOCK_FAVICON" "$output"
    printf '200'
    ;;
  https://intar.dev/)
    if [ "$maintenance" = true ]; then printf '%s' '<h1>Maintenance</h1>' > "$output"; printf '503'; else printf '%s' '<h1>intar.dev</h1>' > "$output"; printf '200'; fi
    ;;
  *) exit 92 ;;
esac
`,
  );
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  for (const executable of [bunx, bun, curl, join(bin, "sleep")]) {
    chmodSync(executable, 0o755);
  }

  const result = spawnSync(
    "bash",
    [deployScriptPath, config, databaseId, sessionNamespaceId, secrets, evidence],
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
        MOCK_FAVICON: favicon,
        MOCK_TARGET_HEALTH_COUNT: targetHealthCount,
        MOCK_TARGET_HEALTH_FAILURES: String(targetHealthFailures),
        MOCK_DEPLOY_SUCCEEDS: String(deploySucceeds),
        BEFORE_VERSION_ID: beforeVersionId,
        DEPLOYED_VERSION_ID: deployedVersionId,
        DATABASE_ID: databaseId,
        SESSION_NAMESPACE_ID: sessionNamespaceId,
        DO_NAMESPACE_ID: "667e00c5c90a4a68b08676230cbb6e5c",
        BEFORE_DEPLOYMENT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        AFTER_DEPLOYMENT_ID: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        BEFORE_MAINTENANCE: String(beforeMaintenance),
        TARGET_MAINTENANCE: String(targetMaintenance),
      },
    },
  );
  const parsedEvidence = existsSync(evidence)
    ? (JSON.parse(readFileSync(evidence, "utf8")) as Record<string, unknown>)
    : null;
  return {
    result,
    state: readFileSync(state, "utf8"),
    evidence: parsedEvidence,
    runtime: join(runnerTemp, "intar-web-deploy-12345-standard"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("automatic web deployment", () => {
  it("uses one strict full deploy with no rollback path", () => {
    expect(script).toContain("bunx wrangler deploy");
    expect(script).toContain("--strict");
    expect(script).toContain("--secrets-file");
    expect(script).toContain("--experimental-provision=false");
    expect(script).toContain("--autoconfig=false");
    expect(script).not.toContain("wrangler versions upload");
    expect(script).not.toContain("wrangler versions deploy");
    expect(script).not.toMatch(/rollback|restore_previous/iu);
    expect(script).toContain("https://intar.dev/api/health");
    expect(script).toContain("https://intar.dev/favicon.svg");
    expect(script).toContain("full_configuration_deployed: true");
  });

  it("deploys the exact version and waits for stable live health", () => {
    const run = runDeployment({ targetHealthFailures: 2 });
    try {
      expect(run.result.status).toBe(0);
      expect(run.state).toBe(deployedVersionId);
      expect(run.evidence).toMatchObject({
        operation: "deploy-web",
        deployed_version_id: deployedVersionId,
        target_mode: "open",
        exact_version_active: true,
        full_configuration_deployed: true,
        propagation_required_consecutive_healthy: 5,
        propagation_observed_consecutive_healthy: 5,
        propagation_observed_attempt: 7,
        live_health_proven: true,
      });
    } finally {
      run.cleanup();
    }
  });

  it("can activate maintenance and later reopen from maintenance", () => {
    const maintenance = runDeployment({ targetMaintenance: true });
    try {
      expect(maintenance.result.status).toBe(0);
      expect(maintenance.evidence).toMatchObject({ target_mode: "maintenance" });
    } finally {
      maintenance.cleanup();
    }

    const open = runDeployment({ beforeMaintenance: true });
    try {
      expect(open.result.status).toBe(0);
      expect(open.evidence).toMatchObject({
        target_mode: "open",
        before_health: { expected_mode: "maintenance", healthy: true },
      });
    } finally {
      open.cleanup();
    }
  });

  it("does not restore the old version after an ambiguous deploy failure", () => {
    const run = runDeployment({ deploySucceeds: false });
    try {
      expect(run.result.status).toBe(42);
      expect(run.state).toBe(deployedVersionId);
      expect(run.evidence).toBeNull();
    } finally {
      run.cleanup();
    }
  });

  it("leaves the deployed version active when live health never stabilizes", () => {
    const run = runDeployment({ targetHealthFailures: 99 });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.state).toBe(deployedVersionId);
      expect(run.evidence).toBeNull();
      expect(
        readFileSync(join(run.runtime, "propagation-attempts.ndjson"), "utf8"),
      ).toContain('"root_healthy":false');
    } finally {
      run.cleanup();
    }
  });
});
