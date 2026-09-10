/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { session } from "@/db/schema";
import {
  agentHosts,
  betaAdmissionForHostFixture,
  connectHost,
  desiredRunningVm,
  drizzle,
  env,
  eq,
  grantActiveBetaAccessForHostFixture,
  mutateStoredHostDesiredState,
  runNextScheduledAlarm,
  scenarioRuns,
  seedHost,
  seedRun,
  sendBridge,
  sleep,
  upsertDesiredVm,
  user,
  waitForBridgeMessage,
  vmReport,
  resetHostRuntimeTestDatabase,
} from "./test-fixtures";

type StatusMessage =
  | { type: "subscribed"; runId: string }
  | { type: "invalidate"; runId: string; revision: number };

describe("HostRuntimeDO run status stream", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("sends an invalidation only after the VM report projection commits", async () => {
    const hostId = "host-status-invalidation";
    const runId = "run-status-invalidation";
    const now = Date.now();
    await seedHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const listener = await openStatusStream({ hostId, runId, now });
    await waitForStatusMessage(
      listener.messages,
      (message): message is Extract<StatusMessage, { type: "subscribed" }> =>
        message.type === "subscribed",
    );

    // A hibernated browser socket must restore as a status listener, not as
    // an agent socket, before the agent's next report wakes this object.
    await evictDurableObject(listener.stub);

    const { messages: agentMessages, ws: agentSocket } = await connectHost(hostId);
    await waitForBridgeMessage(
      agentMessages,
      (message) => message.type === "server_hello",
    );
    sendBridge(
      agentSocket,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "ready",
        now + 1,
        22_001,
        "10.77.0.2",
      ),
    );

    const invalidation = await waitForStatusMessage(
      listener.messages,
      (message): message is Extract<StatusMessage, { type: "invalidate" }> =>
        message.type === "invalidate",
    );
    const row = await env.DB.prepare(
      "SELECT updated_at FROM scenario_runs WHERE run_id = ?1",
    )
      .bind(runId)
      .first<{ updated_at: number }>();
    expect(row?.updated_at).toBe(invalidation.revision);
    expect(invalidation.revision).toBeGreaterThan(now);

    listener.ws.close();
    agentSocket.close();
  });

  it("rejects a different active user before it can subscribe to a run", async () => {
    const hostId = "host-status-wrong-owner";
    const runId = "run-status-wrong-owner";
    const now = Date.now();
    await seedHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    await seedStatusUser("user-2", now);

    const response = await createStatusStreamResponse({
      hostId,
      runId,
      now,
      userId: "user-2",
    });

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it("revalidates a subscribed run after its host mapping changes", async () => {
    const hostId = "host-status-old-mapping";
    const replacementHostId = "host-status-new-mapping";
    const runId = "run-status-host-moved";
    const now = Date.now();
    await seedHost(hostId);
    await seedHost(replacementHostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const listener = await openStatusStream({ hostId, runId, now });
    await waitForStatusMessage(
      listener.messages,
      (message): message is Extract<StatusMessage, { type: "subscribed" }> =>
        message.type === "subscribed",
    );

    await db
      .update(scenarioRuns)
      .set({ hostId: replacementHostId })
      .where(eq(scenarioRuns.runId, runId));

    const retry = await createStatusStreamResponse({ hostId, runId, now });
    expect(retry.status).toBe(403);

    await runInDurableObject(listener.stub, async (runtime) => {
      await (
        runtime as unknown as {
          notifyRunStatusInvalidation(input: {
            runId: string;
            hostId: string;
            revision: number;
          }): Promise<void>;
        }
      ).notifyRunStatusInvalidation({
        runId,
        hostId,
        revision: now + 1,
      });
    });

    const close = await waitForStatusClose(listener);
    expect(close.code).toBe(1008);
    expect(listener.messages.filter((message) => message.type === "invalidate")).toEqual(
      [],
    );
  });

  it("does not notify when a stale agent session cannot commit its report", async () => {
    const hostId = "host-status-stale-agent";
    const runId = "run-status-stale-agent";
    const now = Date.now();
    await seedHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const listener = await openStatusStream({ hostId, runId, now });
    await waitForStatusMessage(
      listener.messages,
      (message): message is Extract<StatusMessage, { type: "subscribed" }> =>
        message.type === "subscribed",
    );
    const { messages: agentMessages, ws: agentSocket } = await connectHost(hostId);
    await waitForBridgeMessage(
      agentMessages,
      (message) => message.type === "server_hello",
    );
    await db
      .update(agentHosts)
      .set({ activeSessionId: "v6:replacement-session" })
      .where(eq(agentHosts.id, hostId));

    sendBridge(
      agentSocket,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "ready",
        now + 1,
        22_001,
        "10.77.0.2",
      ),
    );
    await sleep(75);

    expect(listener.messages.filter((message) => message.type === "invalidate")).toEqual(
      [],
    );
    const row = await env.DB.prepare(
      "SELECT updated_at FROM scenario_runs WHERE run_id = ?1",
    )
      .bind(runId)
      .first<{ updated_at: number }>();
    expect(row?.updated_at).toBe(now);

    listener.ws.close();
    agentSocket.close();
  });

  it("notifies when a durable-object alarm commits a lease-expiry failure", async () => {
    const hostId = "host-status-lease-expiry";
    const runId = "run-status-lease-expiry";
    const now = Date.now();
    await seedHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const listener = await openStatusStream({ hostId, runId, now });
    await waitForStatusMessage(
      listener.messages,
      (message): message is Extract<StatusMessage, { type: "subscribed" }> =>
        message.type === "subscribed",
    );
    await mutateStoredHostDesiredState(db, hostId, now, (draft) => {
      upsertDesiredVm(draft, {
        ...desiredRunningVm(runId, "runtime-web", now),
        lease_expires_at_unix_ms: now - 1,
      });
    });

    const wake = await listener.stub.fetch(
      "http://host-runtime/_internal/wake",
      { method: "POST" },
    );
    expect(wake.status).toBe(202);
    await runNextScheduledAlarm(listener.stub);

    const invalidation = await waitForStatusMessage(
      listener.messages,
      (message): message is Extract<StatusMessage, { type: "invalidate" }> =>
        message.type === "invalidate",
    );
    const row = await env.DB.prepare(
      "SELECT state, updated_at FROM scenario_runs WHERE run_id = ?1",
    )
      .bind(runId)
      .first<{ state: string; updated_at: number }>();
    expect(row?.state).toBe("failed");
    expect(invalidation.revision).toBe(row?.updated_at);

    listener.ws.close();
  });

  it("closes a revoked subscriber before sending another invalidation", async () => {
    const hostId = "host-status-revoked";
    const runId = "run-status-revoked";
    const now = Date.now();
    await seedHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const listener = await openStatusStream({ hostId, runId, now });
    await waitForStatusMessage(
      listener.messages,
      (message): message is Extract<StatusMessage, { type: "subscribed" }> =>
        message.type === "subscribed",
    );
    const { messages: agentMessages, ws: agentSocket } = await connectHost(hostId);
    await waitForBridgeMessage(
      agentMessages,
      (message) => message.type === "server_hello",
    );

    await db.delete(session).where(eq(session.id, "status-session-user-1"));
    sendBridge(
      agentSocket,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "ready",
        now + 1,
        22_001,
        "10.77.0.2",
      ),
    );

    const close = await waitForStatusClose(listener);
    expect(close.code).toBe(1008);
    expect(listener.messages.filter((message) => message.type === "invalidate")).toEqual(
      [],
    );
    agentSocket.close();
  });

  it("does not treat a browser status socket as an agent bridge socket", async () => {
    const hostId = "host-status-attachment";
    const runId = "run-status-attachment";
    const now = Date.now();
    await seedHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const listener = await openStatusStream({ hostId, runId, now });
    const { messages: agentMessages, ws: agentSocket } = await connectHost(hostId);
    await waitForBridgeMessage(
      agentMessages,
      (message) => message.type === "server_hello",
    );

    listener.ws.send("unexpected client frame");
    const close = await waitForStatusClose(listener);
    expect(close.code).toBe(1003);
    const host = await env.DB.prepare(
      "SELECT connected FROM agent_hosts WHERE id = ?1",
    )
      .bind(hostId)
      .first<{ connected: number }>();
    expect(host?.connected).toBe(1);
    agentSocket.close();
  });
});

