/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { agentHosts, scenarioRuns, user } from "@/db/schema";
import { deleteAgentHostPreservingHistory } from "@/lib/agent-host-deletion";
import { resetD1Database } from "@/test/d1-migrations";

describe("scenario host history", () => {
  beforeEach(resetD1Database);

  it("keeps a host that has scenario history", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    await db.insert(user).values({
      id: "user-history",
      name: "History Owner",
      email: "history@example.com",
    });
    await db.insert(agentHosts).values({
      id: "host-history",
      userId: "user-history",
      name: "History Host",
    });
    await db.insert(scenarioRuns).values({
      runId: "run-history",
      userId: "user-history",
      hostId: "host-history",
      scenarioId: "scenario-history",
      scenarioName: "scenario-history",
      title: "History",
      tagline: "",
      briefingMarkdown: "",
      objectivesJson: "[]",
      difficulty: "easy",
      estimatedMinutes: 1,
      tagsJson: [],
      hintsJson: [],
      solutionMarkdown: "",
      vmCount: 1,
      state: "completed",
      stateRank: 1,
      stateJson: "{}",
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      deleteAgentHostPreservingHistory(db, {
        hostId: "host-history",
        userId: "user-history",
      }),
    ).resolves.toBe(false);
    await expect(
      db.select().from(agentHosts).where(eq(agentHosts.id, "host-history")),
    ).resolves.toHaveLength(1);
  });
});
