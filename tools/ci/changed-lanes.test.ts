import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "../..");
const script = join(root, "tools/ci/changed-lanes.sh");
const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true });
});

// The runner's own GITHUB_* variables must not reach the script under test,
// and a developer's git config (signing, hooks) must not reach the fixture.
const baseEnv: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith("GITHUB_") && !key.startsWith("GIT_")) {
    baseEnv[key] = value;
  }
}

function run(command: string, args: string[], cwd: string, env = baseEnv) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// The lanes exactly as ci.yml's changes job passes them.
const tasks = JSON.parse(run("cuenv", ["task", "-o", "json"], root)) as {
  name: string;
  node: { args: string[] };
}[];
const lanes = tasks.find((task) => task.name === "ci-changes")!.node.args;

function write(repo: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
}

// A repository whose main holds a file for every lane, and a pull request
// branch that changes `files`, committed by `author`. Returns the base commit.
const releaseApp = "intar-release[bot] <336463729+intar-release[bot]@users.noreply.github.com>";
function fixture(files: Record<string, string>, author = "test <test@example.invalid>") {
  const repo = mkdtempSync(join(tmpdir(), "intar-changed-lanes-"));
  roots.push(repo);
  run("git", ["init", "-q", "-b", "main"], repo);
  write(repo, {
    "Cargo.toml": "[workspace]\n",
    "crates/kino/Cargo.toml": "[package]\n",
    "docs/src/index.md": "# Docs\n",
    "apps/web/src/index.ts": "export {};\n",
  });
  run("git", ["add", "-A"], repo);
  run("git", ["commit", "-q", "-m", "base"], repo);
  const base = run("git", ["rev-parse", "HEAD"], repo);
  run("git", ["checkout", "-q", "-b", "pr"], repo);
  write(repo, files);
  run("git", ["add", "-A"], repo);
  run("git", ["commit", "-q", "-m", "change", `--author=${author}`], repo);
  return { repo, base };
}

// GitHub checks a pull request out as the merge into its base branch.
function mergeCheckout(repo: string) {
  run("git", ["checkout", "-q", "--detach", "main"], repo);
  run("git", ["merge", "-q", "--no-ff", "--no-edit", "pr"], repo);
}

function changedLanes(repo: string, env: Record<string, string>, args = lanes) {
  const output = join(repo, ".git", "github-output");
  writeFileSync(output, "");
  run(script, args, repo, { ...baseEnv, GITHUB_OUTPUT: output, ...env });
  return Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

test("a docs-only pull request runs only the docs lane", () => {
  const { repo, base } = fixture({ "docs/src/index.md": "# Changed\n" });
  mergeCheckout(repo);
  expect(changedLanes(repo, { GITHUB_EVENT_NAME: "pull_request" })).toEqual({
    base,
    rust: "false",
    security: "false",
    images: "false",
    web: "false",
    kino: "false",
    docs: "true",
  });
});

test("a change to the lane definitions runs every lane", () => {
  const { repo } = fixture({ "ci/workflows/lanes.cue": "package workflows\n" });
  mergeCheckout(repo);
  const selected = changedLanes(repo, { GITHUB_EVENT_NAME: "pull_request" });
  delete selected.base;
  expect(Object.values(selected)).toEqual(lanes.map(() => "true"));
});

test("**/ globs match at the root and below it", () => {
  const spec = ["cargo **/Cargo.toml", "crates crates/**", "web apps/web/**"];
  for (const [path, expected] of [
    ["Cargo.toml", { cargo: "true", crates: "false", web: "false" }],
    ["crates/kino/Cargo.toml", { cargo: "true", crates: "true", web: "false" }],
  ] as const) {
    const { repo } = fixture({ [path]: "[changed]\n" });
    mergeCheckout(repo);
    const selected = changedLanes(repo, { GITHUB_EVENT_NAME: "pull_request" }, spec);
    delete selected.base;
    expect(selected).toEqual(expected);
  }
});

test("a dispatch runs every lane", () => {
  const { repo } = fixture({ "docs/src/index.md": "# Changed\n" });
  const selected = changedLanes(repo, { GITHUB_EVENT_NAME: "workflow_dispatch" });
  expect(selected.base).toBeUndefined();
  expect(Object.values(selected)).toEqual(lanes.map(() => "true"));
});

test("the release app's release pull request and the daily run select no lane", () => {
  const { repo } = fixture({ "crates/kino/Cargo.toml": "[package]\nversion = \"1.0.0\"\n" }, releaseApp);
  mergeCheckout(repo);
  for (const env of [
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "release/next" },
    { GITHUB_EVENT_NAME: "schedule" },
  ]) {
    const selected = changedLanes(repo, env);
    delete selected.base;
    expect(Object.values(selected)).toEqual(lanes.map(() => "false"));
  }
});

