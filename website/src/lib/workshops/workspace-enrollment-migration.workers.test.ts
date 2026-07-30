/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { d1Migrations, resetD1Database } from "@/test/d1-migrations";

const migration0020 = d1Migrations.filter(
  (migration) =>
    migration.name === "0020_workshop_workspace_enrollment.sql",
);
const migrationsBefore0020 = d1Migrations.filter(
  (migration) => migration.name < "0020",
);

describe("workshop workspace enrollment migration", () => {
  it("backfills participants as workspace-enabled without enrolling staff", async () => {
    await reset();
    await applyD1Migrations(env.DB, migrationsBefore0020);
    await seedWorkshopGraph();
    await insertRosterMember("roster-participant", "learner-a", "participant");
    await insertRosterMember("roster-helper", "helper-a", "helper");
    await insertRosterMember("roster-facilitator", "owner-a", "facilitator");

    await applyD1Migrations(env.DB, migration0020);

    const rows = await env.DB.prepare(
      `SELECT user_id, role, workspace_enabled
       FROM workshop_session_members
       ORDER BY user_id`,
    ).all<{
      user_id: string;
      role: string;
      workspace_enabled: number;
    }>();
    expect(rows.results).toEqual([
      { user_id: "helper-a", role: "helper", workspace_enabled: 0 },
      {
        user_id: "learner-a",
        role: "participant",
        workspace_enabled: 1,
      },
      {
        user_id: "owner-a",
        role: "facilitator",
        workspace_enabled: 0,
      },
    ]);
  });

  it("normalizes participant enrollment on insert and update", async () => {
    await resetD1Database();
    await seedWorkshopGraph();

    await insertRosterMember("roster-participant", "learner-a", "participant");
    await insertRosterMember("roster-helper", "helper-a", "helper");

    await expect(
      workspaceEnabledFor("roster-participant"),
    ).resolves.toBe(1);
    await expect(workspaceEnabledFor("roster-helper")).resolves.toBe(0);

    await env.DB.prepare(
      `UPDATE workshop_session_members
       SET role = 'participant', workspace_enabled = 0
       WHERE id = 'roster-helper'`,
    ).run();
    await expect(workspaceEnabledFor("roster-helper")).resolves.toBe(1);

    await env.DB.prepare(
      `UPDATE workshop_session_members
       SET workspace_enabled = 0
       WHERE id = 'roster-participant'`,
    ).run();
    await expect(
      workspaceEnabledFor("roster-participant"),
    ).resolves.toBe(1);
  });

  it("prevents workspace enrollment changes after provisioning starts", async () => {
    await resetD1Database();
    await seedWorkshopGraph();
    await insertRosterMember("roster-participant", "learner-a", "participant");
    await insertRosterMember("roster-helper", "helper-a", "helper");
    await insertWorkspace("workspace-a", "session-a", "learner-a");

    await expect(
      env.DB.prepare(
        `UPDATE workshop_session_members
         SET workspace_enabled = 0
         WHERE id = 'roster-participant'`,
      ).run(),
    ).rejects.toThrow(
      /workshop roster is immutable after workspace provisioning starts/,
    );
    await expect(
      env.DB.prepare(
        `UPDATE workshop_session_members
         SET workspace_enabled = 1
         WHERE id = 'roster-helper'`,
      ).run(),
    ).rejects.toThrow(
      /workshop roster is immutable after workspace provisioning starts/,
    );
  });

  it("rejects stale-member workspace reassignment across users and organizations", async () => {
    await resetD1Database();
    await seedWorkshopGraph({ includeSecondOrganization: true });
    await insertRosterMember("roster-participant", "learner-a", "participant");
    await insertRosterMember(
      "roster-stale-a",
      "stale-a",
      "participant",
      "session-a",
    );
    await insertRosterMember(
      "roster-stale-b",
      "stale-b",
      "participant",
      "session-b",
    );
    await insertWorkspace("workspace-a", "session-a", "learner-a");
    await env.DB.batch([
      env.DB
        .prepare("DELETE FROM member WHERE id = ?")
        .bind("membership-stale-a"),
      env.DB
        .prepare("DELETE FROM member WHERE id = ?")
        .bind("membership-stale-b"),
    ]);

    await expect(
      env.DB.prepare(
        `UPDATE workshop_workspaces
         SET user_id = 'stale-a'
         WHERE id = 'workspace-a'`,
      ).run(),
    ).rejects.toThrow(
      /workshop workspace owner is not an active workspace-enabled member/,
    );
    await expect(
      env.DB.prepare(
        `UPDATE workshop_workspaces
         SET session_id = 'session-b', user_id = 'stale-b'
         WHERE id = 'workspace-a'`,
      ).run(),
    ).rejects.toThrow(
      /workshop workspace owner is not an active workspace-enabled member/,
    );

    await expect(
      env.DB.prepare(
        `SELECT session_id, user_id
         FROM workshop_workspaces
         WHERE id = 'workspace-a'`,
      ).first(),
    ).resolves.toEqual({
      session_id: "session-a",
      user_id: "learner-a",
    });
  });
});

