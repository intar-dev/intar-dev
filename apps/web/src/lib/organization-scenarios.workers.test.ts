/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageBuildBundles,
  imageBuilds,
  member,
  organization,
  scenarioAssignments,
  user,
  vmScenarios,
} from "@/db/schema";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import { deleteOrganizationScenario } from "@/lib/organization-scenarios";
import { interleaveBefore } from "@/test/d1-interleave";
import { resetD1Database } from "@/test/d1-migrations";

const ORG = "org";
const SCENARIO = "org-broken-nginx";
const GIT_REV = "git-scenarios-abc123-digest";

describe("organization scenario deletion", () => {
  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    await db.insert(user).values({ id: "owner", name: "owner", email: "owner@example.test" });
    await db.insert(organization).values({ id: ORG, name: ORG, slug: ORG, createdAt: new Date(0) });
    await db.insert(member).values({
      id: "owner", userId: "owner", organizationId: ORG, role: "owner", createdAt: new Date(0),
    });
    await db.insert(vmScenarios).values({
      scenarioId: SCENARIO, organizationId: ORG, title: SCENARIO, description: "d",
      difficulty: "easy", estimatedMinutes: 10, tagsJson: [], briefingMarkdown: "b",
      solutionMarkdown: "s", hintsJson: [],
    });
    await db.insert(scenarioAssignments).values({
      id: "assignment", organizationId: ORG, scenarioId: SCENARIO, assignedBy: "owner",
    });
    await insertBundle("org-legacy");
    await db.insert(imageBuilds).values({
      id: "legacy-build", organizationId: ORG, scenarioId: SCENARIO, arch: "x86_64",
      rev: "org-legacy", contentHash: "a".repeat(64), status: "succeeded", phase: "succeeded",
    });
  });

  const remove = () =>
    deleteOrganizationScenario({ organizationId: ORG, actorUserId: "owner", scenarioId: SCENARIO });

  it("deletes a legacy scenario and sweeps its orphaned bundle", async () => {
    await remove();
    await expect(remainingRows()).resolves.toEqual({ scenarios: 0, assignments: 0, builds: 0, bundles: [] });
  });

  it("refuses once the org has a git bundle", async () => {
    await insertBundle(GIT_REV);
    await expect(remove()).rejects.toMatchObject({ status: 409, code: "scenario_managed_by_git_source" });
    await expect(remainingRows()).resolves.toEqual({
      scenarios: 1, assignments: 1, builds: 1, bundles: [GIT_REV, "org-legacy"],
    });
  });

  it("deletes nothing when a git bundle lands between the check and the batch", async () => {
    const batch = env.DB.batch.bind(env.DB);
    let raced = false;
    const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await insertBundle(GIT_REV);
      raced = true;
      return batch(statements);
    });
    try {
      await expect(remove()).rejects.toMatchObject({ status: 409, code: "scenario_managed_by_git_source" });
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);
    await expect(remainingRows()).resolves.toEqual({
      scenarios: 1, assignments: 1, builds: 1, bundles: [GIT_REV, "org-legacy"],
    });
  });

  it("still succeeds when a concurrent delete removed the scenario first", async () => {
    const batch = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await batch(statements);
      return batch(statements);
    });
    try {
      await remove();
    } finally {
      spy.mockRestore();
    }
    await expect(remainingRows()).resolves.toEqual({ scenarios: 0, assignments: 0, builds: 0, bundles: [] });
  });

  it("keeps a git bundle without build references in the orphan sweep", async () => {
    const race = interleaveBefore(/^delete from "image_build_bundles"/i, () => insertBundle(GIT_REV));
    try {
      await remove();
    } finally {
      race.restore();
    }
    expect(race.fired()).toBe(true);
    await expect(remainingRows()).resolves.toEqual({ scenarios: 0, assignments: 0, builds: 0, bundles: [GIT_REV] });
  });
});

async function insertBundle(rev: string) {
  await drizzle(env.DB).insert(imageBuildBundles).values({
    rev, organizationId: ORG, r2Key: `builds/bundles/${rev}.tar.gz`,
    metaJson: { buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION, scenarios: [] },
  });
}

async function remainingRows() {
  const db = drizzle(env.DB);
  return {
    scenarios: (await db.select().from(vmScenarios)).length,
    assignments: (await db.select().from(scenarioAssignments)).length,
    builds: (await db.select().from(imageBuilds)).length,
    bundles: (await db.select({ rev: imageBuildBundles.rev }).from(imageBuildBundles))
      .map((row) => row.rev)
      .sort(),
  };
}