test("a branch named release/next that the release app did not commit runs its lanes", () => {
  const { repo } = fixture({ "docs/src/index.md": "# Changed\n" });
  mergeCheckout(repo);
  expect(changedLanes(repo, { GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "release/next" })).toMatchObject({
    docs: "true",
  });
});

test("without a merge checkout the base is the event's base sha", () => {
  const { repo, base } = fixture({ "docs/src/index.md": "# Changed\n" });
  const event = join(repo, ".git", "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base } } }));
  const selected = changedLanes(repo, {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: event,
  });
  expect(selected).toMatchObject({ base, docs: "true", web: "false" });
});

test("a merge group without its pull request head runs every lane the group changed", () => {
  const { repo, base } = fixture({ "docs/src/index.md": "# Changed\n" });
  const event = join(repo, ".git", "event.json");
  writeFileSync(event, JSON.stringify({ merge_group: { base_sha: base } }));
  const selected = changedLanes(repo, {
    GITHUB_EVENT_NAME: "merge_group",
    GITHUB_EVENT_PATH: event,
  });
  expect(selected).toMatchObject({ base, docs: "true", docs_touched: "true", web: "false", web_touched: "false" });
});

// main at `base`; the pull request branched there and changed docs, as
// `author`; main then moved on with each of `mainCommits`; the queue squashes
// the pull request onto main's tip. GitHub's refs/pull/7/head is `head`, the
// pull request's head unless given. Returns the lanes the merge group runs.
function queued(mainCommits: Record<string, string | null>[], options: { author?: string; head?: string } = {}) {
  const { repo } = fixture({ "docs/src/index.md": "# Changed\n" }, options.author);
  run("git", ["update-ref", "refs/pull/7/head", options.head ?? "pr"], repo);
  run("git", ["remote", "add", "origin", repo], repo);
  run("git", ["checkout", "-q", "main"], repo);
  for (const files of mainCommits) {
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) rmSync(join(repo, path));
      else write(repo, { [path]: contents });
    }
    run("git", ["add", "-A"], repo);
    run("git", ["commit", "-q", "--allow-empty", "-m", "main moved on"], repo);
  }
  const tip = run("git", ["rev-parse", "HEAD"], repo);
  run("git", ["merge", "-q", "--squash", "pr"], repo);
  run("git", ["commit", "-q", "-m", "fix(docs): change (#7)"], repo);
  const event = join(repo, ".git", "event.json");
  writeFileSync(
    event,
    JSON.stringify({ merge_group: { base_sha: tip, head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${tip}` } }),
  );
  const selected = changedLanes(repo, { GITHUB_EVENT_NAME: "merge_group", GITHUB_EVENT_PATH: event });
  expect(selected.base).toBe(tip);
  expect(selected.docs_touched).toBe("true");
  return selected;
}
const webMoved = [{ "apps/web/src/index.ts": "export const later = true;\n" }];

test("a merge group skips a lane its pull request's run checked against the same inputs", () => {
  expect(queued(webMoved)).toMatchObject({ docs: "false", web: "false", web_touched: "false" });
});

test("a merge group reruns a lane whose inputs main changed since the pull request's merge base", () => {
  expect(queued([{ "docs/src/other.md": "# Later\n" }])).toMatchObject({ docs: "true", web: "false" });
});

test("a merge group reruns a lane main changed and reverted since: the pull request's run may have seen it", () => {
  const reverted = queued([{ "docs/src/other.md": "# Later\n" }, { "docs/src/other.md": null }]);
  expect(reverted).toMatchObject({ docs: "true" });
});

test("a merge group runs every lane it changed when the pull request head does not give its tree", () => {
  expect(queued(webMoved, { head: "main" })).toMatchObject({ docs: "true", web: "false" });
});

test("a merge group runs every lane the release app's pull request changed", () => {
  expect(queued(webMoved, { author: releaseApp })).toMatchObject({ docs: "true", web: "false" });
});

test("a local run compares the working tree with the merge base of origin/main", () => {
  const { repo } = fixture({ "docs/src/index.md": "# Changed\n" });
  run("git", ["update-ref", "refs/remotes/origin/main", "main"], repo);
  write(repo, { "apps/web/src/index.ts": "export const changed = true;\n" });
  const output = run(script, lanes, repo);
  expect(output.split("\n")).toEqual([
    "rust=false",
    "security=false",
    "images=false",
    "web=true",
    "kino=false",
    "docs=true",
  ]);
});
