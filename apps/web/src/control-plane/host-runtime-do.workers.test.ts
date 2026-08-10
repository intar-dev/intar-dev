/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it } from "vitest";
import {
  testImageKey,
  desiredRunningVm,
  seedHost,
  connectHost,
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
  hostCpuReservations,
  hostDesiredState,
  scenarioRuns,
  upsertDesiredCachedImage,
  upsertDesiredVm,
  mutateStoredHostDesiredState,
  type RunStateDocument,
  resetHostRuntimeTestDatabase,
} from "./host-runtime-do/test-fixtures";
import { organization } from "@/db/schema";
import {
  insertPersonalHostForActiveBetaAdmission,
  rotatePersonalBootstrapForActiveBetaAdmission,
} from "@/lib/personal-agent-admission";
import {
  acquireBetaRevocationCleanup,
  allowBetaReinvite,
  completeBetaRevocationCleanup,
  revokeBetaUser,
} from "@/lib/access-invites";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import {
  FIXTURE_BETA_ADMIN_ID,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";

describe("HostRuntimeDO bridge dispatch and sessions", () => {
  beforeEach(resetHostRuntimeTestDatabase);

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
    await expect(retired.json()).resolves.toEqual({ ok: true, hostId });

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
    const admission = await env.DB.prepare(
      `SELECT source_invite_id, source_lease_id, granted_at
       FROM access_allowlist WHERE user_id = 'user-1'`,
    ).first<{
      source_invite_id: string;
      source_lease_id: string;
      granted_at: number;
    }>();
    expect(admission).not.toBeNull();
    await blockFixtureBetaAccess("user-1");

    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const response = await stub.fetch("http://host-runtime/connect", {
      headers: {
        upgrade: "websocket",
        "x-agent-host-id": hostId,
        "x-agent-beta-source-invite-id": admission!.source_invite_id,
        "x-agent-beta-source-lease-id": admission!.source_lease_id,
        "x-agent-beta-admission-granted-at": String(admission!.granted_at),
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "beta access is revoked",
    });
  });

  it("rejects a personal socket with different admission ids at the same timestamp", async () => {
    const hostId = "host-stale-admission-at-do";
    await seedHost(hostId);
    const admission = await env.DB.prepare(
      `SELECT source_invite_id, source_lease_id, granted_at
       FROM access_allowlist WHERE user_id = 'user-1'`,
    ).first<{
      source_invite_id: string;
      source_lease_id: string;
      granted_at: number;
    }>();
    expect(admission).not.toBeNull();

    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const response = await stub.fetch("http://host-runtime/connect", {
      headers: {
        upgrade: "websocket",
        "x-agent-host-id": hostId,
        "x-agent-beta-source-invite-id": `${admission!.source_invite_id}-old`,
        "x-agent-beta-source-lease-id": `${admission!.source_lease_id}-old`,
        "x-agent-beta-admission-granted-at": String(admission!.granted_at),
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "stale beta admission",
    });
  });

  it("does not activate an old socket after equal-timestamp readmission", async () => {
    const hostId = "host-revoked-during-hello";
    await seedHost(hostId);
    const admission = await env.DB.prepare(
      `SELECT source_invite_id, source_lease_id, granted_at
       FROM access_allowlist WHERE user_id = 'user-1'`,
    ).first<{
      source_invite_id: string;
      source_lease_id: string;
      granted_at: number;
    }>();
    expect(admission).not.toBeNull();
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const response = await stub.fetch("http://host-runtime/connect", {
      headers: {
        upgrade: "websocket",
        "x-agent-host-id": hostId,
        "x-agent-beta-source-invite-id": admission!.source_invite_id,
        "x-agent-beta-source-lease-id": admission!.source_lease_id,
        "x-agent-beta-admission-granted-at": String(admission!.granted_at),
      },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    expect(ws).not.toBeNull();
    if (!ws) throw new Error("missing websocket");
    const messages: unknown[] = [];
    ws.accept();
    ws.addEventListener("message", (event) => messages.push(event.data));

    const equalGrantedAt = admission!.granted_at;
    const blocked = await blockFixtureBetaAccess(
      "user-1",
      equalGrantedAt - 6,
    );
    const cleanup = await acquireBetaRevocationCleanup({
      d1: env.DB,
      userId: "user-1",
      revocationId: blocked.revocationId,
      now: equalGrantedAt - 5,
    });
    expect(cleanup.status).toBe("acquired");
    await completeBetaRevocationCleanup({
      d1: env.DB,
      userId: "user-1",
      revocationId: blocked.revocationId,
      cleanupAttemptId: cleanup.cleanupAttemptId,
      now: equalGrantedAt - 4,
    });
    await allowBetaReinvite({
      d1: env.DB,
      userId: "user-1",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      revocationId: blocked.revocationId,
      now: equalGrantedAt - 3,
    });
    await grantFixtureBetaAccess({
      d1: env.DB,
      userId: "user-1",
      githubAccountId: "host-runtime-github-user-1",
      githubUsername: "user-1",
      now: equalGrantedAt - 2,
    });
    const freshAdmission = await loadFixtureBetaAdmission("user-1");
    expect(freshAdmission.grantedAt).toBe(equalGrantedAt);
    expect(freshAdmission.sourceInviteId).not.toBe(
      admission!.source_invite_id,
    );
    expect(freshAdmission.sourceLeaseId).not.toBe(
      admission!.source_lease_id,
    );

    sendBridge(ws, {
      type: "client_hello",
      protocol_version: 6,
      host_id: hostId,
      agent_version: "test-agent",
      role: "agent",
      capabilities: {
        arch: "x86_64",
        cloud_hypervisor_sha256:
          "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
        boot_cpu_millis: 2_000,
        boot_cpu_lease_ms: 45_000,
        supports_kvm: true,
        supports_vsock: true,
        supports_reflink: true,
        supports_nftables: true,
        supports_jailer_v2: true,
        supports_boot_cpu_lease: true,
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

  it("keeps organization-owned host connections independent of beta access", async () => {
    const hostId = "host-organization-owned";
    const now = Date.now();
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "org-host-owner",
      name: "Organization Host Owner",
      email: "org-host-owner@example.com",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await db.insert(organization).values({
      id: "org-host-test",
      name: "Host Test Org",
      slug: "host-test-org",
      createdAt: new Date(now),
    });
    await db.insert(agentHosts).values({
      id: hostId,
      userId: "org-host-owner",
      organizationId: "org-host-test",
      name: "Organization Host",
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

  it("fences paused personal issuance against revocation and readmission", async () => {
    await seedHost("host-existing-admission");
    const capturedAdmission = await loadFixtureBetaAdmission("user-1");
    const now = Date.now();
    await expect(
      insertPersonalHostForActiveBetaAdmission(env.DB, {
        hostId: "host-created-while-active",
        userId: "user-1",
        name: "Created While Active",
        role: "agent",
        betaAdmission: capturedAdmission,
        now,
      }),
    ).resolves.toBe(true);
    await expect(
      rotatePersonalBootstrapForActiveBetaAdmission(env.DB, {
        tokenId: "token-created-while-active",
        hostId: "host-created-while-active",
        userId: "user-1",
        tokenHash: "a".repeat(64),
        betaAdmission: capturedAdmission,
        now: now + 1,
      }),
    ).resolves.toBe(true);

    const blocked = await blockFixtureBetaAccess("user-1");
    await expect(
      insertPersonalHostForActiveBetaAdmission(env.DB, {
        hostId: "host-created-after-revoke",
        userId: "user-1",
        name: "Must Not Exist",
        role: "agent",
        betaAdmission: capturedAdmission,
        now: now + 2,
      }),
    ).resolves.toBe(false);
    await expect(
      rotatePersonalBootstrapForActiveBetaAdmission(env.DB, {
        tokenId: "token-created-after-revoke",
        hostId: "host-created-while-active",
        userId: "user-1",
        tokenHash: "b".repeat(64),
        betaAdmission: capturedAdmission,
        now: now + 3,
      }),
    ).resolves.toBe(false);

    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM agent_hosts WHERE id = 'host-created-after-revoke') AS hosts,
           (SELECT count(*) FROM agent_bootstrap_tokens WHERE id = 'token-created-after-revoke') AS tokens`,
      ).first<{ hosts: number; tokens: number }>(),
    ).resolves.toEqual({ hosts: 0, tokens: 0 });

    const cleanup = await acquireBetaRevocationCleanup({
      d1: env.DB,
      userId: "user-1",
      revocationId: blocked.revocationId,
      now: blocked.now + 1,
    });
    expect(cleanup.status).toBe("acquired");
    await completeBetaRevocationCleanup({
      d1: env.DB,
      userId: "user-1",
      revocationId: blocked.revocationId,
      cleanupAttemptId: cleanup.cleanupAttemptId,
      now: blocked.now + 2,
    });
    await allowBetaReinvite({
      d1: env.DB,
      userId: "user-1",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      revocationId: blocked.revocationId,
      now: blocked.now + 3,
    });
    await grantFixtureBetaAccess({
      d1: env.DB,
      userId: "user-1",
      githubAccountId: "host-runtime-github-user-1",
      githubUsername: "user-1",
      now: blocked.now + 4,
    });
    const freshAdmission = await loadFixtureBetaAdmission("user-1");
    expect(freshAdmission).not.toEqual(capturedAdmission);

    // These calls model requests paused after requireUserContext captured the
    // old admission, then resumed only after the same user was re-admitted.
    await expect(
      insertPersonalHostForActiveBetaAdmission(env.DB, {
        hostId: "host-created-by-paused-request",
        userId: "user-1",
        name: "Must Still Not Exist",
        role: "agent",
        betaAdmission: capturedAdmission,
        now: blocked.now + 7,
      }),
    ).resolves.toBe(false);
    await expect(
      rotatePersonalBootstrapForActiveBetaAdmission(env.DB, {
        tokenId: "token-created-by-paused-request",
        hostId: "host-created-while-active",
        userId: "user-1",
        tokenHash: "c".repeat(64),
        betaAdmission: capturedAdmission,
        now: blocked.now + 8,
      }),
    ).resolves.toBe(false);

    await expect(
      insertPersonalHostForActiveBetaAdmission(env.DB, {
        hostId: "host-created-by-fresh-request",
        userId: "user-1",
        name: "Fresh Admission Host",
        role: "agent",
        betaAdmission: freshAdmission,
        now: blocked.now + 9,
      }),
    ).resolves.toBe(true);
    await expect(
      rotatePersonalBootstrapForActiveBetaAdmission(env.DB, {
        tokenId: "token-created-by-fresh-request",
        hostId: "host-created-while-active",
        userId: "user-1",
        tokenHash: "d".repeat(64),
        betaAdmission: freshAdmission,
        now: blocked.now + 10,
      }),
    ).resolves.toBe(true);

    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM agent_hosts WHERE id = 'host-created-by-paused-request') AS stale_hosts,
           (SELECT count(*) FROM agent_bootstrap_tokens WHERE id = 'token-created-by-paused-request') AS stale_tokens,
           (SELECT count(*) FROM agent_hosts WHERE id = 'host-created-by-fresh-request') AS fresh_hosts,
           (SELECT count(*) FROM agent_bootstrap_tokens WHERE id = 'token-created-by-fresh-request') AS fresh_tokens`,
      ).first<{
        stale_hosts: number;
        stale_tokens: number;
        fresh_hosts: number;
        fresh_tokens: number;
      }>(),
    ).resolves.toEqual({
      stale_hosts: 0,
      stale_tokens: 0,
      fresh_hosts: 1,
      fresh_tokens: 1,
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
        image_sha256: "1".repeat(64),
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
            image_sha256: "1".repeat(64),
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
        image_sha256: "1".repeat(64),
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
            image_sha256: "1".repeat(64),
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
          image_sha256: "1".repeat(64),
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
        image_sha256: "1".repeat(64),
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

  it("dispatches desired state only after the CPU reservation commit succeeds", async () => {
    const hostId = "host-commit-dispatch";
    const runId = "run-commit-dispatch";
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

    const reserved = await stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/reserve",
      {
        method: "POST",
        body: JSON.stringify({
          hostId,
          runId,
          steadyCpuMillisByVm: [1_000],
        }),
      },
    );
    expect(reserved.status).toBe(201);
    await mutateStoredHostDesiredState(db, hostId, now + 1, (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "1".repeat(64),
      });
    });

    const committed = await stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/commit",
      {
        method: "POST",
        body: JSON.stringify({ hostId, runId }),
      },
    );
    expect(committed.status).toBe(200);
    await expect(committed.json()).resolves.toEqual({ ok: true });
    await expect(
      waitForBridgeMessage(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).resolves.toMatchObject({ type: "desired_state" });
    await expect(
      db
        .select({ state: hostCpuReservations.state })
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.runId, runId)),
    ).resolves.toEqual([{ state: "committed" }]);

    await mutateStoredHostDesiredState(db, hostId, now + 2, (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "3".repeat(64),
      });
    });
    const missingCommit = await stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/commit",
      {
        method: "POST",
        body: JSON.stringify({ hostId, runId: "missing-reservation" }),
      },
    );
    await expect(missingCommit.json()).resolves.toEqual({ ok: false });
    await sleep(20);
    expect(
      messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 2,
      ),
    ).toBe(false);
    ws.close();
  });

  it("dispatches a committed reservation only through the newest bridge session", async () => {
    const hostId = "host-commit-replacement-dispatch";
    const runId = "run-commit-replacement-dispatch";
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
    const reserved = await replacement.stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/reserve",
      {
        method: "POST",
        body: JSON.stringify({
          hostId,
          runId,
          steadyCpuMillisByVm: [1_000],
        }),
      },
    );
    expect(reserved.status).toBe(201);
    await mutateStoredHostDesiredState(db, hostId, now + 1, (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "1".repeat(64),
      });
    });
    expect(
      replacement.messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    const committed = await replacement.stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/commit",
      {
        method: "POST",
        body: JSON.stringify({ hostId, runId }),
      },
    );
    await expect(committed.json()).resolves.toEqual({ ok: true });
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

async function blockFixtureBetaAccess(
  userId: string,
  now = Date.now(),
): Promise<{ revocationId: string; now: number }> {
  const result = await revokeBetaUser({
    d1: env.DB,
    userId,
    actorUserId: FIXTURE_BETA_ADMIN_ID,
    reason: "adversarial_race_test",
    now,
  });
  await expect(
    env.DB.prepare(
      "SELECT state FROM access_allowlist WHERE user_id = ?1",
    )
      .bind(userId)
      .first<{ state: string }>(),
  ).resolves.toEqual({ state: "blocked" });
  return { revocationId: result.revocationId, now };
}

async function loadFixtureBetaAdmission(
  userId: string,
): Promise<BetaAdmissionEpoch> {
  const row = await env.DB.prepare(
    `SELECT source_invite_id, source_lease_id, granted_at
     FROM access_allowlist
     WHERE user_id = ?1 AND state = 'active'`,
  )
    .bind(userId)
    .first<{
      source_invite_id: string;
      source_lease_id: string;
      granted_at: number;
    }>();
  if (!row) throw new Error(`active beta fixture missing: ${userId}`);
  return {
    sourceInviteId: row.source_invite_id,
    sourceLeaseId: row.source_lease_id,
    grantedAt: row.granted_at,
  };
}
