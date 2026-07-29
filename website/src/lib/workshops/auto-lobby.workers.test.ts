/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  member,
  organization,
  user,
  workshopEvents,
  workshopSessions,
  type WorkshopManifestV1,
} from "@/db/schema";
import { StaticFeatureToggleService } from "@/lib/feature-toggles";
import { resetD1Database } from "@/test/d1-migrations";
import { openDueWorkshopLobbies } from "./auto-lobby";
import { WORKSHOPS_FEATURE_FLAG } from "./feature-flag";
import { createWorkshopSession } from "./sessions";
import { createWorkshopTemplate } from "./templates";

describe("workshop automatic lobby", () => {
  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    const createdAt = new Date();
    await db.batch([
      db.insert(user).values({
        id: "owner",
        name: "Workshop owner",
        email: "owner@example.test",
        emailVerified: true,
        createdAt,
        updatedAt: createdAt,
      }),
      db.insert(organization).values({
        id: "org",
        name: "Pilot organization",
        slug: "pilot",
        createdAt,
      }),
      db.insert(member).values({
        id: "owner-membership",
        organizationId: "org",
        userId: "owner",
        role: "owner",
        createdAt,
      }),
    ]);
  });

  it("opens a due lobby once and atomically releases gate modules", async () => {
    const now = Date.now();
    const sessionId = await createSession(now);
    const disabled = await openDueWorkshopLobbies({
      now,
      featureToggles: flags(false),
    });
    expect(disabled).toEqual({
      due: 1,
      opened: 0,
      disabled: 1,
      conflicted: 0,
      providerBlocked: 0,
    });

    const opened = await openDueWorkshopLobbies({
      now,
      featureToggles: flags(true),
    });
    expect(opened).toEqual({
      due: 1,
      opened: 1,
      disabled: 0,
      conflicted: 0,
      providerBlocked: 0,
    });
    const db = drizzle(env.DB);
    const [sessions, events] = await Promise.all([
      db
        .select({
          state: workshopSessions.state,
          version: workshopSessions.version,
          releasedModuleIds: workshopSessions.releasedModuleIdsJson,
        })
        .from(workshopSessions)
        .where(eq(workshopSessions.id, sessionId)),
      db
        .select({
          actorUserId: workshopEvents.actorUserId,
          type: workshopEvents.type,
          payload: workshopEvents.payloadJson,
        })
        .from(workshopEvents)
        .where(eq(workshopEvents.type, "session.lobby")),
    ]);
    expect(sessions).toEqual([
      { state: "lobby", version: 2, releasedModuleIds: ["setup"] },
    ]);
    expect(events).toEqual([
      {
        actorUserId: null,
        type: "session.lobby",
        payload: expect.objectContaining({
          previousState: "draft",
          version: 2,
          automatic: true,
          releasedGateModuleIds: ["setup"],
        }),
      },
    ]);
    await expect(
      openDueWorkshopLobbies({ now, featureToggles: flags(true) }),
    ).resolves.toEqual({
      due: 0,
      opened: 0,
      disabled: 0,
      conflicted: 0,
      providerBlocked: 0,
    });
  });

  it("leaves a draft session closed before its lobby time", async () => {
    const now = Date.now();
    const sessionId = await createSession(now + 1);
    await expect(
      openDueWorkshopLobbies({ now, featureToggles: flags(true) }),
    ).resolves.toEqual({
      due: 0,
      opened: 0,
      disabled: 0,
      conflicted: 0,
      providerBlocked: 0,
    });
    await expect(
      drizzle(env.DB)
        .select({ state: workshopSessions.state })
        .from(workshopSessions)
        .where(eq(workshopSessions.id, sessionId)),
    ).resolves.toEqual([{ state: "draft" }]);
  });
});

async function createSession(lobbyOpensAt: number): Promise<string> {
  const template = await createWorkshopTemplate({
    organizationId: "org",
    actorUserId: "owner",
    sourceRevision: `source-${lobbyOpensAt}`,
    contentHash: lobbyOpensAt.toString(16).padStart(64, "0").slice(-64),
    manifest: manifest(),
  });
  const session = await createWorkshopSession({
    organizationId: "org",
    actorUserId: "owner",
    templateRevisionId: template.revision.id,
    title: "Scheduled workshop",
    lobbyOpensAt,
    scheduledStartAt: lobbyOpensAt + 30 * 60_000,
  });
  return session.id;
}

function flags(enabled: boolean): StaticFeatureToggleService {
  return new StaticFeatureToggleService({
    [WORKSHOPS_FEATURE_FLAG]: enabled,
  });
}

function manifest(): WorkshopManifestV1 {
  return {
    schemaVersion: 1,
    workshop: {
      slug: "scheduled-workshop",
      title: "Scheduled workshop",
      summary: "A workshop with an automatic lobby.",
      prerequisites: [],
      defaultLobbyMinutes: 30,
    },
    workspace: {
      leaseGraceMinutes: 60,
      vms: [
        {
          id: "workspace",
          name: "Workspace",
          cpuMillis: 1_000,
          memoryMib: 1_024,
          diskMib: 10_240,
        },
      ],
      checkpoints: [
        {
          id: "checkpoint-00",
          label: "Initial",
          vmImages: [
            {
              vmId: "workspace",
              imageKey: {
                scenario: "scheduled-workshop-00",
                vm: "workspace",
                arch: "x86_64",
              },
              imageSha256: "a".repeat(64),
            },
          ],
        },
      ],
      initialCheckpointId: "checkpoint-00",
      applications: [],
    },
    modules: [
      {
        id: "setup",
        title: "Setup",
        tier: "gate",
        outcome: "Enter the prepared workspace.",
        dependsOn: [],
        participantMarkdown: "Check the workspace.",
        facilitatorNotesMarkdown: "Watch readiness.",
        hints: [],
        solutionMarkdown: "Run the preflight.",
        probeIds: ["workspace-ready"],
        catchUpCheckpointId: "checkpoint-00",
      },
      {
        id: "core",
        title: "Core lab",
        tier: "core",
        outcome: "Complete the lab.",
        dependsOn: ["setup"],
        participantMarkdown: "Build the service.",
        facilitatorNotesMarkdown: "Observe the service.",
        hints: [],
        solutionMarkdown: "Apply the service.",
        probeIds: ["service-ready"],
        catchUpCheckpointId: "checkpoint-00",
      },
    ],
    agenda: [
      {
        id: "core",
        kind: "lab",
        title: "Core lab",
        durationMinutes: 30,
        scheduled: true,
        moduleId: "core",
        slideIds: ["welcome"],
        release: "facilitator",
      },
    ],
    presentation: {
      slides: [
        {
          id: "welcome",
          layout: "title",
          title: "Welcome",
          bodyMarkdown: "Welcome.",
          moduleId: "core",
        },
      ],
    },
    durationMinutes: 30,
  };
}
