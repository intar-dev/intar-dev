/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  member,
  organization,
  user,
  workshopRegistryTokens,
} from "@/db/schema";
import { revokeBetaUser } from "@/lib/access-invites";
import {
  FIXTURE_BETA_ADMIN_ID,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import {
  createWorkshopRegistryToken,
  hashWorkshopRegistryToken,
  listWorkshopRegistryTokens,
  revokeWorkshopRegistryToken,
} from "./registry-tokens";

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_TOKEN_LIFETIME_MS = 366 * DAY_MS;

describe("workshop registry token administration", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedOrganizations();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets an owner create, list, and revoke a token with a 24-hour default expiry", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const created = await createWorkshopRegistryToken({
      organizationId: "org-a",
      actorUserId: "owner-a",
      name: "CI publisher",
    });

    expect(created).toMatchObject({
      name: "CI publisher",
      expiresAt: NOW + DAY_MS,
      revokedAt: null,
      createdAt: NOW,
    });
    expect(created.token).toMatch(/^intar_ws_[a-f0-9]{64}$/);

    const listedBeforeRevoke = await listWorkshopRegistryTokens({
      organizationId: "org-a",
      actorUserId: "owner-a",
    });
    expect(listedBeforeRevoke).toEqual([
      {
        id: created.id,
        name: "CI publisher",
        tokenPrefix: created.tokenPrefix,
        lastUsedAt: null,
        expiresAt: NOW + DAY_MS,
        revokedAt: null,
        createdAt: NOW,
      },
    ]);

    clock.mockReturnValue(NOW + 5_000);
    await expect(
      revokeWorkshopRegistryToken({
        organizationId: "org-a",
        actorUserId: "owner-a",
        tokenId: created.id,
      }),
    ).resolves.toBeUndefined();

    await expect(
      listWorkshopRegistryTokens({
        organizationId: "org-a",
        actorUserId: "owner-a",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: created.id,
        revokedAt: NOW + 5_000,
      }),
    ]);
  });

  it("does not create a registry token after the owner loses beta access", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await revokeBetaUser({
      d1: env.DB,
      userId: "owner-a",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "registry_access_revoked",
      now: NOW,
    });

    await expect(
      createWorkshopRegistryToken({
        organizationId: "org-a",
        actorUserId: "owner-a",
        name: "Must not exist",
      }),
    ).rejects.toMatchObject({ status: 403, code: "beta_access_revoked" });
    const rows = await drizzle(env.DB).select().from(workshopRegistryTokens);
    expect(rows).toEqual([]);
  });

  it("denies token creation, listing, and revocation to admins, members, and nonmembers", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const token = await createWorkshopRegistryToken({
      organizationId: "org-a",
      actorUserId: "owner-a",
      name: "Owner token",
    });

    for (const actorUserId of ["admin-a", "member-a"]) {
      for (const operation of [
        () =>
          createWorkshopRegistryToken({
            organizationId: "org-a",
            actorUserId,
            name: "Forbidden token",
          }),
        () =>
          listWorkshopRegistryTokens({
            organizationId: "org-a",
            actorUserId,
          }),
        () =>
          revokeWorkshopRegistryToken({
            organizationId: "org-a",
            actorUserId,
            tokenId: token.id,
          }),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          status: 403,
          code: "organization_owner_required",
        });
      }
    }

    for (const operation of [
      () =>
        createWorkshopRegistryToken({
          organizationId: "org-a",
          actorUserId: "nonmember",
          name: "Forbidden token",
        }),
      () =>
        listWorkshopRegistryTokens({
          organizationId: "org-a",
          actorUserId: "nonmember",
        }),
      () =>
        revokeWorkshopRegistryToken({
          organizationId: "org-a",
          actorUserId: "nonmember",
          tokenId: token.id,
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        status: 404,
        code: "organization_not_found",
      });
    }

    const rows = await drizzle(env.DB)
      .select({ revokedAt: workshopRegistryTokens.revokedAt })
      .from(workshopRegistryTokens)
      .where(eq(workshopRegistryTokens.id, token.id));
    expect(rows).toEqual([{ revokedAt: null }]);
  });

  it("returns plaintext only at creation and persists only its SHA-256 hash and prefix", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const created = await createWorkshopRegistryToken({
      organizationId: "org-a",
      actorUserId: "owner-a",
      name: "Secret handling",
    });
    const rows = await drizzle(env.DB)
      .select()
      .from(workshopRegistryTokens)
      .where(eq(workshopRegistryTokens.id, created.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      organizationId: "org-a",
      tokenPrefix: created.tokenPrefix,
      tokenHash: await hashWorkshopRegistryToken(created.token),
    });
    expect(rows[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.token.startsWith(created.tokenPrefix)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(created.token);

    const listed = await listWorkshopRegistryTokens({
      organizationId: "org-a",
      actorUserId: "owner-a",
    });
    expect(listed[0]).not.toHaveProperty("token");
    expect(listed[0]).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it("trims valid names and enforces the 1-to-80 character name boundary", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    await expect(
      createWorkshopRegistryToken({
        organizationId: "org-a",
        actorUserId: "owner-a",
        name: "  A  ",
      }),
    ).resolves.toMatchObject({ name: "A" });
    await expect(
      createWorkshopRegistryToken({
        organizationId: "org-a",
        actorUserId: "owner-a",
        name: "x".repeat(80),
      }),
    ).resolves.toMatchObject({ name: "x".repeat(80) });

    for (const name of ["", "   ", "x".repeat(81)]) {
      await expect(
        createWorkshopRegistryToken({
          organizationId: "org-a",
          actorUserId: "owner-a",
          name,
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: "invalid_workshop_registry_token_name",
      });
    }
  });

  it("accepts the exact 366-day expiry ceiling and rejects invalid expiries", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    await expect(
      createWorkshopRegistryToken({
        organizationId: "org-a",
        actorUserId: "owner-a",
        name: "Maximum lifetime",
        expiresAt: NOW + MAX_TOKEN_LIFETIME_MS,
      }),
    ).resolves.toMatchObject({
      expiresAt: NOW + MAX_TOKEN_LIFETIME_MS,
    });

    for (const expiresAt of [
      NOW,
      NOW - 1,
      NOW + MAX_TOKEN_LIFETIME_MS + 1,
      NOW + 1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        createWorkshopRegistryToken({
          organizationId: "org-a",
          actorUserId: "owner-a",
          name: "Invalid expiry",
          expiresAt,
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: "invalid_workshop_registry_token_expiry",
      });
    }
  });

  it("keeps token listing and revocation isolated to the owning organization", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const orgAToken = await createWorkshopRegistryToken({
      organizationId: "org-a",
      actorUserId: "owner-a",
      name: "Organization A",
    });
    clock.mockReturnValue(NOW + 1_000);
    const orgBToken = await createWorkshopRegistryToken({
      organizationId: "org-b",
      actorUserId: "owner-b",
      name: "Organization B",
    });

    await expect(
      listWorkshopRegistryTokens({
        organizationId: "org-a",
        actorUserId: "owner-a",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: orgAToken.id, name: "Organization A" }),
    ]);
    await expect(
      listWorkshopRegistryTokens({
        organizationId: "org-b",
        actorUserId: "owner-b",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: orgBToken.id, name: "Organization B" }),
    ]);
    await expect(
      listWorkshopRegistryTokens({
        organizationId: "org-b",
        actorUserId: "owner-a",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "organization_not_found",
    });

    await expect(
      revokeWorkshopRegistryToken({
        organizationId: "org-a",
        actorUserId: "owner-a",
        tokenId: orgBToken.id,
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_registry_token_not_found",
    });

    const [storedOrgBToken] = await drizzle(env.DB)
      .select({ revokedAt: workshopRegistryTokens.revokedAt })
      .from(workshopRegistryTokens)
      .where(eq(workshopRegistryTokens.id, orgBToken.id));
    expect(storedOrgBToken?.revokedAt).toBeNull();
  });

  it("lists newest tokens first", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const oldest = await createWorkshopRegistryToken({
      organizationId: "org-a",
      actorUserId: "owner-a",
      name: "Oldest",
    });
    clock.mockReturnValue(NOW + 1_000);
    const middle = await createWorkshopRegistryToken({
      organizationId: "org-a",
      actorUserId: "owner-a",
      name: "Middle",
    });
    clock.mockReturnValue(NOW + 2_000);
    const newest = await createWorkshopRegistryToken({
      organizationId: "org-a",
      actorUserId: "owner-a",
      name: "Newest",
    });

    const listed = await listWorkshopRegistryTokens({
      organizationId: "org-a",
      actorUserId: "owner-a",
    });
    expect(listed.map(({ id }) => id)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);
  });

  it("makes repeated same-organization revocation idempotent without changing its timestamp", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const token = await createWorkshopRegistryToken({
      organizationId: "org-a",
      actorUserId: "owner-a",
      name: "Idempotent revoke",
    });

    clock.mockReturnValue(NOW + 1_000);
    await revokeWorkshopRegistryToken({
      organizationId: "org-a",
      actorUserId: "owner-a",
      tokenId: token.id,
    });
    clock.mockReturnValue(NOW + 2_000);
    await expect(
      revokeWorkshopRegistryToken({
        organizationId: "org-a",
        actorUserId: "owner-a",
        tokenId: token.id,
      }),
    ).resolves.toBeUndefined();

    const rows = await drizzle(env.DB)
      .select({ revokedAt: workshopRegistryTokens.revokedAt })
      .from(workshopRegistryTokens)
      .where(eq(workshopRegistryTokens.id, token.id));
    expect(rows).toEqual([{ revokedAt: NOW + 1_000 }]);

    await expect(
      revokeWorkshopRegistryToken({
        organizationId: "org-a",
        actorUserId: "owner-a",
        tokenId: "missing-token",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_registry_token_not_found",
    });
  });
});

