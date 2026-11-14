/// <reference types="@cloudflare/vitest-plugin/types" />

import { gzipSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import { handleImageRegistryRequest } from "@/control-plane/image-registry/router";
import { OCI_MANIFEST_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { blob, machineConfig, manifestOf, type PushedBlob } from "@/control-plane/image-registry/oci-test-fixtures";
import { agentBootstrapTokens, agentHosts, hostDesiredState, user } from "@/db/schema";
import type { BridgeMessageV9, BuildReportV2, HostStateReportV3 } from "@/generated/contracts/bridge-message-v9";
import validateBridgeMessageV9 from "@/generated/contracts/bridge-message-v9.validate";
import bundleFixture from "@/generated/fixtures/scenario/broken-nginx-bundle.json";
import { expireMachineBuildLeases, maintainMachineBuilds, REVISION_BUILD_FAILURE } from "@/lib/machine-builds";
import { ingestSourceBundle } from "@/lib/scenario-bundles";
import { canonicalJson, sha256Digest } from "@/lib/scenario-contract/canonical-json";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { resetHostRuntimeTestDatabase, seedHost, sleep } from "./test-fixtures";

const HARDWARE = {
  cloud_hypervisor_sha256: null, kvm: true, vsock: true, reflink: true, landlock: true, cgroup_v2: true,
  hard_cpu_quota: true,
};
const digestOf = (digit: string) => `sha256:${digit.repeat(64)}`;

function hello(hostId: string, role: "agent" | "builder", overrides: Record<string, unknown> = {}) {
  return {
    type: "client_hello", protocol_version: 9, host_id: hostId, agent_version: "1.0.0", role, guest_contract: 3,
    hardware: HARDWARE,
    ...(role === "builder"
      ? { builder: { image_format: "intar-image-3", source_compile_digest: "p00000000" } }
      : {}),
    ...overrides,
  };
}

function stateReport(hostId: string): Extract<BridgeMessageV9, { type: "state_report" }> {
  const report: HostStateReportV3 = {
    schema_version: 8, host_id: hostId, observed_at_unix_ms: Date.now(), applied_desired_version: 0,
    relay_connected: false, guest_contract: 3, hardware: HARDWARE,
    capacity: {
      total_cpu_millis: 4000, reserved_cpu_millis: 0, schedulable_cpu_millis: 4000, committed_cpu_millis: 0,
      memory_total_mib: 8192, memory_available_mib: 8192, disk_probe_path: "/var/lib", disk_total_mib: 100_000,
      disk_available_mib: 100_000,
    },
    cached_images: [], vms: [],
  };
  return { type: "state_report", protocol_version: 9, host_id: hostId, report };
}

/** Opens a socket that states protocol 9 and sends `first`. */
async function connect(hostId: string, first: unknown) {
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
  const response = await stub.fetch("http://host-runtime/connect", {
    headers: {
      upgrade: "websocket", "x-agent-host-id": hostId, "x-agent-credential-generation": "1",
      "intar-bridge-protocol": "9",
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const messages: unknown[] = [];
  const closed: { code: number | null } = { code: null };
  ws.accept();
  ws.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string)));
  ws.addEventListener("close", (event) => {
    closed.code = event.code;
  });
  ws.send(JSON.stringify(first));
  return { ws, messages, closed };
}

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(10);
  }
}

const desiredStates = (messages: unknown[]) =>
  messages.filter((message): message is Extract<BridgeMessageV9, { type: "desired_state" }> =>
    (message as { type?: string }).type === "desired_state");

