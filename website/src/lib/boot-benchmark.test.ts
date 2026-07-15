import { describe, expect, it } from "vitest";
import {
  BOOT_BENCHMARK_CPU_POLICIES,
  BOOT_BENCHMARK_MEASUREMENT_BOUNDARY,
  BOOT_BENCHMARK_VARIANTS,
  bootArtifactFingerprint,
  compareBootBenchmarkResults,
  durationDistribution,
  evaluatePromotionGate,
  nearestRankPercentile,
  parseBootBenchmarkResult,
  sealProjectionReadyDurationMs,
  sealProjectionUiReadyDurationMs,
  summarizeBootSamples,
  type BootBenchmarkResultV1,
  type BootBenchmarkVariant,
  type BootSampleV1,
  type PassedBootSampleV1,
} from "../../scripts/boot-benchmark-core";
import {
  assertLiveRunnerVariant,
  assertNoForeignHostRuns,
  assertOwnedHostRun,
  browserMarkerCommand,
  hasBootBenchmarkReadyVm,
  parseBrowserCookies,
  parseBootBenchmarkOptions,
} from "../../scripts/boot-benchmark";
import type { ScenarioRunRecord } from "./scenario-runs";
import { runUsableTerminalMarkerProbe } from "../../scripts/live-e2e";

