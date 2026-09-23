/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it } from "vitest";
import {
  testImageKey,
  desiredRunningVm,
  seedHost,
  connectHost,
  clientHello,
  sendBridge,
  waitForBridgeMessage,
  runNextScheduledAlarm,
  waitForRunState,
  waitForHostActualState,
  sleep,
  seedRun,
  stateReport,
  actualVm,
  vmReport,
  env,
  runDurableObjectAlarm,
  eq,
  drizzle,
  agentHosts,
  user,
  hostDesiredState,
  scenarioRuns,
  upsertDesiredCachedImage,
  upsertDesiredVm,
  mutateStoredHostDesiredState,
  type RunStateDocument,
  resetHostRuntimeTestDatabase,
} from "./host-runtime-do/test-fixtures";
import { organization } from "@/db/schema";
import { revokeFixtureAccount } from "@/test/account-fixtures";

describe("HostRuntimeDO bridge dispatch and sessions", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("connects organization hosts after creator deletion and binds the organization identity", async () => {
    const hostId = "org-host";
    await seedHost(hostId);
    await env.DB.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org-1','Org','org-1',1)").run();
    await env.DB.prepare("UPDATE agent_hosts SET scope='organization', organization_id='org-1' WHERE id=?").bind(hostId).run();
    await env.DB.prepare("UPDATE user SET banned=1, deleted_at=1 WHERE id='user-1'").run();
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const rejected = await stub.fetch("http://host-runtime/connect", { headers: {
      upgrade: "websocket", "x-agent-host-id": hostId, "x-agent-credential-generation": "1", "x-agent-organization-id": "other-org",
    } });
    expect(rejected.status).toBe(401);
    const connection = await connectHost(hostId);
    const desired = await waitForBridgeMessage(connection.messages, message => message.type === "desired_state");
    if (desired.type !== "desired_state") throw new Error("expected desired state");
    expect(desired.desired_state).toMatchObject({ scope: "organization", owner_user_id: "user-1" });
    expect(desired.relay?.identity.host_id).toBe(hostId);
    connection.ws.close();
  });

  it("retires durable runtime state and cancels its alarm", async () => {
    const hostId = "host-retired";
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const wake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      body: JSON.stringify({ hostId }),
    });
    expect(wake.status).toBe(202);

    const retired = await stub.fetch("http://host-runtime/_internal/retire", {
      method: "POST",
      headers: { "x-agent-host-id": hostId },
    });
    expect(retired.status).toBe(200);
    await expect(retired.json()).resolves.toEqual({ ok: true, hostId, alarmCleared: true });

    expect(await runDurableObjectAlarm(stub)).toBe(false);
    const wakeWithoutIdentity = await stub.fetch(
      "http://host-runtime/_internal/wake",
      { method: "POST" },
    );
    expect(wakeWithoutIdentity.status).toBe(409);
  });

  it("rejects a revoked personal host again inside the durable object", async () => {
    const hostId = "host-revoked-before-upgrade";
    await seedHost(hostId);
    await revokeFixtureAccount({ d1: env.DB, userId: "user-1" });

    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const response = await stub.fetch("http://host-runtime/connect", {
      headers: {
        upgrade: "websocket",
        "x-agent-host-id": hostId,
        "x-agent-credential-generation": "1",
      },
    });

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: "account access is revoked",
    });
  });

  it("does not activate a socket whose owner was revoked before hello", async () => {
    const hostId = "host-revoked-during-hello";
    await seedHost(hostId);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const response = await stub.fetch("http://host-runtime/connect", {
      headers: {
        upgrade: "websocket",
        "x-agent-host-id": hostId,
        "x-agent-credential-generation": "1",
      },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    expect(ws).not.toBeNull();
    if (!ws) throw new Error("missing websocket");
    const messages: unknown[] = [];
    ws.accept();
    ws.addEventListener("message", (event) => messages.push(event.data));

    await revokeFixtureAccount({ d1: env.DB, userId: "user-1" });

    sendBridge(ws, {
      type: "client_hello",
      protocol_version: 8,
      host_id: hostId,
      agent_version: "test-agent",
      role: "agent",
      capabilities: {
        arch: "x86_64",
        cloud_hypervisor_sha256:
          "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
        supports_kvm: true,
        supports_vsock: true,
        supports_reflink: true,
        supports_nftables: true,
        supports_jailer_v2: true,
      supports_jailer_v3: true,
      supports_raw_chunks_v1: true,
      supports_scenario_guest_tools_v1: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_hard_cpu_quota: true,
        supports_landlock: true,
        supports_cgroup_v2: true,
      },
    });
    await sleep(50);

    const host = await drizzle(env.DB)
      .select({
        connected: agentHosts.connected,
        activeSessionId: agentHosts.activeSessionId,
        lastClientHelloAt: agentHosts.lastClientHelloAt,
      })
      .from(agentHosts)
      .where(eq(agentHosts.id, hostId))
      .limit(1);
    expect(host[0]).toEqual({
      connected: false,
      activeSessionId: null,
      lastClientHelloAt: null,
    });
    expect(messages).toEqual([]);
  });

  it("rejects a hello after the host's scope changed since the upgrade", async () => {
    const hostId = "host-scope-flipped-before-hello";
    await seedHost(hostId);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const response = await stub.fetch("http://host-runtime/connect", {
      headers: {
        upgrade: "websocket",
        "x-agent-host-id": hostId,
        "x-agent-credential-generation": "1",
      },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    if (!ws) throw new Error("missing websocket");
    const messages: unknown[] = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }),
    );
    ws.accept();
    ws.addEventListener("message", (event) => messages.push(event.data));

    // The socket was admitted as personal; a platform host needs new credentials.
    await env.DB.prepare("UPDATE agent_hosts SET scope = 'platform' WHERE id = ?1").bind(hostId).run();
    sendBridge(ws, clientHello(hostId));

    await expect(closed).resolves.toEqual({ code: 1008, reason: "host admission required" });
    expect(messages).toEqual([]);
    expect(await env.DB.prepare(
      "SELECT connected, active_session_id, last_client_hello_at FROM agent_hosts WHERE id = ?1",
    ).bind(hostId).first()).toEqual({ connected: 0, active_session_id: null, last_client_hello_at: null });
  });

  it("keeps platform host connections independent of the owner's account", async () => {
    const hostId = "host-platform-owned";
    const now = Date.now();
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "platform-host-owner",
      name: "Platform Host Owner",
      email: "platform-host-owner@example.com",
      banned: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await db.insert(agentHosts).values({
      id: hostId,
      userId: "platform-host-owner",
      scope: "platform",
      credentialGeneration: 1,
      name: "Platform Host",
      role: "agent",
      disabled: false,
      connected: false,
      createdAt: now,
      updatedAt: now,
    });

    const { messages, ws } = await connectHost(hostId);
    await expect(
      waitForBridgeMessage(
        messages,
        (message) => message.type === "server_hello",
      ),
    ).resolves.toMatchObject({ type: "server_hello", host_id: hostId });
    ws.close();
  });

  it.each([0, 1])("rejects a historical organization host with connection generation %s", async (generation) => {
    const hostId = "host-historical-organization";
    await seedHost(hostId);
    const db = drizzle(env.DB);
    await db.insert(organization).values({
      id: "historical-org",
      name: "Historical Organization",
      slug: "historical-org",
      createdAt: new Date(),
    });
    await db.update(agentHosts).set({
      scope: null,
      credentialGeneration: 0,
    }).where(eq(agentHosts.id, hostId));

    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const response = await stub.fetch("http://host-runtime/connect", {
      headers: {
        upgrade: "websocket",
        "x-agent-host-id": hostId,
        "x-agent-credential-generation": String(generation),
      },
    });
    expect(response.status).toBe(401);
    expect(response.webSocket).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: generation === 0
        ? "invalid credential generation"
        : "server credentials changed",
    });
    expect(await env.DB.prepare(
      "SELECT connected, active_session_id, last_client_hello_at FROM agent_hosts WHERE id = ?",
    ).bind(hostId).first()).toEqual({
      connected: 0,
      active_session_id: null,
      last_client_hello_at: null,
    });
  });

  it("dispatches a changed desired state on alarm to the active bridge socket", async () => {
    const hostId = "host-alarm-dispatch";
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);

    expect(
      await waitForBridgeMessage(
        messages,
        (message) => message.type === "server_hello",
      ),
    ).toMatchObject({ type: "server_hello", desired_version: 0 });
    expect(
      await waitForBridgeMessage(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 0,
      ),
    ).toMatchObject({ type: "desired_state" });

    const db = drizzle(env.DB);
    await mutateStoredHostDesiredState(db, hostId, Date.now(), (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_id: "1".repeat(64),
      });
    });

    await runNextScheduledAlarm(stub);
    const desired = await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 1,
    );
    expect(desired).toMatchObject({
      type: "desired_state",
      desired_state: {
        cached_images: [
          {
            image_key: testImageKey,
            image_id: "1".repeat(64),
          },
        ],
      },
    });

    ws.close();
  });

  it("dispatches a changed desired state immediately when the host is woken", async () => {
    const hostId = "host-wake-dispatch";
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);

    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    const db = drizzle(env.DB);
    await mutateStoredHostDesiredState(db, hostId, Date.now(), (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_id: "1".repeat(64),
      });
    });
    expect(
      messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    const wake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      body: JSON.stringify({ hostId }),
    });
    expect(wake.status).toBe(202);
    await expect(wake.json()).resolves.toEqual({ ok: true, hostId });

    const desired = await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 1,
    );
    expect(desired).toMatchObject({
      type: "desired_state",
      desired_state: {
        cached_images: [
          {
            image_key: testImageKey,
            image_id: "1".repeat(64),
          },
        ],
      },
    });

    ws.close();
  });

  it("never dispatches a desired version older than the socket has seen", async () => {
    const hostId = "host-monotonic-dispatch";
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    const db = drizzle(env.DB);
    const desiredV1 = await mutateStoredHostDesiredState(
      db,
      hostId,
      Date.now(),
      (draft) => {
        upsertDesiredCachedImage(draft, {
          image_key: testImageKey,
          image_id: "1".repeat(64),
        });
      },
    );
    await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      body: JSON.stringify({ hostId }),
    });
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 1,
    );

    await db
      .update(hostDesiredState)
      .set({
        version: 0,
        docJson: { ...desiredV1, version: 0 },
        updatedAt: Date.now(),
      })
      .where(eq(hostDesiredState.hostId, hostId));
    const desiredCount = messages.filter(
      (message) => message.type === "desired_state",
    ).length;

    const staleWake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      body: JSON.stringify({ hostId }),
    });
    expect(staleWake.status).toBe(202);
    await sleep(20);
    expect(
      messages.filter((message) => message.type === "desired_state"),
    ).toHaveLength(desiredCount);

    ws.close();
  });

  it("keeps VM-report projection free of desired reloads with a durable alarm fallback", async () => {
    const hostId = "host-vm-report-dispatch";
    const runId = "run-vm-report-dispatch";
    const observedAt = Date.now() + 10;
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now: Date.now() });
    await mutateStoredHostDesiredState(db, hostId, Date.now(), (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_id: "1".repeat(64),
      });
    });
    expect(
      messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "booting",
        observedAt,
        22_001,
        "10.77.0.2",
      ),
    );

    await waitForRunState(
      db,
      runId,
      (state) => state.vms[0]?.runtimeObservedAt === observedAt,
    );
    await sleep(20);
    expect(
      messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    await runNextScheduledAlarm(stub);
    await expect(
      waitForBridgeMessage(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).resolves.toMatchObject({ type: "desired_state" });
    ws.close();
  });

  it("projects a VM report before heartbeat maintenance", async () => {
    const hostId = "host-vm-report-order";
    const runId = "run-vm-report-order";
    const now = Date.now();
    const observedAt = now + 100;
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    // Finish the initial grant before this test adds work. A grant whose
    // authorization changes in flight correctly forces a new connection.
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "desired_state" && message.desired_state.version === 0,
    );
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    await mutateStoredHostDesiredState(db, hostId, now + 1, (draft) => {
      upsertDesiredVm(draft, desiredRunningVm(runId, "runtime-web", now));
    });
    const wake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
    });
    expect(wake.status).toBe(202);
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 1,
    );
    await env.DB.prepare(
      `CREATE TABLE vm_report_projection_order (
        host_id TEXT NOT NULL,
        runtime_observed_at INTEGER
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TRIGGER vm_report_projection_before_heartbeat
       AFTER UPDATE OF last_heartbeat_at ON agent_hosts
       WHEN NEW.id = '${hostId}'
       BEGIN
         INSERT INTO vm_report_projection_order (host_id, runtime_observed_at)
         SELECT NEW.id, json_extract(state_json, '$.vms[0].runtimeObservedAt')
         FROM scenario_runs
         WHERE run_id = '${runId}';
       END`,
    ).run();

    try {
      sendBridge(
        ws,
        vmReport(
          hostId,
          runId,
          "runtime-web",
          "ready",
          observedAt,
          22_001,
          "10.77.0.2",
        ),
      );
      await waitForRunState(
        db,
        runId,
        (state) => state.vms[0]?.runtimeObservedAt === observedAt,
      );

      const deadline = Date.now() + 1_000;
      let orderRow: { runtime_observed_at: number | null } | null = null;
      while (Date.now() <= deadline) {
        orderRow = await env.DB.prepare(
          `SELECT runtime_observed_at
           FROM vm_report_projection_order
           WHERE host_id = ?
           ORDER BY rowid DESC
           LIMIT 1`,
        )
          .bind(hostId)
          .first<{ runtime_observed_at: number | null }>();
        if (orderRow) {
          break;
        }
        await sleep(10);
      }
      expect(orderRow?.runtime_observed_at).toBe(observedAt);
    } finally {
      ws.close();
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS vm_report_projection_before_heartbeat",
      ).run();
      await env.DB.prepare(
        "DROP TABLE IF EXISTS vm_report_projection_order",
      ).run();
    }
  });

  it("rejects VM reports from a replaced bridge session before projection", async () => {
    const hostId = "host-replaced-vm-report";
    const runId = "run-replaced-vm-report";
    const now = Date.now();
    const fencedHeartbeat = now + 5_000;
    await seedHost(hostId);
    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    await db
      .update(agentHosts)
      .set({
        activeSessionId: "v6:replacement-session",
        lastHeartbeatAt: fencedHeartbeat,
        updatedAt: fencedHeartbeat,
      })
      .where(eq(agentHosts.id, hostId));

    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "ready",
        now + 100,
        22_001,
        "10.77.0.2",
      ),
    );
    await sleep(50);

    const [run] = await db
      .select({ stateJson: scenarioRuns.stateJson })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, runId));
    const state = JSON.parse(run?.stateJson ?? "{}") as RunStateDocument;
    expect(state.vms[0]?.runtimeObservedAt).toBeNull();
    const [host] = await db
      .select({ lastHeartbeatAt: agentHosts.lastHeartbeatAt })
      .from(agentHosts)
      .where(eq(agentHosts.id, hostId));
    expect(host?.lastHeartbeatAt).toBe(fencedHeartbeat);
    ws.close();
  });

  it("rejects a VM report when its bridge session is replaced during the projection CAS", async () => {
    const hostId = "host-replaced-during-vm-projection";
    const runId = "run-replaced-during-vm-projection";
    const replacementSessionId = "v6:replacement-during-vm-projection";
    const now = Date.now();
    await seedHost(hostId);
    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const [hostBefore] = await db
      .select({ lastHeartbeatAt: agentHosts.lastHeartbeatAt })
      .from(agentHosts)
      .where(eq(agentHosts.id, hostId));

    await env.DB.prepare(
      `CREATE TRIGGER replace_vm_report_session_before_projection
       BEFORE UPDATE ON scenario_runs
       WHEN OLD.run_id = '${runId}'
       BEGIN
         UPDATE agent_hosts
         SET active_session_id = '${replacementSessionId}'
         WHERE id = '${hostId}';
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    try {
      sendBridge(
        ws,
        vmReport(
          hostId,
          runId,
          "runtime-web",
          "ready",
          now + 100,
          22_001,
          "10.77.0.2",
        ),
      );

      const deadline = Date.now() + 1_000;
      let activeSessionId: string | null | undefined;
      while (Date.now() <= deadline) {
        const [host] = await db
          .select({ activeSessionId: agentHosts.activeSessionId })
          .from(agentHosts)
          .where(eq(agentHosts.id, hostId));
        activeSessionId = host?.activeSessionId;
        if (activeSessionId === replacementSessionId) break;
        await sleep(10);
      }
      expect(activeSessionId).toBe(replacementSessionId);
      await sleep(20);

      const [run] = await db
        .select({ stateJson: scenarioRuns.stateJson })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, runId));
      const state = JSON.parse(run?.stateJson ?? "{}") as RunStateDocument;
      expect(state.vms[0]?.runtimeObservedAt).toBeNull();

      const [hostAfter] = await db
        .select({ lastHeartbeatAt: agentHosts.lastHeartbeatAt })
        .from(agentHosts)
        .where(eq(agentHosts.id, hostId));
      expect(hostAfter?.lastHeartbeatAt).toBe(hostBefore?.lastHeartbeatAt);
    } finally {
      ws.close();
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS replace_vm_report_session_before_projection",
      ).run();
    }
  });

  it("rejects a state-report projection when its bridge session is replaced during the run CAS", async () => {
    const hostId = "host-replaced-during-state-projection";
    const runId = "run-replaced-during-state-projection";
    const replacementSessionId = "v6:replacement-during-state-projection";
    const now = Date.now();
    await seedHost(hostId);
    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });

    await env.DB.prepare(
      `CREATE TRIGGER replace_state_report_session_before_projection
       BEFORE UPDATE ON scenario_runs
       WHEN OLD.run_id = '${runId}'
       BEGIN
         UPDATE agent_hosts
         SET active_session_id = '${replacementSessionId}'
         WHERE id = '${hostId}';
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    try {
      sendBridge(
        ws,
        stateReport(hostId, {
          observedAt: now + 100,
          appliedDesiredVersion: 0,
          vms: [actualVm(runId, "runtime-web", now + 100)],
        }),
      );

      const deadline = Date.now() + 1_000;
      let activeSessionId: string | null | undefined;
      while (Date.now() <= deadline) {
        const [host] = await db
          .select({ activeSessionId: agentHosts.activeSessionId })
          .from(agentHosts)
          .where(eq(agentHosts.id, hostId));
        activeSessionId = host?.activeSessionId;
        if (activeSessionId === replacementSessionId) break;
        await sleep(10);
      }
      expect(activeSessionId).toBe(replacementSessionId);
      await sleep(20);

      const [run] = await db
        .select({ stateJson: scenarioRuns.stateJson })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, runId));
      const state = JSON.parse(run?.stateJson ?? "{}") as RunStateDocument;
      expect(state.vms[0]?.runtimeObservedAt).toBeNull();
      expect(state.vms[0]?.runtimeConstraints).toBeNull();
    } finally {
      ws.close();
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS replace_state_report_session_before_projection",
      ).run();
    }
  });

  it("dispatches the committed desired version to the active bridge session on wake", async () => {
    const hostId = "host-commit-dispatch";
    const now = Date.now();
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );
    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        schedulableCpuMillis: 4_000,
      }),
    );
    const db = drizzle(env.DB);
    await waitForHostActualState(db, hostId, (row) => row.observedAt === now);

    // A durable desired-state publish is delivered by the wake that follows
    // it. There is no reservation commit to gate on any more: the admission
    // batch writes the run, its quota, and the desired version in one
    // transaction, and the wake is only the latency hint.
    await mutateStoredHostDesiredState(db, hostId, now + 1, (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_id: "1".repeat(64),
      });
    });
    const woke = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId }),
    });
    expect(woke.status).toBe(202);
    await expect(
      waitForBridgeMessage(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).resolves.toMatchObject({ type: "desired_state" });

    // A repeat wake for an already delivered version sends nothing.
    await sleep(20);
    expect(
      messages.filter(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toHaveLength(1);
    ws.close();
  });

  it("delivers a new desired version only through the newest bridge session", async () => {
    const hostId = "host-commit-replacement-dispatch";
    const now = Date.now();
    await seedHost(hostId);
    const first = await connectHost(hostId);
    await waitForBridgeMessage(
      first.messages,
      (message) => message.type === "server_hello",
    );
    await sleep(2);
    const replacement = await connectHost(hostId);
    await waitForBridgeMessage(
      replacement.messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      replacement.messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    sendBridge(
      replacement.ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        schedulableCpuMillis: 4_000,
      }),
    );
    const db = drizzle(env.DB);
    await waitForHostActualState(db, hostId, (row) => row.observedAt === now);

    await mutateStoredHostDesiredState(db, hostId, now + 1, (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_id: "1".repeat(64),
      });
    });
    expect(
      replacement.messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    const woke = await replacement.stub.fetch(
      "http://host-runtime/_internal/wake",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId }),
      },
    );
    expect(woke.status).toBe(202);
    await expect(
      waitForBridgeMessage(
        replacement.messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).resolves.toMatchObject({ type: "desired_state" });
    expect(
      first.messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    first.ws.close();
    replacement.ws.close();
  });

});
