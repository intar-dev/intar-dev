import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Bun is the CI runtime and supplies the YAML parser; no new dependency.
function parse(path: string) {
  const parsed = spawnSync("bun", ["-e", `console.log(JSON.stringify(Bun.YAML.parse(await Bun.file("${path}").text())))`], { encoding: "utf8" });
  if (parsed.status !== 0) throw new Error(parsed.stderr);
  return JSON.parse(parsed.stdout) as { on: Record<string, unknown>; jobs: Record<string, Job> };
}
type Step = { name: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  outputs?: Record<string, string>;
  steps: Step[];
};
const workflow = parse(".github/workflows/deploy.yml");
const ci = parse(".github/workflows/ci.yml");
const release = parse(".github/workflows/release.yml");
const deploy = workflow.jobs["deploy-web"]!;
const docs = workflow.jobs["deploy-docs"]!;
const pending = "steps.migrations.outputs.pending == 'true'";

// A step runs its body inline or as `cuenv task -p ci --package ci
// <workflow>-<name>`, whose body is tools/workflows/<workflow>/<name>.sh.
function body(step: Step) {
  const task = /^cuenv task -p ci --package ci (website|deploy)-([a-z0-9-]+)$/.exec(step.run ?? "");
  return task ? readFileSync(`tools/workflows/${task[1]}/${task[2]}.sh`, "utf8") : step.run;
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

it("deploys when the merge queue moves main, after a CI run dispatched from main, or on a dispatch", () => {
  expect(Object.keys(workflow.jobs).sort()).toEqual(["deploy-docs", "deploy-web", "resolve"]);
  expect(workflow.on).toEqual({
    workflow_dispatch: {
      inputs: {
        break_glass: {
          description: "Deploy each build whose own CI lane passed on main's tip, although another CI job failed",
          type: "boolean",
          default: false,
        },
      },
    },
    push: { branches: ["main"] },
    workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["main"] },
  });
  // CI runs on no push: the merge queue already checked main's tip.
  expect(ci.on.push).toBeUndefined();
  expect(Object.keys(ci.on).sort()).toEqual(["merge_group", "pull_request", "schedule", "workflow_dispatch"]);
  // release.yml tags and publishes on the same events.
  expect(release.on.push).toEqual(workflow.on.push);
  expect(release.on.workflow_run).toEqual(workflow.on.workflow_run);
  const gate = workflow.jobs.resolve!.if!;
  expect(release.jobs.plan!.if).toBe(gate);
  for (const condition of [
    "((github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main')",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'workflow_dispatch' &&",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
    "github.event.workflow_run.head_sha == github.sha",
  ]) {
    expect(gate).toContain(condition);
  }
  // A merge group or a scheduled run completing on main triggers nothing.
  expect(gate).not.toContain("workflow_run.event == 'merge_group'");
  expect(gate).not.toContain("workflow_run.event == 'schedule'");
  expect(deploy.environment).toEqual({ name: "production", url: "https://intar.dev" });
  expect(docs.environment).toEqual({ name: "production", url: "https://docs.intar.dev" });
});

it("deploys each build that its CI lane uploaded, by the identity resolve checked", () => {
  for (const [lane, job, path] of [
    ["web", deploy, "apps/web/dist"],
    ["docs", docs, "docs/dist"],
  ] as const) {
    const upload = ci.jobs[lane]!.steps.at(-1)!;
    expect(upload.if).toBe("github.event_name == 'merge_group' || github.ref == 'refs/heads/main'");
    // Every merge group builds it, whatever the group changed.
    expect(ci.jobs.changes!.outputs![lane]).toContain("github.event_name == 'merge_group'");
    expect(upload.with).toMatchObject({ name: `${lane}-dist-\${{ github.sha }}`, path, overwrite: true });
    expect(job.needs).toBe("resolve");
    expect(job.if).toBe(`needs.resolve.outputs.${lane}_artifact != ''`);
    expect(job.permissions).toEqual({ actions: "read", contents: "read" });
    const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
    expect(download.with).toEqual({
      "artifact-ids": `\${{ needs.resolve.outputs.${lane}_artifact }}`,
      "run-id": "${{ needs.resolve.outputs.run_id }}",
      "github-token": "${{ github.token }}",
      "digest-mismatch": "error",
      path,
    });
    // The revision check comes first, and refuses a re-run once main moved on.
    const verify = job.steps.findIndex((step) => step.name === "Verify exact-main deployment revision");
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(job.steps.indexOf(download));
  }
  expect(ci.jobs.web!.steps.at(-1)!.with!["include-hidden-files"]).toBe(true);
});

