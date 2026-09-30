import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Bun is the CI runtime and supplies the YAML parser; no new dependency.
const parsed = spawnSync("bun", ["-e", 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(".github/workflows/website.yml").text())))'], { encoding: "utf8" });
if (parsed.status !== 0) throw new Error(parsed.stderr);
type Step = { name: string; if?: string; run?: string; with?: Record<string, unknown> };
const workflow = JSON.parse(parsed.stdout) as {
  jobs: Record<string, { if?: string; steps: Step[] }>;
};

// A step runs its body inline or as `cuenv task -p ci --package ci
// website-<name>`, whose body is tools/workflows/website/<name>.sh.
function body(step: Step) {
  const task = /^cuenv task -p ci --package ci website-([a-z0-9-]+)$/.exec(step.run ?? "");
  return task ? readFileSync(`tools/workflows/website/${task[1]}.sh`, "utf8") : step.run;
}

it("parses every workflow shell block", () => {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    const run = body(step);
    if (!run) continue;
    const result = spawnSync("bash", ["-n"], { input: run, encoding: "utf8" });
    expect(result.status, `${step.name}: ${result.stderr}`).toBe(0);
  }
});
