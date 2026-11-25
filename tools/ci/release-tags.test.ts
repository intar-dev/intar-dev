import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "bun:test";

// release.yml's plan-release.sh and publish-tagged-github-release.sh in a
// scratch repository. git and deps-commits.py are real; gh and git-cliff are
// stand-ins that read the releases from releases.json and log their calls.
const tools = resolve(import.meta.dir, "../workflows/release");
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true });
});

const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// Product a, tagged a/v1.0.0 on the first commit, with a commit on top.
// `releases` is each tag's release state: "draft" or "published".
function fixture(releases: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "intar-release-tags-"));
  roots.push(root);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(repo, "tools/workflows/release"), { recursive: true });
  mkdirSync(join(repo, "crates/a"), { recursive: true });
  mkdirSync(bin);
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", origin);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  writeFileSync(join(repo, "tools/workflows/release/products.json"), JSON.stringify([
    { project: "a", prefix: "a", package: "a", binary: "a", manifest: "crates/a/Cargo.toml", runner: "r", paths: ["crates/a/**"] },
  ]));
  for (const file of ["deps-commits.py", "cliff.toml"]) {
    writeFileSync(join(repo, "tools/workflows/release", file), readFileSync(join(tools, file)));
  }
  writeFileSync(join(repo, "Cargo.toml"), "[workspace]\n");
  writeFileSync(join(repo, "Cargo.lock"), "version = 4\n");
  writeFileSync(join(repo, "crates/a/Cargo.toml"), '[package]\nname = "a"\nversion = "1.0.0"\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feat(a): first");
  git(repo, "tag", "-a", "a/v1.0.0", "-m", "a v1.0.0");
  writeFileSync(join(repo, "crates/a/lib.rs"), "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fix(a): second");
  git(repo, "push", "-q", "origin", "main", "--tags");
  git(repo, "fetch", "-q", "origin");
  writeFileSync(join(root, "releases.json"), JSON.stringify(releases));
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // `release view TAG --json isDraft --jq …` answers draft or published, or fails.
  script("gh", `echo "gh $*" >> "${root}/calls.log"
state() { jq -r --arg tag "$1" '.[$tag] // empty' "${root}/releases.json"; }
case "$1 $2" in
  "release view") s="$(state "$3")"; [ -n "$s" ] || exit 1
    case "$*" in *isDraft,isPrerelease,name*) echo '[false,false,"a v1.1.0"]' ;;
      *"--json assets"*) ;;
      *) [ "$s" = draft ] && echo draft || echo published ;; esac ;;
  "release list") ;;
  "api repos/"*) echo true ;;
  "auth setup-git") ;;
  *) ;;
esac`);
  script("git-cliff", `echo "git-cliff $*" >> "${root}/calls.log"
case "$*" in *--bumped-version*) echo "\${CLIFF_NEXT}" ;; *) echo "### Fixes" ;; esac`);
  return { root, repo, bin, head: git(repo, "rev-parse", "HEAD") };
}

function plan(fixtureRoot: ReturnType<typeof fixture>, next: string) {
  const output = join(fixtureRoot.root, "output");
  writeFileSync(output, "");
  const ran = spawnSync("bash", [join(tools, "plan-release.sh")], {
    cwd: fixtureRoot.repo,
    encoding: "utf8",
    env: { ...env, PATH: `${fixtureRoot.bin}:${env.PATH}`, GITHUB_SHA: fixtureRoot.head, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "o/r", CLIFF_NEXT: next },
  });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return {
    matrix: JSON.parse(readFileSync(output, "utf8").replace(/^matrix=/, "")) as Record<string, unknown>[],
    calls: readFileSync(join(fixtureRoot.root, "calls.log"), "utf8"),
  };
}

test("a releasable commit plans the next version from this commit, as a draft, and tags nothing", () => {
  const f = fixture({ "a/v1.0.0": "published" });
  const { matrix, calls } = plan(f, "a/v1.0.1");
  expect(matrix).toEqual([expect.objectContaining({ tag: "a/v1.0.1", version: "1.0.1", ref: f.head, create_tag: true, ci_passed: true })]);
  expect(calls).toContain(`gh release create a/v1.0.1 --draft --target ${f.head}`);
  expect(git(f.repo, "tag", "--list", "a/v1.0.1")).toBe("");
});

test("nothing to release plans nothing", () => {
  const f = fixture({ "a/v1.0.0": "published" });
  expect(plan(f, "a/v1.0.0").matrix).toEqual([]);
});

test("a tag whose publish failed is rebuilt from that tag", () => {
  const f = fixture({ "a/v1.0.0": "draft" });
  const tagged = git(f.repo, "rev-parse", "a/v1.0.0^{commit}");
  expect(plan(f, "a/v1.0.1").matrix).toEqual([
    expect.objectContaining({ tag: "a/v1.0.0", version: "1.0.0", ref: tagged, create_tag: false }),
  ]);
});

function publish(f: ReturnType<typeof fixture>, tag: string, ref: string) {
  mkdirSync(join(f.repo, "dist"), { recursive: true });
  writeFileSync(join(f.repo, "dist/a_1.1.0_checksums.txt"), "x\n");
  return spawnSync("bash", [join(tools, "publish-tagged-github-release.sh")], {
    cwd: f.repo,
    encoding: "utf8",
    env: {
      ...env, PATH: `${f.bin}:${env.PATH}`, TAG: tag, VERSION: tag.split("/v")[1]!, REF: ref, CREATE_TAG: "true", TITLE: "a v1.1.0",
    },
  });
}

test("publish tags a new version only above the product's latest tag", () => {
  const f = fixture({ "a/v1.0.0": "published" });
  // A version at or below the latest tag is refused, and tags nothing.
  const stale = publish(f, "a/v0.9.0", f.head);
  expect(stale.status).not.toBe(0);
  expect(stale.stderr).toContain("is not above a/v1.0.0");
  expect(git(f.repo, "tag", "--list", "a/v0.9.0")).toBe("");
  // A commit the latest tag is not an ancestor of is refused.
  const before = git(f.repo, "rev-parse", "HEAD^");
  git(f.repo, "tag", "-a", "a/v1.0.5", f.head, "-m", "a v1.0.5");
  const behind = publish(f, "a/v1.1.0", before);
  expect(behind.status).not.toBe(0);
  expect(behind.stderr).toContain("a/v1.0.5 is not an ancestor");
});
