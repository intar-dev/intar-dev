/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  testImageDigest,
  seedHost,
  connectHost,
  sendBridge,
  waitForBridgeMessage,
  runDurableObjectAlarm,
  runNextScheduledAlarm,
  waitForMessageCount,
  waitForHostActualState,
  stateReport,
  env,
  eq,
  drizzle,
  mutateDesiredState,
  resetHostRuntimeTestDatabase,
  sleep,
  type BridgeMessageV9,
} from "./test-fixtures";
import {
  DESIRED_VERSION_LAG_REPUSH_AFTER_MS,
  RUNTIME_ALARM_KEY,
  type SocketAttachment,
} from "./base";
import { agentHosts } from "@/db/schema";

describe("HostRuntimeDO desired-state re-push", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("re-pushes a lagging desired version from the alarm loop after the dispatch threshold", async () => {
    const { messages, stub, ws } = await connectLaggingHost("host-lag-repush");
    // Run the alarm loop once, just past the threshold since the last dispatch.
    // Waiting in real time instead lets the Durable Object's own alarms fire,
    // so the number of re-pushes would depend on milliseconds between a
    // dispatch and the alarm armed around it.
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + DESIRED_VERSION_LAG_REPUSH_AFTER_MS + 1);
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect(await waitForMessageCount(messages, isLaggingVersion, 2, 2_000)).toBe(2);
    ws.close();
  });

  it("re-pushes at the threshold when a fallback alarm armed before the dispatch fires first", async () => {
    const hostId = "host-lag-early-alarm";
    const { messages, stub, ws } = await connectLaggingHost(hostId);
    const lastDispatch = await runInDurableObject(stub, (_instance, state) => {
      const [socket] = state.getWebSockets(`host:${hostId}`);
      return (socket?.deserializeAttachment() as SocketAttachment | null)
        ?.lastDesiredDispatchAtMs;
    });
    if (typeof lastDispatch !== "number") throw new Error("no desired-state dispatch recorded");

    // The wake, hello, and VM-report paths arm a fallback alarm from their own
    // clock reading, which can predate the dispatch it backs up.
    const early = lastDispatch + DESIRED_VERSION_LAG_REPUSH_AFTER_MS - 5;
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(RUNTIME_ALARM_KEY, early);
      await state.storage.setAlarm(early);
    });
    await runNextScheduledAlarm(stub);
    // Short of the threshold it does not re-push, and it re-arms for one tick
    // past the threshold rather than a whole threshold later.
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).toBe(lastDispatch + DESIRED_VERSION_LAG_REPUSH_AFTER_MS + 1);
    await runNextScheduledAlarm(stub);
    expect(await waitForMessageCount(messages, isLaggingVersion, 2, 2_000)).toBe(2);
    ws.close();
  });
});

let laggingVersion = 0;

function isLaggingVersion(message: BridgeMessageV9): boolean {
  return message.type === "desired_state" && message.desired_state.version === laggingVersion;
}

/**
 * Connect a platform host, deliver a new desired version, and have the host report
 * version 0 applied, so the host runtime sees it lagging.
 */
async function connectLaggingHost(hostId: string) {
  await seedHost(hostId);
  const db = drizzle(env.DB);
  // Platform hosts retain manually staged cache entries during reconciliation.
  await db.update(agentHosts).set({ scope: "platform" }).where(eq(agentHosts.id, hostId));
  const connection = await connectHost(hostId);
  const { messages, ws } = connection;
  await waitForBridgeMessage(messages, (message) => message.type === "server_hello");

  await mutateDesiredState(db, hostId, Date.now(), (draft) => {
    draft.cached_images = [testImageDigest];
  });
  sendBridge(ws, {
    type: "sync_request",
    protocol_version: 9,
    host_id: hostId,
    reason: "operator_requested",
  });
  // The reconcile that follows the change may publish a newer version still.
  await waitForBridgeMessage(
    messages,
    (message) => message.type === "desired_state" && message.desired_state.version > 0,
  );
  await sleep(50);
  laggingVersion = Math.max(...messages.flatMap((message) =>
    message.type === "desired_state" ? [message.desired_state.version] : []));

  sendBridge(ws, stateReport(hostId, { observedAt: Date.now(), appliedDesiredVersion: 0 }));
  await waitForHostActualState(db, hostId, (row) => row.appliedDesiredVersion === 0);
  return connection;
}
