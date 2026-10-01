import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "bun:test";

// tools/workflows/release/deps-commits.py: which dependency fixes in the root
// Cargo.lock release which product.
const root = resolve(import.meta.dir, "../..");
const script = join(root, "tools/workflows/release/deps-commits.py");
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

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// [name, version, dependencies]. A workspace member has no source.
type Package = [string, string, string[]?];
const registry = 'source = "registry+https://github.com/rust-lang/crates.io-index"\n';
const members = new Set(["intar-agent", "stargate-gateway", "intar-xtask"]);

function lock(packages: Package[]) {
  return `version = 4\n${packages
    .map(
      ([name, version, dependencies = []]) =>
        `\n[[package]]\nname = "${name}"\nversion = "${version}"\n` +
        (members.has(name) ? "" : registry) +
        (dependencies.length
          ? `dependencies = [\n${dependencies.map((d) => ` "${d}",\n`).join("")}]\n`
          : ""),
    )
    .join("")}`;
}

// The agent reaches rustls 0.21 through hyper, Stargate uses rustls 0.23, and
// serde belongs to a workspace crate no product ships.
function packages(rustls21 = "0.21.0", rustls23 = "0.23.1", serde = "1.0.0"): Package[] {
  return [
    ["hyper", "1.0.0", [`rustls ${rustls21}`]],
    ["intar-agent", "0.1.0", ["hyper"]],
    ["intar-xtask", "0.1.0", ["serde"]],
    ["rustls", rustls21],
    ["rustls", rustls23],
    ["serde", serde],
    ["stargate-gateway", "0.1.0", [`rustls ${rustls23}`]],
  ];
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "intar-release-deps-"));
  roots.push(repo);
  run("git", ["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "Cargo.toml"), "[workspace]\n");
  writeFileSync(join(repo, "Cargo.lock"), lock(packages()));
  run("git", ["add", "-A"], repo);
  run("git", ["commit", "-q", "-m", "chore(release): agent/v0.1.0"], repo);
  run("git", ["tag", "base"], repo);
  return repo;
}

function commit(repo: string, message: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(repo, path), contents);
  }
  run("git", ["add", "-A"], repo);
  run("git", ["commit", "-q", "-m", message], repo);
  return `${run("git", ["rev-parse", "HEAD"], repo)} ${message}`;
}

function released(repo: string, packageName: string) {
  return run("python3", [script, packageName, "base"], repo);
}

test("a crate in the agent's closure only releases the agent", () => {
  const repo = fixture();
  const fix = commit(repo, "fix(deps): bump rustls 0.21", {
    "Cargo.lock": lock(packages("0.21.1")),
  });
  expect(released(repo, "intar-agent")).toBe(fix);
  expect(released(repo, "stargate-gateway")).toBe("");
});

test("a crate in no product's closure releases nothing", () => {
  const repo = fixture();
  commit(repo, "fix(deps): bump serde", {
    "Cargo.lock": lock(packages(undefined, undefined, "1.0.1")),
  });
  expect(released(repo, "intar-agent")).toBe("");
  expect(released(repo, "stargate-gateway")).toBe("");
});

test("a commit that is not a dependency fix releases nothing", () => {
  const repo = fixture();
  commit(repo, "fix(web): bump rustls 0.23", {
    "Cargo.lock": lock(packages(undefined, "0.23.2")),
  });
  commit(repo, "chore(deps): bump rustls 0.21", {
    "Cargo.lock": lock(packages("0.21.1", "0.23.2")),
  });
  expect(released(repo, "intar-agent")).toBe("");
  expect(released(repo, "stargate-gateway")).toBe("");
});

test("only a dependency fix confined to the root Cargo files counts", () => {
  const repo = fixture();
  commit(repo, "fix(deps): bump rustls 0.23 and devalue", {
    "Cargo.lock": lock(packages(undefined, "0.23.2")),
    "bun.lock": "{}\n",
  });
  const breaking = commit(repo, "feat(deps)!: move to rustls 0.23.3", {
    "Cargo.toml": '[workspace]\ndependencies = { rustls = "0.23.3" }\n',
    "Cargo.lock": lock(packages(undefined, "0.23.3")),
  });
  expect(released(repo, "stargate-gateway")).toBe(breaking);
  expect(released(repo, "intar-agent")).toBe("");
});
