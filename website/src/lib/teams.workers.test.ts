/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  member,
  organization,
  scenarioAssignments,
  teamInvites,
  user,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import {
  acceptTeamInvite,
  createTeam,
  declineTeamInvite,
  deleteTeam,
  inviteToTeam,
  leaveTeam,
  transferTeamOwnership,
  updateTeamMemberRole,
  updateTeamName,
} from "@/lib/teams";
import { resetD1Database } from "@/test/d1-migrations";

const OWNER = { id: "user-owner", username: "owner-gh" };
const ADMIN = { id: "user-admin", username: "admin-gh" };
const MEMBER = { id: "user-member", username: "member-gh" };
const OUTSIDER = { id: "user-outsider", username: "outsider-gh" };

async function seedUsers(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(user).values(
    [OWNER, ADMIN, MEMBER, OUTSIDER].map((entry) => ({
      id: entry.id,
      name: entry.id,
      email: `${entry.id}@example.com`,
      username: entry.username,
    })),
  );
}

async function seedTeam(): Promise<{
  orgId: string;
  memberIds: Record<string, string>;
}> {
  const db = drizzle(env.DB);
  const team = await createTeam({ name: "Test Team", ownerUserId: OWNER.id });
  await db.insert(member).values([
    {
      id: "member-admin",
      organizationId: team.id,
      userId: ADMIN.id,
      role: "admin",
      createdAt: new Date(),
    },
    {
      id: "member-member",
      organizationId: team.id,
      userId: MEMBER.id,
      role: "member",
      createdAt: new Date(),
    },
  ]);
  const rows = await db
    .select({ id: member.id, userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, team.id));
  const memberIds = Object.fromEntries(rows.map((row) => [row.userId, row.id]));
  return { orgId: team.id, memberIds };
}

async function memberRow(orgId: string, userId: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));
  return rows;
}

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.status).toBe(status);
  expect(appError.code).toBe(code);
}

