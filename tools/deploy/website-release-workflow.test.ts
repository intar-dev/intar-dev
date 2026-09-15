import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function read(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

const release = read(".github/workflows/website-release.yml");
const website = read(".github/workflows/website.yml");
const deploy = read(".github/workflows/website-deploy.yml");

function pushPaths(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === "  push:");
  expect(start).toBeGreaterThan(-1);
  const paths: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^ {2}[a-z_]+:/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('- "')) paths.push(trimmed);
  }
  return paths.sort();
}

describe("automatic web release lane", () => {
  it("releases every main commit that builds a website artifact", () => {
    expect(release).toContain("name: Website release");
    expect(release).toContain("      - main");
    expect(release).toContain("  workflow_dispatch:");
    // A deployable artifact always has a lane that releases it: the release
    // paths are the website paths.
    expect(pushPaths(release)).toEqual(pushPaths(website));
  });

  it("lets a push ask for nothing but a routine release", () => {
    const validate = release.slice(
      release.indexOf("name: Validate the release request"),
      release.indexOf("name: Checkout exact main revision"),
    );
    // The push branch refuses a closed release and the delete campaign, so an
    // unattended release can not change the runtime contract or remove
    // registry objects.
    expect(validate).toContain("test \"${REQUESTED_MAINTENANCE}\" = auto");
    expect(validate).toContain("test \"${REQUESTED_CLEANUP_MODE}\" = preserve");
    expect(validate).toContain('test "${CONFIRMATION}" = \'DEPLOY WEB RELEASE\'');
    expect(validate).toContain(
      "REQUESTED_MAINTENANCE: ${{ inputs.maintenance || 'auto' }}",
    );
    expect(validate).toContain(
      "REQUESTED_CLEANUP_MODE: ${{ inputs.registry_cleanup_mode || 'preserve' }}",
    );
  });

  it("waits for a green website run and refuses a red one", () => {
    // The deploy lane refuses an artifact from a run that has not concluded,
    // so the release waits for its own revision and never deploys an
    // unproven artifact.
    expect(release).toContain(
      '/actions/workflows/website.yml/runs?head_sha=${GITHUB_SHA}&per_page=10',
    );
    expect(release).toContain('if [ "${conclusion}" != success ]');
    expect(release).toContain("website_dist_run_id=%s");
  });

  it("takes the ABI pin from a verified build, strictly for a closed release", () => {
    const pin = release.slice(
      release.indexOf("name: Resolve the verified guest-tools pin"),
      release.indexOf("name: Activate the D1 upload admission switch"),
    );
    expect(pin).toContain("guest-tools-deploy.yml/runs?branch=main&status=success");
    expect(pin).toContain('if [ "${MAINTENANCE_MODE}" = auto ]');
    // The closed path adds the exact revision, which is the ABI rule.
    expect(pin).toContain(".head_sha == $sha and");
    expect(pin).toContain("tools/deploy/guest-tools-pin.ts release");
    expect(pin).toContain("tools/deploy/guest-tools-pin.ts check");
    expect(pin).toContain('jq -e \'.schema_version == 1 and .bootstrap_abi == 2\'');
  });

  it("deploys the tested artifact through the deploy lane", () => {
    const deployJob = release.slice(
      release.indexOf("  deploy:"),
    );
    expect(deployJob).toContain("uses: ./.github/workflows/website-deploy.yml");
    expect(deployJob).toContain(
      "guest_tools_static_pin_json: ${{ needs.plan.outputs.static_pin_json }}",
    );
    expect(deployJob).toContain("maintenance: ${{ needs.plan.outputs.maintenance }}");
    expect(deployJob).toContain(
      "registry_cleanup_mode: ${{ needs.plan.outputs.registry_cleanup_mode }}",
    );
    expect(deployJob).toContain(
      "website_dist_run_id: ${{ needs.plan.outputs.website_dist_run_id }}",
    );
    expect(deployJob).toContain("secrets: inherit");
  });

  it("activates the D1 admission switch before the plane closes", () => {
    const activation = release.indexOf(
      "Activate the D1 upload admission switch for a delete release",
    );
    const deployJob = release.indexOf("uses: ./.github/workflows/website-deploy.yml");
    expect(activation).toBeGreaterThan(-1);
    expect(deployJob).toBeGreaterThan(activation);
    expect(release.slice(activation)).toContain(
      "tools/deploy/registry-cleanup-activation.sh enforce",
    );
  });

  it("accepts the release lane as the only caller", () => {
    expect(deploy).toContain(
      "intar-dev/intar-dev/.github/workflows/website-release.yml@refs/heads/main",
    );
    expect(deploy).toContain("push|workflow_dispatch) ;;");
    expect(deploy).not.toContain("website-cutover.yml");
    // The validation lane uploads an artifact and still never deploys.
    expect(website).not.toContain(
      "uses: ./.github/workflows/website-deploy.yml",
    );
  });
});
