/// <reference types="@cloudflare/vitest-plugin/types" />
// Fixtures for runs of scenario revisions: registry artifacts, revision
// rows, bridge 9 hosts and their reports.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { expect } from "vitest";
import { handleAgentBootstrap, mintRegistryToken, sha256Hex } from "@/control-plane/auth";
import { handleOciRequest } from "@/control-plane/image-registry/oci";
import { blob, machineConfig, manifestOf, type PushedBlob } from "@/control-plane/image-registry/oci-test-fixtures";
import { sleep } from "@/control-plane/host-runtime-do/test-fixtures";
import { agentBootstrapTokens, agentHosts, courseCatalogs, scenarioRevisions, scenarios } from "@/db/schema";
import type { HostDesiredStateV3, VmLabV1, VmStateV3 } from "@/generated/contracts/bridge-message-v9";
import validateBridgeMessageV9 from "@/generated/contracts/bridge-message-v9.validate";
import type { ScenarioRevisionV1 } from "@/generated/contracts/scenario-revision-v1";

export const ORIGIN = "https://intar.test";
// The pin vitest.workers.config.ts binds as KINO_PINS_JSON for contract 3.
export const KINO = "sha256:ba84da6c273cceb718a63a6374ceeebc4ad862fd4098e570ed71937fe01b4639";
export const LEARNER = "learner";
export const STRANGER = "stranger";
export const HOST = "host-1";
export const OTHER_HOST = "host-2";
export const SOLUTION = "SOLUTION-TEXT run nginx -t";
export const HINT_BODY = "HINT-BODY check the port";
export const TASK_BODY = "TASK-BODY get **nginx** serving on port 80";
export const HARDWARE = {
  cloud_hypervisor_sha256: "4".repeat(64), kvm: true, vsock: true, reflink: true, landlock: true, cgroup_v2: true,
  hard_cpu_quota: true,
};