describe("boot benchmark statistics", () => {
  it("uses the exact nearest-rank p50 and p95 for thirty samples", () => {
    const values = Array.from({ length: 30 }, (_, index) => index + 1);

    expect(nearestRankPercentile(values, 50)).toBe(15);
    expect(nearestRankPercentile(values, 95)).toBe(29);
    expect(durationDistribution(values)).toEqual({
      count: 30,
      min_ms: 1,
      p50_ms: 15,
      p95_ms: 29,
      max_ms: 30,
      mean_ms: 15.5,
    });
  });

  it("passes only five clean warmups and thirty clean measured boots", () => {
    const warmups = Array.from({ length: 5 }, (_, index) =>
      passedSample("warmup", index + 1, 6_000),
    );
    const measured = Array.from({ length: 30 }, (_, index) =>
      passedSample("measured", index + 1, index < 28 ? 6_500 : 9_000),
    );
    const summary = summarizeBootSamples({ warmups, measured });

    expect(
      evaluatePromotionGate({
        warmups,
        measured,
        summary,
        performanceReady: true,
      }),
    ).toMatchObject({ passed: true, reasons: [] });
    expect(summary.usable_terminal_ms).toMatchObject({
      p50_ms: 6_500,
      p95_ms: 9_000,
    });
  });

  it("treats the p95 upper bound as exclusive and never drops failures", () => {
    const warmups = Array.from({ length: 5 }, (_, index) =>
      passedSample("warmup", index + 1, 6_000),
    );
    const measured: BootSampleV1[] = Array.from({ length: 29 }, (_, index) =>
      passedSample("measured", index + 1, index < 27 ? 6_500 : 10_000),
    );
    measured.push({
      kind: "measured",
      ordinal: 30,
      status: "failed",
      run_id: "run-failed",
      started_at_unix_ms: 1,
      elapsed_ms: 12_000,
      error: "boot failed",
      teardown_ms: 100,
    });
    const summary = summarizeBootSamples({ warmups, measured });
    const gate = evaluatePromotionGate({
      warmups,
      measured,
      summary,
      performanceReady: true,
    });

    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain("1 measured boot(s) failed");
    expect(gate.reasons).toContain(
      "usable-terminal p95 10000ms is not below 10000ms",
    );
  });

  it("enforces the 500ms request-acceptance p95 phase target", () => {
    const warmups = Array.from({ length: 5 }, (_, index) =>
      passedSample("warmup", index + 1, 6_000),
    );
    const measured = Array.from({ length: 30 }, (_, index) =>
      passedSample("measured", index + 1, 6_500),
    );
    measured[28]!.accepted_ms = 501;
    measured[29]!.accepted_ms = 501;
    const summary = summarizeBootSamples({ warmups, measured });
    const gate = evaluatePromotionGate({
      warmups,
      measured,
      summary,
      performanceReady: true,
    });

    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain(
      "request-acceptance p95 501ms exceeds 500ms",
    );
  });

  it("requires complete CPU samples and enforces host phase p95 targets", () => {
    const warmups = Array.from({ length: 5 }, (_, index) =>
      passedSample("warmup", index + 1, 6_000),
    );
    const measured = Array.from({ length: 30 }, (_, index) =>
      passedSample("measured", index + 1, 6_500),
    );
    measured[0]!.host_boot_evidence = null;
    measured[0]!.seal_projection_ready_ms = null;
    measured[0]!.seal_projection_ui_ready_ms = null;
    const summary = summarizeBootSamples({ warmups, measured });
    const gate = evaluatePromotionGate({
      warmups,
      measured,
      summary,
      performanceReady: true,
    });

    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain(
      "1 successful boot(s) lacked complete generation-fenced phase/CPU evidence",
    );
    expect(gate.reasons).toContain(
      "guest-to-Kino evidence covered 29 measured boot(s), expected 30",
    );
    expect(gate.reasons).toContain(
      "seal/projection/UI-ready evidence covered 29 measured boot(s), expected 30",
    );

    const completeMeasured = Array.from({ length: 30 }, (_, index) =>
      passedSample("measured", index + 1, 6_500),
    );
    for (const index of [28, 29]) {
      completeMeasured[index]!.host_boot_evidence!.phases.guest_to_kino_ms =
        6_501;
    }
    const completeSummary = summarizeBootSamples({
      warmups,
      measured: completeMeasured,
    });
    expect(
      evaluatePromotionGate({
        warmups,
        measured: completeMeasured,
        summary: completeSummary,
        performanceReady: true,
      }).reasons,
    ).toContain("guest-to-Kino p95 6501ms exceeds 6500ms");
  });

  it("gates the final phase through embedded terminal rendering", () => {
    const warmups = Array.from({ length: 5 }, (_, index) =>
      passedSample("warmup", index + 1, 6_000),
    );
    const measured = Array.from({ length: 30 }, (_, index) =>
      passedSample("measured", index + 1, 6_500),
    );
    for (const index of [28, 29]) {
      measured[index]!.seal_projection_ui_ready_ms = 501;
    }
    const summary = summarizeBootSamples({ warmups, measured });

    expect(
      evaluatePromotionGate({
        warmups,
        measured,
        summary,
        performanceReady: true,
      }).reasons,
    ).toContain("seal/projection/UI-ready p95 501ms exceeds 500ms");
    expect(sealProjectionReadyDurationMs(bootEvidence(), 5_000)).toBe(300);
    expect(sealProjectionUiReadyDurationMs(bootEvidence(), 5_100)).toBe(400);
    expect(sealProjectionUiReadyDurationMs(bootEvidence(), 4_699)).toBeNull();

    const invalidEvidence = bootEvidence();
    invalidEvidence.phases.total_ms = 299;
    expect(sealProjectionUiReadyDurationMs(invalidEvidence, 5_100)).toBeNull();
  });
});