async function seedOrganizations(): Promise<void> {
  const db = drizzle(env.DB);
  const now = new Date(NOW);
  await db.insert(user).values(
    ["owner-a", "admin-a", "member-a", "nonmember", "owner-b"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.insert(organization).values([
    {
      id: "org-a",
      name: "Organization A",
      slug: "org-a",
      createdAt: now,
    },
    {
      id: "org-b",
      name: "Organization B",
      slug: "org-b",
      createdAt: now,
    },
  ]);
  await db.insert(member).values([
    {
      id: "membership-owner-a",
      organizationId: "org-a",
      userId: "owner-a",
      role: "owner",
      createdAt: now,
    },
    {
      id: "membership-admin-a",
      organizationId: "org-a",
      userId: "admin-a",
      role: "admin",
      createdAt: now,
    },
    {
      id: "membership-member-a",
      organizationId: "org-a",
      userId: "member-a",
      role: "member",
      createdAt: now,
    },
    {
      id: "membership-owner-b",
      organizationId: "org-b",
      userId: "owner-b",
      role: "owner",
      createdAt: now,
    },
  ]);
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId: "owner-a",
    githubUsername: "owner-a",
    now: NOW - 10_000,
  });
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId: "owner-b",
    githubUsername: "owner-b",
    now: NOW - 5_000,
  });
}
