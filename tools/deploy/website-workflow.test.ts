import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Bun is the CI runtime and supplies the YAML parser; no new dependency.
const parsed = spawnSync("bun", ["-e", 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(".github/workflows/website.yml").text())))'], { encoding: "utf8" });
if (parsed.status !== 0) throw new Error(parsed.stderr);
type Step = { name: string; if?: string; run?: string; with?: Record<string, unknown> };
const workflow = JSON.parse(parsed.stdout) as {
  jobs: Record<string, { if?: string; steps: Step[] }>;
};
const steps = workflow.jobs.deploy.steps;
const request = workflow.jobs.plan.steps.find(step => step.name === "Validate the release request")!;
const sha = "a".repeat(40);

function context(operation: string, guard = "active", action = operation.replace(/^metal-/, "")) {
  return {
    github: { ref: "refs/heads/main", event_name: operation === "push" ? "push" : "workflow_dispatch" },
    inputs: { operation }, vars: { PERSONAL_METAL_ROLLOUT: guard },
    needs: { plan: { outputs: { metal_action: operation.startsWith("metal-") ? action : "", maintenance: "off" } } },
    steps: { "runtime-secrets": { outcome: "success" }, migrations: { outputs: { pending: "true" } }, "registry-cleanup-state": { outputs: { child_present: "false" } }, "registry-cleanup-child": { outputs: { skip: "false" } } },
    env: { REGISTRY_CLEANUP_MODE: "delete" },
  };
}

