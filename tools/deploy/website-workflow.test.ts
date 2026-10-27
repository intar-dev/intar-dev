import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    // Named by the hash of its inputs, which resolve computes the same way.
    expect(ci.jobs.changes!.outputs![`${lane}_inputs`]).toBe(`\${{ steps.inputs.outputs.${lane} }}`);
    expect(upload.with).toMatchObject({
      name: `${lane}-dist-\${{ needs.changes.outputs.${lane}_inputs }}`,
      path,
      overwrite: true,
    });
    expect(job.needs).toBe("resolve");
    expect(job.if).toBe(`needs.resolve.outputs.${lane}_artifact != ''`);
    expect(job.permissions).toEqual({ actions: "read", contents: "read" });
    const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
    expect(download.with).toEqual({
      "artifact-ids": `\${{ needs.resolve.outputs.${lane}_artifact }}`,
      "run-id": `\${{ needs.resolve.outputs.${lane}_run }}`,
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

// find-builds.sh in a repository whose main has a docs commit and then a web
// commit, against a stub gh: main's tip, artifacts by name, runs by id, and a
// run's jobs. A run's commit is main's tip unless it says otherwise.
const digest = `sha256:${"b".repeat(64)}`;
const queue = `gh-readonly-queue/main/pr-1-${"c".repeat(40)}`;
type Run = { event: string; head_branch: string; conclusion: string; path?: string; jobs?: string[]; head_sha?: string };
const passed = (event: string, head_branch: string): Run => ({ event, head_branch, conclusion: "success" });

function findBuilds(env: Record<string, string>, runs: Record<number, Run>, artifacts: Record<string, number[][]>) {
  const root = mkdtempSync(join(tmpdir(), "intar-find-builds-"));
  try {
    const repo = join(root, "repo");
    const git = (args: string[]) =>
      spawnSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      }).stdout.trim();
    mkdirSync(join(repo, "docs"), { recursive: true });
    mkdirSync(join(repo, "web"), { recursive: true });
    git(["init", "-q"]);
    writeFileSync(join(repo, "docs", "index.md"), "# Docs\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "docs"]);
    const docsCommit = git(["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "web", "index.ts"), "export {};\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "web"]);
    const tip = git(["rev-parse", "HEAD"]);
    const hash = (lane: string, globs: string) =>
      // Without GITHUB_OUTPUT, which a CI run sets, the hash goes to stdout.
      spawnSync("bash", [resolve("tools/ci/lane-inputs.sh"), `${lane} ${globs}`], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: "" },
      })
        .stdout.trim()
        .split("=")[1];
    const names = { web: `web-dist-${hash("web", "web/**")}`, docs: `docs-dist-${hash("docs", "docs/**")}` };
    const runMap = Object.fromEntries(
      Object.entries(runs).map(([id, run]) => [
        id,
        { path: ".github/workflows/ci.yml", head_repository: { full_name: "intar-dev/intar-dev" }, head_sha: tip, status: "completed", ...run },
      ]),
    );
    const byName = Object.fromEntries(
      Object.entries(artifacts).map(([lane, list]) => [
        names[lane as "web" | "docs"],
        { artifacts: list.map(([id, run, expired = 0]) => ({ id, digest, expired: expired === 1, workflow_run: { id: run } })) },
      ]),
    );
    writeFileSync(join(root, "runs.json"), JSON.stringify(runMap));
    writeFileSync(join(root, "artifacts.json"), JSON.stringify(byName));
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
  */actions/artifacts\?name=*) body="$(jq -c --arg n "\${path##*name=}" '.[$n] // {"artifacts":[]}' "${root}/artifacts.json")" ;;
  */jobs*) id="\${path%/jobs*}"; id="\${id##*/}"; body="$(jq -c --arg id "$id" '{jobs: ((.[$id].jobs // []) | map({name: ., conclusion: "success"}))}' "${root}/runs.json")" ;;
  */actions/runs/*) body="$(jq -c --arg id "\${path##*/}" '.[$id]' "${root}/runs.json")" ;;
