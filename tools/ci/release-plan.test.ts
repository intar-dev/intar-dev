import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "bun:test";

const script = resolve(import.meta.dir, "../workflows/ci/release-plan.sh");
const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true });
});

// The runner's own GITHUB_* variables must not reach the script under test,
// and a developer's git config must not reach the fixture.
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

function git(repo: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, env: baseEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(repo: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
}

// Two products at 1.0.0 on the base, then `files` committed on top. Returns
// the tags the pull request's dry run would build.
function plan(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "intar-release-plan-"));
  roots.push(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, {
    "tools/workflows/release/products.json": JSON.stringify([
      { project: "intar-agent", prefix: "a", manifest: "crates/a/Cargo.toml", paths: ["crates/a/**"] },
      { project: "intar-desktop", prefix: "b", manifest: "crates/b/Cargo.toml", paths: ["crates/b/**"] },
    ]),
    "crates/a/Cargo.toml": '[package]\nversion = "1.0.0"\n',
    "crates/b/Cargo.toml": '[package]\nversion = "1.0.0"\n',
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  write(repo, files);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  const output = join(repo, ".git", "github-output");
  writeFileSync(output, "");
  const result = spawnSync(script, {
    cwd: repo,
    env: { ...baseEnv, BASE_SHA: base, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return (JSON.parse(readFileSync(output, "utf8").replace(/^matrix=/, "")) as { tag: string }[]).map((p) => p.tag);
}

const release = "tools/workflows/release";

test("a product change dry-runs nothing: release.yml builds it after the merge", () => {
  expect(plan({ "crates/a/src/lib.rs": "" })).toEqual([]);
});

test("a change to the shared release build dry-runs every product at its manifest version", () => {
  expect(plan({ [`${release}/build-release-artifacts.sh`]: "#!/bin/sh\n" })).toEqual(["a/v1.0.0", "b/v1.0.0"]);
  expect(plan({ "ci/workflows/release.cue": "", [`${release}/build-jumper-macos.sh`]: "" })).toEqual(["a/v1.0.0", "b/v1.0.0"]);
});

test("a script one product's build alone runs dry-runs that product", () => {
  expect(plan({ [`${release}/build-jumper-macos.sh`]: "#!/bin/sh\n" })).toEqual(["b/v1.0.0"]);
  expect(plan({ [`${release}/privileged-agent-package-smoke.sh`]: "", [`${release}/setup-macos-signing.sh`]: "" })).toEqual(["a/v1.0.0", "b/v1.0.0"]);
});

test("plan and publish scripts dry-run nothing", () => {
  expect(plan({ [`${release}/plan-release.sh`]: "", [`${release}/cliff.toml`]: "" })).toEqual([]);
});