describe("boot benchmark options", () => {
  const environment = {
    INTAR_LIVE_BASE_URL: "https://intar.dev",
    INTAR_LIVE_COOKIE: "session=test",
    INTAR_BOOT_BENCH_IMPLEMENTATION_SHA256: "E".repeat(64),
  };

  it("requires an explicit host, variant, and manifest", () => {
    expect(() => parseBootBenchmarkOptions([], environment)).toThrow(
      "--host is required",
    );
    expect(() =>
      parseBootBenchmarkOptions(["--host", "host-1"], environment),
    ).toThrow("--variant is required");
    expect(() =>
      parseBootBenchmarkOptions(
        ["--host", "host-1", "--variant", "fully-optimized-current-path"],
        environment,
      ),
    ).toThrow("--manifest is required");
  });

  it("defaults to the promotion sample shape", () => {
    const options = parseBootBenchmarkOptions(
      [
        "--host",
        "host-1",
        "--variant",
        "fully-optimized-current-path",
        "--manifest",
        "broken-nginx.manifest.json",
      ],
      environment,
    );

    expect(options.hostId).toBe("host-1");
    expect(options.warmups).toBe(5);
    expect(options.measuredSamples).toBe(30);
    expect(options.pollMs).toBe(100);
    expect(options.coldPrewarmStartedAtUnixMs).toBeNull();
    expect(options.implementationSha256).toBe("e".repeat(64));
  });

  it("requires a canonical deployed implementation digest", () => {
    const args = [
      "--host",
      "host-1",
      "--variant",
      "fully-optimized-current-path",
      "--manifest",
      "broken-nginx.manifest.json",
    ];
    expect(() =>
      parseBootBenchmarkOptions(args, {
        INTAR_LIVE_BASE_URL: environment.INTAR_LIVE_BASE_URL,
        INTAR_LIVE_COOKIE: environment.INTAR_LIVE_COOKIE,
      }),
    ).toThrow("--implementation-sha256");
    expect(() =>
      parseBootBenchmarkOptions(
        [...args, "--implementation-sha256", "not-a-digest"],
        environment,
      ),
    ).toThrow("64 hexadecimal characters");
  });

  it("rejects labels outside the exact comparison matrix", () => {
    expect(() =>
      parseBootBenchmarkOptions(
        [
          "--host",
          "host-1",
          "--variant",
          "optimized",
          "--manifest",
          "broken-nginx.manifest.json",
        ],
        environment,
      ),
    ).toThrow("--variant must be one of");
  });

  it("keeps the production live runner boot-lease-only", () => {
    expect(() =>
      assertLiveRunnerVariant("fully-optimized-current-path"),
    ).not.toThrow();
    expect(() => assertLiveRunnerVariant("pre-jailer-direct")).toThrow(
      "breaking v2 live runner cannot execute historical variant",
    );
    expect(() => assertLiveRunnerVariant("current-1000m-baseline")).toThrow(
      "breaking v2 live runner cannot execute historical variant",
    );
  });
});

describe("boot benchmark browser cookies", () => {
  it("parses strict Cookie pairs for one browser origin", () => {
    expect(
      parseBrowserCookies(
        "better-auth.session_token=abc==; csrf=token",
        "https://intar.dev/scenarios/broken-nginx",
      ),
    ).toEqual([
      {
        name: "better-auth.session_token",
        value: "abc==",
        url: "https://intar.dev",
      },
      { name: "csrf", value: "token", url: "https://intar.dev" },
    ]);
  });

  it("rejects duplicate cookies, Set-Cookie attributes, and unsafe URLs", () => {
    expect(() =>
      parseBrowserCookies("session=one; session=two", "https://intar.dev"),
    ).toThrow("duplicate Cookie name");
    expect(() =>
      parseBrowserCookies("session=one; Path=/", "https://intar.dev"),
    ).toThrow("Set-Cookie attribute");
    expect(() =>
      parseBrowserCookies("session=one", "https://user@intar.dev"),
    ).toThrow("credentials are not allowed");
  });
});

