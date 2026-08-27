/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentHosts, scenarioRuns, user } from "@/db/schema";
import { buildInitialRunState } from "@/lib/run-state";
import { resetD1Database } from "@/test/d1-migrations";

const auth = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: auth,
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...Object.fromEntries(new Headers(init?.headers)),
      },
    }),
}));

import { GET as getRunStatus } from "./[runId]/status";
import { GET as getRunsSummary } from "./summary";

describe("scenario run status routes", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    auth.mockResolvedValue({
      ok: true as const,
      context: { userId: "user-1" },
    });
    await resetD1Database();

    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "user-1",
      name: "Run Owner",
      email: "run-owner@example.test",
    });
    await db.insert(agentHosts).values({
      id: "host-1",
      userId: "user-1",
      name: "Run Host",
    });
    await insertRun({
      runId: "run-live",
      state: "queued",
      stateRank: 0,
      activeKey: "user-1",
      updatedAt: 100,
    });
    await insertRun({
      runId: "run-finished",
      state: "completed",
      stateRank: 8,
      activeKey: null,
      updatedAt: 90,
    });
    await insertRun({
      runId: "run-saving",
      state: "archiving",
      stateRank: 7,
      activeKey: null,
      updatedAt: 95,
    });
    await insertRun({
      runId: "run-hidden",
      state: "archiving",
      stateRank: 7,
      activeKey: null,
      hiddenAt: 1,
      updatedAt: 94,
    });
  });

  it("returns only mutable status fields and 204s for the supplied version", async () => {
    const first = await getRunStatus({
      request: new Request("https://intar.dev/api/scenarios/runs/run-live/status"),
      params: { runId: "run-live" },
    } as never);

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const firstBody = (await first.json()) as {
      status: { version: string; updatedAt: number; briefingMarkdown?: string };
    };
    expect(firstBody.status).toMatchObject({ version: "100", updatedAt: 100 });
    expect(firstBody.status.briefingMarkdown).toBeUndefined();

    const current = await getRunStatus({
      request: new Request(
        `https://intar.dev/api/scenarios/runs/run-live/status?version=${encodeURIComponent(firstBody.status.version)}`,
      ),
      params: { runId: "run-live" },
    } as never);
    expect(current.status).toBe(204);
    expect(current.headers.get("cache-control")).toBe("private, no-store");

    const stale = await getRunStatus({
      request: new Request(
        "https://intar.dev/api/scenarios/runs/run-live/status?version=not-current",
      ),
      params: { runId: "run-live" },
    } as never);
    expect(stale.status).toBe(200);
  });

  it("keeps denied status responses private and non-cacheable", async () => {
    auth.mockResolvedValueOnce({
      ok: false as const,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      }),
    });
    const runResponse = await getRunStatus({
      request: new Request("https://intar.dev/api/scenarios/runs/run-live/status"),
      params: { runId: "run-live" },
    } as never);
    expect(runResponse.status).toBe(401);
    expect(runResponse.headers.get("cache-control")).toBe("private, no-store");

    auth.mockResolvedValueOnce({
      ok: false as const,
      response: new Response(JSON.stringify({ error: "access revoked" }), {
        status: 403,
      }),
    });
    const summaryResponse = await getRunsSummary({
      request: new Request("https://intar.dev/api/scenarios/runs/summary"),
      params: {},
    } as never);
    expect(summaryResponse.status).toBe(403);
    expect(summaryResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("uses a bounded summary for the sidebar badge", async () => {
    const response = await getRunsSummary({
      request: new Request("https://intar.dev/api/scenarios/runs/summary"),
      params: {},
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      activeCount: 2,
      activeRunId: "run-live",
    });
  });

  it("keeps the foreground run and exact count beyond a cleanup backlog", async () => {
    for (let index = 0; index < 25; index += 1) {
      await insertRun({
        runId: `run-backlog-${index}`,
        state: "archiving",
        stateRank: 7,
        activeKey: null,
        updatedAt: 200 + index,
      });
    }

    const response = await getRunsSummary({
      request: new Request("https://intar.dev/api/scenarios/runs/summary"),
      params: {},
    } as never);

    await expect(response.json()).resolves.toEqual({
      // run-live, run-saving, and 25 queued archive cleanups. Completed and
      // hidden rows remain outside the badge count.
      activeCount: 27,
      activeRunId: "run-live",
    });
  });
});

async function insertRun(input: {
  runId: string;
  state: string;
  stateRank: number;
  activeKey: string | null;
  hiddenAt?: number | null;
  updatedAt: number;
}) {
  const db = drizzle(env.DB);
  await db.insert(scenarioRuns).values({
    runId: input.runId,
    userId: "user-1",
    hostId: "host-1",
    scenarioId: "scenario-1",
    scenarioName: "scenario-1",
    title: "Scenario",
    tagline: "Test",
    briefingMarkdown: "Briefing",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "Solution",
    vmCount: 0,
    state: input.state,
    stateRank: input.stateRank,
    activeKey: input.activeKey,
    ...(input.hiddenAt === undefined ? {} : { hiddenAt: input.hiddenAt }),
    stateJson: JSON.stringify(buildInitialRunState({ vms: [] })),
    createdAt: 1,
    updatedAt: input.updatedAt,
  });
}
