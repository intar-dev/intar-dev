/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_HELLO_TIMEOUT_MS, MAX_PENDING_HOST_SOCKETS, MAX_STATUS_SOCKETS,
  MAX_STATUS_SOCKETS_PER_USER, STATUS_SOCKET_LIFETIME_MS,
  type RunStatusSocketAttachment,
} from "./base";
import {
  betaAdmissionForHostFixture, clientHello, connectHost, drizzle, env,
  resetHostRuntimeTestDatabase, seedHost, seedRun, waitForBridgeMessage,
} from "./test-fixtures";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function accept(response: Response): WebSocket {
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  return ws;
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise(resolve => ws.addEventListener("close", event => resolve(event.code), { once: true }));
}

async function pendingHostRequest(hostId: string) {
  const admission = await betaAdmissionForHostFixture("user-1");
  return () => env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId)).fetch(
    "http://host-runtime/connect", {
      headers: {
        upgrade: "websocket", "x-agent-host-id": hostId, "x-agent-credential-generation": "1",
        "x-agent-beta-source-invite-id": admission.sourceInviteId,
        "x-agent-beta-source-lease-id": admission.sourceLeaseId,
        "x-agent-beta-admission-granted-at": String(admission.grantedAt),
      },
    },
  );
}

async function statusRequest(hostId: string, sessionId: string, expiresAt: number) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES (?, ?, 'user-1', ?, ?, ?)",
  ).bind(sessionId, `${sessionId}-token`, expiresAt, now, now).run();
  const admission = await betaAdmissionForHostFixture("user-1");
  return () => env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId)).fetch(
    "http://host-runtime/_internal/run-status", {
      headers: {
        upgrade: "websocket", "x-run-status-host-id": hostId, "x-run-status-run-id": "run",
        "x-run-status-user-id": "user-1", "x-run-status-session-id": sessionId,
        "x-run-status-beta-source-invite-id": admission.sourceInviteId,
        "x-run-status-beta-source-lease-id": admission.sourceLeaseId,
        "x-run-status-beta-admission-granted-at": String(admission.grantedAt),
      },
    },
  );
}

// Workerd eviction drains active requests for up to five seconds per eviction.
vi.setConfig({ testTimeout: 20_000 });

