/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientHello, connectHost, drizzle, env, resetHostRuntimeTestDatabase,
  seedHost, seedRun, sendBridge, stateReport, vmReport, waitForBridgeMessage,
} from "./test-fixtures";
import type { VmReportV2 } from "@/generated/bridge";
import { runtimeVms, runtimeVmAccessKeys } from "@/db/schema";
import { encryptRuntimeVmAccessKey, recordRuntimeVmActualState } from "@/lib/runtime-vm-state";
import { revokeAccount } from "@/lib/access-revocation-store";
import { FIXTURE_ADMIN_ID } from "@/test/account-fixtures";

// Workerd eviction drains active requests for up to five seconds per eviction.
vi.setConfig({ testTimeout: 20_000 });

describe("host credential generation", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("rejects connections without a generation before accepting a socket", async () => {
    await seedHost("host");
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("host"));
    const response = await stub.fetch("http://host-runtime/connect", {
      headers: { upgrade: "websocket", "x-agent-host-id": "host" },
    });
    expect(response.status).toBe(401);
    expect(response.webSocket).toBeNull();
  });

  it.each(["report", "hello"] as const)("rejects an old %s after hibernation and credential replacement", async (message) => {
    await seedHost("host");
    const { ws, stub, messages } = await connectHost("host");
    await waitForBridgeMessage(messages, frame => frame.type === "desired_state");
    await evictDurableObject(stub);
    await env.DB.prepare("UPDATE agent_hosts SET credential_generation = 2 WHERE id = 'host'").run();
    const closed = new Promise<number>(resolve => ws.addEventListener("close", event => resolve(event.code), { once: true }));
    sendBridge(ws, message === "hello" ? clientHello("host") : stateReport("host", {
      observedAt: Date.now(), appliedDesiredVersion: 0,
    }));
    expect(await closed).toBe(1008);
    expect(await env.DB.prepare("SELECT host_id FROM host_actual_state WHERE host_id = 'host'").first()).toBeNull();
  });

  it("rejects an old attachment with no credential generation after hibernation", async () => {
    await seedHost("host");
    const { ws, stub, messages } = await connectHost("host");
    await waitForBridgeMessage(messages, frame => frame.type === "desired_state");
    await runInDurableObject(stub, async (_instance, state) => {
      for (const socket of state.getWebSockets("host:host")) {
        const attachment = socket.deserializeAttachment();
        delete attachment.credentialGeneration;
        socket.serializeAttachment(attachment);
      }
    });
    await evictDurableObject(stub);
    const closed = new Promise<number>(resolve => ws.addEventListener("close", event => resolve(event.code), { once: true }));
    sendBridge(ws, clientHello("host"));
    expect(await closed).toBe(1008);
  });

  it("rejects a report queued before a credential generation change", async () => {
    await seedHost("host");
    const { ws, stub, messages } = await connectHost("host");
    await waitForBridgeMessage(messages, frame => frame.type === "desired_state");
    const now = Date.now();
    await seedRun({ db: drizzle(env.DB), hostId: "host", runId: "run", now });
    await runInDurableObject(stub, async instance => {
      const runtime = instance as unknown as {
        withRunProjectionLock(id: string, operation: () => Promise<void>): Promise<void>;
        applyBridgeVmReport(hostId: string, report: VmReportV2, sessionId: string, generation: number): Promise<void>;
      };
      const row = await env.DB.prepare("SELECT active_session_id FROM agent_hosts WHERE id = 'host'").first<{ active_session_id: string }>();
      let release!: () => void;
      let locked!: () => void;
      const started = new Promise<void>(resolve => { locked = resolve; });
      const holding = runtime.withRunProjectionLock("run", () => new Promise<void>(resolve => {
        release = resolve;
        locked();
      }));
      await started;
      const message = vmReport("host", "run", "runtime-web", "ready", now + 1, 22001, "10.77.0.2");
      if (message.type !== "vm_report") throw new Error("expected a VM report");
      const waiting = runtime.applyBridgeVmReport("host", message.report, row!.active_session_id, 1);
      await env.DB.prepare("UPDATE agent_hosts SET credential_generation = 2 WHERE id = 'host'").run();
      release();
      await Promise.all([holding, waiting]);
    });
    const run = await env.DB.prepare("SELECT updated_at FROM scenario_runs WHERE run_id = 'run'").first<{ updated_at: number }>();
    expect(run?.updated_at).toBe(now);
    ws.close();
  });

  it("does not commit an admitted report after access revocation, before cleanup", async () => {
    await seedHost("host-revocation-race");
    const { ws, stub, messages } = await connectHost("host-revocation-race");
    await waitForBridgeMessage(messages, frame => frame.type === "desired_state");
    const now = Date.now();
    await seedRun({ db: drizzle(env.DB), hostId: "host-revocation-race", runId: "run", now });
    const before = await env.DB.prepare(
      "SELECT state, state_json, updated_at FROM scenario_runs WHERE run_id = 'run'",
    ).first();

    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as {
        isCurrentHostSessionAdmission(...args: unknown[]): Promise<boolean>;
        webSocketMessage(ws: WebSocket, message: string): Promise<void>;
      };
      let admitted!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>(resolve => { admitted = resolve; });
      const release = new Promise<void>(resolve => { resume = resolve; });
      const check = runtime.isCurrentHostSessionAdmission.bind(runtime);
      const admission = vi.spyOn(runtime, "isCurrentHostSessionAdmission")
        .mockImplementationOnce(async (...args) => {
          const current = await check(...args);
          expect(current).toBe(true);
          admitted();
          await release;
          return current;
        });
      const pending = runtime.webSocketMessage(
        state.getWebSockets("host:host-revocation-race")[0]!,
        JSON.stringify(vmReport("host-revocation-race", "run", "runtime-web", "ready", now + 1, 22001, "10.77.0.2")),
      );
      try {
        await reached;
        // Do not run deferred cleanup: the revocation transaction alone must fence this report.
        await revokeAccount({
          d1: env.DB, userId: "user-1", actorUserId: FIXTURE_ADMIN_ID,
          reason: "paused-report-regression",
        });
        expect(await env.DB.prepare(
          "SELECT disabled, credential_generation, active_session_id FROM agent_hosts WHERE id = 'host-revocation-race'",
        ).first()).toEqual({ disabled: 1, credential_generation: 2, active_session_id: null });
      } finally {
        admission.mockRestore();
        resume();
        await pending;
      }
    });
    expect(await env.DB.prepare(
      "SELECT state, state_json, updated_at FROM scenario_runs WHERE run_id = 'run'",
    ).first()).toEqual(before);
    ws.close();
  });

  it.each([false, true])("checks credentials again after terminal key loading (rotation: %s)", async rotate => {
    await seedHost("host");
    await env.DB.prepare("UPDATE agent_hosts SET active_session_id = 'host-session' WHERE id = 'host'").run();
    const db = drizzle(env.DB);
    const now = Date.now();
    await seedRun({ db, hostId: "host", runId: "run", now, seedRuntimeVms: false });
    await db.insert(runtimeVms).values({
      id: "vm", executionId: "run", vmId: "vm-1", ordinal: 0,
      runtimeVmName: "runtime-web", imageKeyJson: { scenario: "broken-nginx", vm: "webserver", arch: "x86_64" },
      imageSha256: "2".repeat(64), cpuMillis: 1000, memoryMib: 512, diskMib: 4096,
    });
    const encrypted = await encryptRuntimeVmAccessKey({
      executionId: "run", vmId: "vm-1", runtimeVmName: "runtime-web",
      publicKeyOpenssh: "test-public-key", privateKeyOpenssh: "test-private-key",
    });
    await db.insert(runtimeVmAccessKeys).values({
      runtimeVmId: "vm", executionId: "run", publicKeyOpenssh: "test-public-key",
      privateKeyCiphertextB64: encrypted.ciphertextB64, privateKeyIvB64: encrypted.ivB64,
    });
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
      if (rotate) await env.DB.prepare("UPDATE agent_hosts SET credential_generation = 2 WHERE id = 'host'").run();
      return decrypt(...args);
    });
    try {
      const message = vmReport("host", "run", "runtime-web", "ready", now, 22001, "10.77.0.2");
      if (message.type !== "vm_report") throw new Error("expected a VM report");
      const recording = recordRuntimeVmActualState({
        executionId: "run", expectedGeneration: 1, vmId: "vm-1", hostId: "host",
        expectedHostSessionId: "host-session", expectedHostCredentialGeneration: 1,
        report: { ...message.report, updated_at_unix_ms: now },
      });
      if (rotate) await expect(recording).rejects.toMatchObject({ code: "runtime_generation_stale" });
      else await expect(recording).resolves.toBe("updated");
      expect(spy).toHaveBeenCalledOnce();
      expect(await env.DB.prepare("SELECT terminal_host FROM runtime_vms WHERE id = 'vm'").first())
        .toEqual({ terminal_host: rotate ? null : "203.0.113.9" });
    } finally {
      spy.mockRestore();
    }
  });
});
