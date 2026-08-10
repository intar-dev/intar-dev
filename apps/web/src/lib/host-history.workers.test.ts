/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  imageBuilds,
  organization,
  runtimeExecutions,
  scenarioRuns,
  user,
  workshopPublications,
  workshopRegistryTokens,
} from "@/db/schema";
import { deleteAgentHostPreservingHistory } from "@/lib/agent-host-deletion";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

describe("host history database invariant", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("keeps a host when scenario history exists", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    await db.insert(user).values({
      id: "user-history",
      name: "History Owner",
      email: "history@example.com",
    });
    await db.insert(agentHosts).values({
      id: "host-history",
      userId: "user-history",
      name: "History Host",
    });
    await db.insert(scenarioRuns).values({
      runId: "run-history",
      userId: "user-history",
      hostId: "host-history",
      scenarioId: "scenario-history",
      scenarioName: "scenario-history",
      title: "History",
      tagline: "",
      briefingMarkdown: "",
      objectivesJson: "[]",
      difficulty: "easy",
      estimatedMinutes: 1,
      tagsJson: [],
      hintsJson: [],
      solutionMarkdown: "",
      vmCount: 1,
      state: "completed",
      stateRank: 1,
      stateJson: "{}",
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      deleteAgentHostPreservingHistory(db, {
        hostId: "host-history",
        userId: "user-history",
      }),
    ).resolves.toBe(false);

    await expect(
      db
        .select({ id: agentHosts.id })
        .from(agentHosts)
        .where(eq(agentHosts.id, "host-history")),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ id: scenarioRuns.runId })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, "run-history")),
    ).resolves.toHaveLength(1);
  });

  it("deletes a retired builder while preserving terminal history", async () => {
    const db = drizzle(env.DB);
    await seedBuilderHistory("published", "verified");

    await expect(
      db
        .update(workshopPublications)
        .set({ error: "tampered" })
        .where(eq(workshopPublications.id, "publication-history")),
    ).rejects.toThrow();

    await expect(
      deleteAgentHostPreservingHistory(db, {
        hostId: "builder-history",
        userId: "user-builder-history",
      }),
    ).resolves.toBe(true);

    await expect(
      db
        .select({ id: agentHosts.id })
        .from(agentHosts)
        .where(eq(agentHosts.id, "builder-history")),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select({
          id: workshopPublications.id,
          status: workshopPublications.status,
          certificationState: workshopPublications.certificationState,
          builderHostId: workshopPublications.builderHostId,
        })
        .from(workshopPublications)
        .where(eq(workshopPublications.id, "publication-history")),
    ).resolves.toEqual([
      {
        id: "publication-history",
        status: "published",
        certificationState: "verified",
        builderHostId: null,
      },
    ]);
    await expect(
      db
        .select({ id: imageBuilds.id, hostId: imageBuilds.hostId })
        .from(imageBuilds)
        .where(eq(imageBuilds.id, "image-build-history")),
    ).resolves.toEqual([{ id: "image-build-history", hostId: null }]);
    await expect(
      env.DB.prepare("PRAGMA foreign_key_check").all(),
    ).resolves.toMatchObject({ results: [] });
  });

  it("keeps every reference attached when cleanup is unfinished", async () => {
    const db = drizzle(env.DB);
    await seedBuilderHistory("published", "verified");
    await db.insert(workshopPublications).values({
      id: "publication-cleanup",
      organizationId: "org-builder-history",
      workshopSlug: "cleanup",
      contentHash: "cleanup-hash",
      sourceR2Key: "sources/cleanup.tar.zst",
      compiledManifestJson: {},
      requiredCheckpointIdsJson: [],
      status: "failed",
      submittedBy: "user-builder-history",
      registryTokenId: "registry-token-builder-history",
      builderHostId: "builder-history",
      certificationState: "cleanup_pending",
    });

    await expect(
      deleteAgentHostPreservingHistory(db, {
        hostId: "builder-history",
        userId: "user-builder-history",
      }),
    ).resolves.toBe(false);

    await expect(
      db
        .select({ id: agentHosts.id })
        .from(agentHosts)
        .where(eq(agentHosts.id, "builder-history")),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({
          id: workshopPublications.id,
          builderHostId: workshopPublications.builderHostId,
        })
        .from(workshopPublications)
        .where(eq(workshopPublications.builderHostId, "builder-history"))
        .orderBy(asc(workshopPublications.id)),
    ).resolves.toEqual([
      {
        id: "publication-cleanup",
        builderHostId: "builder-history",
      },
      {
        id: "publication-history",
        builderHostId: "builder-history",
      },
    ]);
  });

  it.each([null, "failed"] as const)(
    "detaches failed terminal history with certification state %s",
    async (certificationState) => {
      const db = drizzle(env.DB);
      await seedBuilderHistory("failed", certificationState);

      await expect(
        deleteAgentHostPreservingHistory(db, {
          hostId: "builder-history",
          userId: "user-builder-history",
        }),
      ).resolves.toBe(true);
      await expect(
        db
          .select({ builderHostId: workshopPublications.builderHostId })
          .from(workshopPublications)
          .where(eq(workshopPublications.id, "publication-history")),
      ).resolves.toEqual([{ builderHostId: null }]);
    },
  );

  it("fails closed for a legacy published row without verified certification", async () => {
    const db = drizzle(env.DB);
    await seedBuilderHistory("published", null);

    await expect(
      deleteAgentHostPreservingHistory(db, {
        hostId: "builder-history",
        userId: "user-builder-history",
      }),
    ).resolves.toBe(false);
    await expect(builderPublicationHostId()).resolves.toBe("builder-history");
  });

  it("keeps terminal references attached while an image build is active", async () => {
    const db = drizzle(env.DB);
    await seedBuilderHistory("published", "verified");
    await db
      .update(imageBuilds)
      .set({ status: "assigned", phase: "queued" })
      .where(eq(imageBuilds.id, "image-build-history"));

    await expect(
      deleteAgentHostPreservingHistory(db, {
        hostId: "builder-history",
        userId: "user-builder-history",
      }),
    ).resolves.toBe(false);
    await expect(builderPublicationHostId()).resolves.toBe("builder-history");
  });

  it("keeps terminal references attached while a workshop runtime is active", async () => {
    const db = drizzle(env.DB);
    await seedBuilderHistory("published", "verified");
    // This test isolates the host-deletion guard; workshop authorization is
    // covered separately and would otherwise require a complete live roster.
    await env.DB.prepare(
      "DROP TRIGGER runtime_executions_workshop_member_insert_guard",
    ).run();
    await db.insert(runtimeExecutions).values({
      id: "runtime-builder-history",
      userId: "user-builder-history",
      organizationId: "org-builder-history",
      hostId: "builder-history",
      domainKind: "workshop",
      domainId: "workshop-builder-history",
      generation: 1,
      state: "ready",
    });

    await expect(
      deleteAgentHostPreservingHistory(db, {
        hostId: "builder-history",
        userId: "user-builder-history",
      }),
    ).resolves.toBe(false);
    await expect(builderPublicationHostId()).resolves.toBe("builder-history");
  });
});

