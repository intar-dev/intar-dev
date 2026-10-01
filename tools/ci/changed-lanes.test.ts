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
// branch that changes `files`. Returns the base commit.
function fixture(files: Record<string, string>) {
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
  run("git", ["commit", "-q", "-m", "change"], repo);
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

test("a push or a dispatch runs every lane", () => {
  const { repo } = fixture({ "docs/src/index.md": "# Changed\n" });
  for (const event of ["push", "workflow_dispatch"]) {
    const selected = changedLanes(repo, { GITHUB_EVENT_NAME: event });
    expect(selected.base).toBeUndefined();
    expect(Object.values(selected)).toEqual(lanes.map(() => "true"));
  }
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
    "docs=true",
  ]);
});