/** Puts an artifact into R2 and the index, as the push routes leave it. */
export async function store(artifactType: string, configMediaType: string, config: unknown, layers: Array<[string, string]>) {
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

/** Every machine image the fixtures stored; a host reports them ready unless told otherwise. */
export const storedImages: string[] = [];

export const machineImage = async (label: string) => {
  const image = await storeMachineImage(label);
  storedImages.push(image);
  return image;
};

const storeMachineImage = (label: string) => store("application/vnd.intar.machine.v1", "application/vnd.intar.machine.config.v1+json",
  machineConfig(`sha256:${"b".repeat(64)}`, { boot: { cmdline: label } }),
  [["application/vnd.intar.kernel.v1", `kernel ${label}`], ["application/vnd.intar.disk.chunk.v1+zstd", `chunk ${label}`]]);

export async function specBlob(label: string): Promise<string> {
  const pushed = await blob(JSON.stringify({ spec: label }));
  await env.VM_IMAGE_REGISTRY_BUCKET.put(`oci/sha256/${pushed.hex}`, pushed.bytes);
  return pushed.digest;
}

export function revisionDoc(images: Record<string, string>, specs: Record<string, string>): ScenarioRevisionV1 {
  const machine = (name: string) => ({
    name, build_key: `sha256:${"b".repeat(64)}`, image_digest: images[name] ?? null, spec: specs[name]!,
    verify_spec: `sha256:${"9".repeat(64)}`, cpu_millis: 1000, memory_mib: 512, disk_mib: 4096, terminal: true, egress: false,
  });
  return {
    title: "Web", summary: "Fix the web server", briefing: "Fix it.", difficulty: "easy", minutes: 10, play: false,
    tags: [], solution: SOLUTION, hints: [{ id: "start", title: "Start", body: "Look around." }],
    machines: [machine("web"), machine("client")],
    tasks: [
      { id: "serve", title: "Serve", body: TASK_BODY, machine: "web", needs: [], optional: false, ordinal: 0,
        hints: [{ id: "port", title: "Port", body: HINT_BODY }] },
      { id: "fetch", title: "Fetch", machine: "client", needs: ["serve"], optional: false, ordinal: 1, hints: [] },
    ],
  };
}

export async function seedScenario(id: string, organizationId: string | null, doc: ScenarioRevisionV1) {
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

/** Enrolls a host of `owner`, personal unless said otherwise, and returns its agent token. */
export async function enrollHost(hostId: string, owner: string, scope: "personal" | "platform" = "personal"): Promise<string> {
  const db = drizzle(env.DB);
  await db.insert(agentHosts).values({ id: hostId, userId: owner, name: hostId, scope, role: "agent",
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

export async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(10);
  }
}

/** Connects a host over bridge 9 and sends a Ready state report. */
export async function connect(hostId: string): Promise<WebSocket> {
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
  sendState(ws, hostId, []);
  await until(() => env.DB.prepare("SELECT json_extract(report_json, '$.schema_version') AS schema FROM host_actual_state WHERE host_id = ?1")
    .bind(hostId).first("schema"), (schema) => schema === 8);
  return ws;
}

/**
 * Closes a host's socket and waits until its Durable Object has released the
 * session, so the close handler does not run on into the next test or past
 * the end of the file.
 */
export async function disconnect(ws: WebSocket, hostId: string): Promise<void> {
  ws.close();
  await until(() => env.DB.prepare("SELECT connected FROM agent_hosts WHERE id = ?1").bind(hostId).first<number>("connected"),
    (connected) => connected !== 1);
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
  await runInDurableObject(stub, async (_instance, state) => { await state.storage.getAlarm(); });
}

export async function desiredDoc(hostId: string): Promise<HostDesiredStateV3 | null> {
  const row = await env.DB.prepare("SELECT doc_json FROM host_desired_state WHERE host_id = ?1").bind(hostId).first<{ doc_json: string }>();
  return row ? JSON.parse(row.doc_json) as HostDesiredStateV3 : null;
}

export async function runRow(runId: string) {
  const row = await env.DB.prepare("SELECT state, end_reason, state_json, scenario_rev, tasks_json FROM scenario_runs WHERE run_id = ?1")
    .bind(runId).first<{ state: string; end_reason: string | null; state_json: string; scenario_rev: string; tasks_json: string }>();
  return row!;
}

export function labState(state: VmLabV1["state"], tasks: VmLabV1["tasks"] = [], failure: string | null = null): VmLabV1 {
  return { state, kino_version: "run-test", ready: [{ name: "nginx", status: state === "failed" ? "fail" : "pass", tail: "nginx tail" }], tasks,
    timings_ms: {}, failure };
}

export function vmState(runId: string, name: string, lab: VmLabV1, at = Date.now()): VmStateV3 {
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

/** A full state report of `hostId` with `vms`, its `readyImages` cached. */
export function sendState(ws: WebSocket, hostId: string, vms: VmStateV3[], readyImages: readonly string[] = storedImages) {
  const at = Date.now();
  ws.send(JSON.stringify({ type: "state_report", protocol_version: 9, host_id: hostId, report: {
    schema_version: 8, host_id: hostId, observed_at_unix_ms: at, applied_desired_version: 0, relay_connected: true,
    guest_contract: 3, hardware: HARDWARE,
    cached_images: readyImages.map((image) => ({ image, phase: "ready", updated_at_unix_ms: at })), vms,
    capacity: { total_cpu_millis: 8000, reserved_cpu_millis: 0, schedulable_cpu_millis: 8000, committed_cpu_millis: 0,
      memory_total_mib: 16384, memory_available_mib: 16384, disk_probe_path: "/var/lib", disk_total_mib: 100_000,
      disk_available_mib: 100_000 },
  } }));
}

export function sendVm(ws: WebSocket, hostId: string, vm: VmStateV3) {
  const message = { type: "vm_report", protocol_version: 9, host_id: hostId,
    report: { schema_version: 7, host_id: hostId, observed_at_unix_ms: vm.updated_at_unix_ms, vm } };
  expect(validateBridgeMessageV9(message)).toBe(true);
  ws.send(JSON.stringify(message));
}

export const v2 = async (path: string, token: string) => {
  const response = await handleOciRequest(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } }), {
    ...env, REGISTRY_TOKEN_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as Cloudflare.Env);
  return response!.status;
};

export const registryToken = async (hostId: string, owner: string, scope: "personal" | "platform" = "personal") => (await mintRegistryToken(env, {
  scope, organizationId: null, credentialGeneration: 1, hostId, userId: owner, role: "agent",
}))!.token;

/**
 * A connected platform agent whose fresh report lists `images`, by default
 * every machine image the stored revisions name, as ready.
 */
export async function seedReadyPlatformHost(hostId = "platform-ready", images?: readonly string[]) {
  const now = Date.now();
  const ready = images ?? (await env.DB.prepare(
    `SELECT DISTINCT json_extract(machine.value, '$.image_digest') AS image
       FROM scenario_revisions revision, json_each(revision.doc_json, '$.machines') machine
      WHERE json_extract(machine.value, '$.image_digest') IS NOT NULL`,
  ).all<{ image: string }>()).results.map((row) => row.image);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user (id, name, email, email_verified) VALUES ('platform-owner', 'Platform', 'platform@users.invalid', 1)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO agent_hosts (id, user_id, name, scope, role, credential_generation, active_session_id, scenario_enabled,
        disabled, connected, last_heartbeat_at, created_at, updated_at)
      VALUES (?1, 'platform-owner', ?1, 'platform', 'agent', 1, 'ready-session', 1, 0, 1, ?2, ?2, ?2)`,
  ).bind(hostId, now).run();
  const report = { schema_version: 8, host_id: hostId, observed_at_unix_ms: now, applied_desired_version: 0,
    relay_connected: true, guest_contract: 3, hardware: HARDWARE, vms: [],
    capacity: { total_cpu_millis: 8000, reserved_cpu_millis: 0, schedulable_cpu_millis: 8000, committed_cpu_millis: 0,
      memory_total_mib: 16384, memory_available_mib: 16384, disk_probe_path: "/var/lib", disk_total_mib: 100_000,
      disk_available_mib: 100_000 },
    cached_images: ready.map((image) => ({ image, phase: "ready", updated_at_unix_ms: now })) };
  await env.DB.prepare(
    `INSERT INTO host_actual_state (host_id, applied_desired_version, observed_at, report_json, created_at, updated_at)
      VALUES (?1, 0, ?2, ?3, ?2, ?2)`,
  ).bind(hostId, now, JSON.stringify(report)).run();
}
