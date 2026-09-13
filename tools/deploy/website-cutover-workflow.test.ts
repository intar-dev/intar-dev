import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const cutover = read("website-cutover.yml");
const deployWorkflow = read("website-deploy.yml");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function read(name: string): string {
  return readFileSync(resolve(repositoryRoot, ".github/workflows", name), "utf8");
}

/**
 * Return the shell body of one workflow step exactly as it ships. The tests
 * below execute this text, so a change that stops enforcing an invariant
 * fails here even when a matching string is still present somewhere.
 */
function stepScript(name: string): string {
  const lines = cutover.split("\n");
  const start = lines.findIndex((line) => line === "      - name: " + name);
  if (start < 0) throw new Error("step not found: " + name);
  let runStart = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^ {6}- /.test(line)) break;
    if (line === "        run: |") {
      runStart = index;
      break;
    }
  }
  if (runStart < 0) throw new Error("run block not found: " + name);
  const body: string[] = [];
  for (let index = runStart + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      body.push("");
      continue;
    }
    if (!line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n") + "\n";
}

function sha(fill: string): string {
  return fill.repeat(40);
}

const CUTOVER_SHA = sha("a");
const OTHER_SHA = sha("b");
const ACTIVE_VERSION = "22222222-3333-4444-8555-666666666666";

