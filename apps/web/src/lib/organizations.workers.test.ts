/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  member,
  organization,
  scenarioSourceCommits,
  scenarioSources,
  user,
  vmScenarios,
  vmScenarioVms,
} from "@/db/schema";
import { StaticFeatureToggleService } from "@/lib/feature-toggles";
import { errorChainMatches } from "@/lib/app-error";
import { createOrganization, deleteOrganization } from "@/lib/organizations";
import { listEnabledScenarios, loadScenario } from "@/lib/scenarios";
import { interleaveBefore } from "@/test/d1-interleave";
import { resetD1Database } from "@/test/d1-migrations";

describe("organization boundaries", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("gates creation and enforces one owned organization under races", async () => {
    const db = drizzle(env.DB);
    await insertUser("creator");
    await expect(
      createOrganization({
        name: "Denied Org",
        ownerUserId: "creator",
        featureToggleService: new StaticFeatureToggleService(),
      }),
    ).rejects.toMatchObject({ code: "organization_creation_disabled" });

    const created = await createOrganization({
      name: "Allowed Org",
      ownerUserId: "creator",
      featureToggleService: new StaticFeatureToggleService({
        "organization-creation": true,
      }),
    });
    expect(created.role).toBe("owner");
    await expect(
      createOrganization({
        name: "Second Org",
        ownerUserId: "creator",
        featureToggleService: new StaticFeatureToggleService({
          "organization-creation": true,
        }),
      }),
    ).rejects.toMatchObject({ code: "organization_limit_reached" });

    await db.insert(organization).values({
      id: "race-org",
      name: "Race Org",
      slug: "race-org",
      createdAt: new Date(),
    });
    const ownerRace = db.insert(member).values({
        id: "race-owner",
        organizationId: "race-org",
        userId: "creator",
        role: "owner",
        createdAt: new Date(),
      });
    await expect(ownerRace).rejects.toSatisfy((error: unknown) =>
      errorChainMatches(
        error,
        /unique constraint failed|member_single_owner_uidx/i,
      ),
    );
  });

  it("shows public scenarios plus only the requesting organization catalog", async () => {
    await Promise.all([
      insertOrganization("org-a"),
      insertOrganization("org-b"),
    ]);
    await Promise.all([
      insertScenario(null, "public-scenario"),
      insertScenario("org-a", "org-a-private"),
      insertScenario("org-b", "org-b-private"),
    ]);

    expect(scenarioIds(await listEnabledScenarios())).toEqual([
      "public-scenario",
    ]);
    expect(
      scenarioIds(await listEnabledScenarios({ organizationId: "org-a" })),
    ).toEqual(["org-a-private", "public-scenario"]);
    expect(
      scenarioIds(await listEnabledScenarios({ organizationId: "org-b" })),
    ).toEqual(["org-b-private", "public-scenario"]);
    await expect(loadScenario("org-a-private")).resolves.toBeNull();
    await expect(
      loadScenario("org-a-private", { organizationId: "org-a" }),
    ).resolves.toMatchObject({
      scenarioId: "org-a-private",
      organizationId: "org-a",
    });
  });

  it("refuses deletion while a scenario source binding can still write", async () => {
    const db = drizzle(env.DB);
    await insertUser("owner");
    await insertOrganization("org-a");
    await db.insert(member).values({
      id: "owner-member",
      organizationId: "org-a",
      userId: "owner",
      role: "owner",
      createdAt: new Date(),
    });
    const remove = () =>
      deleteOrganization({ organizationId: "org-a", actorUserId: "owner" });
    const binding = {
      scopeKey: "organization:org-a",
      organizationId: "org-a",
      githubInstallationId: 1,
      githubRepositoryId: 42,
      githubRepository: "acme/scenarios",
      defaultBranch: "main",
    };

    // A binding connected between the owned-resources read and the DELETE.
    const race = interleaveBefore(/^delete from "organization"/iu, () =>
      db.insert(scenarioSources).values(binding),
    );
    try {
      await expect(remove()).rejects.toMatchObject({
        code: "organization_not_empty",
      });
      expect(race.fired()).toBe(true);
    } finally {
      race.restore();
    }
    await expect(remove()).rejects.toMatchObject({
      code: "organization_not_empty",
    });

    await db.update(scenarioSources).set({ disconnectedAt: 1 });
    await db.insert(scenarioSourceCommits).values({
      id: "commit-1",
      scopeKey: binding.scopeKey,
      purpose: "deploy",
      sha: "abc",
      rev: "git-abc",
      via: "pull",
      state: "fetching",
    });
    for (const state of [
      "fetching",
      "compiling",
      "ingesting",
      "promoting",
    ] as const) {
      await db.update(scenarioSourceCommits).set({ state });
      await expect(remove(), state).rejects.toMatchObject({
        code: "organization_not_empty",
      });
    }

    await db.update(scenarioSourceCommits).set({ state: "failed" });
    await remove();
    expect(await db.select().from(organization)).toEqual([]);
    expect(await db.select().from(scenarioSources)).toEqual([]);
    expect(await db.select().from(scenarioSourceCommits)).toEqual([]);
  });

  it("treats a concurrent deletion of the organization as done", async () => {
    const db = drizzle(env.DB);
    await insertUser("owner");
    await insertOrganization("org-a");
    await db.insert(member).values({
      id: "owner-member",
      organizationId: "org-a",
      userId: "owner",
      role: "owner",
      createdAt: new Date(),
    });

    const race = interleaveBefore(/^delete from "organization"/iu, () =>
      db.delete(organization).where(eq(organization.id, "org-a")),
    );
    try {
      await deleteOrganization({
        organizationId: "org-a",
        actorUserId: "owner",
      });
      expect(race.fired()).toBe(true);
    } finally {
      race.restore();
    }
    expect(await db.select().from(organization)).toEqual([]);
  });
});

async function insertUser(id: string) {
  await drizzle(env.DB)
    .insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
}

async function insertOrganization(id: string) {
  await drizzle(env.DB).insert(organization).values({
    id,
    name: id,
    slug: id,
    createdAt: new Date(),
  });
}

async function insertScenario(
  organizationId: string | null,
  scenarioId: string,
) {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.batch([
    db.insert(vmScenarios).values({
      scenarioId,
      organizationId,
      title: scenarioId,
      category: "test",
      description: "test scenario",
      difficulty: "easy",
      estimatedMinutes: 10,
      tagsJson: [],
      briefingMarkdown: "briefing",
      solutionMarkdown: "solution",
      hintsJson: [],
      enabled: true,
      enabledAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(vmScenarioVms).values({
      id: `${scenarioId}:vm`,
      scenarioId,
      ordinal: 0,
      vmName: "vm",
      image: `${scenarioId}-vm-x86_64.raw.zst`,
      imageKeyJson: { scenario: scenarioId, vm: "vm", arch: "x86_64" },
      imageSha256: "a".repeat(64),
      imageFormat: "raw_zstd",
      imageVirtualSizeBytes: 1024,
      kernelSha256: "b".repeat(64),
      initrdSha256: "c".repeat(64),
      bootCmdline: "console=ttyS0 root=/dev/vda rw",
      cpuMillis: 1_000,
      memoryMib: 512,
      diskMib: 1_024,
    }),
  ]);
}

function scenarioIds(
  scenarios: Awaited<ReturnType<typeof listEnabledScenarios>>,
) {
  return scenarios.map((scenario) => scenario.scenarioId).sort();
}