describe("HostRuntimeDO socket lifecycle", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("preserves Pause written after hello reads the host", async () => {
    const hostId = "pause-during-hello";
    await seedHost(hostId);
    const client = accept(await (await pendingHostRequest(hostId))());
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: { DB: D1Database }; webSocketMessage(ws: WebSocket, raw: string): Promise<void> };
      const batch = runtime.env.DB.batch.bind(runtime.env.DB);
      const spy = vi.spyOn(runtime.env.DB, "batch").mockImplementationOnce(async statements => {
        await runtime.env.DB.prepare("UPDATE agent_hosts SET scenario_enabled = 0 WHERE id = ?").bind(hostId).run();
        return batch(statements);
      });
      try {
        await runtime.webSocketMessage(state.getWebSockets(`host:${hostId}`)[0]!, JSON.stringify(clientHello(hostId)));
      } finally { spy.mockRestore(); }
    });
    expect(await env.DB.prepare("SELECT scenario_enabled FROM agent_hosts WHERE id = ?").bind(hostId).first()).toEqual({ scenario_enabled: 0 });
    client.close();
  });

  it("advances the relay session clock for replacement hellos at the same time", async () => {
    const hostId = "same-clock-replacement";
    await seedHost(hostId);
    const first = accept(await (await pendingHostRequest(hostId))());
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const now = Date.now();
    const hello = () => runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { webSocketMessage(ws: WebSocket, raw: string): Promise<void> };
      const pending = state.getWebSockets(`host:${hostId}`).find(socket => !socket.deserializeAttachment().helloReceived)!;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try { await runtime.webSocketMessage(pending, JSON.stringify(clientHello(hostId))); }
      finally { clock.mockRestore(); }
    });
    await hello();
    const firstIdentity = await env.DB.prepare("SELECT connected_at, active_session_id FROM agent_hosts WHERE id = ?")
      .bind(hostId).first<{ connected_at: number; active_session_id: string }>();
    expect(firstIdentity?.connected_at).toBe(now);
    // Connect the replacement after the first hello; the first hello closes older pending sockets.
    const second = accept(await (await pendingHostRequest(hostId))());
    await hello();
    const replacement = await env.DB.prepare("SELECT connected_at, active_session_id FROM agent_hosts WHERE id = ?")
      .bind(hostId).first<{ connected_at: number; active_session_id: string }>();
    expect(replacement?.connected_at).toBe(now + 1);
    expect(replacement?.active_session_id).not.toBe(firstIdentity?.active_session_id);
    first.close();
    second.close();
  });

  it.each([false, true])("does not clear a replacement session when a stale close write resumes (rotation: %s)", async rotate => {
    await seedHost("host");
    const { ws, stub, messages } = await connectHost("host");
    await waitForBridgeMessage(messages, message => message.type === "desired_state");
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as {
        env: { DB: D1Database };
        handleSocketClosed(ws: WebSocket): Promise<void>;
      };
      const reached = deferred();
      const release = deferred();
      const prepare = runtime.env.DB.prepare.bind(runtime.env.DB);
      let intercepted = false;
      const spy = vi.spyOn(runtime.env.DB, "prepare").mockImplementation(query => {
        const statement = prepare(query);
        if (!intercepted && query.startsWith('update "agent_hosts"')) {
          intercepted = true;
          const bind = statement.bind.bind(statement);
          vi.spyOn(statement, "bind").mockImplementation((...values) => {
            const bound = bind(...values);
            // Pause at D1 execution, after the close handler has built its write.
            const raw = bound.raw.bind(bound);
            vi.spyOn(bound, "raw").mockImplementation(async () => {
              reached.resolve();
              await release.promise;
              return raw();
            });
            const run = bound.run.bind(bound);
            vi.spyOn(bound, "run").mockImplementation(async () => {
              reached.resolve();
              await release.promise;
              return run();
            });
            return bound;
          });
        }
        return statement;
      });
      const closing = runtime.handleSocketClosed(state.getWebSockets("host:host")[0]!);
      try {
        await reached.promise;
        await env.DB.prepare(
          "UPDATE agent_hosts SET active_session_id = 'replacement', credential_generation = ?, connected = 1, disconnected_at = NULL WHERE id = 'host'",
        ).bind(rotate ? 2 : 1).run();
      } finally {
        spy.mockRestore();
        release.resolve();
        await closing;
      }
      expect(await env.DB.prepare(
        "SELECT active_session_id, connected, disconnected_at FROM agent_hosts WHERE id = 'host'",
      ).first()).toEqual({ active_session_id: "replacement", connected: 1, disconnected_at: null });
    });
    ws.close();
  });

  it("caps simultaneous pending hosts and expires them after hibernation without D1 polling", async () => {
    await seedHost("pending");
    const request = await pendingHostRequest("pending");
    const start = Date.now();
    const responses = await Promise.all(Array.from({ length: 12 }, request));
    await Promise.all(responses.filter(response => response.status !== 101).map(response => response.text()));
    const clients = responses.filter(response => response.status === 101).map(accept);
    expect(clients).toHaveLength(MAX_PENDING_HOST_SOCKETS);
    expect(responses.filter(response => response.status === 429)).toHaveLength(12 - MAX_PENDING_HOST_SOCKETS);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("pending"));
    const closes = clients.map(closed);
    await runInDurableObject(stub, async (_instance, state) => {
      const deadline = await state.storage.getAlarm();
      expect(deadline).toBeGreaterThanOrEqual(start + HOST_HELLO_TIMEOUT_MS);
      expect(deadline).toBeLessThanOrEqual(Date.now() + HOST_HELLO_TIMEOUT_MS);
      for (const socket of state.getWebSockets("host")) {
        const attachment = socket.deserializeAttachment();
        socket.serializeAttachment({ ...attachment, connectedAt: Date.now() - HOST_HELLO_TIMEOUT_MS });
      }
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: { DB: D1Database }; alarm(): Promise<void> };
      const spy = vi.spyOn(runtime.env.DB, "prepare");
      try {
        await runtime.alarm();
        expect(spy).not.toHaveBeenCalled();
        expect(await state.storage.getAlarm()).toBeNull();
      } finally { spy.mockRestore(); }
    });
    expect(await Promise.all(closes)).toEqual(Array(MAX_PENDING_HOST_SOCKETS).fill(1008));
    const replacement = accept(await request());
    replacement.close();
  });

  it("rejects a late hello before the expiry alarm runs, including after hibernation", async () => {
    await seedHost("late");
    const ws = accept(await (await pendingHostRequest("late"))());
    const close = closed(ws);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("late"));
    await runInDurableObject(stub, async (_instance, state) => {
      const server = state.getWebSockets("host")[0]!;
      server.serializeAttachment({ ...server.deserializeAttachment(), connectedAt: Date.now() - HOST_HELLO_TIMEOUT_MS });
    });
    await evictDurableObject(stub);
    ws.send(JSON.stringify(clientHello("late")));
    expect(await close).toBe(1008);
    expect(await env.DB.prepare("SELECT active_session_id FROM agent_hosts WHERE id = 'late'").first())
      .toEqual({ active_session_id: null });
  });

  it("does not apply the hello deadline to an established host after hibernation", async () => {
    await seedHost("established");
    const { ws, stub, messages } = await connectHost("established");
    await waitForBridgeMessage(messages, message => message.type === "desired_state");
    await runInDurableObject(stub, async (_instance, state) => {
      const server = state.getWebSockets("host")[0]!;
      server.serializeAttachment({ ...server.deserializeAttachment(), connectedAt: 0 });
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(await env.DB.prepare("SELECT connected FROM agent_hosts WHERE id = 'established'").first())
      .toEqual({ connected: 1 });
    ws.close();
  });

  it.each(["timeout", "duplicate"] as const)("clears a pending session when its in-flight hello ends with %s", async failure => {
    await seedHost("hello-race");
    const ws = accept(await (await pendingHostRequest("hello-race"))());
    const close = closed(ws);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("hello-race"));
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as {
        isCurrentHostSessionAdmission(...args: unknown[]): Promise<boolean>;
        webSocketMessage(ws: WebSocket, message: string): Promise<void>;
        alarm(): Promise<void>;
      };
      const server = state.getWebSockets("host")[0]!;
      const reached = deferred();
      const release = deferred();
      const check = runtime.isCurrentHostSessionAdmission.bind(runtime);
      const admission = vi.spyOn(runtime, "isCurrentHostSessionAdmission").mockImplementationOnce(async (...args) => {
        const current = await check(...args);
        expect(current).toBe(true);
        reached.resolve();
        await release.promise;
        return current;
      });
      const hello = JSON.stringify(clientHello("hello-race"));
      const pending = runtime.webSocketMessage(server, hello);
      try {
        await reached.promise;
        if (failure === "duplicate") {
          await runtime.webSocketMessage(server, hello);
          expect(admission).toHaveBeenCalledOnce();
        } else {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + HOST_HELLO_TIMEOUT_MS);
          try { await runtime.alarm(); } finally { clock.mockRestore(); }
        }
      } finally {
        release.resolve();
        await pending;
        admission.mockRestore();
      }
      expect(await env.DB.prepare("SELECT active_session_id, connected FROM agent_hosts WHERE id = 'hello-race'").first())
        .toEqual({ active_session_id: null, connected: 0 });
    });
    expect(await close).toBe(1008);
  });

  it("caps concurrent status listeners per user across sessions and hibernation", async () => {
    await seedHost("status");
    await seedRun({ db: drizzle(env.DB), hostId: "status", runId: "run", now: Date.now() });
    const requests = await Promise.all(["a", "b"].map(id => statusRequest("status", id, Date.now() + 60_000)));
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => requests[i % 2]!()));
    await Promise.all(responses.filter(response => response.status !== 101).map(response => response.text()));
    const clients = responses.filter(response => response.status === 101).map(accept);
    expect(clients).toHaveLength(MAX_STATUS_SOCKETS_PER_USER);
    expect(responses.filter(response => response.status === 429)).toHaveLength(12 - MAX_STATUS_SOCKETS_PER_USER);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("status"));
    await evictDurableObject(stub);
    const rejected = await requests[0]!();
    expect(rejected.status).toBe(429);
    await rejected.text();
    for (const ws of clients) ws.close();
  });

  it("caps total status listeners separately from host admission", async () => {
    await seedHost("full");
    await seedRun({ db: drizzle(env.DB), hostId: "full", runId: "run", now: Date.now() });
    const request = await statusRequest("full", "browser", Date.now() + 60_000);
    const first = accept(await request());
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("full"));
    await runInDurableObject(stub, async (_instance, state) => {
      const attachment = state.getWebSockets("run-status")[0]!.deserializeAttachment() as RunStatusSocketAttachment;
      // Seed other users' accepted sockets to exercise the host-wide limit without 511 D1 fixtures.
      for (let i = 1; i < MAX_STATUS_SOCKETS; i++) {
        const pair = new WebSocketPair();
        state.acceptWebSocket(pair[1], ["run-status"]);
        pair[1].serializeAttachment({ ...attachment, userId: `other-${i}` });
      }
      const rejected = await request();
      expect(rejected.status).toBe(429);
      await rejected.text();
      const host = accept(await (await pendingHostRequest("full"))());
      host.close();
      for (const ws of state.getWebSockets("run-status")) ws.close();
    });
    first.close();
  });

  it.each([60_000, STATUS_SOCKET_LIFETIME_MS * 2])("bounds status lifetime by session expiry and maximum age (%s ms)", async sessionLifetime => {
    await seedHost("expiry");
    await seedRun({ db: drizzle(env.DB), hostId: "expiry", runId: "run", now: Date.now() });
    const started = Date.now();
    const sessionExpiry = started + sessionLifetime;
    const ws = accept(await (await statusRequest("expiry", "browser", sessionExpiry))());
    const close = closed(ws);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("expiry"));
    const runtimeDeadline = Date.now() + STATUS_SOCKET_LIFETIME_MS * 3;
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { scheduleAlarmNoLaterThan(deadline: number): Promise<void> };
      const server = state.getWebSockets("run-status")[0]!;
      const attachment = server.deserializeAttachment() as RunStatusSocketAttachment;
      expect(attachment.expiresAt).toBeGreaterThanOrEqual(Math.min(sessionExpiry, started + STATUS_SOCKET_LIFETIME_MS));
      expect(attachment.expiresAt).toBeLessThanOrEqual(Math.min(sessionExpiry, Date.now() + STATUS_SOCKET_LIFETIME_MS));
      expect(await state.storage.getAlarm()).toBe(attachment.expiresAt);
      await runtime.scheduleAlarmNoLaterThan(runtimeDeadline);
      expect(await state.storage.getAlarm()).toBe(attachment.expiresAt);
      server.serializeAttachment({ ...attachment, expiresAt: Date.now() - 1 });
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: { DB: D1Database }; alarm(): Promise<void> };
      const spy = vi.spyOn(runtime.env.DB, "prepare");
      try {
        await runtime.alarm();
        expect(spy).not.toHaveBeenCalled();
        // Expiring sockets must not discard the later runtime maintenance alarm.
        expect(await state.storage.getAlarm()).toBe(runtimeDeadline);
      } finally { spy.mockRestore(); }
    });
    expect(await close).toBe(1008);
  });
});