it("never cancels a deploy in progress", () => {
  expect(deploy.concurrency).toEqual({ group: "website-production", "cancel-in-progress": false });
  expect(docs.concurrency).toEqual({ group: "docs-production", "cancel-in-progress": false });
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

it("leaves the collector alone when the hold refused before it paused", () => {
  // Without hold evidence the release never calls the gate, which would fail
  // here for want of credentials.
  const root = mkdtempSync(join(tmpdir(), "intar-release-collector-"));
  try {
    const released = spawnSync("bash", ["tools/workflows/website/release-registry-collector.sh"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, RUNNER_TEMP: root },
    });
    expect(released.status, released.stderr).toBe(0);
    expect(released.stdout).toContain("the collector stays as it was");
    writeFileSync(join(root, "registry-cleanup-hold.json"), "{}");
    const held = spawnSync("bash", ["tools/workflows/website/release-registry-collector.sh"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, RUNNER_TEMP: root },
    });
    expect(held.status).not.toBe(0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
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

// find-builds.sh against a stub gh: main's tip, the CI runs, and one CI run's
// artifacts.
function findBuilds(env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "intar-find-builds-"));
  try {
    writeFileSync(
      join(root, "gh"),
      `#!/usr/bin/env bash
path="" filter=""
while [ $# -gt 0 ]; do
  case "$1" in api|--paginate) ;; --jq) filter="$2"; shift ;; *) path="$1" ;; esac
  shift
done
case "$path" in
  */commits/main) body='{"sha":"'"$MAIN"'"}' ;;
  */actions/workflows/ci.yml/runs*) body="$RUNS" ;;
  */artifacts) body="$ARTIFACTS" ;;
  */jobs*) body="$JOBS" ;;
esac
jq -r "\${filter:-.}" <<<"$body"
`,
    );
    chmodSync(join(root, "gh"), 0o755);
    for (const file of ["output", "summary"]) writeFileSync(join(root, file), "");
    const result = spawnSync("bash", ["-e", "tools/workflows/deploy/find-builds.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "intar-dev/intar-dev",
        GITHUB_SHA: sha,
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        RUNNER_TEMP: root,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        MAIN: sha,
        CI_RUN_ID: "77",
        RUNS: '{"workflow_runs":[]}',
        ...env,
      },
    });
    return { status: result.status, stderr: result.stderr, output: readFileSync(join(root, "output"), "utf8") };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
function artifacts(...list: { id: number; name: string; expired?: boolean }[]) {
  return JSON.stringify({
    artifacts: list.map(({ id, name, expired = false }) => ({
      id,
      name,
      expired,
      digest,
      workflow_run: { id: 77, head_sha: sha },
    })),
  });
}

it("finds the build of each lane that ran, and nothing for one that did not", () => {
  const found = findBuilds({
    ARTIFACTS: artifacts({ id: 1, name: `web-dist-${sha}` }, { id: 3, name: "website-smoke-1" }),
  });
  expect(found.status, found.stderr).toBe(0);
  expect(found.output).toBe(`run_id=77\nweb_artifact=1\nweb_digest=${digest}\n`);
});

it("refuses an expired build, and deploys nothing once main moved on", () => {
  const expired = findBuilds({
    ARTIFACTS: artifacts({ id: 1, name: `web-dist-${sha}` }, { id: 2, name: `docs-dist-${sha}`, expired: true }),
  });
  expect(expired.status).not.toBe(0);
  expect(expired.output).toBe("");
  const moved = findBuilds({ MAIN: "c".repeat(40), ARTIFACTS: artifacts({ id: 1, name: `web-dist-${sha}` }) });
  expect(moved.status, moved.stderr).toBe(0);
  expect(moved.output).toBe("");
});

const runs = (list: { id: number; event: string; head_branch: string }[]) =>
  JSON.stringify({ workflow_runs: list.map((run, index) => ({ ...run, run_number: index })) });
const queued = { event: "merge_group", head_branch: `gh-readonly-queue/main/pr-1-${"c".repeat(40)}` };

it("deploys main's tip from its merge group or a CI run dispatched from main", () => {
  const others = [
    { id: 75, event: "push", head_branch: "main" },
    { id: 76, event: "merge_group", head_branch: `gh-readonly-queue/other/pr-1-${"c".repeat(40)}` },
    { id: 78, event: "pull_request", head_branch: "main" },
    { id: 79, event: "workflow_dispatch", head_branch: "other" },
  ];
  for (const [event, run] of [
    ["push", { id: 77, ...queued }],
    ["workflow_dispatch", { id: 77, ...queued }],
    ["workflow_dispatch", { id: 77, event: "workflow_dispatch", head_branch: "main" }],
  ] as const) {
    const found = findBuilds({
      GITHUB_EVENT_NAME: event,
      CI_RUN_ID: "",
      RUNS: runs([...others.slice(0, 2), run, ...others.slice(2)]),
      ARTIFACTS: artifacts({ id: 2, name: `docs-dist-${sha}` }),
    });
    expect(found.status, found.stderr).toBe(0);
    expect(found.output).toBe(`run_id=77\ndocs_artifact=2\ndocs_digest=${digest}\n`);
  }
  const none = findBuilds({ CI_RUN_ID: "", RUNS: runs(others) });
  expect(none.status).not.toBe(0);
});

it("breaks glass with the builds whose own lane jobs passed", () => {
  // The job names find-builds.sh reads.
  expect(ci.jobs.web!.name).toBeUndefined();
  expect(ci.jobs.docs!.name).toBeUndefined();
  expect(ci.jobs["web-ui"]!.name).toBe("Chromium smoke");
  const jobs = (passed: string[]) =>
    JSON.stringify({
      jobs: ["changes", "security", "web", "Chromium smoke", "docs"].map((name) => ({
        name,
        conclusion: passed.includes(name) ? "success" : "failure",
      })),
    });
  const env = {
    CI_RUN_ID: "",
    BREAK_GLASS: "true",
    RUNS: runs([{ id: 77, ...queued }]),
    ARTIFACTS: artifacts({ id: 1, name: `web-dist-${sha}` }, { id: 2, name: `docs-dist-${sha}` }),
  };
  const web = findBuilds({ ...env, JOBS: jobs(["changes", "web", "Chromium smoke"]) });
  expect(web.status, web.stderr).toBe(0);
  expect(web.output).toBe(`run_id=77\nweb_artifact=1\nweb_digest=${digest}\n`);
  const docs = findBuilds({ ...env, JOBS: jobs(["changes", "web", "docs"]) });
  expect(docs.status, docs.stderr).toBe(0);
  expect(docs.output).toBe(`run_id=77\ndocs_artifact=2\ndocs_digest=${digest}\n`);
  const none = findBuilds({ ...env, JOBS: jobs(["changes", "security"]) });
  expect(none.status).not.toBe(0);
  expect(none.output).toBe("");
});