describe("team management lib", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedUsers();
  });

  describe("updateTeamName", () => {
    it("lets instructors rename the team", async () => {
      const { orgId } = await seedTeam();
      await updateTeamName({
        organizationId: orgId,
        actorUserId: ADMIN.id,
        name: "Renamed Team",
      });
      const db = drizzle(env.DB);
      const rows = await db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, orgId));
      expect(rows[0]?.name).toBe("Renamed Team");
    });

    it("rejects plain members and invalid names", async () => {
      const { orgId } = await seedTeam();
      await expectAppError(
        updateTeamName({
          organizationId: orgId,
          actorUserId: MEMBER.id,
          name: "Renamed",
        }),
        403,
        "instructor_required",
      );
      await expectAppError(
        updateTeamName({
          organizationId: orgId,
          actorUserId: OWNER.id,
          name: " x ",
        }),
        400,
        "invalid_team_name",
      );
    });
  });

  describe("deleteTeam", () => {
    it("lets the owner delete and cascades team-owned rows", async () => {
      const { orgId } = await seedTeam();
      const db = drizzle(env.DB);
      await inviteToTeam({
        organizationId: orgId,
        inviterUserId: OWNER.id,
        githubUsername: OUTSIDER.username,
      });
      await db.insert(scenarioAssignments).values({
        id: "assignment-1",
        organizationId: orgId,
        scenarioId: "scenario-1",
        assignedBy: OWNER.id,
      });

      await deleteTeam({ organizationId: orgId, actorUserId: OWNER.id });

      expect(
        await db.select().from(organization).where(eq(organization.id, orgId)),
      ).toHaveLength(0);
      expect(
        await db.select().from(member).where(eq(member.organizationId, orgId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(teamInvites)
          .where(eq(teamInvites.organizationId, orgId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(scenarioAssignments)
          .where(eq(scenarioAssignments.organizationId, orgId)),
      ).toHaveLength(0);
    });

    it("rejects non-owners", async () => {
      const { orgId } = await seedTeam();
      await expectAppError(
        deleteTeam({ organizationId: orgId, actorUserId: ADMIN.id }),
        403,
        "owner_required",
      );
      await expectAppError(
        deleteTeam({ organizationId: orgId, actorUserId: OUTSIDER.id }),
        404,
        "team_not_found",
      );
    });
  });

  describe("leaveTeam", () => {
    it("removes non-owner members", async () => {
      const { orgId } = await seedTeam();
      await leaveTeam({ organizationId: orgId, userId: MEMBER.id });
      expect(await memberRow(orgId, MEMBER.id)).toHaveLength(0);
      await leaveTeam({ organizationId: orgId, userId: ADMIN.id });
      expect(await memberRow(orgId, ADMIN.id)).toHaveLength(0);
    });

    it("blocks the owner", async () => {
      const { orgId } = await seedTeam();
      await expectAppError(
        leaveTeam({ organizationId: orgId, userId: OWNER.id }),
        400,
        "owner_cannot_leave",
      );
      expect(await memberRow(orgId, OWNER.id)).toHaveLength(1);
    });
  });

  describe("transferTeamOwnership", () => {
    it("swaps owner and target roles atomically", async () => {
      const { orgId, memberIds } = await seedTeam();
      await transferTeamOwnership({
        organizationId: orgId,
        actorUserId: OWNER.id,
        targetMemberId: memberIds[MEMBER.id]!,
      });
      expect((await memberRow(orgId, MEMBER.id))[0]?.role).toBe("owner");
      expect((await memberRow(orgId, OWNER.id))[0]?.role).toBe("admin");
      // Old owner can now leave.
      await leaveTeam({ organizationId: orgId, userId: OWNER.id });
      expect(await memberRow(orgId, OWNER.id)).toHaveLength(0);
    });

    it("rejects non-owner actors, self-transfer and unknown targets", async () => {
      const { orgId, memberIds } = await seedTeam();
      await expectAppError(
        transferTeamOwnership({
          organizationId: orgId,
          actorUserId: ADMIN.id,
          targetMemberId: memberIds[MEMBER.id]!,
        }),
        403,
        "owner_required",
      );
      await expectAppError(
        transferTeamOwnership({
          organizationId: orgId,
          actorUserId: OWNER.id,
          targetMemberId: memberIds[OWNER.id]!,
        }),
        400,
        "cannot_transfer_to_self",
      );
      await expectAppError(
        transferTeamOwnership({
          organizationId: orgId,
          actorUserId: OWNER.id,
          targetMemberId: "missing-member",
        }),
        404,
        "member_not_found",
      );
    });
  });

  describe("updateTeamMemberRole", () => {
    it("promotes and demotes non-owner members", async () => {
      const { orgId, memberIds } = await seedTeam();
      await updateTeamMemberRole({
        organizationId: orgId,
        actorUserId: OWNER.id,
        memberId: memberIds[MEMBER.id]!,
        role: "admin",
      });
      expect((await memberRow(orgId, MEMBER.id))[0]?.role).toBe("admin");

      await updateTeamMemberRole({
        organizationId: orgId,
        actorUserId: ADMIN.id,
        memberId: memberIds[MEMBER.id]!,
        role: "member",
      });
      expect((await memberRow(orgId, MEMBER.id))[0]?.role).toBe("member");
    });

    it("never touches the owner row", async () => {
      const { orgId, memberIds } = await seedTeam();
      await expectAppError(
        updateTeamMemberRole({
          organizationId: orgId,
          actorUserId: ADMIN.id,
          memberId: memberIds[OWNER.id]!,
          role: "member",
        }),
        400,
        "cannot_change_owner_role",
      );
      expect((await memberRow(orgId, OWNER.id))[0]?.role).toBe("owner");
    });
  });

  describe("invites", () => {
    it("accepting twice keeps a single membership row", async () => {
      const { orgId } = await seedTeam();
      const invite = await inviteToTeam({
        organizationId: orgId,
        inviterUserId: OWNER.id,
        githubUsername: OUTSIDER.username,
      });

      await acceptTeamInvite({
        inviteId: invite.id,
        userId: OUTSIDER.id,
        githubUsername: OUTSIDER.username,
      });
      // Simulate a replayed accept: reset the invite to pending and accept again.
      const db = drizzle(env.DB);
      await db
        .update(teamInvites)
        .set({ status: "pending" })
        .where(eq(teamInvites.id, invite.id));
      await acceptTeamInvite({
        inviteId: invite.id,
        userId: OUTSIDER.id,
        githubUsername: OUTSIDER.username,
      });

      expect(await memberRow(orgId, OUTSIDER.id)).toHaveLength(1);
      const invites = await db
        .select({ status: teamInvites.status })
        .from(teamInvites)
        .where(eq(teamInvites.id, invite.id));
      expect(invites[0]?.status).toBe("accepted");
    });

    it("declining marks the invite and re-inviting reactivates it", async () => {
      const { orgId } = await seedTeam();
      const invite = await inviteToTeam({
        organizationId: orgId,
        inviterUserId: OWNER.id,
        githubUsername: OUTSIDER.username,
      });

      await declineTeamInvite({
        inviteId: invite.id,
        userId: OUTSIDER.id,
        githubUsername: OUTSIDER.username,
      });
      const db = drizzle(env.DB);
      const declined = await db
        .select({ status: teamInvites.status })
        .from(teamInvites)
        .where(eq(teamInvites.id, invite.id));
      expect(declined[0]?.status).toBe("declined");
      expect(await memberRow(orgId, OUTSIDER.id)).toHaveLength(0);

      await inviteToTeam({
        organizationId: orgId,
        inviterUserId: OWNER.id,
        githubUsername: OUTSIDER.username,
      });
      const reinvited = await db
        .select({ status: teamInvites.status })
        .from(teamInvites)
        .where(
          and(
            eq(teamInvites.organizationId, orgId),
            eq(teamInvites.githubUsername, OUTSIDER.username),
          ),
        );
      expect(reinvited).toHaveLength(1);
      expect(reinvited[0]?.status).toBe("pending");
    });

    it("rejects declining someone else's invite", async () => {
      const { orgId } = await seedTeam();
      const invite = await inviteToTeam({
        organizationId: orgId,
        inviterUserId: OWNER.id,
        githubUsername: OUTSIDER.username,
      });
      await expectAppError(
        declineTeamInvite({
          inviteId: invite.id,
          userId: MEMBER.id,
          githubUsername: MEMBER.username,
        }),
        404,
        "invite_not_found",
      );
    });
  });

  it("blocks duplicate memberships at the schema level", async () => {
    const { orgId } = await seedTeam();
    const db = drizzle(env.DB);
    await expect(
      db.insert(member).values({
        id: "member-duplicate",
        organizationId: orgId,
        userId: MEMBER.id,
        role: "member",
        createdAt: new Date(),
      }),
    ).rejects.toThrow();
    expect(await memberRow(orgId, MEMBER.id)).toHaveLength(1);
  });
});
