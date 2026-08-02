/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { agentHosts, scenarioRuns, user } from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";

describe("host history database invariant", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("rejects direct host deletion when scenario history exists", async () => {
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
      db.delete(agentHosts).where(eq(agentHosts.id, "host-history")),
    ).rejects.toThrow();

    await expect(
      db
        .select({ id: agentHosts.id })
        .from(agentHosts)
        .where(eq(agentHosts.id, "host-history")),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ id: scenarioRuns.runId })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, "run-history")),
    ).resolves.toHaveLength(1);
  });
});
