import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const guestTools = read(".github/workflows/guest-tools.yml");
const images = read(".github/workflows/images.yml");
const website = read(".github/workflows/website.yml");
const websiteDeploy = read(".github/workflows/website-deploy.yml");
const release = read(".github/workflows/release.yml");
const cleanBase = read(".github/workflows/workshop-clean-base.yml");

describe("guest-tool publication workflow", () => {
  it("owns guest-tool validation and automatic main publication", () => {
    expect(guestTools).toContain("name: Guest tools");
    expect(guestTools).toContain("push:\n    branches:\n      - main");
    expect(guestTools).toContain('      - "crates/intar-workspace-agent/**"');
    expect(guestTools).toContain('      - "crates/kino/**"');
    expect(guestTools).toContain(
      "cargo test --locked -p intar-workspace-agent -p kino",
    );
    expect(guestTools).toContain("Publish content-addressed guest tools");
    expect(guestTools).toContain("Publish current guest-tool manifest");
    expect(guestTools).toContain(
      "production-workshop-guest-tools-${{ github.sha }}",
    );
  });

  it("keeps guest-tool work out of both website jobs", () => {
    const web = `${website}\n${websiteDeploy}`;
    expect(web).not.toContain("intar-workspace-agent");
    expect(web).not.toContain("production-workshop-guest-tools");
    expect(web).not.toContain("workspace-agent/releases/current.json");
  });

  it("makes downstream consumers trust the dedicated push workflow", () => {
    expect(release).toContain(
      'test "${run_path}" = ".github/workflows/guest-tools.yml"',
    );
    expect(release).toContain('[ "${run_event}" != "push" ]');
    expect(release).toContain('.event == "push"');
    expect(cleanBase).toContain('.path == ".github/workflows/website.yml"');
    expect(cleanBase).toContain('.path == ".github/workflows/guest-tools.yml"');
  });

  it("keeps Namespace caches off the dedicated agent release runner", () => {
    expect(release).toContain(
      "- name: Set up Namespace caches\n        if: inputs.project != 'intar-agent' && steps.next.outputs.resume != 'true'",
    );
    expect(release).toContain(
      "- name: Restore shared Bun cache\n        if: inputs.project != 'intar-agent' && steps.next.outputs.resume != 'true'",
    );
  });

  it("keeps the main-repository image workflow validation-only", () => {
    expect(images).toContain("push:\n    branches:\n      - main");
    expect(images).toContain("Validate curriculum source");
    expect(images).toContain("just validate-images");
    expect(images).toContain("just render-images");
    expect(images).not.toContain("bundle-images");
    expect(images).not.toContain("INTAR_IMAGE_PUBLISH_TOKEN");
    expect(images).not.toContain("Publish exact scenario source bundle");
    expect(`${website}\n${websiteDeploy}`).not.toContain("bundle-images");
  });
});

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}
