import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function workflow(name: string): string {
  return readFileSync(
    resolve(repositoryRoot, ".github/workflows", name),
    "utf8",
  );
}

const PLANE_ENDPOINTS = ["intar.dev/registry/", "intar.dev/api/"];

interface Phase {
  id: string;
  workflow: string;
  requires: string[];
  plane: "none" | "required";
  /** The workflow that talks to the plane, when the phase delegates. */
  planeWorkflow?: string;
  marks: string[];
}

/**
 * The no-compatibility rollout order. A phase may only run after every phase
 * it requires, and a phase marked plane "none" must not call the control
 * plane at all: it has to be able to run while the previous ABI is still
 * serving. This is what breaks the cycle that a naive order creates, where
 * the tools promotion waits on the new plane and the new plane waits on the
 * tools promotion.
 */
const PHASES: Phase[] = [
  {
    id: "gate-drain",
    workflow: "image-gate.yml",
    requires: [],
    plane: "required",
    marks: ["SET IMAGE GATE DRAINED"],
  },
  {
    id: "tools-build",
    workflow: "guest-tools-deploy.yml",
    requires: ["gate-drain"],
    plane: "none",
    marks: ["Upload candidate objects", "Verify uploaded objects by re-download"],
  },
  {
    id: "web-release-closed",
    workflow: "website-release.yml",
    requires: ["tools-build"],
    plane: "required",
    // The release lane delegates every plane call to the deploy lane.
    planeWorkflow: "website-deploy.yml",
    marks: ["DEPLOY WEB RELEASE", "on holds the control plane closed"],
  },
  {
    // The cutover lane deploys the collector and the parent that binds it. The
    // bootstrap order inside that lane is: the parent with MaintenanceState and
    // no binding, the collector, the parent with the binding. Promotion waits
    // for the lane because its endpoint deletes retired registry artifacts
    // through the collector service binding.
    id: "registry-cleanup-deploy",
    workflow: "website-deploy.yml",
    requires: ["web-release-closed"],
    plane: "required",
    marks: [
      "Deploy the parent revision for the first cleanup rollout",
      "Deploy the image registry cleanup worker",
    ],
  },
  {
    id: "tools-promote",
    workflow: "guest-tools-promote.yml",
    requires: ["registry-cleanup-deploy"],
    plane: "required",
    marks: ["PROMOTE GUEST TOOLS", "guest-tools/promote"],
  },
  {
    id: "web-release-open",
    workflow: "website-release.yml",
    requires: ["tools-promote"],
    plane: "required",
    planeWorkflow: "website-deploy.yml",
    marks: ["off returns the release to service"],
  },
  {
    id: "gate-open",
    workflow: "image-gate.yml",
    requires: ["web-release-open"],
    plane: "required",
    marks: ["SET IMAGE GATE OPEN"],
  },
];

describe("no-compatibility rollout graph", () => {
  it("declares a linear order with no forward dependency", () => {
    const index = new Map(PHASES.map((phase, position) => [phase.id, position]));
    expect(index.size).toBe(PHASES.length);
    for (const phase of PHASES) {
      for (const required of phase.requires) {
        const requiredIndex = index.get(required);
        expect(requiredIndex, phase.id + " requires unknown " + required).not.toBeUndefined();
        expect(
          requiredIndex as number,
          phase.id + " requires " + required + " which comes later",
        ).toBeLessThan(index.get(phase.id) as number);
      }
    }
  });

  it("keeps every plane-free phase free of control-plane calls", () => {
    for (const phase of PHASES.filter((entry) => entry.plane === "none")) {
      const source = workflow(phase.planeWorkflow ?? phase.workflow);
      for (const endpoint of PLANE_ENDPOINTS) {
        expect(
          source.includes(endpoint),
          phase.id + " must not call " + endpoint,
        ).toBe(false);
      }
      expect(
        source.includes("INTAR_IMAGE_PUBLISH_TOKEN"),
        phase.id + " must not need a publish token",
      ).toBe(false);
    }
  });

  it("requires the plane for every phase that mutates published state", () => {
    for (const phase of PHASES.filter((entry) => entry.plane === "required")) {
      const source = workflow(phase.planeWorkflow ?? phase.workflow);
      expect(
        PLANE_ENDPOINTS.some((endpoint) => source.includes(endpoint)),
        phase.id + " must call the control plane",
      ).toBe(true);
    }
  });

  it("keeps each phase marker present in its workflow", () => {
    for (const phase of PHASES) {
      const source = workflow(phase.workflow);
      for (const mark of phase.marks) {
        expect(source, phase.id + " is missing " + mark).toContain(mark);
      }
    }
  });

  it("binds the release to a completed website run and a tools build", () => {
    const release = workflow("website-release.yml");
    const toolsBuild = workflow("guest-tools-deploy.yml");
    // The release refuses an artifact from a run that has not concluded, waits
    // for the website run of its own revision, and takes the pin from a
    // successful guest-tools build, so it cannot build a pin from an
    // unverified upload.
    expect(release).toContain("guest-tools-deploy.yml");
    expect(release).toContain("guest-tools-deployment-");
    expect(release).toContain(".conclusion == \"success\"");
    expect(release).toContain("website.yml/runs?head_sha=");
    expect(release).toContain('if [ "${conclusion}" != success ]');
    expect(toolsBuild).toContain("guest-tools-deployment-");
  });

  it("keeps the promotion lane out of the build lane", () => {
    const build = workflow("guest-tools-deploy.yml");
    const promote = workflow("guest-tools-promote.yml");
    // Promotion needs the new plane; the build lane must not wait on it.
    expect(build).not.toContain("guest-tools/promote");
    expect(build).not.toContain("guest-tools/warm");
    expect(build).not.toContain("tools_disk_sha256 == $disk");
    expect(promote).toContain("guest-tools/promote");
    expect(promote).toContain("guest-tools/warm");
    expect(promote).toContain('test "\${CONFIRMATION}" = \'PROMOTE GUEST TOOLS\'');
  });

  it("binds promotion to the candidate digest the cutover pinned", () => {
    const promote = workflow("guest-tools-promote.yml");
    const build = workflow("guest-tools-deploy.yml");
    // The build lane may run again between the cutover and the promotion, so
    // the promotion must take the expected manifest digest as an input and
    // refuse a published candidate that no longer matches it. Without this the
    // promotion would warm and promote a release the worker was not deployed
    // with.
    expect(promote).toContain("expected_candidate_sha256:");
    expect(promote).toContain("EXPECTED_CANDIDATE_SHA256");
    expect(promote).toContain("^[0-9a-f]{64}$");
    expect(promote).toContain("The published candidate does not match the expected digest.");
    expect(promote).toContain("x-intar-candidate-sha256");
    // The digest must be checked before the warm call, so a stale candidate is
    // refused before anything is scheduled on a host.
    const bindingIndex = promote.indexOf("does not match the expected digest");
    const warmIndex = promote.indexOf("guest-tools/warm");
    expect(bindingIndex).toBeGreaterThan(-1);
    expect(warmIndex).toBeGreaterThan(bindingIndex);
    // The build lane now only builds and verifies, and no longer takes the
    // bundle revision it does not use.
    expect(build).toContain("Build and verify tools");
    expect(build).not.toContain("Build, verify, and promote");
    expect(build).not.toContain("REVISION");
  });
});
