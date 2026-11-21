import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "../workflows/website/check-scenario-publish-refs.sh");

let dir: string;
let remote: string;
let first: string;
let second: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", remote, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { encoding: "utf8" }).trim();

/** Runs the check against a built configuration with these variables. */
function check(vars: Record<string, string>) {
  const config = join(dir, "wrangler.json");
  writeFileSync(config, JSON.stringify({ vars }));
  const result = spawnSync("bash", [script, config], {
    encoding: "utf8", env: { ...process.env, SCENARIO_PUBLISH_REMOTE: remote },
  });
  return { status: result.status, stderr: result.stderr.trim() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "scenario-publish-refs-"));
  remote = join(dir, "remote");
  execFileSync("git", ["init", "-q", remote]);
  git("commit", "-q", "--allow-empty", "-m", "one");
  first = git("rev-parse", "HEAD");
  // An annotated tag: its own object is not the commit it names.
  git("tag", "-a", "scenario-publish-v1", "-m", "v1");
  git("commit", "-q", "--allow-empty", "-m", "two");
  second = git("rev-parse", "HEAD");
  git("tag", "scenario-publish-v2");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the scenario-publish refs the source card shows", () => {
  it("pass when each resolves to a commit on the list: an annotated tag, a lightweight one, a commit", () => {
    expect(check({ SCENARIO_PUBLISH_WORKFLOW_REF: "scenario-publish-v1", SCENARIO_PUBLISH_WORKFLOW_SHAS: first })).toEqual({ status: 0, stderr: "" });
    expect(check({
      SCENARIO_PUBLISH_WORKFLOW_REF: "scenario-publish-v1", SCENARIO_PUBLISH_PIPELINE_WORKFLOW_REF: "scenario-publish-v2",
      SCENARIO_PUBLISH_WORKFLOW_SHAS: `${second}, ${first}`,
    }).status).toBe(0);
    expect(check({
      SCENARIO_PUBLISH_WORKFLOW_REF: "scenario-publish-v1", SCENARIO_PUBLISH_PIPELINE_WORKFLOW_REF: second,
      SCENARIO_PUBLISH_WORKFLOW_SHAS: `${first} ${second}`,
    }).status).toBe(0);
    // An empty pipeline ref is "not released yet".
    expect(check({
      SCENARIO_PUBLISH_WORKFLOW_REF: "scenario-publish-v1", SCENARIO_PUBLISH_PIPELINE_WORKFLOW_REF: "",
      SCENARIO_PUBLISH_WORKFLOW_SHAS: first,
    }).status).toBe(0);
  });

  it("fail when a tag resolves to a commit the list does not name", () => {
    const tagObject = git("rev-parse", "refs/tags/scenario-publish-v1");
    expect(tagObject).not.toBe(first);
    for (const shas of [second, tagObject, ""]) {
      const result = check({ SCENARIO_PUBLISH_WORKFLOW_REF: "scenario-publish-v1", SCENARIO_PUBLISH_WORKFLOW_SHAS: shas });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        `the scenario-publish ref scenario-publish-v1 resolves to ${first}, which SCENARIO_PUBLISH_WORKFLOW_SHAS does not list`,
      );
    }
    expect(check({
      SCENARIO_PUBLISH_WORKFLOW_REF: "scenario-publish-v1", SCENARIO_PUBLISH_PIPELINE_WORKFLOW_REF: "scenario-publish-v2",
      SCENARIO_PUBLISH_WORKFLOW_SHAS: first,
    }).stderr).toContain("scenario-publish-v2 resolves to");
  });

  it("fail for a tag that does not exist, a ref of another shape, a commit off the list, and no ref at all", () => {
    expect(check({ SCENARIO_PUBLISH_WORKFLOW_REF: "scenario-publish-v9", SCENARIO_PUBLISH_WORKFLOW_SHAS: first }).stderr)
      .toContain("is not a tag on");
    expect(check({ SCENARIO_PUBLISH_WORKFLOW_REF: "main", SCENARIO_PUBLISH_WORKFLOW_SHAS: first }).stderr)
      .toContain("neither a scenario-publish-vN tag nor a commit");
    expect(check({ SCENARIO_PUBLISH_WORKFLOW_REF: second, SCENARIO_PUBLISH_WORKFLOW_SHAS: first }).status).toBe(1);
    expect(check({ SCENARIO_PUBLISH_WORKFLOW_SHAS: first }).stderr).toContain("names no scenario-publish workflow ref");
  });
});
