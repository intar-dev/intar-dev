/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  imageBuildCoordinationLocks,
  imageBuildBundles,
  imageBuilds,
  organization,
  user,
  type ImageBuildBundleMeta,
} from "@/db/schema";
import type {
  BuildReportV1,
  DesiredBuildV1,
  HostStateReportV2,
} from "@/generated/bridge";
import hostReportFixture from "@/generated/fixtures/bridge/host-state-report-v2.json";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import {
  assertBundleRevScope,
  assignQueuedImageBuilds,
  maintainHostBuildAssignments,
  queueImageBuildsFromBundle,
  reconcileAssignedBuildsForHost,
  recordImageBuildReport,
  retryImageBuild,
} from "@/lib/build-scheduler";
import {
  withImageBuildCoordinationLock,
  withImageBuildCoordinationLocks,
} from "@/lib/image-build-lock";
import {
  IMAGE_BUILD_FORMAT_VERSION,
  platformCompileDigest,
} from "@/lib/image-build-format";
import { interleaveBefore } from "@/test/d1-interleave";
import { resetD1Database } from "@/test/d1-migrations";

type SchedulerDb = Parameters<typeof queueImageBuildsFromBundle>[0];

describe("build scheduler bundle supersession", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("retires only superseded active hashes, cleans desired state, and rejects late reports", async () => {
    const now = 1_762_041_660_000;
    const db = drizzle(env.DB);
    await seedBuilder(db, now);
    await db.insert(imageBuildBundles).values({
      rev: "bundle-old",
      r2Key: "builds/bundles/bundle-old.tar.gz",
      metaJson: {
        buildFormatVersion: "intar-image-build-v11",
        scenarios: [],
      },
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
    });

    const oldRows = [
      oldBuild("queued-old", "1", "queued", null, now),
      oldBuild("assigned-old", "2", "assigned", "builder-1", now),
      oldBuild("building-old", "3", "building", "builder-1", now),
      oldBuild("succeeded-old", "4", "succeeded", "builder-1", now),
      oldBuild("failed-old", "5", "failed", "builder-1", now),
      {
        ...oldBuild("stale-old", "6", "building", "builder-1", now),
        status: "stale" as const,
        error: "builder stopped reporting build progress",
      },
    ];
    await db.insert(imageBuilds).values(oldRows);

    const desired = {
      ...createEmptyHostDesiredState({ ownerUserId: "user-1", scope: "platform", hostId: "builder-1", nowUnixMs: now }),
      version: 1,
      builds: [
        desiredBuild("assigned-old", "2"),
        desiredBuild("building-old", "3"),
        desiredBuild("keep", "9"),
      ],
    };
    await db.insert(hostDesiredState).values({
      hostId: "builder-1",
      version: desired.version,
      docJson: desired,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      queueImageBuildsFromBundle(db, {
        rev: "bundle-new",
        r2Key: "builds/bundles/bundle-new.tar.gz",
        meta: {
          buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
          scenarios: [
            {
              scenarioId: "broken-nginx",
              arch: "x86_64",
              contentHash: "a".repeat(64),
            },
          ],
        },
        nowUnixMs: now,
      }),
    ).resolves.toEqual({ queued: 1 });

    const rows = await db
      .select({
        id: imageBuilds.id,
        rev: imageBuilds.rev,
        status: imageBuilds.status,
        error: imageBuilds.error,
        updatedAt: imageBuilds.updatedAt,
      })
      .from(imageBuilds)
      .where(eq(imageBuilds.scenarioId, "broken-nginx"));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [
      "queued-old",
      "assigned-old",
      "building-old",
      "failed-old",
      "stale-old",
    ]) {
      expect(byId.get(id)).toMatchObject({
        status: "stale",
        error: "superseded by bundle bundle-new",
        updatedAt: now,
      });
    }
    expect(byId.get("succeeded-old")).toMatchObject({
      status: "succeeded",
      error: null,
      updatedAt: now - 1_000,
    });
    const newRow = rows.find((row) => row.rev === "bundle-new");
    expect(newRow).toMatchObject({ status: "queued", error: null });

    const [storedDesired] = await db
      .select({ docJson: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "builder-1"));
    expect(
      storedDesired?.docJson.builds.map((build) => build.build_id),
    ).toEqual(["keep"]);

    await expect(
      recordImageBuildReport(
        db,
        "builder-1",
        buildReport("assigned-old", "2"),
        now + 1,
        { sessionId: "builder-session", credentialGeneration: 1 },
      ),
    ).resolves.toEqual({ updated: false, terminal: false });

    await expect(
      queueImageBuildsFromBundle(db, {
        rev: "bundle-same-hash",
        r2Key: "builds/bundles/bundle-same-hash.tar.gz",
        meta: {
          buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
          scenarios: [
            {
              scenarioId: "broken-nginx",
              arch: "x86_64",
              contentHash: "a".repeat(64),
            },
          ],
        },
        nowUnixMs: now + 2,
      }),
    ).resolves.toEqual({ queued: 0 });
    const [sameHashRow] = await db
      .select({ rev: imageBuilds.rev, status: imageBuilds.status })
      .from(imageBuilds)
      .where(eq(imageBuilds.contentHash, "a".repeat(64)));
    expect(sameHashRow).toEqual({ rev: "bundle-new", status: "queued" });
  });

  it("serializes concurrent bundle hashes so only the last lock holder stays active", async () => {
    const db = drizzle(env.DB);
    const now = 1_762_041_660_000;

    const results = await Promise.all([
      queueBundle(db, "bundle-a", "a", now),
      queueBundle(db, "bundle-b", "b", now + 1),
    ]);
    expect(results).toEqual([{ queued: 1 }, { queued: 1 }]);

    const rows = await db
      .select({
        contentHash: imageBuilds.contentHash,
        status: imageBuilds.status,
      })
      .from(imageBuilds)
      .where(eq(imageBuilds.scenarioId, "broken-nginx"));
    const active = rows.filter((row) =>
      ["queued", "assigned", "building"].includes(row.status),
    );
    expect(active).toHaveLength(1);
    expect(rows.find((row) => row !== active[0])?.status).toBe("stale");
    await expect(db.select().from(imageBuildCoordinationLocks)).resolves.toEqual(
      [],
    );
  });

  it("never moves a bundle rev to another scope", async () => {
    const db = drizzle(env.DB);
    const now = 1_762_041_660_000;
    await db.insert(organization).values({
      id: "org-a", name: "Org A", slug: "org-a", createdAt: new Date(now),
    });
    const rev = "git-repo-sha-digest";
    const queue = (
      organizationId: string | null,
      nowUnixMs: number,
      scenarios: ImageBuildBundleMeta["scenarios"] = [],
    ) =>
      queueImageBuildsFromBundle(db, {
        rev,
        r2Key: `builds/bundles/${rev}.tar.gz`,
        meta: { buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION, scenarios },
        organizationId,
        nowUnixMs,
      });
    const conflict = { status: 409, code: "rev_scope_conflict" };

    await expect(assertBundleRevScope(db, { rev, organizationId: null })).resolves.toBeUndefined();
    await queue("org-a", now);
    await expect(assertBundleRevScope(db, { rev, organizationId: null })).rejects.toMatchObject(conflict);
    await expect(assertBundleRevScope(db, { rev, organizationId: "org-a" })).resolves.toBeUndefined();
    // The other scope is refused before it queues a build for the rev.
    await expect(
      queue(null, now + 1, [
        { scenarioId: "broken-nginx", arch: "x86_64", contentHash: "a".repeat(64) },
      ]),
    ).rejects.toMatchObject(conflict);

    await expect(
      db
        .select({
          organizationId: imageBuildBundles.organizationId,
          updatedAt: imageBuildBundles.updatedAt,
        })
        .from(imageBuildBundles),
    ).resolves.toEqual([{ organizationId: "org-a", updatedAt: now }]);
    await expect(db.select().from(imageBuilds)).resolves.toEqual([]);
    // The same scope still refreshes its row.
    await queue("org-a", now + 2);
    await expect(
      db.select({ updatedAt: imageBuildBundles.updatedAt }).from(imageBuildBundles),
    ).resolves.toEqual([{ updatedAt: now + 2 }]);
  });

  it("retries only a failed build that is still current", async () => {
    const db = drizzle(env.DB);
    const now = 1_762_041_660_000;
    await db.insert(imageBuildBundles).values({
      rev: "bundle-old",
      r2Key: "builds/bundles/bundle-old.tar.gz",
      metaJson: {
        buildFormatVersion: "intar-image-build-v11",
        scenarios: [],
      },
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
    });
    await db
      .insert(imageBuilds)
      .values(oldBuild("failed-current", "1", "failed", null, now));

    await expect(
      retryImageBuild(db, {
        buildId: "failed-current",
        nowUnixMs: now,
      }),
    ).resolves.toEqual({ outcome: "retried", assigned: [] });

    const [build] = await db
      .select({
        status: imageBuilds.status,
        phase: imageBuilds.phase,
        attempt: imageBuilds.attempt,
        error: imageBuilds.error,
      })
      .from(imageBuilds)
      .where(eq(imageBuilds.id, "failed-current"));
    expect(build).toEqual({
      status: "queued",
      phase: "queued",
      attempt: 0,
      error: null,
    });
  });

  it("cannot retry a build superseded while it waits for the publish fence", async () => {
    const db = drizzle(env.DB);
    const now = 1_762_041_660_000;
    await db.insert(imageBuildBundles).values({
      rev: "bundle-old",
      r2Key: "builds/bundles/bundle-old.tar.gz",
      metaJson: {
        buildFormatVersion: "intar-image-build-v11",
        scenarios: [],
      },
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
    });
    await db.insert(imageBuilds).values({
      ...oldBuild("stale-old", "1", "building", null, now),
      status: "stale",
      error: "builder stopped reporting build progress",
    });

    let retrySettled = false;
    let retryPromise!: ReturnType<typeof retryImageBuild>;
    await withImageBuildCoordinationLock(
      db,
      { scenarioId: "broken-nginx", arch: "x86_64" },
      async () => {
        retryPromise = retryImageBuild(db, {
          buildId: "stale-old",
          nowUnixMs: now + 2,
        }).finally(() => {
          retrySettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(retrySettled).toBe(false);
        await db
          .update(imageBuilds)
          .set({
            status: "stale",
            error: "superseded by bundle bundle-new",
            updatedAt: now + 1,
          })
          .where(eq(imageBuilds.id, "stale-old"));
      },
    );

    await expect(retryPromise).resolves.toEqual({
      outcome: "not_retryable",
      status: "stale",
    });
  });

  it("repairs an assigned build missing from host desired state", async () => {
    const db = drizzle(env.DB);
    const now = 1_762_041_660_000;
    await seedBuilder(db, now);
    await db.insert(imageBuildBundles).values({
      rev: "bundle-repair",
      r2Key: "builds/bundles/bundle-repair.tar.gz",
      metaJson: {
        buildFormatVersion: "intar-image-build-v11",
        scenarios: [],
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(imageBuilds).values({
      ...oldBuild("assigned-repair", "a", "assigned", "builder-1", now),
      rev: "bundle-repair",
    });
    const desired = createEmptyHostDesiredState({ ownerUserId: "user-1", scope: "platform",
      hostId: "builder-1",
      nowUnixMs: now,
    });
    await db.insert(hostDesiredState).values({
      hostId: "builder-1",
      version: desired.version,
      docJson: desired,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      reconcileAssignedBuildsForHost(db, "builder-1", now + 1),
    ).resolves.toEqual(["assigned-repair"]);

    const [stored] = await db
      .select({ docJson: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "builder-1"));
    expect(stored?.docJson.builds).toEqual([
      expect.objectContaining({
        build_id: "assigned-repair",
        scenario_id: "broken-nginx",
        bundle_ref: "builds/bundles/bundle-repair.tar.gz",
      }),
    ]);
  });

  it("retries desired cleanup left by an interrupted supersession", async () => {
    const db = drizzle(env.DB);
    const now = 1_762_041_660_000;
    await seedBuilder(db, now);
    await db.insert(imageBuildBundles).values({
      rev: "bundle-old",
      r2Key: "builds/bundles/bundle-old.tar.gz",
      metaJson: {
        buildFormatVersion: "intar-image-build-v11",
        scenarios: [],
      },
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
    });
    await db.insert(imageBuilds).values([
      oldBuild("current-queued", "a", "queued", null, now),
      {
        ...oldBuild("retired-stale", "b", "building", "builder-1", now),
        status: "stale" as const,
        error: "superseded by an interrupted request",
      },
    ]);
    const desired = {
      ...createEmptyHostDesiredState({ ownerUserId: "user-1", scope: "platform", hostId: "builder-1", nowUnixMs: now }),
      version: 7,
      builds: [
        desiredBuild("current-queued", "a"),
        desiredBuild("retired-stale", "b"),
        desiredBuild("keep", "9"),
      ],
    };
    await db.insert(hostDesiredState).values({
      hostId: "builder-1",
      version: desired.version,
      docJson: desired,
      createdAt: now,
      updatedAt: now,
    });

    await expect(queueBundle(db, "bundle-retry", "a", now + 1)).resolves.toEqual(
      { queued: 0 },
    );

    const [stored] = await db
      .select({ version: hostDesiredState.version, docJson: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "builder-1"));
    expect(stored?.version).toBe(8);
    expect(stored?.docJson.version).toBe(8);
    expect(stored?.docJson.builds.map((build) => build.build_id)).toEqual([
      "keep",
    ]);
  });

  it("holds reports outside a publish-fenced catalog interval", async () => {
    const db = drizzle(env.DB);
    const now = 1_762_041_660_000;
    await seedBuilder(db, now);
    await db.insert(imageBuildBundles).values({
      rev: "bundle-old",
      r2Key: "builds/bundles/bundle-old.tar.gz",
      metaJson: {
        buildFormatVersion: "intar-image-build-v11",
        scenarios: [],
      },
      createdAt: now,
      updatedAt: now,
    });
    await db
      .insert(imageBuilds)
      .values(oldBuild("assigned-old", "1", "assigned", "builder-1", now));

    let reportSettled = false;
    let reportPromise!: ReturnType<typeof recordImageBuildReport>;
    await withImageBuildCoordinationLock(
      db,
      { scenarioId: "broken-nginx", arch: "x86_64" },
      async () => {
        reportPromise = recordImageBuildReport(
          db,
          "builder-1",
          buildReport("assigned-old", "1"),
          now + 1,
          { sessionId: "builder-session", credentialGeneration: 1 },
        ).finally(() => {
          reportSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(reportSettled).toBe(false);
      },
    );

    await expect(reportPromise).resolves.toEqual({
      updated: true,
      terminal: true,
    });
  });

  it("rechecks silence after waiting for a publish fence", async () => {
    const db = drizzle(env.DB);
    const now = 1_762_041_660_000;
    await seedBuilder(db, now);
    await db.insert(imageBuildBundles).values({
      rev: "bundle-old",
      r2Key: "builds/bundles/bundle-old.tar.gz",
      metaJson: {
        buildFormatVersion: "intar-image-build-v11",
        scenarios: [],
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(imageBuilds).values({
      ...oldBuild("building-old", "1", "building", "builder-1", now),
      timingsJson: { lastReportAt: now - 31 * 60 * 1_000 },
      updatedAt: now - 31 * 60 * 1_000,
    });

    let maintenanceSettled = false;
    let maintenancePromise!: ReturnType<typeof maintainHostBuildAssignments>;
    await withImageBuildCoordinationLock(
      db,
      { scenarioId: "broken-nginx", arch: "x86_64" },
      async () => {
        maintenancePromise = maintainHostBuildAssignments(
          db,
          "builder-1",
          now,
        ).finally(() => {
          maintenanceSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(maintenanceSettled).toBe(false);
        await db
          .update(imageBuilds)
          .set({ timingsJson: { lastReportAt: now }, updatedAt: now })
          .where(eq(imageBuilds.id, "building-old"));
      },
    );

    await expect(maintenancePromise).resolves.toMatchObject({
      staleBuildIds: [],
    });
    const [build] = await db
      .select({ status: imageBuilds.status })
      .from(imageBuilds)
      .where(eq(imageBuilds.id, "building-old"));
    expect(build?.status).toBe("building");
  });

  it("releases the coordination lease when the callback fails", async () => {
    const db = drizzle(env.DB);
    const key = { scenarioId: "broken-nginx", arch: "x86_64" as const };
    await expect(
      withImageBuildCoordinationLock(db, key, async () => {
        throw new Error("injected callback failure");
      }),
    ).rejects.toThrow("injected callback failure");
    await expect(
      withImageBuildCoordinationLock(db, key, async () => "reacquired"),
    ).resolves.toBe("reacquired");

    let activeCallbacks = 0;
    let maximumActiveCallbacks = 0;
    const other = { scenarioId: "sandbox-cluster", arch: "x86_64" as const };
    await Promise.all([
      withImageBuildCoordinationLocks(db, [key, other, key], async () => {
        activeCallbacks += 1;
        maximumActiveCallbacks = Math.max(
          maximumActiveCallbacks,
          activeCallbacks,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCallbacks -= 1;
        return "first";
      }),
      withImageBuildCoordinationLocks(db, [other, key], async () => {
        activeCallbacks += 1;
        maximumActiveCallbacks = Math.max(
          maximumActiveCallbacks,
          activeCallbacks,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCallbacks -= 1;
        return "second";
      }),
    ]);
    expect(maximumActiveCallbacks).toBe(1);
    await expect(db.select().from(imageBuildCoordinationLocks)).resolves.toEqual(
      [],
    );
  });
});

describe("build scheduler fairness", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedScopes(drizzle(env.DB));
  });

  it("alternates single-slot refills between scopes", async () => {
    const db = drizzle(env.DB);
    await seedConnectedBuilder(db, "builder-1");
    await db.insert(imageBuilds).values([
      scheduledBuild("public-1", { status: "building", phase: "building", hostId: "builder-1" }),
      scheduledBuild("public-2", { status: "building", phase: "building", hostId: "builder-1" }),
      // Scope A's backlog is older, so an age-only queue would drain it first.
      ...[1, 2, 3].map((n) =>
        scheduledBuild(`a-${n}`, { organizationId: "org-a", createdAt: FAIR_NOW - 100 + n }),
      ),
    ]);
    await db.insert(imageBuilds).values(
      [1, 2, 3].map((n) =>
        scheduledBuild(`b-${n}`, { organizationId: "org-b", createdAt: FAIR_NOW - 50 + n }),
      ),
    );

    const inFlight = ["public-1", "public-2"];
    const refills: string[] = [];
    for (let report = 0; report < 4; report++) {
      await db
        .update(imageBuilds)
        .set({ status: "succeeded", phase: "succeeded" })
        .where(eq(imageBuilds.id, inFlight.shift() ?? ""));
      const assigned = await assignQueuedImageBuilds(db, FAIR_NOW);
      expect(assigned).toHaveLength(1);
      inFlight.push(assigned[0]?.buildId ?? "");
      refills.push(assigned[0]?.buildId ?? "");
    }
    expect(refills).toEqual(["a-1", "b-1", "a-2", "b-2"]);
  });

  it.each([
    [
      "publishing builds",
      [
        { status: "building", phase: "publishing" },
        { status: "building", phase: "uploading_logs" },
      ],
    ],
    [
      "stale rows still in phase building",
      [
        { status: "stale", phase: "building", error: "superseded by bundle next" },
        { status: "stale", phase: "building", error: "builder stopped reporting build progress" },
      ],
    ],
  ] as const)("does not count %s toward the slot cap", async (_name, rows) => {
    const db = drizzle(env.DB);
    await seedConnectedBuilder(db, "builder-1");
    await db.insert(imageBuilds).values([
      ...rows.map((row, index) =>
        scheduledBuild(`held-${index}`, { ...row, hostId: "builder-1" }),
      ),
      scheduledBuild("queued-1", { createdAt: FAIR_NOW - 2 }),
      scheduledBuild("queued-2", { createdAt: FAIR_NOW - 1 }),
    ]);

    await expect(assignQueuedImageBuilds(db, FAIR_NOW)).resolves.toEqual([
      { buildId: "queued-1", hostId: "builder-1" },
      { buildId: "queued-2", hostId: "builder-1" },
    ]);
  });

  it("holds the slot cap against a concurrent assignment pass", async () => {
    const db = drizzle(env.DB);
    await seedConnectedBuilder(db, "builder-1");
    await db.insert(imageBuilds).values([
      scheduledBuild("running", { status: "building", phase: "building", hostId: "builder-1" }),
      ...[1, 2, 3].map((n) => scheduledBuild(`queued-${n}`, { createdAt: FAIR_NOW - 10 + n })),
    ]);

    // Both passes read the same snapshot: one pre-publication build.
    const race = interleaveBefore(/^update "image_builds" set "host_id"/iu, () =>
      assignQueuedImageBuilds(db, FAIR_NOW),
    );
    try {
      await assignQueuedImageBuilds(db, FAIR_NOW);
      expect(race.fired()).toBe(true);
    } finally {
      race.restore();
    }

    const held = await db
      .select({ id: imageBuilds.id })
      .from(imageBuilds)
      .where(
        and(
          eq(imageBuilds.hostId, "builder-1"),
          inArray(imageBuilds.status, ["assigned", "building"]),
        ),
      );
    expect(held).toHaveLength(2);
  });

  it("assigns git- builds only to builders on the Worker's compile digest", async () => {
    const db = drizzle(env.DB);
    const digest = await platformCompileDigest(env.PLATFORM_BASE_IMAGES_SHA256);
    expect(digest).toMatch(/^p[0-9a-f]{8}$/u);
    // A deduplicated build keeps the rev that first queued it, here one from
    // an older digest.
    const rev = `git-1-${"a".repeat(40)}-p00000000`;
    await db.insert(imageBuildBundles).values(scheduledBundle(rev, null));
    await db.insert(imageBuilds).values(scheduledBuild("git-build", { rev }));
    await seedConnectedBuilder(db, "builder-old", "p00000000");

    await expect(assignQueuedImageBuilds(db, FAIR_NOW)).resolves.toEqual([]);

    await seedConnectedBuilder(db, "builder-current", digest ?? undefined);
    await expect(assignQueuedImageBuilds(db, FAIR_NOW)).resolves.toEqual([
      { buildId: "git-build", hostId: "builder-current" },
    ]);
  });
});

const FAIR_NOW = 1_762_041_660_000;

async function seedScopes(db: SchedulerDb): Promise<void> {
  await db.insert(user).values({
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    emailVerified: true,
    createdAt: new Date(FAIR_NOW),
    updatedAt: new Date(FAIR_NOW),
  });
  await db.insert(organization).values(
    ["org-a", "org-b"].map((id) => ({
      id,
      name: id,
      slug: id,
      createdAt: new Date(FAIR_NOW),
    })),
  );
  await db
    .insert(imageBuildBundles)
    .values([
      scheduledBundle("bundle-public", null),
      scheduledBundle("bundle-org-a", "org-a"),
      scheduledBundle("bundle-org-b", "org-b"),
    ]);
}

function scheduledBundle(rev: string, organizationId: string | null) {
  return {
    rev,
    organizationId,
    r2Key: `builds/bundles/${rev}.tar.gz`,
    metaJson: { buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION, scenarios: [] },
    createdAt: FAIR_NOW,
    updatedAt: FAIR_NOW,
  };
}

async function seedConnectedBuilder(
  db: SchedulerDb,
  hostId: string,
  sourceCompilePlatform?: string,
): Promise<void> {
  await db.insert(agentHosts).values({
    id: hostId,
    userId: "user-1",
    name: hostId,
    scope: "platform",
    credentialGeneration: 1,
    activeSessionId: `${hostId}-session`,
    lastClientHelloAt: FAIR_NOW,
    role: "builder",
    scenarioEnabled: false,
    disabled: false,
    connected: true,
    createdAt: FAIR_NOW,
    updatedAt: FAIR_NOW,
  });
  const report = {
    ...structuredClone(hostReportFixture),
    host_id: hostId,
    observed_at_unix_ms: FAIR_NOW,
    vms: [],
    builds: [],
  } as HostStateReportV2;
  if (sourceCompilePlatform) {
    report.capabilities.source_compile_platform = sourceCompilePlatform;
  }
  await db.insert(hostActualState).values({
    hostId,
    appliedDesiredVersion: 0,
    observedAt: FAIR_NOW,
    reportJson: report,
    createdAt: FAIR_NOW,
    updatedAt: FAIR_NOW,
  });
}

function scheduledBuild(
  id: string,
  input: {
    organizationId?: string | null;
    rev?: string;
    status?: "queued" | "assigned" | "building" | "stale";
    phase?: BuildReportV1["phase"];
    hostId?: string;
    error?: string;
    createdAt?: number;
  },
) {
  const organizationId = input.organizationId ?? null;
  const createdAt = input.createdAt ?? FAIR_NOW - 1_000;
  return {
    id,
    organizationId,
    scenarioId: id,
    arch: "x86_64" as const,
    rev: input.rev ?? `bundle-${organizationId ?? "public"}`,
    contentHash: "a".repeat(64),
    hostId: input.hostId ?? null,
    status: input.status ?? "queued",
    phase: input.phase ?? "queued",
    attempt: 0,
    error: input.error ?? null,
    logR2Key: null,
    timingsJson: {},
    createdAt,
    updatedAt: createdAt,
  };
}

async function queueBundle(
  db: SchedulerDb,
  rev: string,
  hashChar: string,
  nowUnixMs: number,
) {
  return queueImageBuildsFromBundle(db, {
    rev,
    r2Key: `builds/bundles/${rev}.tar.gz`,
    meta: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      scenarios: [
        {
          scenarioId: "broken-nginx",
          arch: "x86_64",
          contentHash: hashChar.repeat(64),
        },
      ],
    },
    nowUnixMs,
  });
}

function oldBuild(
  id: string,
  hashChar: string,
  status: "queued" | "assigned" | "building" | "succeeded" | "failed",
  hostId: string | null,
  now: number,
) {
  const phase: BuildReportV1["phase"] =
    status === "queued" || status === "assigned" ? "queued" : status;
  return {
    id,
    scenarioId: "broken-nginx",
    arch: "x86_64" as const,
    rev: "bundle-old",
    contentHash: hashChar.repeat(64),
    hostId,
    status,
    phase,
    attempt: status === "queued" ? 0 : 1,
    error: null,
    logR2Key: null,
    timingsJson: {},
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
  };
}

function desiredBuild(id: string, hashChar: string): DesiredBuildV1 {
  return {
    build_id: id,
    scenario_id: "broken-nginx",
    arch: "x86_64",
    rev: "bundle-old",
    content_hash: hashChar.repeat(64),
    bundle_ref: "builds/bundles/bundle-old.tar.gz",
  };
}

function buildReport(buildId: string, hashChar: string): BuildReportV1 {
  return {
    schema_version: 1,
    host_id: "builder-1",
    build_id: buildId,
    scenario_id: "broken-nginx",
    content_hash: hashChar.repeat(64),
    observed_at_unix_ms: 1_762_041_660_001,
    phase: "succeeded",
    current_vm: null,
    started_at_unix_ms: 1_762_041_659_000,
    finished_at_unix_ms: 1_762_041_660_001,
    attempt: 1,
    error: null,
  };
}

async function seedBuilder(
  db: ReturnType<typeof drizzle>,
  now: number,
): Promise<void> {
  await db.insert(user).values({
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(agentHosts).values({
    id: "builder-1",
    userId: "user-1",
    name: "Builder 1",
    scope: "platform",
    credentialGeneration: 1,
    activeSessionId: "builder-session",
    role: "builder",
    scenarioEnabled: false,
    disabled: false,
    connected: false,
    createdAt: now,
    updatedAt: now,
  });
}
