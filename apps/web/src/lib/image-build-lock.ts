import { and, eq, gt, lte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { imageBuildCoordinationLocks } from "@/db/schema";
import type { ImageArchitecture } from "@/generated/catalog";

const IMAGE_BUILD_LOCK_LEASE_MS = 120_000;
const IMAGE_BUILD_LOCK_RENEW_MS = 30_000;
const IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const IMAGE_BUILD_LOCK_RETRY_MS = 50;

export interface ImageBuildCoordinationLease {
  assertHeld(): Promise<void>;
}

export interface ImageBuildCoordinationKey {
  scenarioId: string;
  arch: ImageArchitecture;
}

export async function withImageBuildCoordinationLock<T>(
  db: DrizzleD1Database,
  input: ImageBuildCoordinationKey,
  callback: (lease: ImageBuildCoordinationLease) => Promise<T>,
): Promise<T> {
  return withImageBuildCoordinationLocks(db, [input], callback);
}

export async function withImageBuildCoordinationLocks<T>(
  db: DrizzleD1Database,
  inputs: readonly ImageBuildCoordinationKey[],
  callback: (lease: ImageBuildCoordinationLease) => Promise<T>,
): Promise<T> {
  const keys = [
    ...new Map(
      inputs.map((input) => [coordinationKey(input), input] as const),
    ).entries(),
  ].sort(([left], [right]) => left.localeCompare(right));
  const leases: ImageBuildCoordinationLease[] = [];

  const acquireNext = async (index: number): Promise<T> => {
    const entry = keys[index];
    if (!entry) {
      return callback({
        assertHeld: async () => {
          for (const lease of leases) await lease.assertHeld();
        },
      });
    }
    const [key, input] = entry;
    return withImageBuildCoordinationLockKey(
      db,
      key,
      input,
      async (lease) => {
        leases.push(lease);
        try {
          return await acquireNext(index + 1);
        } finally {
          leases.pop();
        }
      },
    );
  };

  return acquireNext(0);
}

async function withImageBuildCoordinationLockKey<T>(
  db: DrizzleD1Database,
  key: string,
  input: ImageBuildCoordinationKey,
  callback: (lease: ImageBuildCoordinationLease) => Promise<T>,
): Promise<T> {
  const ownerToken = crypto.randomUUID();
  const acquireDeadline = Date.now() + IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS;

  while (!(await tryAcquireImageBuildLock(db, key, ownerToken))) {
    if (Date.now() >= acquireDeadline) {
      throw new Error(
        `timed out acquiring image-build coordination lock for ${input.scenarioId}/${input.arch}`,
      );
    }
    await delay(IMAGE_BUILD_LOCK_RETRY_MS);
  }

  const renewal = startLeaseRenewal(db, key, ownerToken);
  const lease: ImageBuildCoordinationLease = {
    assertHeld: () => assertImageBuildLockHeld(db, key, ownerToken),
  };
  try {
    const result = await callback(lease);
    await renewal.assertHealthy();
    await lease.assertHeld();
    return result;
  } finally {
    try {
      await renewal.stop();
    } finally {
      await db
        .delete(imageBuildCoordinationLocks)
        .where(
          and(
            eq(imageBuildCoordinationLocks.key, key),
            eq(imageBuildCoordinationLocks.ownerToken, ownerToken),
          ),
        );
    }
  }
}

function coordinationKey(input: ImageBuildCoordinationKey): string {
  return JSON.stringify([input.scenarioId, input.arch]);
}

async function tryAcquireImageBuildLock(
  db: DrizzleD1Database,
  key: string,
  ownerToken: string,
): Promise<boolean> {
  const now = Date.now();
  const acquired = await db
    .insert(imageBuildCoordinationLocks)
    .values({
      key,
      ownerToken,
      expiresAt: now + IMAGE_BUILD_LOCK_LEASE_MS,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: imageBuildCoordinationLocks.key,
      set: {
        ownerToken,
        expiresAt: now + IMAGE_BUILD_LOCK_LEASE_MS,
        updatedAt: now,
      },
      setWhere: lte(imageBuildCoordinationLocks.expiresAt, now),
    })
    .returning({ ownerToken: imageBuildCoordinationLocks.ownerToken });
  return acquired[0]?.ownerToken === ownerToken;
}

function startLeaseRenewal(
  db: DrizzleD1Database,
  key: string,
  ownerToken: string,
): {
  assertHealthy(): Promise<void>;
  stop(): Promise<void>;
} {
  const controller = new AbortController();
  let renewalError: unknown = null;
  const done = (async () => {
    try {
      while (await delay(IMAGE_BUILD_LOCK_RENEW_MS, controller.signal)) {
        const now = Date.now();
        const renewed = await db
          .update(imageBuildCoordinationLocks)
          .set({
            expiresAt: now + IMAGE_BUILD_LOCK_LEASE_MS,
            updatedAt: now,
          })
          .where(
            and(
              eq(imageBuildCoordinationLocks.key, key),
              eq(imageBuildCoordinationLocks.ownerToken, ownerToken),
              gt(imageBuildCoordinationLocks.expiresAt, now),
            ),
          )
          .returning({ key: imageBuildCoordinationLocks.key });
        if (!renewed.length) {
          throw new Error("image-build coordination lock lease was lost");
        }
      }
    } catch (error) {
      renewalError = error;
    }
  })();

  return {
    async assertHealthy(): Promise<void> {
      if (renewalError) throw renewalError;
    },
    async stop(): Promise<void> {
      controller.abort();
      await done;
    },
  };
}

async function assertImageBuildLockHeld(
  db: DrizzleD1Database,
  key: string,
  ownerToken: string,
): Promise<void> {
  const now = Date.now();
  const rows = await db
    .update(imageBuildCoordinationLocks)
    .set({
      expiresAt: now + IMAGE_BUILD_LOCK_LEASE_MS,
      updatedAt: now,
    })
    .where(
      and(
        eq(imageBuildCoordinationLocks.key, key),
        eq(imageBuildCoordinationLocks.ownerToken, ownerToken),
        gt(imageBuildCoordinationLocks.expiresAt, now),
      ),
    )
    .returning({ key: imageBuildCoordinationLocks.key });
  if (!rows.length) {
    throw new Error("image-build coordination lock lease was lost");
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
