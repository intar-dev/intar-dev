import { env } from "cloudflare:workers";
import { and, count, desc, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  imageBuildBundles,
  imageBuilds,
  member,
  organization,
  scenarioRuns,
  scenarioSources,
  ssoProvider,
  user,
  vmScenarios,
} from "@/db/schema";
import { appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  canCreateOrganization,
  hasReachedOwnedOrganizationLimit,
} from "@/lib/organization-access";
import type { FeatureToggleService } from "@/lib/feature-toggles";

export type OrganizationRole = "owner" | "admin" | "member";

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  memberCount: number;
  createdAt: number;
}

export interface OrganizationMemberRecord {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  githubUsername: string | null;
  role: OrganizationRole;
  joinedAt: number;
}

const ORGANIZATION_NAME_MAX = 60;

export function isOrganizationAdminRole(role: OrganizationRole): boolean {
  return role === "owner" || role === "admin";
}

export async function requireOrganizationRole(params: {
  organizationId: string;
  userId: string;
  admin?: boolean;
}): Promise<OrganizationRole> {
  const rows = await drizzle(env.DB)
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, params.organizationId),
        eq(member.userId, params.userId),
      ),
    )
    .limit(1);
  const role = rows[0]?.role as OrganizationRole | undefined;
  if (!role) {
    throw appError(404, "organization_not_found", "organization not found");
  }
  if (params.admin && !isOrganizationAdminRole(role)) {
    throw appError(
      403,
      "organization_admin_required",
      "organization admin role required",
    );
  }
  return role;
}

export async function resolveOrganizationId(
  organizationKey: string,
): Promise<string | null> {
  const key = organizationKey.trim();
  if (!key) return null;
  const rows = await drizzle(env.DB)
    .select({ id: organization.id })
    .from(organization)
    .where(or(eq(organization.id, key), eq(organization.slug, key)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function createOrganization(params: {
  name: string;
  ownerUserId: string;
  featureToggleService?: FeatureToggleService;
}): Promise<OrganizationSummary> {
  if (
    !(await canCreateOrganization(
      params.ownerUserId,
      params.featureToggleService,
    ))
  ) {
    throw appError(
      403,
      "organization_creation_disabled",
      "organization creation is not enabled for this account",
    );
  }
  if (await hasReachedOwnedOrganizationLimit(params.ownerUserId)) {
    throw appError(
      409,
      "organization_limit_reached",
      "this account already owns an organization",
    );
  }

  const name = validateOrganizationName(params.name);
  const id = createAppId();
  const baseSlug = slugifyOrganizationName(name) || "organization";
  const slug = `${baseSlug}-${id.slice(0, 6)}`;
  const now = Date.now();
  const db = drizzle(env.DB);

  try {
    await db.batch([
      db.insert(organization).values({
        id,
        name,
        slug,
        createdAt: new Date(now),
      }),
      db.insert(member).values({
        id: createAppId(),
        organizationId: id,
        userId: params.ownerUserId,
        role: "owner",
        createdAt: new Date(now),
      }),
    ]);
  } catch (error) {
    if (errorChainMatches(error, /member owner limit reached/)) {
      throw appError(
        409,
        "organization_limit_reached",
        "this account already owns an organization",
      );
    }
    throw error;
  }

  return {
    id,
    name,
    slug,
    role: "owner",
    memberCount: 1,
    createdAt: now,
  };
}

export async function listOrganizationsForUser(params: {
  userId: string;
}): Promise<OrganizationSummary[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
      createdAt: organization.createdAt,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, params.userId))
    .orderBy(desc(organization.createdAt));

  if (!rows.length) return [];
  const counts = await db
    .select({ organizationId: member.organizationId, memberCount: count() })
    .from(member)
    .where(
      inArray(
        member.organizationId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(member.organizationId);
  const countByOrganization = new Map(
    counts.map((row) => [row.organizationId, row.memberCount]),
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role as OrganizationRole,
    memberCount: countByOrganization.get(row.id) ?? 1,
    createdAt: row.createdAt.getTime(),
  }));
}

export async function getOrganizationDetail(params: {
  organizationKey: string;
  userId: string;
}): Promise<{
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  role: OrganizationRole;
  members: OrganizationMemberRecord[];
}> {
  const organizationId = await resolveOrganizationId(params.organizationKey);
  if (!organizationId) {
    throw appError(404, "organization_not_found", "organization not found");
  }
  const role = await requireOrganizationRole({
    organizationId,
    userId: params.userId,
  });
  const db = drizzle(env.DB);
  const [organizations, members] = await Promise.all([
    db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1),
    db
      .select({
        memberId: member.id,
        userId: member.userId,
        name: user.name,
        email: user.email,
        githubUsername: user.username,
        role: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, organizationId))
      .orderBy(member.createdAt),
  ]);
  const record = organizations[0];
  if (!record) {
    throw appError(404, "organization_not_found", "organization not found");
  }

  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    createdAt: record.createdAt.getTime(),
    role,
    members: members.map((entry) => ({
      ...entry,
      role: entry.role as OrganizationRole,
      joinedAt: entry.joinedAt.getTime(),
    })),
  };
}