async function openStatusStream(input: {
  hostId: string;
  runId: string;
  now: number;
}): Promise<{
  stub: DurableObjectStub;
  ws: WebSocket;
  messages: StatusMessage[];
  close: CloseEvent | null;
}> {
  const response = await createStatusStreamResponse(input);
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  expect(ws).not.toBeNull();
  if (!ws) throw new Error("missing run status websocket");

  const messages: StatusMessage[] = [];
  let close: CloseEvent | null = null;
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    messages.push(JSON.parse(event.data) as StatusMessage);
  });
  ws.addEventListener("close", (event) => {
    close = event;
  });
  return {
    stub: env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(input.hostId)),
    ws,
    messages,
    get close() {
      return close;
    },
  };
}

async function createStatusStreamResponse(input: {
  hostId: string;
  runId: string;
  now: number;
  userId?: string;
}): Promise<Response> {
  const userId = input.userId ?? "user-1";
  const sessionId = `status-session-${userId}`;
  const admission = await betaAdmissionForHostFixture(userId);
  const db = drizzle(env.DB);
  await db
    .insert(session)
    .values({
      id: sessionId,
      token: `${sessionId}-token`,
      userId,
      expiresAt: new Date(input.now + 60_000),
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    })
    .onConflictDoNothing();
  const stub = env.HOST_RUNTIME.get(
    env.HOST_RUNTIME.idFromName(input.hostId),
  );
  return stub.fetch(
    new Request("https://host-runtime.internal/_internal/run-status", {
      headers: {
        upgrade: "websocket",
        "x-run-status-run-id": input.runId,
        "x-run-status-user-id": userId,
        "x-run-status-host-id": input.hostId,
        "x-run-status-session-id": sessionId,
        "x-run-status-beta-source-invite-id": admission.sourceInviteId,
        "x-run-status-beta-source-lease-id": admission.sourceLeaseId,
        "x-run-status-beta-admission-granted-at": String(admission.grantedAt),
      },
    }),
  );
}

async function seedStatusUser(userId: string, now: number): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(user).values({
    id: userId,
    name: userId,
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await grantActiveBetaAccessForHostFixture(userId, now);
}

async function waitForStatusMessage<T extends StatusMessage>(
  messages: StatusMessage[],
  predicate: (message: StatusMessage) => message is T,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const message = messages.find(predicate);
    if (message) return message;
    await sleep(10);
  }
  throw new Error(`timed out waiting for status message: ${JSON.stringify(messages)}`);
}

async function waitForStatusClose(input: {
  close: CloseEvent | null;
}): Promise<CloseEvent> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    if (input.close) return input.close;
    await sleep(10);
  }
  throw new Error("timed out waiting for status websocket close");
}
