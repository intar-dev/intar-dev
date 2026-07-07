import { env } from "cloudflare:workers";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { member, organization, teamInvites, user } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { isValidGithubUsername, toAllowlistKey } from "@/lib/github-username";
import { createAppId } from "@/lib/id";

// Teams are better-auth organizations: instructors are owner/admin members,
// learners are plain members. We write the org tables directly (they're
// ordinary D1 tables better-auth reads) and keep the product's
// GitHub-username-keyed invites in the app-owned team_invites table.

export type TeamRole = "owner" | "admin" | "member";

export interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  role: TeamRole;
  memberCount: number;
  createdAt: number;
}

export interface TeamMemberRecord {
  memberId: string;
  userId: string;
  name: string;
  githubUsername: string | null;
  role: TeamRole;
  joinedAt: number;
}

export interface TeamInviteRecord {
  id: string;
  githubUsername: string;
  status: "pending" | "accepted" | "revoked";
  createdAt: number;
}

export interface PendingInviteForUser {
  id: string;
  organizationId: string;
  teamName: string;
  createdAt: number;
}

const TEAM_NAME_MAX = 60;

export function isInstructorRole(role: TeamRole): boolean {
  return role === "owner" || role === "admin";
}

export async function getUserGithubUsername(
  userId: string,
): Promise<string | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({ username: user.username })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.username ?? null;
}

function slugifyTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function requireTeamRole(params: {
  organizationId: string;
  userId: string;
  instructor?: boolean;
}): Promise<TeamRole> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, params.organizationId),
        eq(member.userId, params.userId),
      ),
    )
    .limit(1);
  const role = rows[0]?.role as TeamRole | undefined;
  if (!role) {
    throw appError(404, "team_not_found", "team not found");
  }
  if (params.instructor && !isInstructorRole(role)) {
    throw appError(403, "instructor_required", "instructor role required");
  }
  return role;
}

export async function createTeam(params: {
  name: string;
  ownerUserId: string;
}): Promise<TeamSummary> {
  const name = params.name.trim().slice(0, TEAM_NAME_MAX);
  if (name.length < 2) {
    throw appError(400, "invalid_team_name", "team name must be at least 2 characters");
  }

  const db = drizzle(env.DB);
  const id = createAppId();
  const baseSlug = slugifyTeamName(name) || "team";
  const slug = `${baseSlug}-${id.slice(0, 6)}`;
  const now = Date.now();

  await db.insert(organization).values({
    id,
    name,
    slug,
    createdAt: new Date(now),
  });
  await db.insert(member).values({
    id: createAppId(),
    organizationId: id,
    userId: params.ownerUserId,
    role: "owner",
    createdAt: new Date(now),
  });

  return {
    id,
    name,
    slug,
    role: "owner",
    memberCount: 1,
    createdAt: now,
  };
}

export async function listTeamsForUser(params: {
  userId: string;
}): Promise<TeamSummary[]> {
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
    .select({
      organizationId: member.organizationId,
      memberCount: count(),
    })
    .from(member)
    .where(
      inArray(
        member.organizationId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(member.organizationId);
  const countByOrg = new Map(
    counts.map((row) => [row.organizationId, row.memberCount]),
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role as TeamRole,
    memberCount: countByOrg.get(row.id) ?? 1,
    createdAt: row.createdAt.getTime(),
  }));
}

export async function getTeamDetail(params: {
  organizationId: string;
  userId: string;
}): Promise<{
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  role: TeamRole;
  members: TeamMemberRecord[];
  invites: TeamInviteRecord[];
}> {
  const role = await requireTeamRole(params);
  const db = drizzle(env.DB);

  const orgRows = await db
    .select()
    .from(organization)
    .where(eq(organization.id, params.organizationId))
    .limit(1);
  const org = orgRows[0];
  if (!org) {
    throw appError(404, "team_not_found", "team not found");
  }

  const members = await db
    .select({
      memberId: member.id,
      userId: member.userId,
      name: user.name,
      githubUsername: user.username,
      role: member.role,
      joinedAt: member.createdAt,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, params.organizationId))
    .orderBy(member.createdAt);

  const invites = isInstructorRole(role)
    ? await db
        .select({
          id: teamInvites.id,
          githubUsername: teamInvites.githubUsername,
          status: teamInvites.status,
          createdAt: teamInvites.createdAt,
        })
        .from(teamInvites)
        .where(
          and(
            eq(teamInvites.organizationId, params.organizationId),
            eq(teamInvites.status, "pending"),
          ),
        )
        .orderBy(desc(teamInvites.createdAt))
    : [];

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt.getTime(),
    role,
    members: members.map((row) => ({
      memberId: row.memberId,
      userId: row.userId,
      name: row.name,
      githubUsername: row.githubUsername,
      role: row.role as TeamRole,
      joinedAt: row.joinedAt.getTime(),
    })),
    invites,
  };
}

