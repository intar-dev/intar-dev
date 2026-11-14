/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { member, organization, user } from "@/db/schema";
import { setPublicPlay } from "@/lib/organization-entitlements";
import { resetD1Database } from "@/test/d1-migrations";

const grantedAt = async () =>
  (await env.DB.prepare("SELECT public_play_granted_at AS at, granted_by AS by FROM organization_entitlements WHERE organization_id = 'org-a'")
    .first<{ at: number | null; by: string }>()) ?? null;

describe("public play entitlement", () => {
  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    await db.insert(user).values(["operator", "owner"].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true,
      role: id === "operator" ? "admin" : "user", createdAt: new Date(), updatedAt: new Date(),
    })));
    await db.insert(organization).values({ id: "org-a", name: "Org A", slug: "org-a", createdAt: new Date() });
    await db.insert(member).values({ id: "m", organizationId: "org-a", userId: "owner", role: "owner", createdAt: new Date() });
  });

  it("lets a platform admin grant and revoke it, keeping the first grant time", async () => {
    const first = await setPublicPlay({ organizationId: "org-a", actorUserId: "operator", granted: true });
    expect(first.publicPlayGrantedAt).toEqual(expect.any(Number));
    const again = await setPublicPlay({ organizationId: "org-a", actorUserId: "operator", granted: true });
    expect(again.publicPlayGrantedAt).toBe(first.publicPlayGrantedAt);
    expect(await grantedAt()).toEqual({ at: first.publicPlayGrantedAt, by: "operator" });

    await expect(setPublicPlay({ organizationId: "org-a", actorUserId: "operator", granted: false }))
      .resolves.toEqual({ organizationId: "org-a", publicPlayGrantedAt: null });
    expect((await grantedAt())?.at).toBeNull();
  });

  it("refuses everyone else, the organization's own owner included", async () => {
    await expect(setPublicPlay({ organizationId: "org-a", actorUserId: "owner", granted: true }))
      .rejects.toMatchObject({ status: 403, code: "admin_required" });
    expect(await grantedAt()).toBeNull();
    await setPublicPlay({ organizationId: "org-a", actorUserId: "operator", granted: true });
    await expect(setPublicPlay({ organizationId: "org-a", actorUserId: "owner", granted: false }))
      .rejects.toMatchObject({ status: 403, code: "admin_required" });
    expect((await grantedAt())?.at).toEqual(expect.any(Number));
    await expect(setPublicPlay({ organizationId: "missing", actorUserId: "operator", granted: true }))
      .rejects.toMatchObject({ status: 404, code: "organization_not_found" });
  });
});
