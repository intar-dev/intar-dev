import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";

// web-pins.sh in a scratch repository: git, tar, sha256sum and the Kino
// artifact builder are real; gh, the push and the wrangler type run are stand-ins.
const COMPILER = 'pub const SOURCE_COMPILER_VERSION_V2: &str = "intar-source-compiler-v2";\n';
const CONTRACT = "pub const GUEST_CONTRACT: u32 = 3;\n";

function run(tags: { cli: "old" | "current"; kino: "old" | "current" }) {
  const root = mkdtempSync(join(tmpdir(), "intar-web-pins-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const release = join(root, "release");
  const write = (path: string, body: string | Uint8Array) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  const git = (...args: string[]) => {
    const ran = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (ran.status !== 0) throw new Error(ran.stderr);
    return ran.stdout.trim();
  };
  const script = (name: string, body: string) => {
    write(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  try {
    write(join(repo, "crates/intar-image-cli/Cargo.toml"), 'version = "0.11.0"\n');
    write(join(repo, "crates/kino/Cargo.toml"), 'version = "0.6.0"\n');
    write(join(repo, "apps/web/wrangler.jsonc"),
      '{\n  "vars": {\n    "SCENARIO_COMPILER_CLI_VERSION": "",\n    "SCENARIO_COMPILER_CLI_SHA256": "",\n  },\n}\n');
    write(join(repo, "apps/web/worker-configuration.d.ts"), "// types\n");
    write(join(repo, "tools/deploy/kino-artifact.ts"), readFileSync("tools/deploy/kino-artifact.ts"));
    write(join(repo, "tools/workflows/release/web-pins.sh"), readFileSync("tools/workflows/release/web-pins.sh"));
    write(join(repo, "tools/workflows/release/push-bot-branch.sh"), `#!/usr/bin/env bash\necho "push $1" >> "${root}/gh.log"\n`);
    chmodSync(join(repo, "tools/workflows/release/push-bot-branch.sh"), 0o755);
    write(join(repo, "crates/intar-contracts/src/source.rs"), "// the retired compiler\n");
    write(join(repo, "crates/intar-contracts/src/guest.rs"), "// no contract\n");
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "old");
    const old = git("rev-parse", "HEAD");
    write(join(repo, "crates/intar-contracts/src/source.rs"), COMPILER);
    write(join(repo, "crates/intar-contracts/src/guest.rs"), CONTRACT);
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "current");
    git("tag", "image-cli/v0.11.0", tags.cli === "old" ? old : "HEAD");
    git("tag", "kino/v0.6.0", tags.kino === "old" ? old : "HEAD");

    write(join(release, "kino"), "\x7fELF a static kino");
    spawnSync("tar", ["-czf", join(release, "kino_0.6.0_linux_amd64.tar.gz"), "-C", release, "./kino"]);
    const sum = (file: string) => createHash("sha256").update(readFileSync(join(release, file))).digest("hex");
    write(join(release, "kino_0.6.0_checksums.txt"), `${sum("kino_0.6.0_linux_amd64.tar.gz")}  kino_0.6.0_linux_amd64.tar.gz\n`);
    write(join(release, "intar-image-cli_0.11.0_checksums.txt"),
      `${"a".repeat(64)}  intar-image-cli_0.11.0_linux_amd64.tar.gz\n${"b".repeat(64)}  intar-image-cli_0.11.0_linux_arm64.tar.gz\n`);
    script("gh", `echo "$*" >> "${root}/gh.log"
case "$1 $2" in
  "api repos/owner/repo/commits/main") echo "$GITHUB_SHA" ;;
  "api users/"*) echo 1 ;;
  "release view") echo false ;;
  "release download") dir=. out=""; pats=()
    while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift ;; --output) out="$2"; shift ;; --pattern) pats+=("$2"); shift ;; esac; shift; done
    for p in "\${pats[@]}"; do if [ -n "$out" ]; then cp "${release}/$p" "$out"; else cp "${release}/$p" "$dir"; fi; done ;;
  "pr list") ;;
esac`);
    script("bun", `case "$1" in install) ;; run) echo "// regenerated" >> apps/web/worker-configuration.d.ts ;; *) exec "${process.execPath}" "$@" ;; esac`);
    const ran = spawnSync("bash", ["tools/workflows/release/web-pins.sh"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SHA: git("rev-parse", "HEAD"), APP_SLUG: "bot",
      },
    });
    const gh = existsSync(join(root, "gh.log")) ? readFileSync(join(root, "gh.log"), "utf8") : "";
    return {
      status: ran.status,
      output: ran.stdout + ran.stderr,
      gh,
      committed: git("log", "-1", "--format=%s"),
      files: git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean),
      wrangler: readFileSync(join(repo, "apps/web/wrangler.jsonc"), "utf8"),
      pin: existsSync(join(repo, "tools/deploy/kino-pin.json")) ? readFileSync(join(repo, "tools/deploy/kino-pin.json"), "utf8") : null,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test("skips releases built for another contract and leaves the pins as they are", () => {
  const ran = run({ cli: "old", kino: "old" });
  expect(ran.status, ran.output).toBe(0);
  expect(ran.output).toContain("image-cli/v0.11.0 does not compile intar-source-compiler-v2");
  expect(ran.output).toContain("kino/v0.6.0 is not built for guest contract 3");
  expect(ran.wrangler).toContain('"SCENARIO_COMPILER_CLI_VERSION": "",');
  expect(ran.pin).toBeNull();
  expect(ran.gh).not.toContain("release download");
  expect(ran.committed).toBe("current");
});

test("commits a compiler pin alone when there is no Kino pin file", () => {
  const ran = run({ cli: "current", kino: "old" });
  expect(ran.status, ran.output).toBe(0);
  expect(ran.committed).toBe("chore(web): pin the scenario compiler to intar-image-cli 0.11.0");
  expect(ran.files).toEqual(["apps/web/worker-configuration.d.ts", "apps/web/wrangler.jsonc"]);
  expect(ran.wrangler).toContain('"SCENARIO_COMPILER_CLI_VERSION": "0.11.0",');
  expect(ran.pin).toBeNull();
  expect(ran.gh).toContain("pr create");
});

test("pins both when both releases match HEAD's contracts", () => {
  const ran = run({ cli: "current", kino: "current" });
  expect(ran.status, ran.output).toBe(0);
  expect(ran.files).toContain("tools/deploy/kino-pin.json");
  expect(ran.pin).toMatch(/^\{"3":\{"current":"sha256:[0-9a-f]{64}","previous":null\}\}\n$/);
  expect(ran.committed).toStartWith("chore(web): pin the scenario compiler to intar-image-cli 0.11.0 and kino 0.6.0");
});