export async function updateOrganizationName(params: {
  organizationId: string;
  actorUserId: string;
  name: string;
}): Promise<{ id: string; name: string }> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const name = validateOrganizationName(params.name);
  await drizzle(env.DB)
    .update(organization)
    .set({ name })
    .where(eq(organization.id, params.organizationId));
  return { id: params.organizationId, name };
}

export async function deleteOrganization(params: {
  organizationId: string;
  actorUserId: string;
}): Promise<void> {
  const role = await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
  });
  if (role !== "owner") {
    throw appError(
      403,
      "owner_required",
      "only the organization owner can delete the organization",
    );
  }
  if (await organizationHasOwnedResources(params.organizationId)) {
    throw appError(
      409,
      "organization_not_empty",
      "remove the organization provider, scenarios, runners, builds, and runs before deleting it",
    );
  }
  await drizzle(env.DB)
    .delete(organization)
    .where(eq(organization.id, params.organizationId));
}

export async function leaveOrganization(params: {
  organizationId: string;
  userId: string;
}): Promise<void> {
  const role = await requireOrganizationRole(params);
  if (role === "owner") {
    throw appError(
      400,
      "owner_cannot_leave",
      "transfer ownership or delete the organization first",
    );
  }
  await drizzle(env.DB)
    .delete(member)
    .where(
      and(
        eq(member.organizationId, params.organizationId),
        eq(member.userId, params.userId),
      ),
    );
}

export async function transferOrganizationOwnership(params: {
  organizationId: string;
  actorUserId: string;
  targetMemberId: string;
}): Promise<void> {
  const role = await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
  });
  if (role !== "owner") {
    throw appError(
      403,
      "owner_required",
      "only the organization owner can transfer ownership",
    );
  }
  const db = drizzle(env.DB);
  const targets = await db
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.id, params.targetMemberId),
        eq(member.organizationId, params.organizationId),
      ),
    )
    .limit(1);
  const target = targets[0];
  if (!target) throw appError(404, "member_not_found", "member not found");
  if (target.userId === params.actorUserId) {
    throw appError(
      400,
      "cannot_transfer_to_self",
      "you already own this organization",
    );
  }
  if (await hasReachedOwnedOrganizationLimit(target.userId)) {
    throw appError(
      409,
      "target_organization_limit_reached",
      "the selected member already owns an organization",
    );
  }

  await db.batch([
    db
      .update(member)
      .set({ role: "admin" })
      .where(
        and(
          eq(member.organizationId, params.organizationId),
          eq(member.userId, params.actorUserId),
        ),
      ),
    db
      .update(member)
      .set({ role: "owner" })
      .where(eq(member.id, params.targetMemberId)),
  ]);
}

export async function updateOrganizationMemberRole(params: {
  organizationId: string;
  actorUserId: string;
  memberId: string;
  role: "admin" | "member";
}): Promise<void> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const db = drizzle(env.DB);
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.id, params.memberId),
        eq(member.organizationId, params.organizationId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw appError(404, "member_not_found", "member not found");
  if (rows[0].role === "owner") {
    throw appError(
      400,
      "cannot_change_owner_role",
      "transfer ownership to change the owner role",
    );
  }
  await db
    .update(member)
    .set({ role: params.role })
    .where(eq(member.id, params.memberId));
}

export async function removeOrganizationMember(params: {
  organizationId: string;
  memberId: string;
  actorUserId: string;
}): Promise<void> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const db = drizzle(env.DB);
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.id, params.memberId),
        eq(member.organizationId, params.organizationId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw appError(404, "member_not_found", "member not found");
  if (rows[0].role === "owner") {
    throw appError(
      400,
      "cannot_remove_owner",
      "the organization owner cannot be removed",
    );
  }
  await db
    .delete(member)
    .where(
      and(
        eq(member.id, params.memberId),
        eq(member.organizationId, params.organizationId),
      ),
    );
}

async function organizationHasOwnedResources(
  organizationId: string,
): Promise<boolean> {
  const db = drizzle(env.DB);
  const results = await db.batch([
    db
      .select({ id: ssoProvider.id })
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: vmScenarios.scenarioId })
      .from(vmScenarios)
      .where(eq(vmScenarios.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: scenarioSources.id })
      .from(scenarioSources)
      .where(eq(scenarioSources.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: agentHosts.id })
      .from(agentHosts)
      .where(eq(agentHosts.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: imageBuildBundles.rev })
      .from(imageBuildBundles)
      .where(eq(imageBuildBundles.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: imageBuilds.id })
      .from(imageBuilds)
      .where(eq(imageBuilds.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: scenarioRuns.runId })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.organizationId, organizationId))
      .limit(1),
  ]);
  return results.some((rows) => rows.length > 0);
}

function validateOrganizationName(raw: string): string {
  const name = raw.trim().slice(0, ORGANIZATION_NAME_MAX);
  if (name.length < 2) {
    throw appError(
      400,
      "invalid_organization_name",
      "organization name must be at least 2 characters",
    );
  }
  return name;
}

function slugifyOrganizationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
