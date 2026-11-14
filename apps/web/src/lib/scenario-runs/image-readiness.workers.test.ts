/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { user } from "@/db/schema";
import { listCourseCatalogForUser } from "@/lib/course-catalogs";
import { loadPlayScenario } from "@/lib/play-scenarios";
import { beginScenarioRun } from "@/lib/scenario-runs/begin";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import {
  HOST, KINO, LEARNER, OTHER_HOST, connect, desiredDoc, disconnect, enrollHost, machineImage, revisionDoc, seedScenario,
  sendState, specBlob, store, until,
} from "./revision-test-fixtures";

/** Waits until `hostId`'s stored report lists `count` cached images. */
const reported = (hostId: string, count: number) => until(
  () => env.DB.prepare("SELECT json_array_length(report_json, '$.cached_images') AS count FROM host_actual_state WHERE host_id = ?1")
    .bind(hostId).first<number>("count"),
  (current) => current === count,
);

const written = async () => ({
  runs: await env.DB.prepare("SELECT count(*) AS count FROM scenario_runs").first<number>("count"),
  executions: await env.DB.prepare("SELECT count(*) AS count FROM runtime_executions").first<number>("count"),
  active: await env.DB.prepare("SELECT count(*) AS count FROM scenario_runs WHERE active_key IS NOT NULL").first<number>("count"),
});

describe("starts wait for their images on a host", () => {
  let images: Record<string, string>;
  const sockets: Array<[WebSocket, string]> = [];

  const begin = (key: string) => beginScenarioRun({ scenarioId: "intar/web", userId: LEARNER, idempotencyKey: key, organizationId: null });

  async function setup(placement: "platform" | "personal") {
    await resetD1Database();
    await drizzle(env.DB).insert(user).values({ id: LEARNER, name: LEARNER, email: `${LEARNER}@example.test`, metalPlacement: placement });
    await ensureFixtureMember({ d1: env.DB, userId: LEARNER });
    expect(await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "run-test" },
      [["application/octet-stream", "kino binary"]])).toBe(KINO);
    images = { web: await machineImage("web"), client: await machineImage("client") };
    await seedScenario("intar/web", null, revisionDoc(images, { web: await specBlob("web"), client: await specBlob("client") }));
  }

  async function host(hostId: string, scope: "platform" | "personal", ready: readonly string[]) {
    await enrollHost(hostId, LEARNER, scope);
    const ws = await connect(hostId);
    sockets.push([ws, hostId]);
    sendState(ws, hostId, [], ready);
    await reported(hostId, ready.length);
    return ws;
  }

  afterEach(async () => {
    for (const [socket, hostId] of sockets.splice(0)) await disconnect(socket, hostId);
  });

  describe("on platform hosts", () => {
    beforeEach(() => setup("platform"));

    it("refuses the start while no host reports the images ready, and writes nothing", async () => {
      await host(HOST, "platform", []);
      await expect(begin("start-key-1")).rejects.toMatchObject({ status: 409, code: "scenario_image_preparing" });
      expect(await written()).toEqual({ runs: 0, executions: 0, active: 0 });
      expect((await desiredDoc(HOST))!.vms).toEqual([]);
    });

    it("places the run on the host that has the images, not on the one placement would try first", async () => {
      await host(OTHER_HOST, "platform", Object.values(images));
      await host(HOST, "platform", [images.web!]);
      // Placement tries the most recently updated host first.
      await env.DB.prepare("UPDATE agent_hosts SET updated_at = ?2 WHERE id = ?1").bind(HOST, Date.now() + 60_000).run();
      const { hostId } = await begin("start-key-1");
      expect(hostId).toBe(OTHER_HOST);
      expect((await desiredDoc(HOST))!.vms).toEqual([]);
    });

    it("does not count a ready report that is stale or from a disconnected host", async () => {
      await host(HOST, "platform", []);
      await host(OTHER_HOST, "platform", Object.values(images));
      await env.DB.prepare("UPDATE host_actual_state SET updated_at = ?2 WHERE host_id = ?1")
        .bind(OTHER_HOST, Date.now() - 5 * 60_000).run();
      await expect(begin("start-key-1")).rejects.toMatchObject({ code: "scenario_image_preparing" });
      await env.DB.prepare("UPDATE host_actual_state SET updated_at = ?2 WHERE host_id = ?1").bind(OTHER_HOST, Date.now()).run();
      await env.DB.prepare("UPDATE agent_hosts SET connected = 0 WHERE id = ?1").bind(OTHER_HOST).run();
      await expect(begin("start-key-2")).rejects.toMatchObject({ code: "scenario_image_preparing" });
      expect(await written()).toEqual({ runs: 0, executions: 0, active: 0 });
    });

    it("answers the lecture and play pages from the same readiness", async () => {
      const ws = await host(HOST, "platform", []);
      const lecture = async () => (await listCourseCatalogForUser({ db: drizzle(env.DB), userId: LEARNER, organizationId: null }))
        .courses[0]!.lectures[0]!;
      const play = async () => (await loadPlayScenario(env.DB, "intar", "web", LEARNER)) as { ready: boolean } | null;
      await env.DB.prepare("UPDATE scenarios SET play = 1 WHERE id = 'intar/web'").run();
      expect(await lecture()).toMatchObject({ state: "waiting_for_scenario", scenarioReady: false });
      expect((await play())?.ready).toBe(false);
      sendState(ws, HOST, [], Object.values(images));
      await reported(HOST, 2);
      expect(await lecture()).toMatchObject({ state: "available", scenarioReady: true });
      expect((await play())?.ready).toBe(true);
    });
  });

  describe("on the learner's own server", () => {
    beforeEach(() => setup("personal"));

    it("asks the server for the images on the first start and admits a later one once they are ready", async () => {
      const ws = await host(HOST, "personal", []);
      await expect(begin("start-key-1")).rejects.toMatchObject({ status: 409, code: "scenario_image_preparing" });
      expect(await written()).toEqual({ runs: 0, executions: 0, active: 0 });
      const doc = (await desiredDoc(HOST))!;
      expect(doc.vms).toEqual([]);
      expect(doc.cached_images).toEqual(Object.values(images).sort());

      sendState(ws, HOST, [], Object.values(images));
      await reported(HOST, 2);
      const { hostId } = await begin("start-key-2");
      expect(hostId).toBe(HOST);
    });

    it("prepares the server that has room when the ready one is full, and starts there once it is ready", async () => {
      await host(HOST, "personal", Object.values(images));
      const other = await host(OTHER_HOST, "personal", []);
      // The ready server is full, and placement tries it first.
      await env.DB.prepare(`UPDATE host_actual_state SET report_json = json_set(report_json,
          '$.capacity.schedulable_cpu_millis', 0, '$.capacity.memory_available_mib', 0) WHERE host_id = ?1`).bind(HOST).run();
      await env.DB.prepare("UPDATE agent_hosts SET updated_at = ?2 WHERE id = ?1").bind(HOST, Date.now() + 60_000).run();

      await expect(begin("start-key-1")).rejects.toMatchObject({ code: "scenario_image_preparing" });
      const prep = await env.DB.prepare("SELECT host_id FROM personal_image_preparations WHERE user_id = ?1")
        .bind(LEARNER).first<string>("host_id");
      expect(prep).toBe(OTHER_HOST);
      expect((await desiredDoc(OTHER_HOST))!.cached_images).toEqual(Object.values(images).sort());

      sendState(other, OTHER_HOST, [], Object.values(images));
      await reported(OTHER_HOST, 2);
      const { hostId } = await begin("start-key-2");
      expect(hostId).toBe(OTHER_HOST);
    });
  });
});
