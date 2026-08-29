/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  hostDesiredState,
  imageBuildCoordinationLocks,
  imageBuildBundles,
  imageBuilds,
  user,
} from "@/db/schema";
import type { BuildReportV1, DesiredBuildV1 } from "@/generated/bridge";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import {
  maintainHostBuildAssignments,
  queueImageBuildsFromBundle,
  recordImageBuildReport,
} from "@/lib/build-scheduler";
import {
  withImageBuildCoordinationLock,
  withImageBuildCoordinationLocks,
} from "@/lib/image-build-lock";
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
      kinoVersion: "0.4.0",
      metaJson: {
        buildFormatVersion: "intar-image-build-v9",
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
    ];
    await db.insert(imageBuilds).values(oldRows);

    const desired = {
      ...createEmptyHostDesiredState({ hostId: "builder-1", nowUnixMs: now }),
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
        kinoVersion: "0.4.0",
        meta: {
          buildFormatVersion: "intar-image-build-v9",
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
    for (const id of ["queued-old", "assigned-old", "building-old"]) {
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
    expect(byId.get("failed-old")).toMatchObject({
      status: "failed",
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
      ),
    ).resolves.toEqual({ updated: false, terminal: false });

    await expect(
      queueImageBuildsFromBundle(db, {
        rev: "bundle-same-hash",
        r2Key: "builds/bundles/bundle-same-hash.tar.gz",
        kinoVersion: "0.4.0",
        meta: {
          buildFormatVersion: "intar-image-build-v9",
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

  it("retries desired cleanup left by an interrupted supersession", async () => {
    const db = drizzle(env.DB);
    const now = 1_762_041_660_000;
    await seedBuilder(db, now);
    await db.insert(imageBuildBundles).values({
      rev: "bundle-old",
      r2Key: "builds/bundles/bundle-old.tar.gz",
      kinoVersion: "0.4.0",
      metaJson: {
        buildFormatVersion: "intar-image-build-v9",
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
      ...createEmptyHostDesiredState({ hostId: "builder-1", nowUnixMs: now }),
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
      kinoVersion: "0.4.0",
      metaJson: {
        buildFormatVersion: "intar-image-build-v9",
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
      kinoVersion: "0.4.0",
      metaJson: {
        buildFormatVersion: "intar-image-build-v9",
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
    const other = { scenarioId: "workshop-cluster", arch: "x86_64" as const };
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

async function queueBundle(
  db: SchedulerDb,
  rev: string,
  hashChar: string,
  nowUnixMs: number,
) {
  return queueImageBuildsFromBundle(db, {
    rev,
    r2Key: `builds/bundles/${rev}.tar.gz`,
    kinoVersion: "0.4.0",
    meta: {
      buildFormatVersion: "intar-image-build-v9",
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
    kinoVersion: "0.4.0",
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
    kino_version: "0.4.0",
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
    role: "builder",
    scenarioEnabled: false,
    disabled: false,
    connected: false,
    createdAt: now,
    updatedAt: now,
  });
}