esac
jq -r "\${filter:-.}" <<<"$body"
`,
    );
    chmodSync(join(root, "gh"), 0o755);
    for (const file of ["output", "summary"]) writeFileSync(join(root, file), "");
    const result = spawnSync("bash", ["-e", resolve("tools/workflows/deploy/find-builds.sh")], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "intar-dev/intar-dev",
        GITHUB_SHA: tip,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        MAIN: tip,
        WEB_INPUTS: "web/**",
        DOCS_INPUTS: "docs/**",
        // A push after the docs commit changed web, not docs.
        BEFORE: env.GITHUB_EVENT_NAME === "push" ? docsCommit : "",
        ...env,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      output: readFileSync(join(root, "output"), "utf8"),
      summary: readFileSync(join(root, "summary"), "utf8"),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
const web = (id: number, run: number) => `web_artifact=${id}\nweb_digest=${digest}\nweb_run=${run}\n`;
const docsBuild = (id: number, run: number) => `docs_artifact=${id}\ndocs_digest=${digest}\ndocs_run=${run}\n`;

it("deploys the newest passing build of main's inputs from a landed merge group or a dispatch from main", () => {
  const runs = {
    76: passed("workflow_dispatch", "main"),
    77: passed("merge_group", queue),
    78: passed("merge_group", `gh-readonly-queue/other/pr-1-${"c".repeat(40)}`),
    79: { ...passed("merge_group", queue), conclusion: "failure" },
    80: passed("pull_request", "main"),
    81: passed("workflow_dispatch", "other"),
    82: { ...passed("merge_group", queue), path: ".github/workflows/other.yml" },
    // A group that never landed: its commit is not on main.
    83: { ...passed("merge_group", queue), head_sha: "d".repeat(40) },
  };
  // [artifact id, run id, expired]
  const list = [[10, 83], [9, 77, 1], [8, 82], [7, 81], [6, 80], [5, 79], [4, 78], [3, 77], [1, 76]];
  for (const event of ["push", "workflow_dispatch", "workflow_run"]) {
    const found = findBuilds({ GITHUB_EVENT_NAME: event }, runs, { web: list, docs: [[2, 76]] });
    expect(found.status, found.stderr).toBe(0);
    expect(found.output).toBe(web(3, 77) + docsBuild(2, 76));
    expect(found.summary).toContain("- web: web-dist-");
  }
});

it("keeps production's build of inputs a push did not change, and fails a dispatch without one", () => {
  const runs = { 77: passed("merge_group", queue) };
  const push = findBuilds({ GITHUB_EVENT_NAME: "push" }, runs, { web: [[3, 77]] });
  expect(push.status, push.stderr).toBe(0);
  expect(push.output).toBe(web(3, 77));
  expect(push.summary).toContain("docs: inputs unchanged");
  const dispatch = findBuilds({}, runs, { web: [[3, 77]] });
  expect(dispatch.status).not.toBe(0);
  expect(dispatch.stderr).toContain("No passing build of docs-dist-");
  expect(dispatch.output).toBe("");
});

it("deploys nothing once main moved on", () => {
  const moved = findBuilds({ MAIN: "c".repeat(40) }, { 77: passed("merge_group", queue) }, { web: [[3, 77]] });
  expect(moved.status, moved.stderr).toBe(0);
  expect(moved.output).toBe("");
});

it("breaks glass with a build whose own lane jobs passed in a run that failed elsewhere", () => {
  // The job names find-builds.sh reads.
  expect(ci.jobs.web!.name).toBeUndefined();
  expect(ci.jobs.docs!.name).toBeUndefined();
  expect(ci.jobs["web-ui"]!.name).toBe("Chromium smoke");
  expect(ci.jobs["web-build"]!.name).toBe("web build");
  // The docs lane is its own build.
  expect(ci.jobs["docs-build"]).toBeUndefined();
  const failed = (jobs: string[]): Run => ({ ...passed("merge_group", queue), conclusion: "failure", jobs });
  const runs = {
    76: passed("merge_group", queue),
    77: failed(["web build"]),
    78: failed(["changes", "web"]),
    79: failed(["web", "Chromium smoke"]),
  };
  const list = { web: [[5, 79], [4, 78], [3, 77], [2, 76]], docs: [[1, 76]] };
  expect(findBuilds({ BREAK_GLASS: "true" }, runs, list).output).toBe(web(5, 79) + docsBuild(1, 76));
  const noSmoke = { ...runs, 79: failed(["web"]) };
  expect(findBuilds({ BREAK_GLASS: "true" }, noSmoke, list).output).toBe(web(3, 77) + docsBuild(1, 76));
  expect(findBuilds({}, runs, list).output).toBe(web(2, 76) + docsBuild(1, 76));
});
