import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test } from "bun:test";

const script = resolve(import.meta.dir, "check-pr-title.sh");
const cwd = mkdtempSync(join(tmpdir(), "intar-pr-title-"));
afterAll(() => rmSync(cwd, { force: true, recursive: true }));

function check(title: string) {
  return spawnSync(script, {
    cwd,
    env: { PATH: process.env.PATH ?? "", PR_TITLE: title },
  }).status;
}

test.each([
  "feat(intar-agent): add a disk probe",
  "fix(web)!: drop the legacy session route",
  "refactor(apps/web): split the loader",
  "revert(ci): drop the redundant workflow syntax checker",
  "fix(deps): upgrade rustls for RUSTSEC-2026-0285",
  // update-release-pr.sh, web-pins.sh, and Dependabot (.github/dependabot.yml).
  "chore(release): agent/v0.15.0, builder/v0.3.1",
  "chore(web): pin the scenario compiler to intar-image-cli 0.14.0",
  "ci(deps): bump the actions group across 2 directories with 3 updates",
  "ci(deps): [security] bump actions/checkout from 6.0.0 to 6.0.1",
])("accepts %p", (title) => {
  expect(check(title)).toBe(0);
});

test.each([
  "",
  "Fix(web): capital type",
  "feature(web): unknown type",
  "fix: no scope",
  "fix(): empty scope",
  "fix(web,docs): two scopes",
  "fix(web)(docs): two scopes",
  "fix(Web): capital scope",
  "fix(web): Capital subject",
  "fix(web):no space",
  "fix(web):  two spaces",
  "fix(web): ",
  "fix(web)!!: two bangs",
  " fix(web): leading space",
  "fix(web): one line\nfeat(web): another",
  "fix(web): carriage\rreturn",
  "::error::fix(web): workflow command",
])("rejects %p", (title) => {
  expect(check(title)).toBe(1);
});

test("a title is data, never script text", () => {
  const marker = join(cwd, "pwned");
  for (const title of [
    `fix(web): $(touch ${marker}) \`touch ${marker}\` \${{ github.token }}`,
    `$(touch ${marker})`,
    `fix(web): x"; touch ${marker}; echo "`,
  ]) {
    check(title);
  }
  expect(existsSync(marker)).toBe(false);
});
