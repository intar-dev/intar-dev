/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentHosts,
  scenarioRunArtifacts,
  scenarioRuns,
  user,
} from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";

const auth = vi.hoisted(() => ({
  user: vi.fn(),
  admin: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: auth.user,
  requireAdminUserContext: auth.admin,
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
}));

import { GET } from "./[runId]/artifacts/[artifactId]/content";
import { GET as adminGet } from "@/pages/api/admin/runs/[runId]/artifacts/[artifactId]/content";

const ARTIFACT_BODY = "cast-data\n";
const ARTIFACT_R2_KEY = "runs/run-1/vm-1-0.cast";

describe("scenario run artifact content route", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetD1Database();
    auth.user.mockResolvedValue({
      ok: true as const,
      context: { userId: "user-1" },
    });
    auth.admin.mockResolvedValue({
      ok: true as const,
      context: { userId: "admin-user", isAdmin: true },
    });

    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "user-1",
      name: "Artifact Owner",
      email: "artifact-owner@example.test",
    });
    await db.insert(agentHosts).values({
      id: "host-1",
      userId: "user-1",
      name: "Artifact Host",
    });
    await db.insert(scenarioRuns).values({
      runId: "run-1",
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
      vmCount: 1,
      state: "completed",
      stateRank: 100,
      activeKey: null,
      stateJson: "{}",
    });
    await db.insert(scenarioRunArtifacts).values({
      id: "vm-1:0",
      runId: "run-1",
      vmId: "vm-1",
      ordinal: 0,
      kind: "ssh_recording_segment",
      filename: "session.cast",
      contentType: "application/x-asciicast",
      sizeBytes: new TextEncoder().encode(ARTIFACT_BODY).byteLength,
      sha256: "a".repeat(64),
      r2Key: ARTIFACT_R2_KEY,
      uploadStatus: "uploaded",
      uploadedAt: Date.now(),
    });
    await env.VM_RUN_ARTIFACTS_BUCKET.put(ARTIFACT_R2_KEY, ARTIFACT_BODY, {
      httpMetadata: { contentType: "application/x-asciicast" },
    });
  });

  it("serves an owned artifact whose canonical ID contains a literal colon", async () => {
    const response = await GET({
      request: new Request(
        "https://intar.dev/api/runs/run-1/artifacts/vm-1:0/content",
      ),
      params: { runId: "run-1", artifactId: "vm-1:0" },
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-asciicast; charset=utf-8",
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      ARTIFACT_BODY,
    );
  });

  it("keeps byte-range replay requests partial", async () => {
    const response = await GET({
      request: new Request(
        "https://intar.dev/api/runs/run-1/artifacts/vm-1:0/content",
        { headers: { range: "bytes=0-0" } },
      ),
      params: { runId: "run-1", artifactId: "vm-1:0" },
    } as never);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 0-0/${new TextEncoder().encode(ARTIFACT_BODY).byteLength}`,
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("c");
  });

  it("lets an admin read another user's archived artifact", async () => {
    const response = await adminGet({
      request: new Request(
        "https://intar.dev/api/admin/runs/run-1/artifacts/vm-1:0/content",
      ),
      params: { runId: "run-1", artifactId: "vm-1:0" },
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      ARTIFACT_BODY,
    );
  });

  it("denies the admin artifact proxy before storage lookup", async () => {
    auth.admin.mockResolvedValueOnce({
      ok: false as const,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });

    const response = await adminGet({
      request: new Request(
        "https://intar.dev/api/admin/runs/run-1/artifacts/vm-1:0/content",
      ),
      params: { runId: "run-1", artifactId: "vm-1:0" },
    } as never);

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps forged run and artifact pairs hidden from admins", async () => {
    const response = await adminGet({
      request: new Request(
        "https://intar.dev/api/admin/runs/another-run/artifacts/vm-1:0/content",
      ),
      params: { runId: "another-run", artifactId: "vm-1:0" },
    } as never);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not expose hidden or non-archive artifacts through the admin proxy", async () => {
    const db = drizzle(env.DB);
    await db
      .update(scenarioRuns)
      .set({ hiddenAt: Date.now() })
      .where(eq(scenarioRuns.runId, "run-1"));

    let response = await adminGet({
      request: new Request(
        "https://intar.dev/api/admin/runs/run-1/artifacts/vm-1:0/content",
      ),
      params: { runId: "run-1", artifactId: "vm-1:0" },
    } as never);
    expect(response.status).toBe(404);

    await db
      .update(scenarioRuns)
      .set({ hiddenAt: null, state: "queued" })
      .where(eq(scenarioRuns.runId, "run-1"));
    response = await adminGet({
      request: new Request(
        "https://intar.dev/api/admin/runs/run-1/artifacts/vm-1:0/content",
      ),
      params: { runId: "run-1", artifactId: "vm-1:0" },
    } as never);
    expect(response.status).toBe(404);
  });
});
