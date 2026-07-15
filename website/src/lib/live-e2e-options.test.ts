import { describe, expect, it } from "vitest";
import {
  hostReadinessProblems,
  parseOptions,
  type HostSummary,
} from "../../scripts/live-e2e";

const requiredEnv = {
  INTAR_LIVE_BASE_URL: "https://intar.dev",
  INTAR_LIVE_COOKIE: "session=test",
};

describe("live E2E options", () => {
  const performanceReadyHost = (): HostSummary => ({
    id: "host-v2",
    disabled: false,
    scenarioEnabled: true,
    status: { connected: true, lastHeartbeatAt: null },
    actualState: {
      appliedDesiredVersion: 1,
      observedAt: 1,
      capabilities: {
        supports_kvm: true,
        supports_vsock: true,
        supports_reflink: true,
        supports_nftables: true,
        supports_jailer_v1: false,
        supports_jailer_v2: true,
        supports_boot_cpu_lease: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_hard_cpu_quota: true,
        supports_landlock: true,
        supports_cgroup_v2: true,
        boot_cpu_millis: 2_000,
        boot_cpu_lease_ms: 45_000,
        cloud_hypervisor_sha256: "a".repeat(64),
        arch: "x86_64",
      },
      cachedImages: [],
    },
  });

  it("requires the complete breaking v2 fast-launch contract", () => {
    const ready = performanceReadyHost();
    expect(hostReadinessProblems(ready, [])).toEqual([]);

    const legacy = performanceReadyHost();
    legacy.actualState!.capabilities.supports_jailer_v1 = true;
    legacy.actualState!.capabilities.supports_jailer_v2 = false;
    legacy.actualState!.capabilities.fast_template_store = false;
    legacy.actualState!.capabilities.boot_cpu_millis = 1_000;
    expect(hostReadinessProblems(legacy, [])).toEqual(
      expect.arrayContaining([
        "host still advertises the rejected jailer-v1 launch path",
        "host does not report jailer-v2 support",
        "host has not attested the fast template store",
        "host boot CPU allocation is 1000m, expected 2000m",
      ]),
    );
  });

  it("rejects the removed same-user cross-run option", () => {
    expect(() =>
      parseOptions(["--cross-run-scenario", "broken-nginx"], requiredEnv),
    ).toThrow("unknown option: --cross-run-scenario");
  });

  it("rejects the removed cross-run environment variable", () => {
    expect(() =>
      parseOptions([], {
        ...requiredEnv,
        INTAR_LIVE_CROSS_RUN_SCENARIO_ID: "broken-nginx",
      }),
    ).toThrow("concurrent runs on the same agent host");
  });

  it("accepts registered value options", () => {
    const options = parseOptions(
      ["--scenario", "broken-nginx", "--wait-ready-ms", "12345"],
      requiredEnv,
    );
    expect(options.scenarioId).toBe("broken-nginx");
    expect(options.waitReadyMs).toBe(12_345);
  });

  it("defaults readiness beyond the quota-scaled agent deadline", () => {
    const options = parseOptions([], requiredEnv);

    expect(options.waitReadyMs).toBe(480_000);
    expect(options.waitReadyMs).toBeGreaterThan(360_000);
    expect(options.pollMs).toBe(100);
  });

  it("rejects inline values for boolean flags", () => {
    expect(() => parseOptions(["--skip-publish=false"], requiredEnv)).toThrow(
      "--skip-publish does not accept a value",
    );
  });
});