async function seedWorkshopGraph(
  options: { includeSecondOrganization?: boolean } = {},
): Promise<void> {
  const users = [
    "owner-a",
    "learner-a",
    "helper-a",
    "stale-a",
    ...(options.includeSecondOrganization ? ["owner-b", "stale-b"] : []),
  ];
  await env.DB.batch(
    users.map((userId) =>
      env.DB
        .prepare(
          `INSERT INTO user (
             id, name, email, email_verified, created_at, updated_at
           ) VALUES (?, ?, ?, 1, 1000, 1000)`,
        )
        .bind(userId, userId, `${userId}@example.test`),
    ),
  );
  await env.DB.prepare(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-a', 'Organization A', 'org-a', 1000)`,
  ).run();
  await env.DB.batch([
    membershipStatement("membership-owner-a", "org-a", "owner-a", "owner"),
    membershipStatement(
      "membership-learner-a",
      "org-a",
      "learner-a",
      "member",
    ),
    membershipStatement(
      "membership-helper-a",
      "org-a",
      "helper-a",
      "member",
    ),
    membershipStatement(
      "membership-stale-a",
      "org-a",
      "stale-a",
      "member",
    ),
  ]);
  await insertWorkshopDefinition("a", "org-a", "owner-a");

  if (!options.includeSecondOrganization) return;

  await env.DB.prepare(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-b', 'Organization B', 'org-b', 1000)`,
  ).run();
  await env.DB.batch([
    membershipStatement("membership-owner-b", "org-b", "owner-b", "owner"),
    membershipStatement(
      "membership-stale-b",
      "org-b",
      "stale-b",
      "member",
    ),
  ]);
  await insertWorkshopDefinition("b", "org-b", "owner-b");
}

async function insertWorkshopDefinition(
  suffix: string,
  organizationId: string,
  ownerId: string,
): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO workshop_templates (
           id, organization_id, slug, title, summary, created_by,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'Test workshop', ?, 1000, 1000)`,
      )
      .bind(
        `template-${suffix}`,
        organizationId,
        `workshop-${suffix}`,
        `Workshop ${suffix.toUpperCase()}`,
        ownerId,
      ),
    env.DB
      .prepare(
        `INSERT INTO workshop_template_revisions (
           id, template_id, revision, source_revision, content_hash,
           manifest_json, published_by, published_at
         ) VALUES (?, ?, 1, 'test', ?, '{}', ?, 1000)`,
      )
      .bind(
        `revision-${suffix}`,
        `template-${suffix}`,
        suffix.repeat(64),
        ownerId,
      ),
  ]);
  await env.DB.prepare(
    `INSERT INTO workshop_sessions (
       id, organization_id, template_revision_id, title, state, version,
       scheduled_start_at, lobby_opens_at, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'draft', 1, 2000, 1000, ?, 1000, 1000)`,
  )
    .bind(
      `session-${suffix}`,
      organizationId,
      `revision-${suffix}`,
      `Session ${suffix.toUpperCase()}`,
      ownerId,
    )
    .run();
}

function membershipStatement(
  id: string,
  organizationId: string,
  userId: string,
  role: "owner" | "member",
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO member (
       id, organization_id, user_id, role, created_at
     ) VALUES (?, ?, ?, ?, 1000)`,
  ).bind(id, organizationId, userId, role);
}

async function insertRosterMember(
  id: string,
  userId: string,
  role: "participant" | "helper" | "facilitator",
  sessionId = "session-a",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workshop_session_members (
       id, session_id, user_id, role, assigned_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1000, 1000)`,
  )
    .bind(
      id,
      sessionId,
      userId,
      role,
      sessionId === "session-a" ? "owner-a" : "owner-b",
    )
    .run();
}

async function insertWorkspace(
  id: string,
  sessionId: string,
  userId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workshop_workspaces (
       id, session_id, user_id, state, created_at, updated_at
     ) VALUES (?, ?, ?, 'queued', 1000, 1000)`,
  )
    .bind(id, sessionId, userId)
    .run();
}

async function workspaceEnabledFor(rosterId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT workspace_enabled
     FROM workshop_session_members
     WHERE id = ?`,
  )
    .bind(rosterId)
    .first<{ workspace_enabled: number }>();
  return row?.workspace_enabled ?? null;
}