interface StepRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runStep(script: string, env: Record<string, string>): StepRun {
  const root = mkdtempSync(join(tmpdir(), "intar-cutover-step-"));
  temporaryRoots.push(root);
  const scriptPath = join(root, "step.sh");
  writeFileSync(scriptPath, script);
  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** A fake wrangler that reports one active version carrying a chosen tag. */
function fakeWranglerEnv(activeTag: string) {
  const root = mkdtempSync(join(tmpdir(), "intar-cutover-wrangler-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const bunx = join(bin, "bunx");
  writeFileSync(
    bunx,
    [
      "#!/usr/bin/env bash",
      "set -u",
      'if [ "$1" = "wrangler" ] && [ "$2" = "deployments" ] && [ "$3" = "status" ]; then',
      '  printf \'{"versions":[{"version_id":"%s","percentage":100}]}\\n\' "$FAKE_ACTIVE_VERSION"',
      "  exit 0",
      "fi",
      'if [ "$1" = "wrangler" ] && [ "$2" = "versions" ] && [ "$3" = "view" ]; then',
      '  if [ -z "$FAKE_ACTIVE_TAG" ]; then',
      '    printf \'{"id":"%s","annotations":{}}\\n\' "$4"',
      "  else",
      '    printf \'{"id":"%s","annotations":{"workers/tag":"%s"}}\\n\' "$4" "$FAKE_ACTIVE_TAG"',
      "  fi",
      "  exit 0",
      "fi",
      "exit 91",
      "",
    ].join("\n"),
  );
  chmodSync(bunx, 0o755);
  return {
    PATH: bin + ":" + (process.env.PATH ?? ""),
    FAKE_ACTIVE_TAG: activeTag,
    FAKE_ACTIVE_VERSION: ACTIVE_VERSION,
  };
}

function validateEnv(input: {
  operation: string;
  cutoverSha: string;
  dispatchSha: string;
  confirmation: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "intar-cutover-validate-"));
  temporaryRoots.push(root);
  const output = join(root, "github-output");
  writeFileSync(output, "");
  return {
    env: {
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: input.dispatchSha,
      GITHUB_OUTPUT: output,
      OPERATION: input.operation,
      TOOLS_RUN_ID: "34732871220",
      CUTOVER_SHA: input.cutoverSha,
      CONFIRMATION: input.confirmation,
    },
    output,
  };
}

function liveCheckEnv(cutoverSha: string, activeTag: string) {
  const root = mkdtempSync(join(tmpdir(), "intar-cutover-live-"));
  temporaryRoots.push(root);
  return {
    ...fakeWranglerEnv(activeTag),
    RUNNER_TEMP: root,
    GITHUB_STEP_SUMMARY: join(root, "summary"),
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "token",
    CUTOVER_SHA: cutoverSha,
  };
}

describe("manual website cutover workflow", () => {
  it("is manual only and confirms the cutover phrase", () => {
    expect(cutover).toContain("on:" + String.fromCharCode(10) + "  workflow_dispatch:");
    expect(cutover).not.toMatch(/^  push:/mu);
    expect(cutover).not.toContain("pull_request");
    expect(cutover).toContain("CUTOVER WEB RELEASE");
    expect(cutover).toContain("refs/heads/main");
    expect(cutover).toContain("TOOLS_RUN_ID");
  });

  it("accepts only this repository successful guest tools release run", () => {
    expect(cutover).toContain("actions/runs/");
    for (const required of [
      ".repository.full_name ==",
      ".head_sha ==",
      '.head_branch == "main"',
      '.event == "workflow_dispatch"',
      '.conclusion == "success"',
      'endswith("guest-tools-deploy.yml")',
      "GITHUB_REPOSITORY",
    ]) {
      expect(cutover).toContain(required);
    }
    expect(cutover).not.toContain("artifact_path");
    expect(cutover).not.toContain("repository: ");
  });

  it("downloads the release evidence by artifact ID and verifies its digest", () => {
    expect(cutover).toContain("-deployment-");
    expect(cutover).toContain("actions/artifacts/");
    expect(cutover).toContain("/zip");
    expect(cutover).toContain("sha256sum");
    expect(cutover).toContain("expected_digest");
    expect(cutover).toContain('test("^sha256:[0-9a-f]{64}');
    expect(cutover).toContain("unsafe artifact member");
    expect(cutover).toContain(".schema_version == 1 and .bootstrap_abi == 2");
  });

  it("verifies the published release objects before it emits the pin", () => {
    expect(cutover).toContain("guest-tools/scenario/disks/");
    expect(cutover).toContain("guest-tools/scenario/kino/");
    expect(cutover).toContain("--jurisdiction eu");
    expect(cutover).toContain("bun tools/deploy/guest-tools-pin.ts release");
    expect(cutover).toContain("bun tools/deploy/guest-tools-pin.ts check");
    expect(cutover).toContain("static_pin_json=");
  });

  it("requires the decompression and ext4 tools before it downloads anything", () => {
    const checkIndex = cutover.indexOf("Verify the release verification tools");
    const downloadIndex = cutover.indexOf("Download the published release objects");
    expect(checkIndex).toBeGreaterThan(-1);
    expect(downloadIndex).toBeGreaterThan(checkIndex);
    expect(cutover).toContain("for tool in zstd debugfs; do");
    expect(cutover).toContain("missing required release verification tool:");
    expect(cutover).not.toContain("apt-get");
    expect(cutover).not.toContain("INSTALL_TOOLS");
    expect(cutover).not.toContain("INTAR_CUTOVER_APT_INSTALL");
  });

  it("proves the runtime cutover gate is drained before it downloads anything", () => {
    const gateIndex = cutover.indexOf("Verify the runtime cutover gate is drained");
    const downloadIndex = cutover.indexOf("Download the published release objects");
    const deployIndex = cutover.indexOf("uses: ./.github/workflows/website-deploy.yml");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(downloadIndex).toBeGreaterThan(gateIndex);
    expect(deployIndex).toBeGreaterThan(gateIndex);
    expect(cutover).toContain("https://intar.dev/registry/v1/cutover/gate");
    expect(cutover).toContain(".state == \"drained\" and .active_desired_vms == 0");
    expect(cutover).toContain("cutover-gate.json");
    expect(cutover).toContain("INTAR_IMAGE_PUBLISH_TOKEN");
    expect(cutover).toContain("curl --silent --show-error --max-time 30");
    expect(cutover).toContain("The runtime cutover gate is unreadable");
    expect(cutover).toContain("Drain the fleet gate first, then dispatch");
  });

  it("deploys through the tested website artifact with maintenance held", () => {
    expect(cutover).toContain("actions/artifacts?name=");
    expect(cutover).toContain("website-dist-");
    expect(cutover).toContain("website_dist_run_id=");
    expect(cutover).toContain("uses: ./.github/workflows/website-deploy.yml");
    expect(cutover).toContain("needs.verify-release.outputs.static_pin_json");
    expect(cutover).toContain("needs.verify-release.outputs.website_dist_run_id");
    expect(cutover).toContain("maintenance=on");
    expect(cutover).toContain("maintenance=off");
    expect(cutover).toContain("needs.verify-release.outputs.maintenance");
    expect(cutover).toContain("secrets: inherit");
  });

  it("requires the verified pin and the tested artifact run for every deploy", () => {
    expect(deployWorkflow).toContain("guest_tools_static_pin_json:");
    expect(deployWorkflow).toContain("SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON is not set.");
    expect(deployWorkflow).toContain("tools/deploy/guest-tools-pin.ts check");
    expect(deployWorkflow).toContain("website_dist_run_id:");
    expect(deployWorkflow).toContain(".vars.SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON");
    expect(deployWorkflow).toContain("maintenance input must be auto, on, or off");
    expect(deployWorkflow).toContain("website-cutover.yml");
    expect(deployWorkflow).not.toContain("website.yml@refs/heads/main");
  });

  it("holds maintenance through the candidate deploy and proves the drain", () => {
    const maintenanceProbe = deployWorkflow.indexOf("Drain and recheck maintenance");
    const candidateDeploy = deployWorkflow.indexOf("Deploy production at 100 percent");
    expect(maintenanceProbe).toBeGreaterThan(-1);
    expect(candidateDeploy).toBeGreaterThan(maintenanceProbe);
    expect(deployWorkflow).toContain('test "${probe_status}" = 503');
    expect(deployWorkflow).toContain("The cutover holds the control plane closed");
    expect(deployWorkflow).toContain('MAINTENANCE_MODE}" = on');
    expect(deployWorkflow).toContain("active_scenario_run_count == 0");
    expect(deployWorkflow).toContain("non_uploaded_run_artifact_count == 0");
    expect(deployWorkflow).toContain("role = 'agent' AND disabled = 0");
    expect(deployWorkflow).not.toContain("enabled_agent_host_count == 0");
    expect(deployWorkflow).toContain("REQUIRE_DRAINED_GATE");
    expect(deployWorkflow).toContain('cutover_gate_state == "drained"');
    expect(deployWorkflow).toContain("pre-migration-run-drain-audit.json");
  });

  it("separates the cutover from the reopen and never opens the fleet", () => {
    expect(cutover).toContain("- cutover");
    expect(cutover).toContain("- reopen");
    expect(cutover).toContain("REOPEN WEB RELEASE");
    expect(cutover).toContain("operation must be cutover or reopen");
    const gateIndex = cutover.indexOf("Verify the runtime cutover gate is drained");
    const reopenIndex = cutover.indexOf("Verify the control plane is closed for the reopen");
    const checkoutIndex = cutover.indexOf("Checkout cutover revision");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(reopenIndex).toBeGreaterThan(gateIndex);
    expect(checkoutIndex).toBeGreaterThan(reopenIndex);
    expect(cutover).toContain("if: inputs.operation == 'cutover'");
    expect(cutover).toContain("if: inputs.operation == 'reopen'");
    expect(cutover).not.toContain('{"state":"open"}');
    expect(cutover).not.toContain('"disabled":false');
  });
});

describe("reopen is bound to the cutover revision", () => {
  it("refuses a reopen whose named revision is not the dispatch revision", () => {
    const { env } = validateEnv({
      operation: "reopen",
      cutoverSha: CUTOVER_SHA,
      dispatchSha: OTHER_SHA,
      confirmation: "REOPEN WEB RELEASE",
    });

    const result = runStep(stepScript("Validate cutover inputs"), env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match the dispatch revision");
    expect(result.stderr).toContain("cutover_sha=" + CUTOVER_SHA);
    expect(result.stderr).toContain("dispatch=" + OTHER_SHA);
  });

  it("refuses a reopen that does not name a 40-hex revision", () => {
    const { env } = validateEnv({
      operation: "reopen",
      cutoverSha: "main",
      dispatchSha: CUTOVER_SHA,
      confirmation: "REOPEN WEB RELEASE",
    });

    const result = runStep(stepScript("Validate cutover inputs"), env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cutover_sha must be a 40-hex commit SHA");
  });

  it("accepts a cutover whose named revision is the dispatch revision", () => {
    const { env, output } = validateEnv({
      operation: "cutover",
      cutoverSha: CUTOVER_SHA,
      dispatchSha: CUTOVER_SHA,
      confirmation: "CUTOVER WEB RELEASE",
    });

    const result = runStep(stepScript("Validate cutover inputs"), env);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("maintenance=on");
  });

  it("refuses a reopen whose live deployment is a different revision", () => {
    const env = liveCheckEnv(CUTOVER_SHA, "web-" + OTHER_SHA.slice(0, 12) + "-standard");

    const result = runStep(
      stepScript("Verify the live deployment is the cutover revision"),
      env,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not the cutover revision");
    expect(result.stderr).toContain("active_tag=web-" + OTHER_SHA.slice(0, 12));
    expect(result.stderr).toContain("expected_tag_prefix=web-" + CUTOVER_SHA.slice(0, 12) + "-");
  });

  it("refuses a reopen when the active version carries no deploy tag", () => {
    const env = liveCheckEnv(CUTOVER_SHA, "");

    const result = runStep(
      stepScript("Verify the live deployment is the cutover revision"),
      env,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not the cutover revision");
  });

  it("accepts a reopen whose live deployment carries the cutover revision", () => {
    const tag = "web-" + CUTOVER_SHA.slice(0, 12) + "-standard";
    const env = liveCheckEnv(CUTOVER_SHA, tag);

    const result = runStep(
      stepScript("Verify the live deployment is the cutover revision"),
      env,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("active_tag=" + tag);
  });
});
