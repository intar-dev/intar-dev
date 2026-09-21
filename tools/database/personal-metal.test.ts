import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

test("automatic placement selects only the personal, organization, or platform fleet", async () => {
  const sqlite = new Database(":memory:");
  const prepared = (query: string, parameters: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepared(query, values),
    first: async () => sqlite.prepare(query).get(...parameters as never[]),
    raw: async () => sqlite.prepare(query).values(...parameters as never[]),
    all: async () => ({ results: sqlite.prepare(query).all(...parameters as never[]) }),
  });
  mock.module("cloudflare:workers", () => ({
    env: { DB: { prepare: prepared } },
    tracing: { enterSpan: (_name: string, operation: Function) => operation({ setAttribute() {} }) },
  }));
  // These unrelated route/storage operations are not part of host selection.
  mock.module("../../apps/web/src/lib/route-revocation", () => ({ revokeAllRoutes() {} }));
  mock.module("../../apps/web/src/lib/stargate", () => ({ deleteStargateRoute() {}, stargateRouteTtlMs() {} }));
  mock.module("../../apps/web/src/lib/scenario-runs/storage", () => ({ parseRunState() {} }));
  const { selectScenarioHosts } = await import("../../apps/web/src/lib/scenario-runs/start");
  const { HOST_STATE_REPORT_SCHEMA_VERSION } = await import("../../apps/web/src/generated/constants");
  try {
    sqlite.exec("CREATE TABLE user (id TEXT, metal_placement TEXT, deleted_at INTEGER, banned INTEGER); CREATE TABLE organization (id TEXT, metal_placement TEXT); CREATE TABLE member (user_id TEXT, organization_id TEXT); CREATE TABLE agent_hosts (id TEXT, user_id TEXT, scope TEXT, organization_id TEXT, disabled INTEGER, role TEXT, scenario_enabled INTEGER, connected INTEGER, updated_at INTEGER, last_heartbeat_at INTEGER, last_inventory_at INTEGER); CREATE TABLE host_actual_state (host_id TEXT, updated_at INTEGER, report_json TEXT); CREATE TABLE scenario_runs (host_id TEXT, completed_at INTEGER, failed_at INTEGER);");
    sqlite.exec("INSERT INTO user (id, metal_placement) VALUES ('alice', 'personal'), ('bob', 'personal'), ('cloud', 'platform'); INSERT INTO organization VALUES ('org', 'organization'), ('other', 'organization'); INSERT INTO member VALUES ('alice', 'org'), ('cloud', 'org');");
    const now = Date.now();
    const report = {
      schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
      relay_connected: true,
      capacity: { total_cpu_millis: 4000, reserved_cpu_millis: 1000, schedulable_cpu_millis: 3000, committed_cpu_millis: 0, memory_total_mib: 8192, memory_available_mib: 4096, disk_available_mib: 50000 },
      capabilities: {
        arch: "x86_64",
        supports_kvm: true, supports_vsock: true, supports_reflink: true,
        supports_nftables: true, supports_jailer_v3: true,
        supports_template_backed_launch: true, fast_template_store: true,
        supports_hard_cpu_quota: true, supports_landlock: true, supports_cgroup_v2: true,
        supports_raw_chunks_v1: true, supports_scenario_guest_tools_v1: true,
        cloud_hypervisor_sha256: "a".repeat(64),
      },
      vms: [], cached_images: [],
    };
    for (const [id, owner, scope, organizationId] of [["alice-host", "alice", "personal", null], ["cloud-host", "operator", "platform", null], ["org-host", "operator", "organization", "org"], ["other-host", "operator", "organization", "other"]]) {
      sqlite.prepare("INSERT INTO agent_hosts VALUES (?, ?, ?, ?, 0, 'agent', 1, 1, ?, ?, ?)").run(id!, owner!, scope!, organizationId ?? null, now, now, now);
      sqlite.prepare("INSERT INTO host_actual_state VALUES (?, ?, ?)").run(id!, now, JSON.stringify(report));
    }
    expect(await selectScenarioHosts([], "alice", undefined, now, false)).toEqual({ ok: true, hostIds: ["alice-host"] });
    expect(await selectScenarioHosts([], "bob", undefined, now, false)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await selectScenarioHosts([], "cloud", undefined, now, false)).toEqual({ ok: true, hostIds: ["cloud-host"] });
    expect(await selectScenarioHosts([], "cloud", undefined, now, false, "org")).toEqual({ ok: true, hostIds: ["org-host"] });
    expect(await selectScenarioHosts([], "alice", undefined, now, false, "org")).toEqual({ ok: true, hostIds: ["alice-host"] });
    expect(await selectScenarioHosts([], "cloud", undefined, now, false, "other")).toMatchObject({ ok: false, reason: "unavailable" });
    sqlite.exec("UPDATE agent_hosts SET connected = 0 WHERE id = 'org-host'");
    expect(await selectScenarioHosts([], "cloud", undefined, now, false, "org")).toMatchObject({ ok: false, reason: "unavailable" });
    sqlite.exec("UPDATE agent_hosts SET connected = 0 WHERE id = 'alice-host'");
    expect(await selectScenarioHosts([], "alice", undefined, now, false)).toMatchObject({ ok: false, reason: "unavailable" });
  } finally {
    sqlite.close();
    mock.restore();
  }
});