async function builderPublicationHostId(): Promise<string | null | undefined> {
  const rows = await drizzle(env.DB)
    .select({ builderHostId: workshopPublications.builderHostId })
    .from(workshopPublications)
    .where(eq(workshopPublications.id, "publication-history"));
  return rows[0]?.builderHostId;
}

async function seedBuilderHistory(
  status: "failed" | "published",
  certificationState: null | "failed" | "verified",
): Promise<void> {
  const db = drizzle(env.DB);
  const now = new Date();
  await db.batch([
    db.insert(user).values({
      id: "user-builder-history",
      name: "Builder History Owner",
      email: "builder-history@example.com",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(organization).values({
      id: "org-builder-history",
      name: "Builder History",
      slug: "builder-history",
      createdAt: now,
    }),
    db.insert(agentHosts).values({
      id: "builder-history",
      userId: "user-builder-history",
      organizationId: "org-builder-history",
      name: "Retired Builder",
      role: "builder",
      scenarioEnabled: false,
    }),
  ]);
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId: "user-builder-history",
    now: now.getTime(),
  });
  await db.insert(workshopRegistryTokens).values({
    id: "registry-token-builder-history",
    organizationId: "org-builder-history",
    name: "History token",
    tokenPrefix: "history",
    tokenHash: "history-hash",
    createdBy: "user-builder-history",
  });
  await db.insert(workshopPublications).values({
    id: "publication-history",
    organizationId: "org-builder-history",
    workshopSlug: "history",
    contentHash: "history-hash",
    sourceR2Key: "sources/history.tar.zst",
    compiledManifestJson: {},
    requiredCheckpointIdsJson: [],
    status,
    submittedBy: "user-builder-history",
    registryTokenId: "registry-token-builder-history",
    builderHostId: "builder-history",
    certificationState,
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO image_build_bundles
         (rev, organization_id, r2_key, kino_version, meta_json)
       VALUES ('history-rev', 'org-builder-history', 'bundles/history.tar.zst',
               'kino-history', '{}')`,
    ),
    env.DB.prepare(
      `INSERT INTO image_builds
         (id, organization_id, scenario_id, arch, rev, content_hash,
          kino_version, host_id, status, phase)
       VALUES ('image-build-history', 'org-builder-history', 'history', 'amd64',
               'history-rev', 'history-image-hash', 'kino-history',
               'builder-history', 'succeeded', 'succeeded')`,
    ),
  ]);
}
