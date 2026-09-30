import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Bun is the CI runtime and supplies the YAML parser; no new dependency.
const parsed = spawnSync("bun", ["-e", 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(".github/workflows/website.yml").text())))'], { encoding: "utf8" });
if (parsed.status !== 0) throw new Error(parsed.stderr);
type Step = { name: string; id?: string; if?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  if?: string;
  needs?: string[];
  concurrency?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  steps: Step[];
};
const workflow = JSON.parse(parsed.stdout) as { jobs: Record<string, Job> };
const deploy = workflow.jobs.deploy!;
const pending = "steps.migrations.outputs.pending == 'true'";

// A step runs its body inline or as `cuenv task -p ci --package ci
// website-<name>`, whose body is tools/workflows/website/<name>.sh.
function body(step: Step) {
  const task = /^cuenv task -p ci --package ci website-([a-z0-9-]+)$/.exec(step.run ?? "");
  return task ? readFileSync(`tools/workflows/website/${task[1]}.sh`, "utf8") : step.run;
}

function step(name: string) {
  const index = deploy.steps.findIndex((candidate) => candidate.name === name);
  expect(index, name).toBeGreaterThanOrEqual(0);
  return { index, step: deploy.steps[index]! };
}

it("parses every workflow shell block", () => {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    const run = body(step);
    if (!run) continue;
    const result = spawnSync("bash", ["-n"], { input: run, encoding: "utf8" });
    expect(result.status, `${step.name}: ${result.stderr}`).toBe(0);
  }
});

it("deploys from one production job after the tests and the smoke", () => {
  expect(Object.keys(workflow.jobs).sort()).toEqual(["deploy", "ui", "validate"]);
  expect(deploy.needs).toEqual(["validate", "ui"]);
  expect(deploy.environment).toEqual({ name: "production", url: "https://intar.dev" });
});

it("never cancels a deploy in progress", () => {
  expect(deploy.concurrency).toEqual({ group: "website-production", "cancel-in-progress": false });
});

it("holds before it changes production and releases last", () => {
  const order = [
    "Pin and verify production configuration",
    "Plan production D1 migrations",
    "Hold the image registry collector",
    "Enable maintenance for pending migrations",
    "Apply pending D1 migrations",
    "Verify production D1 schema",
    "Deploy the image registry cleanup worker",
    "Deploy production at 100 percent",
    "Release the image registry collector",
  ].map((name) => step(name).index);
  expect(order).toEqual([...order].sort((left, right) => left - right));
});

it("releases the collector after every run that reached the hold", () => {
  expect(step("Hold the image registry collector").step.id).toBe("hold");
  expect(step("Release the image registry collector").step.if).toBe(
    "always() && steps.hold.outcome != 'skipped'",
  );
});

it("conditions only the migration steps on pending migrations", () => {
  const conditioned = Object.fromEntries(
    deploy.steps.filter((candidate) => candidate.if).map((candidate) => [candidate.name, candidate.if]),
  );
  expect(conditioned).toEqual({
    "Rehearse pending migrations on disposable D1": pending,
    "Capture pre-migration D1 evidence": pending,
    "Enable maintenance for pending migrations": pending,
    "Drain and recheck maintenance": pending,
    "Apply pending D1 migrations": pending,
    "Release the image registry collector": "always() && steps.hold.outcome != 'skipped'",
    "Remove runtime secret file": "always() && steps.runtime-secrets.outcome != 'skipped'",
    "Summarize the deployment": "always()",
    "Retain deployment evidence": "always()",
  });
});

it("recovers a maintenance version a failed deploy left serving without a step condition", () => {
  // The recovery lives in the gate script: the hold and the release read the
  // serving parent themselves, so a re-run or a fix push takes the same steps.
  for (const [name, action] of [
    ["Hold the image registry collector", "hold"],
    ["Release the image registry collector", "release"],
  ] as const) {
    expect(body(step(name).step)).toContain(`tools/deploy/registry-cleanup-gate.sh ${action} `);
  }
  expect(readFileSync("tools/deploy/registry-cleanup-gate.sh", "utf8")).toContain(
    "recover_behind_lane_maintenance",
  );
});
