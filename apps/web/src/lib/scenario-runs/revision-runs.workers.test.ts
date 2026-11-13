/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, mintRegistryToken, sha256Hex } from "@/control-plane/auth";
import { handleAgentRunCliRequest } from "@/control-plane/run-cli";
import { handleOciRequest } from "@/control-plane/image-registry/oci";
import { blob, machineConfig, manifestOf, type PushedBlob } from "@/control-plane/image-registry/oci-test-fixtures";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { sleep } from "@/control-plane/host-runtime-do/test-fixtures";
import {
  agentBootstrapTokens, agentHosts, courseCatalogs, member, organization, scenarioRevisions, scenarios, user,
} from "@/db/schema";
import type { HostDesiredStateV3, VmLabV1, VmStateV3 } from "@/generated/contracts/bridge-message-v9";
import validateBridgeMessageV9 from "@/generated/contracts/bridge-message-v9.validate";
import type { ScenarioRevisionV1 } from "@/generated/contracts/scenario-revision-v1";
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

const ORIGIN = "https://intar.test";
// The pin vitest.workers.config.ts binds as KINO_PINS_JSON for contract 3.
const KINO = "sha256:ba84da6c273cceb718a63a6374ceeebc4ad862fd4098e570ed71937fe01b4639";
const LEARNER = "learner";
const STRANGER = "stranger";
const HOST = "host-1";
const OTHER_HOST = "host-2";
const SOLUTION = "SOLUTION-TEXT run nginx -t";
const HINT_BODY = "HINT-BODY check the port";
const HARDWARE = {
  cloud_hypervisor_sha256: "4".repeat(64), kvm: true, vsock: true, reflink: true, landlock: true, cgroup_v2: true,
  hard_cpu_quota: true,
};

/** Puts an artifact into R2 and the index, as the push routes leave it. */
async function store(artifactType: string, configMediaType: string, config: unknown, layers: Array<[string, string]>) {
  const configBlob = await blob(JSON.stringify(config));
  const layerBlobs = await Promise.all(layers.map(async ([type, content]) => [type, await blob(content)] as [string, PushedBlob]));
  const manifest = await blob(JSON.stringify(manifestOf(artifactType, configBlob, configMediaType, layerBlobs)));
  const blobs = [configBlob, ...layerBlobs.map(([, layer]) => layer)];
  for (const entry of [...blobs, manifest]) await env.VM_IMAGE_REGISTRY_BUCKET.put(`oci/sha256/${entry.hex}`, entry.bytes);
  await env.DB.prepare("INSERT INTO registry_manifests (digest, media_type, artifact_type, size) VALUES (?1, ?2, ?3, ?4)")
    .bind(manifest.digest, "application/vnd.oci.image.manifest.v1+json", artifactType, manifest.bytes.length).run();
  for (const entry of blobs) {
    await env.DB.prepare("INSERT OR IGNORE INTO registry_manifest_blobs (manifest_digest, blob_digest) VALUES (?1, ?2)")
      .bind(manifest.digest, entry.digest).run();
  }
  return manifest.digest;
}

const machineImage = (label: string) => store("application/vnd.intar.machine.v1", "application/vnd.intar.machine.config.v1+json",
  machineConfig(`sha256:${"b".repeat(64)}`, { boot: { cmdline: label } }),
  [["application/vnd.intar.kernel.v1", `kernel ${label}`], ["application/vnd.intar.disk.chunk.v1+zstd", `chunk ${label}`]]);

async function specBlob(label: string): Promise<string> {
  const pushed = await blob(JSON.stringify({ spec: label }));
  await env.VM_IMAGE_REGISTRY_BUCKET.put(`oci/sha256/${pushed.hex}`, pushed.bytes);
  return pushed.digest;
}

function revisionDoc(images: Record<string, string>, specs: Record<string, string>): ScenarioRevisionV1 {
  const machine = (name: string) => ({
    name, build_key: `sha256:${"b".repeat(64)}`, image_digest: images[name] ?? null, spec: specs[name]!,
    verify_spec: `sha256:${"9".repeat(64)}`, cpu_millis: 1000, memory_mib: 512, disk_mib: 4096, terminal: true, egress: false,
  });
  return {
    title: "Web", summary: "Fix the web server", briefing: "Fix it.", difficulty: "easy", minutes: 10, play: false,
    tags: [], solution: SOLUTION, hints: [{ id: "start", title: "Start", body: "Look around." }],
    machines: [machine("web"), machine("client")],
    tasks: [
      { id: "serve", title: "Serve", machine: "web", needs: [], optional: false, ordinal: 0,
        hints: [{ id: "port", title: "Port", body: HINT_BODY }] },
      { id: "fetch", title: "Fetch", machine: "client", needs: ["serve"], optional: false, ordinal: 1, hints: [] },
    ],
  };
}

async function seedScenario(id: string, organizationId: string | null, doc: ScenarioRevisionV1) {
  const db = drizzle(env.DB);
  const [namespace, slug] = id.split("/") as [string, string];
  await db.insert(scenarios).values({ id, namespace, slug, organizationId, scopeKey: organizationId ? `organization:${organizationId}` : "public",
    enabled: true, play: false, liveRev: "r1" });
  await db.insert(scenarioRevisions).values({ scenarioId: id, rev: "r1", guestContract: 3, docJson: doc, state: "ready" });
  await db.insert(courseCatalogs).values({
    scopeKey: organizationId ? `organization:${organizationId}` : "public", organizationId, sourceRevision: "test",
    catalogJson: { version: 2, courses: [{ courseId: "course", title: "Course", summary: "", bodyMarkdown: "", sequential: false,
      lectures: [{ lectureId: slug, scenarioId: id, title: "Lecture", summary: "", bodyMarkdown: "", category: "test",
        tags: [], estimatedMinutes: 10 }] }] },
  });
}

