/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentBootstrapTokens,
  agentHosts,
  member,
  organization,
  scenarioRuns,
  user,
  vmScenarios,
  vmScenarioVms,
} from "@/db/schema";
import { StaticFeatureToggleService } from "@/lib/feature-toggles";
import { errorChainMatches } from "@/lib/app-error";
import { createOrRotateOrganizationRunner } from "@/lib/organization-runners";
import { createOrganization } from "@/lib/organizations";
import { getScenarioProgressByScenario } from "@/lib/scenario-runs";
import { listEnabledScenarios, loadScenario } from "@/lib/scenarios";
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

  it("keeps public and organization-context progress separate", async () => {
    const db = drizzle(env.DB);
    await insertUser("learner");
    await insertOrganization("org-a");
    await db.insert(agentHosts).values({
      id: "progress-host",
      userId: "learner",
      organizationId: "org-a",
      name: "Progress host",
    });
    await db.insert(scenarioRuns).values([
      scenarioRun({
        runId: "public-run",
        organizationId: null,
        solvedAt: 1_500,
      }),
      scenarioRun({
        runId: "organization-run",
        organizationId: "org-a",
        solvedAt: 2_000,
      }),
    ]);

    const publicProgress = await getScenarioProgressByScenario("learner");
    const organizationProgress = await getScenarioProgressByScenario(
      "learner",
      "org-a",
    );
    expect(publicProgress.get("public-scenario")).toMatchObject({
      attemptCount: 1,
      completedCount: 1,
      bestSolveMs: 500,
      status: "completed",
    });
    expect(organizationProgress.get("public-scenario")).toMatchObject({
      attemptCount: 1,
      completedCount: 1,
      bestSolveMs: 1_000,
      status: "completed",
    });
  });

  it("creates agent-only organization runners with non-expiring bootstrap credentials", async () => {
    const db = drizzle(env.DB);
    await insertUser("owner");
    await insertOrganization("org-a");
    await db.insert(member).values({
      id: "owner-membership",
      organizationId: "org-a",
      userId: "owner",
      role: "owner",
      createdAt: new Date(),
    });

    const result = await createOrRotateOrganizationRunner({
      organizationId: "org-a",
      actorUserId: "owner",
      name: "Academy runner",
      baseUrl: "https://intar.test",
    });
    expect(result.bootstrapTokenExpiresAt).toBeNull();
    expect(result.runner.role).toBe("agent");
    expect(result.bridgeConfigToml).toContain("bootstrap_token");

    const [hosts, tokens] = await Promise.all([
      db
        .select({
          organizationId: agentHosts.organizationId,
          role: agentHosts.role,
        })
        .from(agentHosts)
        .where(eq(agentHosts.id, result.runner.id)),
      db
        .select({ expiresAt: agentBootstrapTokens.expiresAt })
        .from(agentBootstrapTokens)
        .where(
          and(
            eq(agentBootstrapTokens.hostId, result.runner.id),
            isNull(agentBootstrapTokens.revokedAt),
          ),
        ),
    ]);
    expect(hosts).toEqual([{ organizationId: "org-a", role: "agent" }]);
    expect(tokens).toEqual([{ expiresAt: null }]);
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
      vcpuCount: 1,
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

function scenarioRun(input: {
  runId: string;
  organizationId: string | null;
  solvedAt?: number | null;
}): typeof scenarioRuns.$inferInsert {
  const createdAt = 1_000;
  return {
    runId: input.runId,
    userId: "learner",
    organizationId: input.organizationId,
    hostId: "progress-host",
    scenarioId: "public-scenario",
    scenarioName: "public-scenario",
    title: "Public scenario",
    tagline: "Test",
    briefingMarkdown: "Briefing",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "Solution",
    revealedHintsJson: [],
    solutionAssisted: false,
    vmCount: 1,
    state: "completed",
    stateRank: 1,
    activeKey: null,
    stateJson: "{}",
    solvedAt: input.solvedAt ?? null,
    completedAt: 3_000,
    createdAt,
    updatedAt: 3_000,
  };
}