describe("usable-terminal marker probe", () => {
  it("never types the complete success marker into the echoed shell input", () => {
    const marker = "INTAR_BOOT_MEASURED_1_ABCDEF0123456789";
    const command = browserMarkerCommand(marker);

    expect(command).not.toContain(marker);
    expect(command).toContain(marker.slice(0, Math.ceil(marker.length / 2)));
    expect(command).toContain(marker.slice(Math.ceil(marker.length / 2)));
    expect(() => browserMarkerCommand("unsafe;marker")).toThrow(
      "at least two A-Z",
    );
  });

  it("rejects unsafe markers before opening a websocket", async () => {
    await expect(
      runUsableTerminalMarkerProbe({
        websocketUrl: "wss://example.test/terminal",
        origin: "https://example.test",
        marker: "unsafe; marker",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("only A-Z, 0-9, and underscore");
  });
});

describe("boot benchmark result schema", () => {
  it("accepts only complete browser-measured evidence", () => {
    const result = benchmarkResult("fully-optimized-current-path");

    expect(parseBootBenchmarkResult(result, "fixture")).toEqual(result);

    const stale = structuredClone(result) as unknown as {
      measured: Array<Record<string, unknown>>;
    };
    delete stale.measured[0]!.ui_terminal_ready_ms;
    expect(() => parseBootBenchmarkResult(stale, "stale")).toThrow(
      "ui_terminal_ready_ms",
    );
  });

  it("rejects noncanonical hashes and the wrong browser contract", () => {
    const result = benchmarkResult("fully-optimized-current-path");

    expect(() =>
      parseBootBenchmarkResult(
        { ...result, artifact_fingerprint_sha256: "A".repeat(64) },
        "hash",
      ),
    ).toThrow("canonical artifact_fingerprint_sha256");
    expect(() =>
      parseBootBenchmarkResult(
        {
          ...result,
          browser: { ...result.browser, headless: false },
        },
        "browser",
      ),
    ).toThrow("browser measurement evidence");
    expect(() =>
      parseBootBenchmarkResult(
        {
          ...result,
          browser: {
            ...result.browser,
            measurement_boundary: "api_request_to_terminal_report",
          },
        },
        "boundary",
      ),
    ).toThrow("browser measurement evidence");
  });

  it("rejects claimed summaries and promotion decisions that drift from evidence", () => {
    const result = benchmarkResult("fully-optimized-current-path");

    expect(() =>
      parseBootBenchmarkResult(
        {
          ...result,
          summary: { ...result.summary, measured_passed: 29 },
        },
        "summary",
      ),
    ).toThrow("summary does not match its samples");
    expect(() =>
      parseBootBenchmarkResult(
        {
          ...result,
          promotion: { ...result.promotion, passed: false },
        },
        "promotion",
      ),
    ).toThrow("promotion does not match its evidence");
  });
});

describe("boot benchmark comparison", () => {
  it("requires the exact five variants and identical execution identity", () => {
    const results = BOOT_BENCHMARK_VARIANTS.map(benchmarkResult);
    const comparison = compareBootBenchmarkResults(results, 123);

    expect(comparison.generated_at_unix_ms).toBe(123);
    expect(comparison.variants.map((variant) => variant.variant)).toEqual(
      BOOT_BENCHMARK_VARIANTS,
    );
    expect(
      comparison.variants.map((variant) => variant.cpu_policy.kind),
    ).toEqual([
      "unbounded_pre_jailer",
      "steady_only",
      "steady_only",
      "boot_lease",
      "boot_lease",
    ]);

    expect(() =>
      compareBootBenchmarkResults(
        replaceResult(results, 1, { host_id: "other-host" }),
      ),
    ).toThrow("host mismatch");
    expect(() =>
      compareBootBenchmarkResults(
        replaceResult(results, 1, {
          artifact_fingerprint_sha256: "b".repeat(64),
        }),
      ),
    ).toThrow("artifact fingerprint mismatch");
    expect(() =>
      compareBootBenchmarkResults(
        replaceResult(results, 1, {
          cloud_hypervisor_sha256: "c".repeat(64),
          host: {
            ...results[1]!.host,
            capabilities: {
              ...results[1]!.host.capabilities,
              cloud_hypervisor_sha256: "c".repeat(64),
            },
          },
        }),
      ),
    ).toThrow("Cloud Hypervisor hash mismatch");
    expect(() => compareBootBenchmarkResults(results.slice(0, 4))).toThrow(
      "requires exactly 5",
    );
    expect(() =>
      compareBootBenchmarkResults(
        replaceResult(results, 2, {
          cpu_policy:
            BOOT_BENCHMARK_CPU_POLICIES["current-2000m-boot-to-1000m-steady"],
        }),
      ),
    ).toThrow("CPU policy mismatch for current-1000m-baseline");
    expect(() =>
      compareBootBenchmarkResults(
        replaceResult(results, 4, {
          implementation_sha256: results[3]!.implementation_sha256,
        }),
      ),
    ).toThrow("duplicate benchmark implementation_sha256");
    const driftedArtifacts = {
      ...results[1]!.artifacts,
      vms: [artifactVm("unexpected")],
    };
    expect(() =>
      compareBootBenchmarkResults(
        replaceResult(results, 1, {
          artifact_fingerprint_sha256:
            bootArtifactFingerprint(driftedArtifacts),
          artifacts: driftedArtifacts,
        }),
      ),
    ).toThrow("artifact fingerprint mismatch");
    expect(() =>
      compareBootBenchmarkResults(
        replaceResult(results, 1, {
          browser: {
            ...results[1]!.browser,
            chromium_version: "different",
          },
        }),
      ),
    ).toThrow("browser version mismatch");
    expect(() =>
      compareBootBenchmarkResults(
        replaceResult(results, 1, {
          summary: { ...results[1]!.summary, measured_passed: 29 },
        }),
      ),
    ).toThrow("summary does not match its samples");
  });
});

describe("boot benchmark readiness and isolation", () => {
  it("requires a nonempty generation before treating a terminal as ready", () => {
    expect(
      hasBootBenchmarkReadyVm(readyScenarioRun("generation-1"), 1_000),
    ).toBe(true);
    expect(hasBootBenchmarkReadyVm(readyScenarioRun(""), 1_000)).toBe(false);
  });

  it("rejects attributed and unattributed foreign VMs", () => {
    expect(() =>
      assertNoForeignHostRuns(
        { liveVms: [{ name: "owned", run_id: "run-1" }] },
        "run-1",
      ),
    ).not.toThrow();
    expect(() =>
      assertNoForeignHostRuns(
        { liveVms: [{ name: "foreign", run_id: null }] },
        "run-1",
      ),
    ).toThrow("foreign VM(s)");
  });

  it("requires the measured run to remain present on the pinned host", () => {
    expect(() =>
      assertOwnedHostRun(
        { liveVms: [{ name: "owned", run_id: "run-1" }] },
        "run-1",
      ),
    ).not.toThrow();
    expect(() => assertOwnedHostRun({ liveVms: [] }, "run-1")).toThrow(
      "was not observed on the pinned host",
    );
    expect(() =>
      assertOwnedHostRun(
        {
          liveVms: [
            { name: "owned", run_id: "run-1" },
            { name: "foreign", run_id: "run-2" },
          ],
        },
        "run-1",
      ),
    ).toThrow("foreign VM(s)");
  });
});

function passedSample(
  kind: "warmup" | "measured",
  ordinal: number,
  usableTerminalMs: number,
): PassedBootSampleV1 {
  return {
    kind,
    ordinal,
    status: "passed",
    run_id: `${kind}-${ordinal}`,
    started_at_unix_ms: 1,
    server_accepted_at_unix_ms: 101,
    accepted_ms: 100,
    terminal_report_ready_ms: 5_000,
    ui_terminal_ready_ms: 5_100,
    terminal_websocket_ready_ms: 5_150,
    usable_terminal_ms: usableTerminalMs,
    seal_projection_ready_ms: 300,
    seal_projection_ui_ready_ms: 400,
    phase_evidence: {
      run_created_at_unix_ms: 101,
      vm_created_at_unix_ms: 201,
      quota_verified_at_unix_ms: 4_801,
      runtime_report_observed_at_unix_ms: 4_901,
      terminal_report_observed_at_unix_ms: 5_001,
      ssh_verified_at_unix_ms: 4_951,
      projection_observed_at_unix_ms: 5_051,
      ui_terminal_ready_at_unix_ms: 5_101,
      terminal_websocket_ready_at_unix_ms: 5_151,
      offsets_ms: {
        run_created: 100,
        vm_created: 200,
        quota_verified: 4_800,
        runtime_report_observed: 4_900,
        terminal_report_observed: 5_000,
        ssh_verified: 4_950,
        projection_observed: 5_050,
        ui_terminal_ready: 5_100,
        terminal_websocket_ready: 5_150,
      },
    },
    runtime_evidence: {
      generation: "generation-1",
      phase: "steady",
      steady_cpu_millis: 1_000,
      effective_cpu_millis: 1_000,
      quota_verified_at_unix_ms: 4_801,
      lease_expires_at_unix_ms: null,
    },
    host_boot_evidence: bootEvidence(),
    cpu_evidence: {
      status: "unavailable",
      observed_at_unix_ms: null,
      generation: "generation-1",
      resource_state: null,
      unavailable_reason: "test fixture",
    },
    teardown_ms: 100,
  };
}

function bootEvidence(): NonNullable<PassedBootSampleV1["host_boot_evidence"]> {
  const cpuSample = (
    point: NonNullable<
      PassedBootSampleV1["host_boot_evidence"]
    >["cpu_samples"][number]["point"],
    phase: "boot_burst" | "steady",
  ) => ({
    point,
    sampled_at_unix_ms: 2,
    phase,
    steady_cpu_millis: 1_000,
    effective_cpu_millis: phase === "boot_burst" ? 2_000 : 1_000,
    boot_deadline_unix_ms: phase === "boot_burst" ? 45_000 : null,
    cpu_max: phase === "boot_burst" ? "200000 100000" : "100000 100000",
    cpu_max_burst: 0,
    quota_verified_at_unix_ms: 2,
    usage_usec: 1,
    user_usec: 1,
    system_usec: 0,
    nr_periods: 1,
    nr_throttled: 0,
    throttled_usec: 0,
  });
  return {
    generation: "generation-1",
    started_at_unix_ms: 1,
    ready_at_unix_ms: 5_001,
    phases: {
      image_disk_ms: 200,
      network_jailer_vmm_ms: 500,
      guest_to_kino_ms: 4_000,
      seal_ssh_publish_ms: 300,
      total_ms: 5_000,
      image_cache_ms: 100,
      runtime_disk_ms: 100,
      network_ms: 100,
      jailer_stage_ms: 200,
      vmm_start_ms: 100,
      vm_api_ms: 100,
      quota_seal_ms: 100,
      ssh_verify_ms: 100,
      terminal_publish_ms: 100,
    },
    cpu_samples: [
      cpuSample("vm_boot_accepted", "boot_burst"),
      cpuSample("kino_ready", "boot_burst"),
      cpuSample("pre_seal", "boot_burst"),
      cpuSample("post_seal", "steady"),
      cpuSample("terminal_published", "steady"),
    ],
  };
}

function benchmarkResult(variant: BootBenchmarkVariant): BootBenchmarkResultV1 {
  const warmups = Array.from({ length: 5 }, (_, index) =>
    passedSample("warmup", index + 1, 6_000),
  );
  const measured = Array.from({ length: 30 }, (_, index) =>
    passedSample("measured", index + 1, 6_500),
  );
  const summary = summarizeBootSamples({ warmups, measured });
  const artifacts = {
    scenario_id: "broken-nginx",
    vms: [artifactVm("webserver")],
  } satisfies BootBenchmarkResultV1["artifacts"];
  return {
    schema_version: 1,
    generated_at_unix_ms: 1,
    variant,
    scenario_id: "broken-nginx",
    host_id: "host-1",
    base_url_origin: "https://intar.dev",
    manifest_path: "/tmp/manifest.json",
    implementation_sha256: (BOOT_BENCHMARK_VARIANTS.indexOf(variant) + 1)
      .toString(16)
      .repeat(64),
    artifact_fingerprint_sha256: bootArtifactFingerprint(artifacts),
    artifacts,
    cloud_hypervisor_sha256: "d".repeat(64),
    browser: {
      automation: "playwright",
      playwright_version: "1.61.1",
      browser_name: "chromium",
      chromium_version: "141.0.7390.37",
      headless: true,
      context_reused: true,
      page_reused: true,
      measurement_boundary: BOOT_BENCHMARK_MEASUREMENT_BOUNDARY,
    },
    cpu_policy: BOOT_BENCHMARK_CPU_POLICIES[variant],
    host: {
      agent_version: "test",
      observed_at_unix_ms: 1,
      capabilities: {
        cloud_hypervisor_sha256: "d".repeat(64),
        boot_cpu_millis:
          BOOT_BENCHMARK_CPU_POLICIES[variant].host_boot_cpu_millis,
        boot_cpu_lease_ms:
          BOOT_BENCHMARK_CPU_POLICIES[variant].boot_cpu_lease_ms,
      },
      performance_ready: true,
    },
    prewarm: {
      ready_before_benchmark: true,
      host_observed_at_unix_ms: 1,
      cached_images: [],
      cold: null,
    },
    parameters: {
      warmups: 5,
      measured_samples: 30,
      poll_ms: 100,
      wait_ready_ms: 120_000,
      wait_idle_ms: 240_000,
      terminal_probe_timeout_ms: 15_000,
    },
    isolation: {
      preflight_idle_required: true,
      continuous_foreign_vm_monitor: true,
      monitor_poll_max_ms: 250,
      atomic_host_lease: false,
    },
    warmups,
    measured,
    summary,
    promotion: evaluatePromotionGate({
      warmups,
      measured,
      summary,
      performanceReady: true,
    }),
  };
}

function artifactVm(
  name: string,
): BootBenchmarkResultV1["artifacts"]["vms"][number] {
  return {
    name,
    image_key: {
      scenario: "broken-nginx",
      vm: name,
      arch: "x86_64",
    },
    image_sha256: "1".repeat(64),
    image_format: "raw_zstd",
    image_virtual_size_bytes: 4_294_967_296,
    kernel_sha256: "2".repeat(64),
    initrd_sha256: "3".repeat(64),
    boot_cmdline: "console=ttyS0",
    cpu_millis: 1_000,
    vcpu_count: 1,
    memory_mib: 512,
    disk_mib: 4_096,
  };
}

function replaceResult(
  results: readonly BootBenchmarkResultV1[],
  index: number,
  patch: Partial<BootBenchmarkResultV1>,
): BootBenchmarkResultV1[] {
  return results.map((result, candidateIndex) =>
    candidateIndex === index ? { ...result, ...patch } : result,
  );
}

function readyScenarioRun(generation: string): ScenarioRunRecord {
  return {
    createdAt: 1,
    canOpenTerminal: true,
    vms: [
      {
        canOpenTerminal: true,
        terminalPhase: "ready",
        terminalObservedAt: 8,
        vmCreatedAt: 2,
        runtimeObservedAt: 8,
        terminalTarget: {
          host: "127.0.0.1",
          port: 22,
          username: "ubuntu",
          hostKeyOpenssh: "ssh-ed25519 test",
          checkedAt: 7,
        },
        runtimeConstraints: {
          generation,
          phase: "steady",
          steadyCpuMillis: 1_000,
          effectiveCpuMillis: 1_000,
          quotaVerifiedAt: 6,
          leaseExpiresAt: null,
        },
      },
    ],
  } as unknown as ScenarioRunRecord;
}
