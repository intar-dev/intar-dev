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
    expect(guestTools).toContain("cargo test --locked -p intar-workspace-agent -p kino");
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

  it("publishes Scenario source bundles only from the image workflow", () => {
    expect(images).toContain("push:\n    branches:\n      - main");
    expect(images).toContain("Publish exact scenario source bundle");
    expect(images).toContain("just bundle-images");
    expect(images).toContain("INTAR_IMAGE_PUBLISH_TOKEN");
    expect(`${website}\n${websiteDeploy}`).not.toContain("bundle-images");
  });
});

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}
