/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleAgentRunCliRequest } from "@/control-plane/run-cli";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { member, organization, user } from "@/db/schema";
import validateBridgeMessageV9 from "@/generated/contracts/bridge-message-v9.validate";
import { RUN_CLI_PROTOCOL_VERSION } from "@/generated/run-cli";
import { mutateHostDesiredStateV3 } from "@/lib/desired-state-store";
import { revisionVmId } from "@/lib/run-lifecycle";
import { LAB_FAILED_TEXT } from "@/lib/run-tasks";
import { beginScenarioRun } from "@/lib/scenario-runs/begin";
import { expireOverdueRunLeases } from "@/lib/scenario-runs/lifecycle";
import { liveScenarioRevision } from "@/lib/scenario-runs/revision-begin";
import { getScenarioRunStatusForUser } from "@/lib/scenario-runs/status";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import {
  HARDWARE, HINT_BODY, HOST, KINO, LEARNER, OTHER_HOST, ORIGIN, SOLUTION, STRANGER, TASK_BODY, connect, desiredDoc, enrollHost,
  labState, machineImage, registryToken, revisionDoc, runRow, seedScenario, sendVm, specBlob,
  store, until, v2, vmState,
} from "./revision-test-fixtures";

describe("runs of a live scenario revision", () => {
  let images: Record<string, string>;
  let specs: Record<string, string>;
  let agentToken: string;
  let ws: WebSocket;

  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    for (const id of [LEARNER, STRANGER]) {
      await db.insert(user).values({ id, name: id, email: `${id}@example.test`, metalPlacement: "personal" });
      await ensureFixtureMember({ d1: env.DB, userId: id });
    }
    for (const id of ["org-a", "org-b"]) {
      await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
    }
    await db.insert(member).values([
      { id: "m-a", organizationId: "org-a", userId: LEARNER, role: "member", createdAt: new Date() },
      { id: "m-b", organizationId: "org-b", userId: STRANGER, role: "member", createdAt: new Date() },
    ]);
    expect(await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "run-test" },
      [["application/octet-stream", "kino binary"]])).toBe(KINO);
    images = { web: await machineImage("web"), client: await machineImage("client") };
    specs = { web: await specBlob("web"), client: await specBlob("client") };
    await seedScenario("intar/web", null, revisionDoc(images, specs));
    agentToken = await enrollHost(HOST, LEARNER);
    ws = await connect(HOST);
  });
  afterEach(() => ws.close());

  const begin = (key = "start-key-1", scenarioId = "intar/web", userId = LEARNER, organizationId: string | null = null) =>
    beginScenarioRun({ scenarioId, userId, idempotencyKey: key, organizationId });

  it("writes the run's snapshot and bridge 9 desired VMs", async () => {
    const { runId, hostId } = await begin();
    expect(hostId).toBe(HOST);
    const doc = (await desiredDoc(HOST))!;
    expect(validateBridgeMessageV9({ type: "desired_state", protocol_version: 9, host_id: HOST, desired_state: doc })).toBe(true);
    expect(doc.kino_pin).toBe(KINO);
    expect(doc.cached_images).toEqual(Object.values(images).sort());
    expect(doc.vms).toHaveLength(2);
    for (const vm of doc.vms) {
      expect(vm).toMatchObject({
        vm_id: revisionVmId(vm.name, runId), run_id: runId, runtime_execution_id: runId, owner_user_id: LEARNER,
        generation: 1, desired_phase: "running", image: images[vm.name], kino: KINO, spec: specs[vm.name], mode: "learn",
        cpu_millis: 1000, memory_mib: 512, disk_mib: 4096, terminal: true, egress: false,
        peers: [vm.name === "web" ? "client" : "web"],
      });
      expect(vm.ssh_authorized_keys).toHaveLength(1);
      expect(vm.ssh_authorized_keys[0]).toMatch(/^ssh-ed25519 /);
    }
    const row = await runRow(runId);
    expect(row.scenario_rev).toBe("r1");
    expect(JSON.parse(row.tasks_json).map((task: { id: string }) => task.id)).toEqual(["serve", "fetch"]);
    const prep = await env.DB.prepare("SELECT images_json FROM personal_image_preparations WHERE user_id = ?1")
      .bind(LEARNER).first<{ images_json: string }>();
    expect(JSON.parse(prep!.images_json)).toEqual(Object.values(images).sort());
  });

  it("finds no eligible host without a Kino pin", async () => {
    await env.DB.prepare("DELETE FROM registry_manifests WHERE digest = ?1").bind(KINO).run();
    await expect(begin()).rejects.toMatchObject({ code: "scenario_host_unavailable" });
  });

  it("keeps running VMs when the Kino pin goes away", async () => {
    const { runId } = await begin();
    await env.DB.prepare("DELETE FROM registry_manifests WHERE digest = ?1").bind(KINO).run();
    ws.close();
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(HOST));
    const response = await stub.fetch("http://host-runtime/connect", {
      headers: { upgrade: "websocket", "x-agent-host-id": HOST, "x-agent-credential-generation": "1", "intar-bridge-protocol": "9" },
    });
    ws = response.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: "client_hello", protocol_version: 9, host_id: HOST, agent_version: "1.0.0", role: "agent",
      guest_contract: 3, hardware: HARDWARE }));
    const doc = await until(() => desiredDoc(HOST), (current) => current?.kino_pin === undefined);
    expect(doc?.kino_pin).toBeUndefined();
    expect(doc?.vms.map((vm) => [vm.run_id, vm.desired_phase, vm.kino])).toEqual([[runId, "running", KINO], [runId, "running", KINO]]);
  });

  it("keeps another organization's scenario invisible and unstartable", async () => {
    await seedScenario("org-a/secret", "org-a", revisionDoc(images, specs));
    expect(await liveScenarioRevision(env.DB, "org-a/secret", "org-b")).toBeNull();
    expect(await liveScenarioRevision(env.DB, "org-a/secret", null)).toBeNull();
    expect(await liveScenarioRevision(env.DB, "org-a/secret", "org-a")).not.toBeNull();
    await expect(begin("start-key-2", "org-a/secret", STRANGER, "org-b")).rejects.toMatchObject({ status: 404 });
    await expect(begin("start-key-3", "org-a/secret", STRANGER, null)).rejects.toMatchObject({ status: 404 });
  });

  it("moves a run only from its own host and makes it ready on the lab's readiness", async () => {
    const { runId } = await begin();
    await enrollHost(OTHER_HOST, STRANGER);
    const other = await connect(OTHER_HOST);
    sendVm(other, OTHER_HOST, { ...vmState(runId, "web", labState("failed", [], "boom")), owner_user_id: STRANGER });
    sendVm(ws, HOST, vmState(runId, "web", labState("preparing")));
    const booting = await until(() => runRow(runId), (row) => JSON.parse(row.state_json).vms[0].lab?.state === "preparing");
    expect(JSON.parse(booting.state_json).vms.map((vm: { phase: string }) => vm.phase)).not.toContain("failed");
    expect(JSON.parse(booting.state_json).vms[0].phase).not.toBe("ready");
    sendVm(ws, HOST, vmState(runId, "web", labState("ready", [{ id: "serve", status: "pass", message: "ok" }])));
    sendVm(ws, HOST, vmState(runId, "client", labState("ready")));
    const ready = await until(() => runRow(runId), (row) => row.state === "active_full");
    expect(ready.state).toBe("active_full");
    sendVm(ws, HOST, vmState(runId, "client", labState("ready", [{ id: "fetch", status: "pass", message: "ok" }])));
    expect((await until(() => runRow(runId), (row) => row.state === "solved")).state).toBe("solved");
    other.close();
  });

  it("ends a failed lab with lab_failed, the fixed text, and no admin detail for the learner", async () => {
    const { runId } = await begin();
    sendVm(ws, HOST, vmState(runId, "web", labState("failed", [], "setup.sh: exit 3 at /opt/secret")));
    const row = await until(() => runRow(runId), (current) => current.state === "failed");
    expect(row).toMatchObject({ state: "failed", end_reason: "lab_failed" });
    expect(JSON.parse(row.state_json).vms[0].lab.failure).toContain("setup.sh");
    const status = await getScenarioRunStatusForUser({ runId, userId: LEARNER });
    expect(status.phaseDetail).toBe(LAB_FAILED_TEXT);
    const text = JSON.stringify(status);
    for (const secret of ["setup.sh", SOLUTION, HINT_BODY, "PRIVATE KEY", "verify_spec", "needs"]) {
      expect(text).not.toContain(secret);
    }
    expect(status.tasks?.map((task) => [task.id, task.body])).toEqual([["serve", TASK_BODY], ["fetch", null]]);
  });

  it("takes back a run whose owner was banned inside the commit", async () => {
    await env.DB.prepare(`CREATE TRIGGER ban_on_commit AFTER UPDATE ON host_desired_state
      WHEN NEW.doc_json LIKE '%"desired_phase":"running"%' AND OLD.doc_json NOT LIKE '%"desired_phase":"running"%'
      BEGIN UPDATE user SET banned = 1 WHERE id = '${LEARNER}'; END`).run();
    await expect(begin()).rejects.toMatchObject({ code: "access_revoked" });
    const run = await env.DB.prepare("SELECT state, delete_requested_at FROM scenario_runs").first<{ state: string; delete_requested_at: number }>();
    expect(run).toMatchObject({ state: "teardown_requested", delete_requested_at: expect.any(Number) });
    expect((await desiredDoc(HOST))!.vms.map((vm) => vm.desired_phase)).toEqual(["absent", "absent"]);
  });

  it("leaves the run in teardown when taking back its VMs fails", async () => {
    await env.DB.prepare(`CREATE TRIGGER ban_on_commit AFTER UPDATE ON host_desired_state
      WHEN NEW.doc_json LIKE '%"desired_phase":"running"%' AND OLD.doc_json NOT LIKE '%"desired_phase":"running"%'
      BEGIN UPDATE user SET banned = 1 WHERE id = '${LEARNER}'; END`).run();
    await env.DB.prepare(`CREATE TRIGGER crash_on_absent BEFORE UPDATE ON host_desired_state
      WHEN NEW.doc_json LIKE '%"desired_phase":"absent"%' BEGIN SELECT RAISE(ABORT, 'crash'); END`).run();
    await expect(begin()).rejects.toThrow(/Failed query: update "host_desired_state"/);
    expect(await env.DB.prepare("SELECT state FROM scenario_runs").first("state")).toBe("teardown_requested");
  });

  it("tears an expired lease out of the desired state", async () => {
    const { runId } = await begin();
    await mutateHostDesiredStateV3(drizzle(env.DB), HOST, Date.now(), (draft) => {
      for (const vm of draft.vms) vm.lease_expires_at_unix_ms = Date.now() - 1;
    });
    const { expiredRunIds } = await expireOverdueRunLeases(HOST, Date.now(), { wakeHostRuntime: false });
    expect(expiredRunIds).toEqual([runId]);
    expect((await desiredDoc(HOST))!.vms.every((vm) => vm.desired_phase === "absent")).toBe(true);
  });

  it("grants the run's image and spec to its host only while the run runs", async () => {
    const { runId } = await begin();
    await env.DB.prepare("DELETE FROM personal_image_preparations").run();
    const own = await registryToken(HOST, LEARNER);
    await enrollHost(OTHER_HOST, STRANGER);
    const other = await registryToken(OTHER_HOST, STRANGER);
    const manifest = (image: string) => `/v2/machines/${image.slice(7)}/manifests/machine`;
    expect(await v2(manifest(images.web!), own)).toBe(200);
    expect(await v2(`/v2/specs/blobs/${specs.web}`, own)).toBe(200);
    expect(await v2(manifest(images.web!), other)).toBe(404);
    expect(await v2(`/v2/specs/blobs/${specs.web}`, other)).toBe(404);
    await mutateHostDesiredStateV3(drizzle(env.DB), HOST, Date.now(), (draft) => {
      for (const vm of draft.vms) vm.lease_expires_at_unix_ms = Date.now() - 1;
    });
    expect((await expireOverdueRunLeases(HOST, Date.now(), { wakeHostRuntime: false })).expiredRunIds).toEqual([runId]);
    expect(await v2(manifest(images.web!), own)).toBe(404);
    expect(await v2(`/v2/specs/blobs/${specs.web}`, own)).toBe(404);
  });

  it("grants a preparation's digests to the preparing host before the run exists", async () => {
    // Too big for the host: the start prepares the images, then finds no room.
    await env.DB.prepare(`UPDATE scenario_revisions SET doc_json = json_set(doc_json,
      '$.machines[0].cpu_millis', 6000, '$.machines[1].cpu_millis', 6000)`).run();
    await expect(begin()).rejects.toMatchObject({ code: "scenario_host_capacity_contended" });
    const own = await registryToken(HOST, LEARNER);
    const manifest = `/v2/machines/${images.client!.slice(7)}/manifests/machine`;
    expect((await desiredDoc(HOST))!.cached_images).toEqual(Object.values(images).sort());
    expect(await v2(manifest, own)).toBe(200);
    expect(await v2(`/v2/specs/blobs/${specs.client}`, own)).toBe(404);
    await env.DB.prepare("DELETE FROM personal_image_preparations").run();
    expect(await v2(manifest, own)).toBe(404);
  });

  it("serves the run CLI view, hints and solution by task, and refuses checks", async () => {
    const { runId } = await begin();
    sendVm(ws, HOST, vmState(runId, "web", labState("ready")));
    await until(() => env.DB.prepare("SELECT state FROM runtime_executions WHERE id = ?1").bind(runId).first("state"),
      (state) => state === "ready");
    const cli = async (action: Record<string, unknown>) => {
      const response = await handleAgentRunCliRequest(new Request(`${ORIGIN}/agent/runs/${runId}/vms/${revisionVmId("web", runId)}/cli`, {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json", "x-intar-jail-generation": "jail-web" },
        body: JSON.stringify({ protocol_version: RUN_CLI_PROTOCOL_VERSION, request_id: "r", action }),
      }), env);
      return (await response!.json()) as { result: Record<string, unknown> };
    };
    const view = (await cli({ kind: "status" })).result as { kind: string; view: {
      checks: Array<{ probe_id: string; label: string }>; hint_groups: Array<{ alias: string; label: string; total_count: number }>;
      solution: Record<string, unknown> } };
    expect(view.kind).toBe("ok");
    expect(view.view.checks.map((check) => check.label)).toEqual(["Serve"]);
    expect(JSON.stringify(view)).not.toContain(SOLUTION);
    expect(JSON.stringify(view)).not.toContain(HINT_BODY);
    const hints = (await cli({ kind: "hints" })).result as typeof view;
    expect(hints.view.hint_groups.map((group) => [group.label, group.total_count])).toEqual([["General guidance", 1], ["Check 1", 1]]);
    const alias = hints.view.hint_groups[1]!.alias;
    const revealed = await cli({ kind: "hint_reveal", alias, expected_ordinal: 1 });
    expect(JSON.stringify(revealed)).toContain(HINT_BODY);
    expect((await cli({ kind: "solution_reveal" })).result).toMatchObject({ kind: "ok" });
    expect(JSON.stringify(await cli({ kind: "solution" }))).toContain(SOLUTION);
    expect((await cli({ kind: "check_sync" })).result).toMatchObject({
      kind: "error", error: { code: "unavailable", message: "Checks are not supported for this run." },
    });
  });
});
