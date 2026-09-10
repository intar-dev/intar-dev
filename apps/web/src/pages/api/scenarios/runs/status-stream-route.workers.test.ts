/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { session } from "@/db/schema";
import {
  betaAdmissionForHostFixture,
  drizzle,
  env,
  resetHostRuntimeTestDatabase,
  seedHost,
  seedRun,
  sleep,
} from "@/control-plane/host-runtime-do/test-fixtures";
import { GET as getRunStatusStream } from "./[runId]/status/stream";

describe("scenario run status stream route", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetHostRuntimeTestDatabase();
  });

  it("requires a same-origin WebSocket upgrade before proxying to the host DO", async () => {
    const nonUpgrade = await getRunStatusStream({
      request: new Request(
        "http://localhost/api/scenarios/runs/run-status-stream/status/stream",
      ),
      params: { runId: "run-status-stream" },
    } as never);
    expect(nonUpgrade.status).toBe(426);
    expect(nonUpgrade.headers.get("cache-control")).toBe("private, no-store");

    const crossOrigin = await getRunStatusStream({
      request: new Request(
        "http://localhost/api/scenarios/runs/run-status-stream/status/stream",
        {
          headers: { upgrade: "websocket", origin: "https://other.example" },
        },
      ),
      params: { runId: "run-status-stream" },
    } as never);
    expect(crossOrigin.status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
  });

  it("opens an owner-scoped stream and emits the subscription acknowledgement", async () => {
    const hostId = "host-status-route";
    const runId = "run-status-route";
    const now = Date.now();
    await seedHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    await db.insert(session).values({
      id: "status-route-session",
      token: "status-route-session-token",
      userId: "user-1",
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const admission = await betaAdmissionForHostFixture("user-1");
    auth.mockResolvedValue({
      ok: true as const,
      context: {
        userId: "user-1",
        sessionId: "status-route-session",
        betaAdmission: admission,
      },
    });

    const response = await getRunStatusStream({
      request: new Request(
        `http://localhost/api/scenarios/runs/${runId}/status/stream`,
        {
          headers: {
            upgrade: "websocket",
            origin: "http://localhost",
            "sec-fetch-site": "same-origin",
          },
        },
      ),
      params: { runId },
    } as never);

    expect(response.status).toBe(101);
    const ws = response.webSocket;
    expect(ws).not.toBeNull();
    if (!ws) throw new Error("missing run status websocket");
    const messages: unknown[] = [];
    ws.accept();
    ws.addEventListener("message", (event) => {
      messages.push(event.data);
    });
    await waitForMessage(messages);
    expect(messages).toEqual([
      JSON.stringify({ type: "subscribed", runId }),
    ]);
    ws.close();
  });

  it("does not proxy a stream for another user's run", async () => {
    const hostId = "host-status-route-owner";
    const runId = "run-status-route-owner";
    const now = Date.now();
    await seedHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const admission = await betaAdmissionForHostFixture("user-1");
    auth.mockResolvedValue({
      ok: true as const,
      context: {
        userId: "user-2",
        sessionId: "other-session",
        betaAdmission: admission,
      },
    });

    const response = await getRunStatusStream({
      request: new Request(
        `http://localhost/api/scenarios/runs/${runId}/status/stream`,
        {
          headers: {
            upgrade: "websocket",
            origin: "http://localhost",
            "sec-fetch-site": "same-origin",
          },
        },
      ),
      params: { runId },
    } as never);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

async function waitForMessage(messages: unknown[], timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (messages.length) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for run status stream acknowledgement");
}