// Evaluate the small expression subset used by this workflow. Include GitHub's
// implicit success() rule so failure-path cleanup is checked too.
function runs(expression: string | undefined, state: ReturnType<typeof context>, failed = false) {
  if (failed && !/\b(always|failure|cancelled|success)\(/.test(expression ?? "")) return false;
  if (!expression) return true;
  const js = expression.replace(/\.([A-Za-z_][\w-]*)/g, '["$1"]');
  return Boolean(new Function(...Object.keys(state), "contains", "fromJSON", "always", "success", `return (${js});`)(
    ...Object.values(state), (array: string[], value: string) => array.includes(value), JSON.parse, () => true, () => !failed,
  ));
}

it("blocks normal push and manual deployment at both job boundaries during rollout", () => {
  for (const operation of ["push", "deploy"]) {
    expect(runs(workflow.jobs.plan.if, context(operation))).toBe(false);
    expect(runs(workflow.jobs.deploy.if, context(operation))).toBe(false);
    expect(runs(workflow.jobs.plan.if, context(operation, ""))).toBe(true);
    expect(runs(workflow.jobs.deploy.if, context(operation, ""))).toBe(true);
  }
  for (const operation of ["validate", "metal-invalid"]) {
    expect(runs(workflow.jobs.plan.if, context(operation))).toBe(false);
  }
});

it.each(["deploy", "open-platform-registration", "open-admission"])("isolates metal %s from every normal mutation, even after failure", action => {
  const state = context(`metal-${action}`);
  expect(runs(workflow.jobs.plan.if, state)).toBe(true);
  expect(runs(workflow.jobs.deploy.if, state)).toBe(true);
  expect(runs(workflow.jobs.plan.if, context(`metal-${action}`, ""))).toBe(false);
  expect(runs(workflow.jobs.deploy.if, context(`metal-${action}`, ""))).toBe(false);
  const normalMutations = steps.filter(step => /tools\/deploy\/(deploy-web|deploy-registry-cleanup|registry-cleanup-(gate|child-gate))\.sh|bun tools\/database\/apply-generated-migrations\.ts/.test(step.run ?? ""));
  expect(normalMutations.length).toBeGreaterThan(5);
  for (const failed of [false, true]) for (const step of normalMutations) {
    expect(runs(step.if, state, failed), step.name).toBe(false);
  }
  const staged = steps.find(step => step.name === "Run the staged personal-metal action")!;
  expect(runs(staged.if, state)).toBe(true);
  expect(runs(staged.if, state, true)).toBe(false);
  for (const name of ["Remove runtime secret file", "Retain personal-metal evidence"]) {
    expect(runs(steps.find(step => step.name === name)!.if, state, true), name).toBe(true);
  }
});

function validateRequest(overrides: Record<string, string>) {
  const temp = mkdtempSync(join(tmpdir(), "metal-workflow-"));
  try {
    const result = spawnSync("bash", ["-c", request.run!], { encoding: "utf8", env: {
      ...process.env, EVENT_NAME: "workflow_dispatch", OPERATION: "metal-deploy", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_RUN_ATTEMPT: "1",
      CONFIRMATION: "DEPLOY WEB RELEASE", REQUESTED_MAINTENANCE: "auto", REQUESTED_CLEANUP_MODE: "preserve",
      METAL_REVISION: sha, METAL_DEPLOY_RUN_ID: "", METAL_CHECKS: "", METAL_PROOF_ARTIFACT_ID: "",
      GITHUB_OUTPUT: join(temp, "output"), ...overrides,
    } });
    return { status: result.status, output: result.status === 0 ? readFileSync(join(temp, "output"), "utf8") : "" };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

it("requires the fixed revision, prior deploy, and actual proof artifact input before planning", () => {
  expect(validateRequest({})).toMatchObject({ status: 0, output: expect.stringContaining("maintenance=on") });
  expect(validateRequest({ METAL_DEPLOY_RUN_ID: "123" }).status).toBe(0);
  expect(validateRequest({ GITHUB_RUN_ATTEMPT: "2" }).status).not.toBe(0);
  for (const overrides of [{ METAL_DEPLOY_RUN_ID: "wrong" }, { METAL_REVISION: "b".repeat(40) }, { METAL_REVISION: "" }, { REQUESTED_MAINTENANCE: "off" }, { REQUESTED_CLEANUP_MODE: "delete" }]) {
    expect(validateRequest(overrides).status).not.toBe(0);
  }
  const reopen = { OPERATION: "metal-open-platform-registration", METAL_DEPLOY_RUN_ID: "123", METAL_CHECKS: JSON.stringify({ revision: sha }) };
  expect(validateRequest(reopen)).toMatchObject({ status: 0, output: expect.stringContaining("maintenance=off") });
  expect(validateRequest({ ...reopen, METAL_DEPLOY_RUN_ID: "" }).status).not.toBe(0);
  expect(validateRequest({ ...reopen, METAL_CHECKS: JSON.stringify({ revision: "wrong" }) }).status).not.toBe(0);
  expect(validateRequest({ ...reopen, OPERATION: "metal-open-admission" }).status).not.toBe(0);
});

it("parses every workflow shell block", () => {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (!step.run) continue;
    const result = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
    expect(result.status, `${step.name}: ${result.stderr}`).toBe(0);
  }
});


it.each([
  ["deploy", "failure", true],
  ["open-platform-registration", "success", true],
  ["open-platform-registration", "failure", false],
] as const)("restores immutable inputs for %s from a %s run: %s", (action, conclusion, allowed) => {
  const temp = mkdtempSync(join(tmpdir(), "metal-restore-"));
  const original = { action: "deploy", revision: sha, buildRunId: "90", buildArtifactId: "456", buildArtifactDigest: `sha256:${"b".repeat(64)}` };
  const pin = { originalPin: true };
  try {
    const bin = join(temp, "bin");
    mkdirSync(bin);
    writeFileSync(join(temp, "files.json"), JSON.stringify({
      "release.json": JSON.stringify(original), "release-static-pin.json": JSON.stringify(pin),
      ...(action === "deploy" ? {} : { "deploy.json": JSON.stringify({ revision: sha, runtimeRetiredAt: 1 }) }),
    }));
    const archive = join(temp, "artifact.zip");
    expect(spawnSync("python3", ["-c", "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2], 'w') as z:\n for name,data in json.load(open(sys.argv[1])).items(): z.writestr(name,data)", join(temp, "files.json"), archive]).status).toBe(0);
    const name = action === "deploy" ? `personal-metal-inputs-${sha}-123` : `personal-metal-${sha}-123-1`;
    const metadata = { id: 789, name, expired: false, digest: `sha256:${createHash("sha256").update(readFileSync(archive)).digest("hex")}`, workflow_run: { head_sha: sha } };
    writeFileSync(join(temp, "run.json"), JSON.stringify({ head_sha: sha, head_branch: "main", path: ".github/workflows/website.yml", event: "workflow_dispatch", status: "completed", conclusion }));
    writeFileSync(join(temp, "artifacts.json"), JSON.stringify({ artifacts: [metadata] }));
    writeFileSync(join(temp, "metadata.json"), JSON.stringify(metadata));
    // This subprocess can read fixture files only; no GitHub call is made.
    const gh = join(bin, "gh");
    writeFileSync(gh, `#!/usr/bin/env python3
import os,sys
root = os.environ['FIXTURE_ROOT']
endpoint = sys.argv[-1]
files = {'runs/123': 'run.json', 'runs/123/artifacts': 'artifacts.json', 'artifacts/789': 'metadata.json', 'artifacts/789/zip': 'artifact.zip'}
key = endpoint.split('/actions/', 1)[1]
sys.stdout.buffer.write(open(os.path.join(root, files[key]), 'rb').read())
`);
    chmodSync(gh, 0o755);
    const restore = steps.find(step => step.name === "Restore metal retirement evidence")!;
    const result = spawnSync("bash", ["-c", restore.run!], { encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: temp, RUNNER_TEMP: temp,
      GITHUB_REPOSITORY: "intar-dev/intar-dev", GITHUB_SHA: sha, SOURCE_RUN_ID: "123", METAL_ACTION: action, PROOF_ARTIFACT_ID: "",
    } });
    expect(result.status === 0, result.stderr).toBe(allowed);
    if (allowed) {
      expect(JSON.parse(readFileSync(join(temp, "personal-metal/release.json"), "utf8"))).toEqual(original);
      expect(JSON.parse(readFileSync(join(temp, "personal-metal/release-static-pin.json"), "utf8"))).toEqual(pin);
      expect(existsSync(join(temp, "personal-metal/deploy.json"))).toBe(action !== "deploy");
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

it("saves immutable inputs before retirement and never replaces a metal build on rerun", () => {
  const upload = steps.findIndex(step => step.name === "Retain immutable personal-metal release inputs");
  const retirement = steps.findIndex(step => step.name === "Run the staged personal-metal action");
  expect(upload).toBeGreaterThan(-1);
  expect(upload).toBeLessThan(retirement);
  expect(steps[upload].with?.["if-no-files-found"]).toBe("error");
  const build = workflow.jobs.validate.steps.find(step => step.name === "Upload tested deployment artifact")!;
  expect(build.with?.overwrite).toBe("${{ !startsWith(inputs.operation, 'metal-') }}");
});