export async function inviteToTeam(params: {
  organizationId: string;
  inviterUserId: string;
  githubUsername: string;
}): Promise<TeamInviteRecord> {
  await requireTeamRole({
    organizationId: params.organizationId,
    userId: params.inviterUserId,
    instructor: true,
  });

  const username = toAllowlistKey(params.githubUsername);
  if (!username || !isValidGithubUsername(username)) {
    throw appError(400, "invalid_username", "a valid GitHub username is required");
  }

  const db = drizzle(env.DB);

  // Already a member? (username → user → member)
  const existingMember = await db
    .select({ id: member.id })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(
      and(
        eq(member.organizationId, params.organizationId),
        eq(user.username, username),
      ),
    )
    .limit(1);
  if (existingMember.length) {
    throw appError(409, "already_member", `${username} is already on this team`);
  }

  const invite = {
    id: createAppId(),
    organizationId: params.organizationId,
    githubUsername: username,
    invitedBy: params.inviterUserId,
    status: "pending" as const,
  };

  // Re-inviting after a revoke reactivates the row (unique on org+username).
  await db
    .insert(teamInvites)
    .values(invite)
    .onConflictDoUpdate({
      target: [teamInvites.organizationId, teamInvites.githubUsername],
      set: { status: "pending", invitedBy: params.inviterUserId, acceptedAt: null },
    });

  return {
    id: invite.id,
    githubUsername: username,
    status: "pending",
    createdAt: Date.now(),
  };
}

export async function revokeTeamInvite(params: {
  organizationId: string;
  inviteId: string;
  actorUserId: string;
}): Promise<void> {
  await requireTeamRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    instructor: true,
  });

  const db = drizzle(env.DB);
  await db
    .update(teamInvites)
    .set({ status: "revoked" })
    .where(
      and(
        eq(teamInvites.id, params.inviteId),
        eq(teamInvites.organizationId, params.organizationId),
        eq(teamInvites.status, "pending"),
      ),
    );
}

export async function listPendingInvitesForUser(params: {
  githubUsername: string | null;
}): Promise<PendingInviteForUser[]> {
  const username = toAllowlistKey(params.githubUsername);
  if (!username) return [];

  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: teamInvites.id,
      organizationId: teamInvites.organizationId,
      teamName: organization.name,
      createdAt: teamInvites.createdAt,
    })
    .from(teamInvites)
    .innerJoin(organization, eq(teamInvites.organizationId, organization.id))
    .where(
      and(
        eq(teamInvites.githubUsername, username),
        eq(teamInvites.status, "pending"),
      ),
    )
    .orderBy(desc(teamInvites.createdAt));
  return rows;
}

export async function acceptTeamInvite(params: {
  inviteId: string;
  userId: string;
  githubUsername: string | null;
}): Promise<{ organizationId: string }> {
  const username = toAllowlistKey(params.githubUsername);
  if (!username) {
    throw appError(400, "no_username", "your account has no GitHub username");
  }

  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(teamInvites)
    .where(eq(teamInvites.id, params.inviteId))
    .limit(1);
  const invite = rows[0];
  if (!invite || invite.status !== "pending" || invite.githubUsername !== username) {
    throw appError(404, "invite_not_found", "invite not found");
  }

  const now = Date.now();
  await db.insert(member).values({
    id: createAppId(),
    organizationId: invite.organizationId,
    userId: params.userId,
    role: "member",
    createdAt: new Date(now),
  });
  await db
    .update(teamInvites)
    .set({ status: "accepted", acceptedAt: now })
    .where(eq(teamInvites.id, params.inviteId));

  return { organizationId: invite.organizationId };
}

export async function removeTeamMember(params: {
  organizationId: string;
  memberId: string;
  actorUserId: string;
}): Promise<void> {
  await requireTeamRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    instructor: true,
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
  const target = rows[0];
  if (!target) {
    throw appError(404, "member_not_found", "member not found");
  }
  if (target.role === "owner") {
    throw appError(400, "cannot_remove_owner", "the team owner cannot be removed");
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