/** Enrolls a personal host for `owner` and returns its agent token. */
async function enrollHost(hostId: string, owner: string): Promise<string> {
  const db = drizzle(env.DB);
  await db.insert(agentHosts).values({ id: hostId, userId: owner, name: hostId, scope: "personal", role: "agent",
    credentialGeneration: 1, scenarioEnabled: true, disabled: false, connected: false });
  const secret = (hostId.replace(/[^a-f0-9]/g, "a") + "0".repeat(64)).slice(0, 64);
  await db.insert(agentBootstrapTokens).values({ id: `${hostId}-c2`, hostId, tokenHash: await sha256Hex(secret),
    credentialGeneration: 1, expiresAt: null });
  const response = await handleAgentBootstrap(new Request(`${ORIGIN}/agent/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json", "intar-bridge-protocol": "9" },
    body: JSON.stringify({ hostId, bootstrapToken: secret }),
  }), env);
  expect(response.status).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(10);
  }
}

/** Connects a host over bridge 9 and sends a Ready state report. */
async function connect(hostId: string): Promise<WebSocket> {
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
  const response = await stub.fetch("http://host-runtime/connect", {
    headers: { upgrade: "websocket", "x-agent-host-id": hostId, "x-agent-credential-generation": "1", "intar-bridge-protocol": "9" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  ws.send(JSON.stringify({ type: "client_hello", protocol_version: 9, host_id: hostId, agent_version: "1.0.0", role: "agent",
    guest_contract: 3, hardware: HARDWARE }));
  await until(() => desiredDoc(hostId), (doc) => doc?.kino_pin === KINO);
  ws.send(JSON.stringify({ type: "state_report", protocol_version: 9, host_id: hostId, report: {
    schema_version: 8, host_id: hostId, observed_at_unix_ms: Date.now(), applied_desired_version: 0, relay_connected: true,
    guest_contract: 3, hardware: HARDWARE, cached_images: [], vms: [],
    capacity: { total_cpu_millis: 8000, reserved_cpu_millis: 0, schedulable_cpu_millis: 8000, committed_cpu_millis: 0,
      memory_total_mib: 16384, memory_available_mib: 16384, disk_probe_path: "/var/lib", disk_total_mib: 100_000,
      disk_available_mib: 100_000 },
  } }));
  await until(() => env.DB.prepare("SELECT json_extract(report_json, '$.schema_version') AS schema FROM host_actual_state WHERE host_id = ?1")
    .bind(hostId).first("schema"), (schema) => schema === 8);
  return ws;
}

async function desiredDoc(hostId: string): Promise<HostDesiredStateV3 | null> {
  const row = await env.DB.prepare("SELECT doc_json FROM host_desired_state WHERE host_id = ?1").bind(hostId).first<{ doc_json: string }>();
  return row ? JSON.parse(row.doc_json) as HostDesiredStateV3 : null;
}

async function runRow(runId: string) {
  const row = await env.DB.prepare("SELECT state, end_reason, state_json, scenario_rev, tasks_json FROM scenario_runs WHERE run_id = ?1")
    .bind(runId).first<{ state: string; end_reason: string | null; state_json: string; scenario_rev: string; tasks_json: string }>();
  return row!;
}

function labState(state: VmLabV1["state"], tasks: VmLabV1["tasks"] = [], failure: string | null = null): VmLabV1 {
  return { state, kino_version: "run-test", ready: [{ name: "nginx", status: state === "failed" ? "fail" : "pass", tail: "nginx tail" }], tasks,
    timings_ms: {}, failure };
}

function vmState(runId: string, name: string, lab: VmLabV1, at = Date.now()): VmStateV3 {
  const ready = lab.state === "ready";
  return {
    name, run_id: runId, runtime_execution_id: runId, owner_user_id: LEARNER, generation: 1, desired_version: 1,
    phase: ready ? "ready" : lab.state === "failed" ? "failed" : "booting", updated_at_unix_ms: at,
    network: { bridge_name: "intar-run-test", guest_ip: "10.77.0.2", guest_cidr: "10.77.0.2/28", gateway: "10.77.0.1",
      ssh_host: "203.0.113.9", ssh_host_port: 2201 },
    terminal: ready
      ? { state: "ready", observed_at_unix_ms: at, target: { host: "203.0.113.9", port: 2201, username: "user", checked_at_unix_ms: at } }
      : { state: "pending", observed_at_unix_ms: at },
    runtime_constraints: { generation: `jail-${name}`, cpu_millis: 1000, quota_verified_at_unix_ms: at - 1 },
    ssh_host_keys_openssh: [`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${name} host-key`],
    archive: { phase: "none", artifact_count: 0 },
    lab,
  } as VmStateV3;
}

function sendVm(ws: WebSocket, hostId: string, vm: VmStateV3) {
  const message = { type: "vm_report", protocol_version: 9, host_id: hostId,
    report: { schema_version: 7, host_id: hostId, observed_at_unix_ms: vm.updated_at_unix_ms, vm } };
  expect(validateBridgeMessageV9(message)).toBe(true);
  ws.send(JSON.stringify(message));
}

const v2 = async (path: string, token: string) => {
  const response = await handleOciRequest(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } }), {
    ...env, REGISTRY_TOKEN_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as Cloudflare.Env);
  return response!.status;
};

const registryToken = async (hostId: string, owner: string) => (await mintRegistryToken(env, {
  scope: "personal", organizationId: null, credentialGeneration: 1, hostId, userId: owner, role: "agent",
}))!.token;

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
    expect(status.tasks?.map((task) => task.id)).toEqual(["serve", "fetch"]);
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