async function seedBuilder(hostId: string): Promise<string> {
  const db = drizzle(env.DB);
  await db.insert(user).values({ id: "platform-owner", name: "Platform", email: "platform@example.test" }).onConflictDoNothing();
  await db.insert(agentHosts).values({
    id: hostId, userId: "platform-owner", name: hostId, scope: "platform", role: "builder", credentialGeneration: 1,
  });
  await db.insert(agentBootstrapTokens).values({
    id: `${hostId}-c2`, hostId, tokenHash: await sha256Hex(`${hostId}-secret`), credentialGeneration: 1, expiresAt: null,
  });
  const response = await handleAgentBootstrap(new Request("https://intar.test/agent/bootstrap", {
    method: "POST", headers: { "content-type": "application/json", "intar-bridge-protocol": "9" },
    body: JSON.stringify({ hostId, bootstrapToken: `${hostId}-secret` }),
  }), env);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

describe("bridge 9 transport", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("closes an older hello with 4426 and records the refusal", async () => {
    await seedHost("host-old");
    const { closed } = await connect("host-old", { ...hello("host-old", "agent"), protocol_version: 8, agent_version: "0.9.0" });
    await until(() => closed.code, (code) => code !== null);
    expect(closed.code).toBe(4426);
    expect(await env.DB.prepare(
      "SELECT last_refusal_code, last_refused_agent_version FROM agent_hosts WHERE id = 'host-old'",
    ).first()).toEqual({ last_refusal_code: "upgrade_required", last_refused_agent_version: "0.9.0" });
  });

  it("answers a v9 hello and rewrites the old desired state at version + 1, once", async () => {
    await seedHost("host-a");
    const db = drizzle(env.DB);
    // An old-schema document at version 3.
    await db.insert(hostDesiredState).values({
      hostId: "host-a",
      version: 3,
      docJson: { schema_version: 6, host_id: "host-a", version: 3, cached_guest_tools: [] } as never,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect((await db.select().from(hostDesiredState))[0]?.version).toBe(3);

    const first = await connect("host-a", hello("host-a", "agent"));
    const desired = await until(() => desiredStates(first.messages), (all) => all.length > 0);
    const serverHello = first.messages[0] as Extract<BridgeMessageV9, { type: "server_hello" }>;
    expect(validateBridgeMessageV9(serverHello)).toBe(true);
    expect(serverHello).toMatchObject({ type: "server_hello", protocol_version: 9, host_id: "host-a", desired_version: 4 });
    expect(validateBridgeMessageV9(desired[0])).toBe(true);
    // No Kino pin: no pin and no VMs; an agent never gets builds.
    expect(desired[0]!.desired_state).toMatchObject({ schema_version: 7, version: 4, vms: [], builds: [], source_compiles: [] });
    expect(desired[0]!.desired_state.kino_pin).toBeUndefined();
    first.ws.close();

    const second = await connect("host-a", hello("host-a", "agent", { last_applied_desired_version: 4 }));
    await until(() => second.messages, (all) => all.length > 0);
    expect(second.messages[0]).toMatchObject({ type: "server_hello", desired_version: 4 });
    expect((await db.select().from(hostDesiredState))[0]?.version).toBe(4);
    second.ws.close();
  });

  it("keeps an agent's VMs without a Kino pin and gives a builder no VMs", async () => {
    await seedHost("host-b");
    await seedBuilder("builder-b");
    const vm = {
      vm_id: "vm-1", name: "web", run_id: "run-1", runtime_execution_id: "exec-1", owner_user_id: "user-1",
      generation: 1, desired_phase: "running", lease_expires_at_unix_ms: Date.now() + 60_000,
      image: digestOf("a"), kino: digestOf("b"), spec: digestOf("c"), mode: "learn", cpu_millis: 1000,
      memory_mib: 512, disk_mib: 4096, peers: [], ssh_authorized_keys: [], terminal: true, egress: false,
    };
    for (const [hostId, role] of [["host-b", "agent"], ["builder-b", "builder"]] as const) {
      const doc = {
        scope: role === "agent" ? "personal" : "platform", owner_user_id: role === "agent" ? "user-1" : "platform-owner",
        schema_version: 7, host_id: hostId, version: 5, generated_at_unix_ms: 1, cached_images: [], vms: [vm],
        builds: [], source_compiles: [],
      };
      await env.DB.prepare("INSERT INTO host_desired_state (host_id, version, doc_json) VALUES (?1, 5, ?2)")
        .bind(hostId, JSON.stringify(doc)).run();
      const { messages, ws } = await connect(hostId, hello(hostId, role));
      const desired = await until(() => desiredStates(messages), (all) => all.length > 0);
      const served = desired[0]!.desired_state;
      expect(served.kino_pin).toBeUndefined();
      expect(served.vms.map((entry) => entry.vm_id)).toEqual(role === "agent" ? ["vm-1"] : []);
      ws.close();
    }
  });

  it("closes an invalid message and stores a v9 state report", async () => {
    await seedBuilder("builder-c");
    const { ws, messages, closed } = await connect("builder-c", hello("builder-c", "builder"));
    await until(() => messages, (all) => all.length > 0);
    ws.send(JSON.stringify(stateReport("builder-c")));
    const stored = await until(
      () => env.DB.prepare("SELECT json_extract(report_json, '$.schema_version') AS schema FROM host_actual_state WHERE host_id = 'builder-c'").first("schema"),
      (schema) => schema === 8,
    );
    expect(stored).toBe(8);
    ws.send(JSON.stringify({ ...stateReport("builder-c"), extra: true }));
    await until(() => closed.code, (code) => code !== null);
    expect(closed.code).toBe(1003);
  });
});

describe("machine builds over bridge 9", () => {
  const rev = (n: number) => `git-42-${String(n).repeat(40)}-${digest}`;
  let digest: string;
  let token: string;

  beforeEach(async () => {
    await resetHostRuntimeTestDatabase();
    digest = await sourceCompileDigest();
    token = await seedBuilder("builder-1");
  });

  async function ingest(n: number) {
    expect(await ingestSourceBundle(env, {
      organizationId: null, rev: rev(n), gzip: new Uint8Array(gzipSync(JSON.stringify(bundleFixture))), stored: false,
    })).toBeNull();
  }

  const build = () => env.DB.prepare("SELECT build_key, state, attempt, host_id, image_digest, error, updated_at FROM machine_builds").first<{
    build_key: string; state: string; attempt: number; host_id: string | null; image_digest: string | null; error: string | null;
    updated_at: number;
  }>();
  const revision = (n: number) => env.DB.prepare(
    "SELECT state, content_digest, doc_json, failure_reason FROM scenario_revisions WHERE rev = ?1",
  ).bind(rev(n)).first<{ state: string; content_digest: string | null; doc_json: string; failure_reason: string | null }>();

  async function connectBuilder() {
    const session = await connect("builder-1", hello("builder-1", "builder"));
    await until(() => session.messages, (all) => all.length > 0);
    session.ws.send(JSON.stringify(stateReport("builder-1")));
    return session;
  }

  function report(key: string, attempt: number, phase: BuildReportV2["phase"], extra: Partial<BuildReportV2> = {}) {
    const message = {
      type: "build_report", protocol_version: 9, host_id: "builder-1",
      report: { build_id: key.slice(7), build_key: key, attempt, phase, observed_at_unix_ms: Date.now(), ...extra },
    };
    expect(validateBridgeMessageV9(message)).toBe(true);
    return JSON.stringify(message);
  }

  async function call(method: string, path: string, body: Uint8Array<ArrayBuffer>, contentType: string) {
    const response = await handleImageRegistryRequest(new Request(`https://intar.test/registry/v1${path}`, {
      method, body,
      headers: { authorization: `Bearer ${token}`, "content-type": contentType, "content-length": String(body.length) },
    }), env);
    return response!;
  }

  /** Pushes a machine image for `key` through the real routes; its digest. */
  async function pushImage(key: string) {
    const config = await blob(JSON.stringify(machineConfig(key)));
    const kernel = await blob("kernel bytes");
    const chunk = await blob("chunk bytes");
    for (const pushed of [config, kernel, chunk] as PushedBlob[]) {
      expect((await call("PUT", `/blobs/${pushed.digest}`, pushed.bytes, "application/octet-stream")).status).toBe(201);
    }
    const manifest = await blob(JSON.stringify(manifestOf("application/vnd.intar.machine.v1", config,
      "application/vnd.intar.machine.config.v1+json", [
      ["application/vnd.intar.kernel.v1", kernel], ["application/vnd.intar.disk.chunk.v1+zstd", chunk],
    ])));
    expect((await call("PUT", `/manifests/${manifest.digest}`, manifest.bytes, OCI_MANIFEST_MEDIA_TYPE)).status).toBe(201);
    return manifest.digest;
  }

  async function postResult(key: string, attempt: number, image: string) {
    const body = new TextEncoder().encode(JSON.stringify({ image_digest: image }));
    return call("POST", `/builds/${key.slice(7)}/result?attempt=${attempt}`, body, "application/json");
  }

  it("builds an ingested revision to ready, refusing a mismatching report and a stale attempt", async () => {
    await ingest(1);
    expect(await build()).toMatchObject({ state: "queued", attempt: 0 });
    const { ws, messages } = await connectBuilder();

    const desired = await until(() => desiredStates(messages).at(-1), (last) => (last?.desired_state.builds.length ?? 0) > 0);
    expect(validateBridgeMessageV9(desired)).toBe(true);
    const key = (await build())!.build_key;
    expect(desired!.desired_state.builds).toEqual([{
      build_id: key.slice(7), build_key: key, bundle_rev: rev(1), attempt: 1,
      target: { kind: "machine", scenario: "broken-nginx", machine: "webserver" },
    }]);
    expect(desired!.desired_state.vms).toEqual([]);
    expect(await build()).toMatchObject({ state: "assigned", attempt: 1, host_id: "builder-1" });

    ws.send(report(key, 1, "building"));
    await until(build, (row) => row?.state === "building");
    // An attempt that is not the current one moves nothing.
    ws.send(report(key, 2, "failed", { error: "stale" }));
    const image = await pushImage(key);
    // A succeeded report before the result, or with another digest, is refused.
    ws.send(report(key, 1, "succeeded", { image_digest: image }));
    await sleep(100);
    expect(await build()).toMatchObject({ state: "building", image_digest: null });
    expect((await postResult(key, 1, image)).status).toBe(201);
    ws.send(report(key, 1, "succeeded", { image_digest: digestOf("e") }));
    await sleep(100);
    expect(await build()).toMatchObject({ state: "building", image_digest: image });

    ws.send(report(key, 1, "succeeded", { image_digest: image }));
    const ready = await until(() => revision(1), (row) => row?.state === "ready");
    const doc = JSON.parse(ready!.doc_json) as { machines: Array<{ image_digest: string }> };
    expect(doc.machines[0]!.image_digest).toBe(image);
    expect(ready!.doc_json).toBe(canonicalJson(doc));
    expect(ready!.content_digest).toBe(await sha256Digest(ready!.doc_json));
    const after = await until(() => desiredStates(messages).at(-1), (last) => last?.desired_state.builds.length === 0);
    expect(after!.desired_state.builds).toEqual([]);
    ws.close();
  });

  it("assigns an expired build again, retries a reported failure, and fails the revision after the last", async () => {
    await ingest(1);
    const { ws } = await connectBuilder();
    await until(build, (row) => row?.state === "assigned");
    const key = (await build())!.build_key;

    await env.DB.prepare("UPDATE machine_builds SET updated_at = 0").run();
    await maintainMachineBuilds(env, null, Date.now());
    expect(await build()).toMatchObject({ state: "assigned", attempt: 2, host_id: "builder-1" });

    ws.send(report(key, 2, "failed", { error: "qemu exited" }));
    await until(build, (row) => row?.attempt === 3);
    expect(await build()).toMatchObject({ state: "assigned", attempt: 3, host_id: "builder-1" });
    expect(await revision(1)).toMatchObject({ state: "building" });
    // The superseded attempt can no longer record an image.
    expect((await postResult(key, 2, await pushImage(key))).status).toBe(409);

    ws.send(report(key, 3, "failed", { error: "qemu exited: /var/lib/builder/x" }));
    const failed = await until(() => revision(1), (row) => row?.state === "failed");
    expect(failed).toMatchObject({ state: "failed", failure_reason: REVISION_BUILD_FAILURE });
    expect(await build()).toMatchObject({ state: "failed", error: "qemu exited: /var/lib/builder/x" });

    // Ingest queues the failed key again from its first attempt.
    await ingest(2);
    expect(await build()).toMatchObject({ state: "assigned", attempt: 1, image_digest: null, error: null });
    ws.close();
  });

  it("settles a failure reported after the result POST as succeeded", async () => {
    await ingest(1);
    const { ws } = await connectBuilder();
    await until(build, (row) => row?.state === "assigned");
    const key = (await build())!.build_key;
    const image = await pushImage(key);
    expect((await postResult(key, 1, image)).status).toBe(201);
    // The builder restarted after the push and lost its outcome.
    ws.send(report(key, 1, "failed", { error: "interrupted" }));
    const ready = await until(() => revision(1), (row) => row?.state === "ready");
    expect(ready!.content_digest).toMatch(/^sha256:/);
    expect(await build()).toMatchObject({ state: "succeeded", attempt: 1, image_digest: image });
    ws.close();
  });

  it("keeps a build that reports every heartbeat past the silence window, until the attempt ceiling", async () => {
    await ingest(1);
    const { ws } = await connectBuilder();
    await until(build, (row) => row?.state === "assigned");
    const key = (await build())!.build_key;
    ws.send(report(key, 1, "building"));
    await until(build, (row) => row?.state === "building");

    const now = Date.now();
    await env.DB.prepare("UPDATE machine_builds SET assigned_at = ?1, updated_at = 0").bind(now - 45 * 60_000).run();
    ws.send(report(key, 1, "building"));
    await until(build, (row) => row?.updated_at !== 0);
    await maintainMachineBuilds(env, null, Date.now());
    expect(await build()).toMatchObject({ state: "building", attempt: 1 });

    // Silent for the window: taken back.
    await env.DB.prepare("UPDATE machine_builds SET updated_at = 0").run();
    await maintainMachineBuilds(env, null, Date.now());
    expect(await build()).toMatchObject({ state: "assigned", attempt: 2 });

    // Reporting, but past the ceiling for one attempt: taken back too.
    await env.DB.prepare("UPDATE machine_builds SET assigned_at = ?1").bind(Date.now() - 3 * 60 * 60_000 - 1).run();
    await maintainMachineBuilds(env, null, Date.now());
    expect(await build()).toMatchObject({ state: "assigned", attempt: 3 });
    ws.close();
  });

  it("fails a silent build that is out of attempts", async () => {
    await ingest(1);
    await env.DB.prepare("UPDATE machine_builds SET state = 'building', host_id = 'builder-1', attempt = 3, updated_at = 0").run();
    await expireMachineBuildLeases(env, Date.now());
    expect(await build()).toMatchObject({ state: "failed" });
    expect(await revision(1)).toMatchObject({ state: "failed" });
  });

  it("verifies an equal revision by carry-forward only from a verified twin of the same guest contract", async () => {
    await ingest(1);
    const { ws } = await connectBuilder();
    await until(build, (row) => row?.state === "assigned");
    const key = (await build())!.build_key;
    const image = await pushImage(key);
    expect((await postResult(key, 1, image)).status).toBe(201);
    ws.send(report(key, 1, "succeeded", { image_digest: image }));
    await until(() => revision(1), (row) => row?.state === "ready");

    await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified', guest_contract = 2 WHERE rev = ?1").bind(rev(1)).run();
    await ingest(2);
    expect(await revision(2)).toMatchObject({ state: "ready", content_digest: (await revision(1))!.content_digest });

    await env.DB.prepare("UPDATE scenario_revisions SET guest_contract = 3 WHERE rev = ?1").bind(rev(1)).run();
    await ingest(3);
    expect(await revision(3)).toMatchObject({ state: "verified", content_digest: (await revision(1))!.content_digest });
    ws.close();
  });
});
