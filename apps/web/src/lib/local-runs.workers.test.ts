/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { user } from "@/db/schema";
import { LOCAL_RUN_SILENCE_MS, endLocalRun, localHostId, reapSilentLocalRuns } from "@/lib/local-runs";
import { beginScenarioRun } from "@/lib/scenario-runs/begin";
import { destroyScenarioRunForUser } from "@/lib/scenario-runs/lifecycle";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import {
  KINO, LEARNER, STRANGER, machineImage, revisionDoc, seedScenario, specBlob, store,
} from "./scenario-runs/revision-test-fixtures";

describe("local runs", () => {
  let images: Record<string, string>;
  let specs: Record<string, string>;

  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    for (const id of [LEARNER, STRANGER]) {
      await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
      await ensureFixtureMember({ d1: env.DB, userId: id });
    }
    expect(await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "run-test" },
      [["application/octet-stream", "kino binary"]])).toBe(KINO);
    images = { web: await machineImage("web"), client: await machineImage("client") };
    specs = { web: await specBlob("web"), client: await specBlob("client") };
    await seedScenario("intar/web", null, revisionDoc(images, specs));
  });

  const begin = (key = "local-key-1", userId = LEARNER) =>
    beginScenarioRun({ scenarioId: "intar/web", userId, idempotencyKey: key, runtime: "local" });
  const runRow = (runId: string) => env.DB.prepare(
    "SELECT runtime, host_id, state, active_key, scenario_rev, solved_at FROM scenario_runs WHERE run_id = ?1").bind(runId).first();
  const count = async (sql: string, ...params: unknown[]) =>
    (await env.DB.prepare(sql).bind(...params).first<{ n: number }>())!.n;

  it("starts with no host scheduled, on the learner's placeholder", async () => {
    // No host is enrolled at all: a platform start would find none.
    const { runId, hostId, reused } = await begin();
    expect(reused).toBe(false);
    expect(hostId).toBe(localHostId(LEARNER));

    const row = await runRow(runId);
    expect(row).toMatchObject({ runtime: "local", host_id: "local:learner", state: "provisioning", active_key: LEARNER, scenario_rev: "r1" });

    // The placeholder can never act as a host.
    expect(await env.DB.prepare("SELECT user_id, scope, disabled, scenario_enabled, connected, credential_generation FROM agent_hosts WHERE id = ?1")
      .bind(hostId).first()).toEqual({ user_id: LEARNER, scope: null, disabled: 1, scenario_enabled: 0, connected: 0, credential_generation: 0 });

    // What the device will pull and boot is recorded per machine.
    const { results: vms } = await env.DB.prepare(
      "SELECT image_digest, spec_digest, kino_digest FROM runtime_vms WHERE execution_id = ?1 ORDER BY ordinal").bind(runId).all();
    expect(vms).toHaveLength(2);
    expect(vms.map((vm) => vm.image_digest).sort()).toEqual(Object.values(images).sort());
    expect(vms.map((vm) => vm.spec_digest).sort()).toEqual(Object.values(specs).sort());
    expect(vms.every((vm) => vm.kino_digest === KINO)).toBe(true);

    // Nothing is written for a host.
    expect(await count("SELECT count(*) AS n FROM host_desired_state WHERE host_id = ?1", hostId)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM host_cpu_reservations WHERE run_id = ?1", runId)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM host_resource_reservations WHERE host_id = ?1", hostId)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM active_runtime_slots WHERE user_id = ?1", LEARNER)).toBe(1);
  });

  it("replays the same request and refuses a second run", async () => {
    const first = await begin();
    const replay = await begin();
    expect(replay).toMatchObject({ runId: first.runId, reused: true });
    await expect(begin("local-key-2")).rejects.toMatchObject({ code: "scenario_run_active_conflict" });
    // The one slot is shared with platform runs: a platform start conflicts too.
    await expect(beginScenarioRun({ scenarioId: "intar/web", userId: LEARNER, idempotencyKey: "platform-key" }))
      .rejects.toMatchObject({ code: "scenario_run_active_conflict" });
    // A same-key request for a platform run is a different request.
    await expect(beginScenarioRun({ scenarioId: "intar/web", userId: LEARNER, idempotencyKey: "local-key-1" }))
      .rejects.toMatchObject({ code: "idempotency_key_conflict" });
    expect(await count("SELECT count(*) AS n FROM agent_hosts WHERE id LIKE 'local:%'")).toBe(1);
  });

  it("is ended by the server at once, and frees the slot", async () => {
    const { runId } = await begin();
    const ended = await destroyScenarioRunForUser({ runId, userId: LEARNER });
    expect(ended.activeSlotReleased).toBe(true);
    expect(await runRow(runId)).toMatchObject({ state: "completed", active_key: null, solved_at: null });
    expect(await count("SELECT count(*) AS n FROM active_runtime_slots WHERE user_id = ?1", LEARNER)).toBe(0);
    expect(await env.DB.prepare("SELECT state FROM runtime_executions WHERE id = ?1").bind(runId).first())
      .toEqual({ state: "archived" });
    // Ending again changes nothing, and the learner can start the next run.
    await destroyScenarioRunForUser({ runId, userId: LEARNER });
    expect((await begin("local-key-2")).reused).toBe(false);
  });

  it("is not ended by another learner", async () => {
    const { runId } = await begin();
    await expect(destroyScenarioRunForUser({ runId, userId: STRANGER })).rejects.toMatchObject({ code: "scenario_run_not_found" });
    expect(await endLocalRun({ d1: env.DB, runId, userId: STRANGER })).toBe(false);
    expect(await runRow(runId)).toMatchObject({ state: "provisioning", active_key: LEARNER });
  });

  it("closes a run that has been silent, and leaves a fresh one", async () => {
    const stale = await begin("local-key-1", LEARNER);
    const fresh = await begin("local-key-1", STRANGER);
    const now = Date.now();
    await env.DB.prepare("UPDATE scenario_runs SET updated_at = ?2 WHERE run_id = ?1")
      .bind(stale.runId, now - LOCAL_RUN_SILENCE_MS - 1).run();
    expect(await reapSilentLocalRuns(env.DB, now)).toBe(1);
    expect(await runRow(stale.runId)).toMatchObject({ state: "completed", active_key: null });
    expect(await runRow(fresh.runId)).toMatchObject({ state: "provisioning", active_key: STRANGER });
    expect(await reapSilentLocalRuns(env.DB, now)).toBe(0);
  });

  it("refuses a learner whose account is banned", async () => {
    await env.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?1").bind(LEARNER).run();
    await expect(begin()).rejects.toMatchObject({ code: "access_revoked" });
    expect(await count("SELECT count(*) AS n FROM scenario_runs")).toBe(0);
  });
});
