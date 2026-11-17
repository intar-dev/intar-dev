/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { bundles, member, organization, scenarios, user } from "@/db/schema";
import { StaticFeatureToggleService } from "@/lib/feature-toggles";
import { createOrganization, getOrganizationDetail, renameOrganizationSlug } from "@/lib/organizations";
import { resetD1Database } from "@/test/d1-migrations";

describe("organization slug rename", () => {
  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    await db.insert(user).values(
      ["owner", "plain", "operator"].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
        role: id === "operator" ? "admin" : "user",
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    await db.insert(organization).values([
      // An old generated slug, which is not a chosen one.
      { id: "org-a", name: "Org A", slug: "Org-A-x1Y2z3", createdAt: new Date() },
      { id: "org-b", name: "Org B", slug: "org-b", createdAt: new Date() },
    ]);
    await db.insert(member).values([
      { id: "m-owner", organizationId: "org-a", userId: "owner", role: "owner", createdAt: new Date() },
      { id: "m-plain", organizationId: "org-a", userId: "plain", role: "member", createdAt: new Date() },
    ]);
  });

  const slugOf = async (id: string) =>
    (await drizzle(env.DB).select({ slug: organization.slug }).from(organization).where(eq(organization.id, id)))[0]?.slug;

  it("shows admins that an old slug cannot publish, and allows one rename", async () => {
    const before = await getOrganizationDetail({ organizationKey: "org-a", userId: "owner" });
    expect(before.slugState).toEqual({ scenarioNamespace: false, renamedAt: null, inUse: false });
    const member = await getOrganizationDetail({ organizationKey: "org-a", userId: "plain" });
    expect(member.slugState).toBeNull();

    await expect(renameOrganizationSlug({ organizationId: "org-a", actorUserId: "owner", slug: "acme" }))
      .resolves.toEqual({ id: "org-a", slug: "acme" });
    expect(await slugOf("org-a")).toBe("acme");
    const after = await getOrganizationDetail({ organizationKey: "org-a", userId: "owner" });
    expect(after.slugState?.scenarioNamespace).toBe(true);
    expect(after.slugState?.renamedAt).toEqual(expect.any(Number));

    await expect(renameOrganizationSlug({ organizationId: "org-a", actorUserId: "owner", slug: "acme-two" }))
      .rejects.toMatchObject({ status: 409, code: "organization_slug_rename_used" });
    expect(await slugOf("org-a")).toBe("acme");
  });

  it("refuses members, invalid, reserved and taken slugs", async () => {
    await expect(renameOrganizationSlug({ organizationId: "org-a", actorUserId: "plain", slug: "acme" }))
      .rejects.toMatchObject({ status: 403, code: "organization_admin_required" });
    await expect(renameOrganizationSlug({ organizationId: "org-b", actorUserId: "owner", slug: "acme" }))
      .rejects.toMatchObject({ status: 404, code: "organization_not_found" });
    await expect(renameOrganizationSlug({ organizationId: "org-a", actorUserId: "owner", slug: "Acme" }))
      .rejects.toMatchObject({ status: 400, code: "invalid_organization_slug" });
    await expect(renameOrganizationSlug({ organizationId: "org-a", actorUserId: "owner", slug: "play" }))
      .rejects.toMatchObject({ status: 400, code: "organization_slug_reserved" });
    await expect(renameOrganizationSlug({ organizationId: "org-a", actorUserId: "owner", slug: "org-b" }))
      .rejects.toMatchObject({ status: 409, code: "organization_slug_taken" });
    expect(await slugOf("org-a")).toBe("Org-A-x1Y2z3");
  });

  it("keeps a slug given up by a rename from every other organization", async () => {
    await drizzle(env.DB).update(organization).set({ slug: "acme" }).where(eq(organization.id, "org-a"));
    await renameOrganizationSlug({ organizationId: "org-a", actorUserId: "owner", slug: "acme2" });
    expect((await drizzle(env.DB).select({ previous: organization.previousSlug }).from(organization)
      .where(eq(organization.id, "org-a")))[0]?.previous).toBe("acme");

    await expect(renameOrganizationSlug({ organizationId: "org-b", actorUserId: "operator", slug: "acme" }))
      .rejects.toMatchObject({ status: 409, code: "organization_slug_taken" });
    expect(await slugOf("org-b")).toBe("org-b");
    await expect(createOrganization({
      name: "Copycat", slug: "acme", ownerUserId: "plain",
      featureToggleService: new StaticFeatureToggleService({ "organization-creation": true }),
    })).rejects.toMatchObject({ status: 409, code: "organization_slug_taken" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM organization").first<{ n: number }>())?.n).toBe(2);
    expect(await env.DB.prepare("SELECT 1 FROM member WHERE user_id = 'plain' AND role = 'owner'").first()).toBeNull();
    // The organization itself cannot go back: the rename happens once.
    await expect(renameOrganizationSlug({ organizationId: "org-a", actorUserId: "owner", slug: "acme" }))
      .rejects.toMatchObject({ status: 409, code: "organization_slug_rename_used" });
    // Another organization that renames later still cannot take it.
    await expect(renameOrganizationSlug({ organizationId: "org-b", actorUserId: "operator", slug: "beta" }))
      .resolves.toEqual({ id: "org-b", slug: "beta" });
    await expect(createOrganization({
      name: "Fresh", slug: "fresh", ownerUserId: "plain",
      featureToggleService: new StaticFeatureToggleService({ "organization-creation": true }),
    })).resolves.toMatchObject({ slug: "fresh", role: "owner" });
  });

  it("lets a platform admin rename an organization they are not in", async () => {
    await expect(renameOrganizationSlug({ organizationId: "org-b", actorUserId: "operator", slug: "beta" }))
      .resolves.toEqual({ id: "org-b", slug: "beta" });
  });

  it("refuses once scenarios or bundles are keyed by the slug", async () => {
    const db = drizzle(env.DB);
    await db.insert(scenarios).values({
      id: "org-b/lab", namespace: "org-b", slug: "lab", organizationId: "org-b",
      scopeKey: "organization:org-b", enabled: true, play: false,
    });
    await expect(renameOrganizationSlug({ organizationId: "org-b", actorUserId: "operator", slug: "beta" }))
      .rejects.toMatchObject({ status: 409, code: "organization_slug_in_use" });

    await db.insert(bundles).values({
      rev: "git-1-abc-p00000000", scopeKey: "organization:org-a", organizationId: "org-a",
      compilerVersion: "v2", r2Key: "builds/bundles/x.json.gz",
    });
    await expect(renameOrganizationSlug({ organizationId: "org-a", actorUserId: "owner", slug: "acme" }))
      .rejects.toMatchObject({ status: 409, code: "organization_slug_in_use" });
    expect(await slugOf("org-a")).toBe("Org-A-x1Y2z3");
  });
});
