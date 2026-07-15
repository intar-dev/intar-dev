import { createHash } from "node:crypto";
import type { ScenarioManifestV3 } from "../src/generated/catalog";
import type { VmBootEvidenceV1 } from "../src/generated/bridge";

export const BOOT_BENCHMARK_SCHEMA_VERSION = 1 as const;
export const PROMOTION_WARMUP_COUNT = 5;
export const PROMOTION_SAMPLE_COUNT = 30;
export const PROMOTION_P50_MAX_MS = 7_000;
export const PROMOTION_P95_EXCLUSIVE_MAX_MS = 10_000;
export const PROMOTION_ACCEPT_P95_MAX_MS = 500;
export const PROMOTION_IMAGE_DISK_P95_MAX_MS = 500;
export const PROMOTION_NETWORK_JAILER_VMM_P95_MAX_MS = 1_500;
export const PROMOTION_GUEST_TO_KINO_P95_MAX_MS = 6_500;
export const PROMOTION_SEAL_PROJECTION_UI_READY_P95_MAX_MS = 500;

export const BOOT_BENCHMARK_MEASUREMENT_BOUNDARY =
  "start_scenario_button_click_to_xterm_marker" as const;

export const BOOT_BENCHMARK_VARIANTS = [
  "pre-jailer-direct",
  "exact-jailer-cutover",
  "current-1000m-baseline",
  "current-2000m-boot-to-1000m-steady",
  "fully-optimized-current-path",
] as const;

export type BootBenchmarkVariant = (typeof BOOT_BENCHMARK_VARIANTS)[number];

export interface BootBenchmarkCpuPolicyV1 {
  kind: "unbounded_pre_jailer" | "steady_only" | "boot_lease";
  scenario_steady_cpu_millis: 1000;
  guest_vcpu_count: 1;
  host_steady_cpu_millis: 1000 | null;
  host_boot_cpu_millis: 1000 | 2000 | null;
  boot_cpu_lease_ms: 45000 | null;
}

export const BOOT_BENCHMARK_CPU_POLICIES: Record<
  BootBenchmarkVariant,
  BootBenchmarkCpuPolicyV1
> = {
  "pre-jailer-direct": {
    kind: "unbounded_pre_jailer",
    scenario_steady_cpu_millis: 1_000,
    guest_vcpu_count: 1,
    host_steady_cpu_millis: null,
    host_boot_cpu_millis: null,
    boot_cpu_lease_ms: null,
  },
  "exact-jailer-cutover": {
    kind: "steady_only",
    scenario_steady_cpu_millis: 1_000,
    guest_vcpu_count: 1,
    host_steady_cpu_millis: 1_000,
    host_boot_cpu_millis: 1_000,
    boot_cpu_lease_ms: null,
  },
  "current-1000m-baseline": {
    kind: "steady_only",
    scenario_steady_cpu_millis: 1_000,
    guest_vcpu_count: 1,
    host_steady_cpu_millis: 1_000,
    host_boot_cpu_millis: 1_000,
    boot_cpu_lease_ms: null,
  },
  "current-2000m-boot-to-1000m-steady": {
    kind: "boot_lease",
    scenario_steady_cpu_millis: 1_000,
    guest_vcpu_count: 1,
    host_steady_cpu_millis: 1_000,
    host_boot_cpu_millis: 2_000,
    boot_cpu_lease_ms: 45_000,
  },
  "fully-optimized-current-path": {
    kind: "boot_lease",
    scenario_steady_cpu_millis: 1_000,
    guest_vcpu_count: 1,
    host_steady_cpu_millis: 1_000,
    host_boot_cpu_millis: 2_000,
    boot_cpu_lease_ms: 45_000,
  },
};

export interface BootArtifactIdentityV1 {
  scenario_id: string;
  vms: Array<{
    name: string;
    image_key: ScenarioManifestV3["vms"][number]["image_key"];
    image_sha256: string;
    image_format: string;
    image_virtual_size_bytes: number;
    kernel_sha256: string;
    initrd_sha256: string;
    boot_cmdline: string;
    cpu_millis: number;
    vcpu_count: number;
    memory_mib: number;
    disk_mib: number;
  }>;
}

export interface PassedBootSampleV1 {
  kind: "warmup" | "measured";
  ordinal: number;
  status: "passed";
  run_id: string;
  started_at_unix_ms: number;
  server_accepted_at_unix_ms: number;
  accepted_ms: number;
  terminal_report_ready_ms: number;
  ui_terminal_ready_ms: number;
  terminal_websocket_ready_ms: number;
  usable_terminal_ms: number;
  /// Conservative single-clock upper bound from seal start through the first
  /// control-plane projection that exposes terminal readiness. It includes
  /// click-to-agent dispatch delay and therefore cannot understate the phase.
  seal_projection_ready_ms: number | null;
  /// Conservative single-clock upper bound from seal start through the first
  /// embedded xterm render. This is the promotion boundary.
  seal_projection_ui_ready_ms: number | null;
  phase_evidence: {
    run_created_at_unix_ms: number;
    vm_created_at_unix_ms: number;
    quota_verified_at_unix_ms: number;
    runtime_report_observed_at_unix_ms: number;
    terminal_report_observed_at_unix_ms: number;
    ssh_verified_at_unix_ms: number;
    projection_observed_at_unix_ms: number;
    ui_terminal_ready_at_unix_ms: number;
    terminal_websocket_ready_at_unix_ms: number;
    offsets_ms: {
      run_created: number;
      vm_created: number;
      quota_verified: number;
      runtime_report_observed: number;
      terminal_report_observed: number;
      ssh_verified: number;
      projection_observed: number;
      ui_terminal_ready: number;
      terminal_websocket_ready: number;
    };
  };
  runtime_evidence: {
    generation: string;
    phase: "steady";
    steady_cpu_millis: number;
    effective_cpu_millis: number;
    quota_verified_at_unix_ms: number;
    lease_expires_at_unix_ms: number | null;
  };
  host_boot_evidence: VmBootEvidenceV1 | null;
  cpu_evidence: {
    status: "available" | "unavailable";
    observed_at_unix_ms: number | null;
    generation: string;
    resource_state: {
      cpu_millis: number;
      vcpu_count: number;
      cpu_quota_us: number;
      cpu_period_us: number;
      cpu_usage_usec: number;
      cpu_user_usec: number;
      cpu_system_usec: number;
      cpu_nr_periods: number;
      cpu_nr_throttled: number;
      cpu_throttled_usec: number;
    } | null;
    unavailable_reason: string | null;
  };
  teardown_ms: number;
}

export interface FailedBootSampleV1 {
  kind: "warmup" | "measured";
  ordinal: number;
  status: "failed";
  run_id: string | null;
  started_at_unix_ms: number;
  elapsed_ms: number;
  error: string;
  teardown_ms: number | null;
}

export type BootSampleV1 = PassedBootSampleV1 | FailedBootSampleV1;

export interface DurationDistributionV1 {
  count: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  mean_ms: number;
}

export interface BootBenchmarkSummaryV1 {
  warmup_passed: number;
  warmup_failed: number;
  measured_passed: number;
  measured_failed: number;
  accepted_ms: DurationDistributionV1 | null;
  terminal_report_ready_ms: DurationDistributionV1 | null;
  ui_terminal_ready_ms: DurationDistributionV1 | null;
  terminal_websocket_ready_ms: DurationDistributionV1 | null;
  usable_terminal_ms: DurationDistributionV1 | null;
  image_disk_ms: DurationDistributionV1 | null;
  network_jailer_vmm_ms: DurationDistributionV1 | null;
  guest_to_kino_ms: DurationDistributionV1 | null;
  /// Diagnostic agent-local duration. Promotion uses the conservative
  /// projection-and-UI upper bound below.
  seal_ssh_publish_ms: DurationDistributionV1 | null;
  seal_projection_ready_ms: DurationDistributionV1 | null;
  seal_projection_ui_ready_ms: DurationDistributionV1 | null;
}

export interface BootPromotionGateV1 {
  passed: boolean;
  reasons: string[];
  requirements: {
    warmups: 5;
    measured_samples: 30;
    accept_p95_max_ms: 500;
    p50_max_ms: 7000;
    p95_exclusive_max_ms: 10000;
    image_disk_p95_max_ms: 500;
    network_jailer_vmm_p95_max_ms: 1500;
    guest_to_kino_p95_max_ms: 6500;
    seal_projection_ui_ready_p95_max_ms: 500;
  };
}

export interface BootBenchmarkResultV1 {
  schema_version: typeof BOOT_BENCHMARK_SCHEMA_VERSION;
  generated_at_unix_ms: number;
  variant: BootBenchmarkVariant;
  scenario_id: string;
  host_id: string;
  base_url_origin: string;
  manifest_path: string;
  /// SHA-256 identity of the deployed control-plane/agent/jailerd
  /// implementation and its rollout configuration.
  implementation_sha256: string;
  artifact_fingerprint_sha256: string;
  artifacts: BootArtifactIdentityV1;
  cloud_hypervisor_sha256: string;
  browser: {
    automation: "playwright";
    playwright_version: string;
    browser_name: "chromium";
    chromium_version: string;
    headless: true;
    context_reused: true;
    page_reused: true;
    measurement_boundary: typeof BOOT_BENCHMARK_MEASUREMENT_BOUNDARY;
  };
  cpu_policy: BootBenchmarkCpuPolicyV1;
  host: {
    agent_version: string | null;
    observed_at_unix_ms: number;
    capabilities: Record<string, boolean | string | number | null>;
    performance_ready: boolean;
  };
  prewarm: {
    ready_before_benchmark: true;
    host_observed_at_unix_ms: number;
    cached_images: Array<{
      scenario: string;
      vm: string;
      arch: string;
      image_sha256: string;
      ready_at_unix_ms: number;
    }>;
    cold: {
      started_at_unix_ms: number;
      ready_at_unix_ms: number;
      duration_ms: number;
    } | null;
  };
  parameters: {
    warmups: number;
    measured_samples: number;
    poll_ms: number;
    wait_ready_ms: number;
    wait_idle_ms: number;
    terminal_probe_timeout_ms: number;
  };
  isolation: {
    preflight_idle_required: true;
    continuous_foreign_vm_monitor: true;
    monitor_poll_max_ms: number;
    atomic_host_lease: false;
  };
  warmups: BootSampleV1[];
  measured: BootSampleV1[];
  summary: BootBenchmarkSummaryV1;
  promotion: BootPromotionGateV1;
}

export interface BootBenchmarkComparisonV1 {
  schema_version: 1;
  generated_at_unix_ms: number;
  host_id: string;
  scenario_id: string;
  artifact_fingerprint_sha256: string;
  cloud_hypervisor_sha256: string;
  browser: BootBenchmarkResultV1["browser"];
  variants: Array<{
    variant: BootBenchmarkVariant;
    implementation_sha256: string;
    cpu_policy: BootBenchmarkCpuPolicyV1;
    passed: boolean;
    p50_ms: number | null;
    p95_ms: number | null;
    measured_passed: number;
    measured_failed: number;
  }>;
}

export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number {
  if (values.length === 0) {
    throw new Error("cannot calculate a percentile from an empty sample");
  }
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error(`percentile must be in (0, 100], got ${percentile}`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

export function durationDistribution(
  values: readonly number[],
): DurationDistributionV1 | null {
  if (values.length === 0) return null;
  values.forEach((value) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `duration must be a non-negative finite number, got ${value}`,
      );
    }
  });
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min_ms: sorted[0]!,
    p50_ms: nearestRankPercentile(sorted, 50),
    p95_ms: nearestRankPercentile(sorted, 95),
    max_ms: sorted.at(-1)!,
    mean_ms: Math.round((sum / sorted.length) * 100) / 100,
  };
}

export function sealProjectionReadyDurationMs(
  evidence: VmBootEvidenceV1 | null,
  projectionObservedElapsedMs: number,
): number | null {
  return sealObservationUpperBoundMs(evidence, projectionObservedElapsedMs);
}

export function sealProjectionUiReadyDurationMs(
  evidence: VmBootEvidenceV1 | null,
  uiTerminalReadyElapsedMs: number,
): number | null {
  return sealObservationUpperBoundMs(evidence, uiTerminalReadyElapsedMs);
}

/**
 * Derive a conservative seal-to-observation upper bound without subtracting
 * wall clocks from different machines. The observation is timed from the
 * browser click. The host-monotonic `total - seal_ssh_publish` segment is the
 * VM-boot-start-to-seal-start duration. VM boot cannot start before the click,
 * so the remainder includes dispatch delay and cannot understate the true
 * seal-to-observation duration.
 */
function sealObservationUpperBoundMs(
  evidence: VmBootEvidenceV1 | null,
  observationElapsedMs: number,
): number | null {
  if (
    !evidence ||
    !Number.isSafeInteger(evidence.phases.total_ms) ||
    evidence.phases.total_ms < 0 ||
    !Number.isSafeInteger(evidence.phases.seal_ssh_publish_ms) ||
    evidence.phases.seal_ssh_publish_ms < 0 ||
    evidence.phases.total_ms < evidence.phases.seal_ssh_publish_ms ||
    !Number.isSafeInteger(observationElapsedMs) ||
    observationElapsedMs < 0
  ) {
    return null;
  }
  const bootStartToSealStartMs =
    evidence.phases.total_ms - evidence.phases.seal_ssh_publish_ms;
  if (observationElapsedMs < bootStartToSealStartMs) return null;
  return observationElapsedMs - bootStartToSealStartMs;
}

export function summarizeBootSamples(input: {
  warmups: readonly BootSampleV1[];
  measured: readonly BootSampleV1[];
}): BootBenchmarkSummaryV1 {
  const warmupPassed = input.warmups.filter(isPassedSample);
  const measuredPassed = input.measured.filter(isPassedSample);
  return {
    warmup_passed: warmupPassed.length,
    warmup_failed: input.warmups.length - warmupPassed.length,
    measured_passed: measuredPassed.length,
    measured_failed: input.measured.length - measuredPassed.length,
    accepted_ms: durationDistribution(
      measuredPassed.map((sample) => sample.accepted_ms),
    ),
    terminal_report_ready_ms: durationDistribution(
      measuredPassed.map((sample) => sample.terminal_report_ready_ms),
    ),
    ui_terminal_ready_ms: durationDistribution(
      measuredPassed.map((sample) => sample.ui_terminal_ready_ms),
    ),
    terminal_websocket_ready_ms: durationDistribution(
      measuredPassed.map((sample) => sample.terminal_websocket_ready_ms),
    ),
    usable_terminal_ms: durationDistribution(
      measuredPassed.map((sample) => sample.usable_terminal_ms),
    ),
    image_disk_ms: durationDistribution(
      measuredPassed.flatMap((sample) =>
        sample.host_boot_evidence
          ? [sample.host_boot_evidence.phases.image_disk_ms]
          : [],
      ),
    ),
    network_jailer_vmm_ms: durationDistribution(
      measuredPassed.flatMap((sample) =>
        sample.host_boot_evidence
          ? [sample.host_boot_evidence.phases.network_jailer_vmm_ms]
          : [],
      ),
    ),
    guest_to_kino_ms: durationDistribution(
      measuredPassed.flatMap((sample) =>
        sample.host_boot_evidence
          ? [sample.host_boot_evidence.phases.guest_to_kino_ms]
          : [],
      ),
    ),
    seal_ssh_publish_ms: durationDistribution(
      measuredPassed.flatMap((sample) =>
        sample.host_boot_evidence
          ? [sample.host_boot_evidence.phases.seal_ssh_publish_ms]
          : [],
      ),
    ),
    seal_projection_ready_ms: durationDistribution(
      measuredPassed.flatMap((sample) =>
        sample.seal_projection_ready_ms === null
          ? []
          : [sample.seal_projection_ready_ms],
      ),
    ),
    seal_projection_ui_ready_ms: durationDistribution(
      measuredPassed.flatMap((sample) =>
        sample.seal_projection_ui_ready_ms === null
          ? []
          : [sample.seal_projection_ui_ready_ms],
      ),
    ),
  };
}

export function evaluatePromotionGate(input: {
  warmups: readonly BootSampleV1[];
  measured: readonly BootSampleV1[];
  summary: BootBenchmarkSummaryV1;
  performanceReady: boolean;
}): BootPromotionGateV1 {
  const reasons: string[] = [];
  if (!input.performanceReady) {
    reasons.push("host did not attest the complete fast-launch capability set");
  }
  if (input.warmups.length !== PROMOTION_WARMUP_COUNT) {
    reasons.push(
      `expected ${PROMOTION_WARMUP_COUNT} warmups, got ${input.warmups.length}`,
    );
  }
  if (input.measured.length !== PROMOTION_SAMPLE_COUNT) {
    reasons.push(
      `expected ${PROMOTION_SAMPLE_COUNT} measured samples, got ${input.measured.length}`,
    );
  }
  if (input.summary.warmup_failed > 0) {
    reasons.push(`${input.summary.warmup_failed} warmup boot(s) failed`);
  }
  if (input.summary.measured_failed > 0) {
    reasons.push(`${input.summary.measured_failed} measured boot(s) failed`);
  }
  if (input.summary.measured_passed !== PROMOTION_SAMPLE_COUNT) {
    reasons.push(
      `expected ${PROMOTION_SAMPLE_COUNT} successful measured boots, got ${input.summary.measured_passed}`,
    );
  }

  const passedSamples = [...input.warmups, ...input.measured].filter(
    isPassedSample,
  );
  const missingBootEvidence = passedSamples.filter(
    (sample) => !hasCompleteBootEvidence(sample),
  );
  if (missingBootEvidence.length > 0) {
    reasons.push(
      `${missingBootEvidence.length} successful boot(s) lacked complete generation-fenced phase/CPU evidence`,
    );
  }

  const accepted = input.summary.accepted_ms;
  if (!accepted) {
    reasons.push("no successful request-acceptance measurements were recorded");
  } else if (accepted.p95_ms > PROMOTION_ACCEPT_P95_MAX_MS) {
    reasons.push(
      `request-acceptance p95 ${accepted.p95_ms}ms exceeds ${PROMOTION_ACCEPT_P95_MAX_MS}ms`,
    );
  }

  const distribution = input.summary.usable_terminal_ms;
  if (!distribution) {
    reasons.push("no successful usable-terminal measurements were recorded");
  } else {
    if (distribution.p50_ms > PROMOTION_P50_MAX_MS) {
      reasons.push(
        `usable-terminal p50 ${distribution.p50_ms}ms exceeds ${PROMOTION_P50_MAX_MS}ms`,
      );
    }
    if (distribution.p95_ms >= PROMOTION_P95_EXCLUSIVE_MAX_MS) {
      reasons.push(
        `usable-terminal p95 ${distribution.p95_ms}ms is not below ${PROMOTION_P95_EXCLUSIVE_MAX_MS}ms`,
      );
    }
  }

  checkPhaseP95(
    reasons,
    "image/disk",
    input.summary.image_disk_ms,
    PROMOTION_IMAGE_DISK_P95_MAX_MS,
  );
  checkPhaseP95(
    reasons,
    "network/jailer/VMM",
    input.summary.network_jailer_vmm_ms,
    PROMOTION_NETWORK_JAILER_VMM_P95_MAX_MS,
  );
  checkPhaseP95(
    reasons,
    "guest-to-Kino",
    input.summary.guest_to_kino_ms,
    PROMOTION_GUEST_TO_KINO_P95_MAX_MS,
  );
  checkPhaseP95(
    reasons,
    "seal/projection/UI-ready",
    input.summary.seal_projection_ui_ready_ms,
    PROMOTION_SEAL_PROJECTION_UI_READY_P95_MAX_MS,
  );

  return {
    passed: reasons.length === 0,
    reasons,
    requirements: {
      warmups: 5,
      measured_samples: 30,
      accept_p95_max_ms: 500,
      p50_max_ms: 7000,
      p95_exclusive_max_ms: 10000,
      image_disk_p95_max_ms: 500,
      network_jailer_vmm_p95_max_ms: 1500,
      guest_to_kino_p95_max_ms: 6500,
      seal_projection_ui_ready_p95_max_ms: 500,
    },
  };
}

function hasCompleteBootEvidence(sample: PassedBootSampleV1): boolean {
  const evidence = sample.host_boot_evidence;
  if (!evidence || evidence.generation !== sample.runtime_evidence.generation) {
    return false;
  }
  const points = new Set(evidence.cpu_samples.map((cpu) => cpu.point));
  const requiredPoints: Array<(typeof evidence.cpu_samples)[number]["point"]> =
    [
      "vm_boot_accepted",
      "kino_ready",
      "pre_seal",
      "post_seal",
      "terminal_published",
    ];
  return (
    evidence.cpu_samples.length === 5 &&
    requiredPoints.every((point) => points.has(point)) &&
    evidence.cpu_samples.every((cpu) => cpu.cpu_max_burst === 0)
  );
}

function checkPhaseP95(
  reasons: string[],
  label: string,
  distribution: DurationDistributionV1 | null,
  maximumMs: number,
): void {
  if (!distribution || distribution.count !== PROMOTION_SAMPLE_COUNT) {
    reasons.push(
      `${label} evidence covered ${distribution?.count ?? 0} measured boot(s), expected ${PROMOTION_SAMPLE_COUNT}`,
    );
  } else if (distribution.p95_ms > maximumMs) {
    reasons.push(
      `${label} p95 ${distribution.p95_ms}ms exceeds ${maximumMs}ms`,
    );
  }
}

export function bootArtifactIdentity(
  manifest: ScenarioManifestV3,
): BootArtifactIdentityV1 {
  return {
    scenario_id: manifest.scenario_id,
    vms: [...manifest.vms]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((vm) => ({
        name: vm.name,
        image_key: vm.image_key,
        image_sha256: vm.image_sha256.toLowerCase(),
        image_format: vm.image_format,
        image_virtual_size_bytes: vm.image_virtual_size_bytes,
        kernel_sha256: vm.boot.kernel_sha256.toLowerCase(),
        initrd_sha256: vm.boot.initrd_sha256.toLowerCase(),
        boot_cmdline: vm.boot.cmdline,
        cpu_millis: vm.cpu_millis,
        vcpu_count: vm.vcpu_count,
        memory_mib: vm.memory_mib,
        disk_mib: vm.disk_mib,
      })),
  };
}

export function bootArtifactFingerprint(
  identity: BootArtifactIdentityV1,
): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function compareBootBenchmarkResults(
  results: readonly BootBenchmarkResultV1[],
  nowUnixMs = Date.now(),
): BootBenchmarkComparisonV1 {
  if (results.length !== BOOT_BENCHMARK_VARIANTS.length) {
    throw new Error(
      `comparison requires exactly ${BOOT_BENCHMARK_VARIANTS.length} benchmark results (${BOOT_BENCHMARK_VARIANTS.join(", ")})`,
    );
  }
  const first = results[0]!;
  const variants = new Set<string>();
  const implementations = new Map<string, string>();
  const derivedEvidence = new Map<
    BootBenchmarkVariant,
    {
      summary: BootBenchmarkSummaryV1;
      promotion: BootPromotionGateV1;
    }
  >();
  for (const result of results) {
    if (variants.has(result.variant)) {
      throw new Error(`duplicate benchmark variant: ${result.variant}`);
    }
    variants.add(result.variant);
    if (!/^[a-f0-9]{64}$/.test(result.implementation_sha256)) {
      throw new Error(
        `benchmark ${result.variant} is missing a canonical implementation_sha256`,
      );
    }
    const duplicateImplementation = implementations.get(
      result.implementation_sha256,
    );
    if (duplicateImplementation) {
      throw new Error(
        `duplicate benchmark implementation_sha256: ${result.variant} and ${duplicateImplementation} used the same deployed implementation`,
      );
    }
    implementations.set(result.implementation_sha256, result.variant);
    const expectedPolicy =
      BOOT_BENCHMARK_CPU_POLICIES[result.variant as BootBenchmarkVariant];
    if (!expectedPolicy) {
      throw new Error(`unexpected benchmark variant: ${result.variant}`);
    }
    if (!sameCpuPolicy(result.cpu_policy, expectedPolicy)) {
      throw new Error(
        `CPU policy mismatch for ${result.variant}: expected ${JSON.stringify(expectedPolicy)}, got ${JSON.stringify(result.cpu_policy)}`,
      );
    }
    if (result.host_id !== first.host_id) {
      throw new Error(
        `host mismatch: ${result.variant} used ${result.host_id}, expected ${first.host_id}`,
      );
    }
    if (result.scenario_id !== first.scenario_id) {
      throw new Error(
        `scenario mismatch: ${result.variant} used ${result.scenario_id}, expected ${first.scenario_id}`,
      );
    }
    if (
      result.artifact_fingerprint_sha256 !== first.artifact_fingerprint_sha256
    ) {
      throw new Error(`artifact fingerprint mismatch for ${result.variant}`);
    }
    if (!isCanonicalSha256(result.artifact_fingerprint_sha256)) {
      throw new Error(
        `benchmark ${result.variant} is missing a canonical artifact_fingerprint_sha256`,
      );
    }
    if (
      bootArtifactFingerprint(result.artifacts) !==
      result.artifact_fingerprint_sha256
    ) {
      throw new Error(
        `benchmark ${result.variant} artifact fingerprint does not match its identity`,
      );
    }
    if (result.artifacts.scenario_id !== result.scenario_id) {
      throw new Error(
        `benchmark ${result.variant} artifact identity does not match its scenario`,
      );
    }
    if (!sameJsonValue(result.artifacts, first.artifacts)) {
      throw new Error(`artifact identity mismatch for ${result.variant}`);
    }
    if (!/^[a-f0-9]{64}$/.test(result.cloud_hypervisor_sha256)) {
      throw new Error(
        `benchmark ${result.variant} is missing a canonical cloud_hypervisor_sha256`,
      );
    }
    if (
      result.host.capabilities.cloud_hypervisor_sha256 !==
      result.cloud_hypervisor_sha256
    ) {
      throw new Error(
        `benchmark ${result.variant} does not use its host-attested Cloud Hypervisor hash`,
      );
    }
    if (
      (result.host.capabilities.boot_cpu_millis ?? null) !==
      expectedPolicy.host_boot_cpu_millis
    ) {
      throw new Error(
        `benchmark ${result.variant} did not attest its expected host boot CPU policy`,
      );
    }
    if (
      (result.host.capabilities.boot_cpu_lease_ms ?? null) !==
      expectedPolicy.boot_cpu_lease_ms
    ) {
      throw new Error(
        `benchmark ${result.variant} did not attest its expected boot lease policy`,
      );
    }
    if (
      first.cloud_hypervisor_sha256 &&
      result.cloud_hypervisor_sha256 !== first.cloud_hypervisor_sha256
    ) {
      throw new Error(`Cloud Hypervisor hash mismatch for ${result.variant}`);
    }
    if (
      result.browser.measurement_boundary !==
        BOOT_BENCHMARK_MEASUREMENT_BOUNDARY ||
      result.browser.automation !== "playwright" ||
      result.browser.browser_name !== "chromium" ||
      result.browser.headless !== true ||
      result.browser.context_reused !== true ||
      result.browser.page_reused !== true
    ) {
      throw new Error(
        `invalid browser measurement contract for ${result.variant}`,
      );
    }
    if (
      result.browser.playwright_version !== first.browser.playwright_version ||
      result.browser.chromium_version !== first.browser.chromium_version
    ) {
      throw new Error(`browser version mismatch for ${result.variant}`);
    }
    const recomputedSummary = recomputeSummary(result, result.variant);
    const recomputedPromotion = evaluatePromotionGate({
      warmups: result.warmups,
      measured: result.measured,
      summary: recomputedSummary,
      performanceReady: result.host.performance_ready,
    });
    if (!sameJsonValue(result.summary, recomputedSummary)) {
      throw new Error(
        `benchmark ${result.variant} summary does not match its samples`,
      );
    }
    if (!sameJsonValue(result.promotion, recomputedPromotion)) {
      throw new Error(
        `benchmark ${result.variant} promotion does not match its evidence`,
      );
    }
    derivedEvidence.set(result.variant, {
      summary: recomputedSummary,
      promotion: recomputedPromotion,
    });
  }
  for (const required of BOOT_BENCHMARK_VARIANTS) {
    if (!variants.has(required)) {
      throw new Error(`comparison is missing required variant: ${required}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(first.cloud_hypervisor_sha256)) {
    throw new Error(
      `benchmark ${first.variant} is missing a canonical cloud_hypervisor_sha256`,
    );
  }

  return {
    schema_version: 1,
    generated_at_unix_ms: nowUnixMs,
    host_id: first.host_id,
    scenario_id: first.scenario_id,
    artifact_fingerprint_sha256: first.artifact_fingerprint_sha256,
    cloud_hypervisor_sha256: first.cloud_hypervisor_sha256,
    browser: first.browser,
    variants: BOOT_BENCHMARK_VARIANTS.map((variant) => {
      const result = results.find(
        (candidate) => candidate.variant === variant,
      )!;
      const derived = derivedEvidence.get(variant)!;
      return {
        variant: result.variant,
        implementation_sha256: result.implementation_sha256,
        cpu_policy: result.cpu_policy,
        passed: derived.promotion.passed,
        p50_ms: derived.summary.usable_terminal_ms?.p50_ms ?? null,
        p95_ms: derived.summary.usable_terminal_ms?.p95_ms ?? null,
        measured_passed: derived.summary.measured_passed,
        measured_failed: derived.summary.measured_failed,
      };
    }),
  };
}

function sameCpuPolicy(
  actual: BootBenchmarkCpuPolicyV1 | undefined,
  expected: BootBenchmarkCpuPolicyV1,
): boolean {
  return Boolean(
    actual &&
    actual.kind === expected.kind &&
    actual.scenario_steady_cpu_millis === expected.scenario_steady_cpu_millis &&
    actual.guest_vcpu_count === expected.guest_vcpu_count &&
    actual.host_steady_cpu_millis === expected.host_steady_cpu_millis &&
    actual.host_boot_cpu_millis === expected.host_boot_cpu_millis &&
    actual.boot_cpu_lease_ms === expected.boot_cpu_lease_ms,
  );
}

export function parseBootBenchmarkResult(
  value: unknown,
  label: string,
): BootBenchmarkResultV1 {
  if (
    !isRecord(value) ||
    value.schema_version !== BOOT_BENCHMARK_SCHEMA_VERSION
  ) {
    throw new Error(`${label} is not a boot benchmark schema_version 1 result`);
  }
  if (!isNonNegativeSafeInteger(value.generated_at_unix_ms)) {
    throw new Error(`${label} has invalid generated_at_unix_ms`);
  }
  for (const field of [
    "variant",
    "scenario_id",
    "host_id",
    "base_url_origin",
    "manifest_path",
    "implementation_sha256",
    "artifact_fingerprint_sha256",
    "cloud_hypervisor_sha256",
  ] as const) {
    if (!isNonEmptyString(value[field])) {
      throw new Error(`${label} has invalid ${field}`);
    }
  }
  if (
    !BOOT_BENCHMARK_VARIANTS.includes(value.variant as BootBenchmarkVariant)
  ) {
    throw new Error(`${label} has invalid benchmark variant`);
  }
  for (const field of [
    "implementation_sha256",
    "artifact_fingerprint_sha256",
    "cloud_hypervisor_sha256",
  ] as const) {
    if (!isCanonicalSha256(value[field])) {
      throw new Error(`${label} has invalid canonical ${field}`);
    }
  }
  if (!isOrigin(value.base_url_origin)) {
    throw new Error(`${label} has invalid base_url_origin`);
  }
  assertArtifactIdentity(value.artifacts, `${label}.artifacts`);
  if (value.artifacts.scenario_id !== value.scenario_id) {
    throw new Error(`${label} artifact identity does not match scenario_id`);
  }
  if (
    bootArtifactFingerprint(value.artifacts) !==
    value.artifact_fingerprint_sha256
  ) {
    throw new Error(
      `${label} artifact fingerprint does not match its identity`,
    );
  }
  if (
    !isRecord(value.browser) ||
    value.browser.automation !== "playwright" ||
    value.browser.browser_name !== "chromium" ||
    value.browser.measurement_boundary !==
      BOOT_BENCHMARK_MEASUREMENT_BOUNDARY ||
    value.browser.headless !== true ||
    value.browser.context_reused !== true ||
    value.browser.page_reused !== true ||
    !isNonEmptyString(value.browser.playwright_version) ||
    !isNonEmptyString(value.browser.chromium_version)
  ) {
    throw new Error(`${label} has invalid browser measurement evidence`);
  }
  const variant = value.variant as BootBenchmarkVariant;
  const expectedPolicy = BOOT_BENCHMARK_CPU_POLICIES[variant];
  if (
    !isRecord(value.cpu_policy) ||
    !sameCpuPolicy(
      value.cpu_policy as unknown as BootBenchmarkCpuPolicyV1,
      expectedPolicy,
    )
  ) {
    throw new Error(`${label} has invalid CPU policy for ${variant}`);
  }
  assertHostEvidence(value.host, `${label}.host`);
  if (
    value.host.capabilities.cloud_hypervisor_sha256 !==
    value.cloud_hypervisor_sha256
  ) {
    throw new Error(`${label} does not use its host-attested runtime hash`);
  }
  if (
    (value.host.capabilities.boot_cpu_millis ?? null) !==
      expectedPolicy.host_boot_cpu_millis ||
    (value.host.capabilities.boot_cpu_lease_ms ?? null) !==
      expectedPolicy.boot_cpu_lease_ms
  ) {
    throw new Error(`${label} does not use its host-attested CPU policy`);
  }
  assertPrewarmEvidence(value.prewarm, `${label}.prewarm`);
  assertParameters(value.parameters, `${label}.parameters`);
  assertIsolation(value.isolation, `${label}.isolation`);
  if (!Array.isArray(value.warmups) || !Array.isArray(value.measured)) {
    throw new Error(`${label} is missing benchmark samples`);
  }
  value.warmups.forEach((sample, index) =>
    assertBootSample(sample, "warmup", index + 1, `${label}.warmups[${index}]`),
  );
  value.measured.forEach((sample, index) =>
    assertBootSample(
      sample,
      "measured",
      index + 1,
      `${label}.measured[${index}]`,
    ),
  );
  if (
    !isRecord(value.parameters) ||
    value.parameters.warmups !== value.warmups.length ||
    value.parameters.measured_samples !== value.measured.length
  ) {
    throw new Error(`${label} sample counts do not match parameters`);
  }
  assertSummary(value.summary, `${label}.summary`);
  assertPromotion(value.promotion, `${label}.promotion`);

  const result = value as unknown as BootBenchmarkResultV1;
  const recomputedSummary = recomputeSummary(result, label);
  const recomputedPromotion = evaluatePromotionGate({
    warmups: result.warmups,
    measured: result.measured,
    summary: recomputedSummary,
    performanceReady: result.host.performance_ready,
  });
  if (!sameJsonValue(result.summary, recomputedSummary)) {
    throw new Error(`${label} summary does not match its samples`);
  }
  if (!sameJsonValue(result.promotion, recomputedPromotion)) {
    throw new Error(`${label} promotion does not match its evidence`);
  }
  return result;
}

function recomputeSummary(
  result: Pick<BootBenchmarkResultV1, "warmups" | "measured">,
  label: string,
): BootBenchmarkSummaryV1 {
  try {
    return summarizeBootSamples({
      warmups: result.warmups,
      measured: result.measured,
    });
  } catch (error) {
    throw new Error(
      `${label} contains invalid benchmark samples: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertArtifactIdentity(
  value: unknown,
  label: string,
): asserts value is BootArtifactIdentityV1 {
  if (!isRecord(value) || !isNonEmptyString(value.scenario_id)) {
    throw new Error(`${label} is invalid`);
  }
  if (!Array.isArray(value.vms) || value.vms.length !== 1) {
    throw new Error(`${label}.vms must contain exactly one VM`);
  }
  const names: string[] = [];
  value.vms.forEach((vm, index) => {
    const vmLabel = `${label}.vms[${index}]`;
    if (!isRecord(vm)) throw new Error(`${vmLabel} is invalid`);
    for (const field of ["name", "image_format"] as const) {
      if (!isNonEmptyString(vm[field])) {
        throw new Error(`${vmLabel}.${field} is invalid`);
      }
    }
    if (typeof vm.boot_cmdline !== "string") {
      throw new Error(`${vmLabel}.boot_cmdline is invalid`);
    }
    for (const field of [
      "image_sha256",
      "kernel_sha256",
      "initrd_sha256",
    ] as const) {
      if (!isCanonicalSha256(vm[field])) {
        throw new Error(`${vmLabel}.${field} is not a canonical SHA-256`);
      }
    }
    if (
      !isRecord(vm.image_key) ||
      !isNonEmptyString(vm.image_key.scenario) ||
      !isNonEmptyString(vm.image_key.vm) ||
      (vm.image_key.arch !== "x86_64" && vm.image_key.arch !== "aarch64")
    ) {
      throw new Error(`${vmLabel}.image_key is invalid`);
    }
    for (const field of [
      "image_virtual_size_bytes",
      "cpu_millis",
      "vcpu_count",
      "memory_mib",
      "disk_mib",
    ] as const) {
      if (!isPositiveSafeInteger(vm[field])) {
        throw new Error(`${vmLabel}.${field} is invalid`);
      }
    }
    names.push(vm.name as string);
  });
  const sortedNames = [...names].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    new Set(names).size !== names.length ||
    !names.every((name, index) => name === sortedNames[index])
  ) {
    throw new Error(`${label}.vms must have unique names in canonical order`);
  }
}

function assertHostEvidence(
  value: unknown,
  label: string,
): asserts value is BootBenchmarkResultV1["host"] {
  if (
    !isRecord(value) ||
    (value.agent_version !== null && !isNonEmptyString(value.agent_version)) ||
    !isNonNegativeSafeInteger(value.observed_at_unix_ms) ||
    typeof value.performance_ready !== "boolean" ||
    !isRecord(value.capabilities)
  ) {
    throw new Error(`${label} is invalid`);
  }
  if (
    !Object.values(value.capabilities).every(
      (capability) =>
        capability === null ||
        typeof capability === "boolean" ||
        typeof capability === "string" ||
        (typeof capability === "number" && Number.isFinite(capability)),
    )
  ) {
    throw new Error(`${label}.capabilities is invalid`);
  }
}

function assertPrewarmEvidence(
  value: unknown,
  label: string,
): asserts value is BootBenchmarkResultV1["prewarm"] {
  if (
    !isRecord(value) ||
    value.ready_before_benchmark !== true ||
    !isNonNegativeSafeInteger(value.host_observed_at_unix_ms) ||
    !Array.isArray(value.cached_images)
  ) {
    throw new Error(`${label} is invalid`);
  }
  value.cached_images.forEach((image, index) => {
    if (
      !isRecord(image) ||
      !isNonEmptyString(image.scenario) ||
      !isNonEmptyString(image.vm) ||
      !isNonEmptyString(image.arch) ||
      !isCanonicalSha256(image.image_sha256) ||
      !isNonNegativeSafeInteger(image.ready_at_unix_ms)
    ) {
      throw new Error(`${label}.cached_images[${index}] is invalid`);
    }
  });
  if (value.cold !== null) {
    if (
      !isRecord(value.cold) ||
      !isNonNegativeSafeInteger(value.cold.started_at_unix_ms) ||
      !isNonNegativeSafeInteger(value.cold.ready_at_unix_ms) ||
      !isNonNegativeFinite(value.cold.duration_ms)
    ) {
      throw new Error(`${label}.cold is invalid`);
    }
  }
}

function assertParameters(
  value: unknown,
  label: string,
): asserts value is BootBenchmarkResultV1["parameters"] {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  for (const field of [
    "warmups",
    "measured_samples",
    "poll_ms",
    "wait_ready_ms",
    "wait_idle_ms",
    "terminal_probe_timeout_ms",
  ] as const) {
    if (!isNonNegativeSafeInteger(value[field])) {
      throw new Error(`${label}.${field} is invalid`);
    }
  }
}

function assertIsolation(
  value: unknown,
  label: string,
): asserts value is BootBenchmarkResultV1["isolation"] {
  if (
    !isRecord(value) ||
    value.preflight_idle_required !== true ||
    value.continuous_foreign_vm_monitor !== true ||
    value.atomic_host_lease !== false ||
    !isNonNegativeSafeInteger(value.monitor_poll_max_ms)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertBootSample(
  value: unknown,
  expectedKind: BootSampleV1["kind"],
  expectedOrdinal: number,
  label: string,
): asserts value is BootSampleV1 {
  if (
    !isRecord(value) ||
    value.kind !== expectedKind ||
    value.ordinal !== expectedOrdinal ||
    !isNonNegativeSafeInteger(value.started_at_unix_ms)
  ) {
    throw new Error(`${label} has invalid sample identity`);
  }
  if (value.status === "failed") {
    if (
      (value.run_id !== null && !isNonEmptyString(value.run_id)) ||
      !isNonNegativeFinite(value.elapsed_ms) ||
      !isNonEmptyString(value.error) ||
      (value.teardown_ms !== null && !isNonNegativeFinite(value.teardown_ms))
    ) {
      throw new Error(`${label} has invalid failure evidence`);
    }
    return;
  }
  if (value.status !== "passed" || !isNonEmptyString(value.run_id)) {
    throw new Error(`${label} has invalid status`);
  }
  if (!isNonNegativeSafeInteger(value.server_accepted_at_unix_ms)) {
    throw new Error(`${label}.server_accepted_at_unix_ms is invalid`);
  }
  const durationFields = [
    "accepted_ms",
    "terminal_report_ready_ms",
    "ui_terminal_ready_ms",
    "terminal_websocket_ready_ms",
    "usable_terminal_ms",
    "teardown_ms",
  ] as const;
  for (const field of durationFields) {
    if (!isNonNegativeFinite(value[field])) {
      throw new Error(
        `${label}.${field} is invalid; complete browser UI evidence is required`,
      );
    }
  }
  const uiTerminalReadyMs = value.ui_terminal_ready_ms as number;
  const terminalWebsocketReadyMs = value.terminal_websocket_ready_ms as number;
  const usableTerminalMs = value.usable_terminal_ms as number;
  if (
    uiTerminalReadyMs > terminalWebsocketReadyMs ||
    terminalWebsocketReadyMs > usableTerminalMs
  ) {
    throw new Error(`${label} has invalid browser UI event ordering`);
  }
  for (const field of [
    "seal_projection_ready_ms",
    "seal_projection_ui_ready_ms",
  ] as const) {
    if (value[field] !== null && !isNonNegativeFinite(value[field])) {
      throw new Error(`${label}.${field} is invalid`);
    }
  }
  assertPhaseEvidence(value.phase_evidence, `${label}.phase_evidence`);
  assertRuntimeEvidence(value.runtime_evidence, `${label}.runtime_evidence`);
  if (value.host_boot_evidence !== null) {
    assertHostBootEvidence(
      value.host_boot_evidence,
      `${label}.host_boot_evidence`,
    );
  }
  const hostBootEvidence = value.host_boot_evidence as VmBootEvidenceV1 | null;
  const expectedProjectionUpperBound = sealProjectionReadyDurationMs(
    hostBootEvidence,
    value.terminal_report_ready_ms as number,
  );
  const expectedUiUpperBound = sealProjectionUiReadyDurationMs(
    hostBootEvidence,
    value.ui_terminal_ready_ms as number,
  );
  if (
    !Object.is(value.seal_projection_ready_ms, expectedProjectionUpperBound) ||
    !Object.is(value.seal_projection_ui_ready_ms, expectedUiUpperBound)
  ) {
    throw new Error(
      `${label} has invalid conservative seal/projection/UI upper bounds`,
    );
  }
  assertCpuEvidence(value.cpu_evidence, `${label}.cpu_evidence`);
}

function assertPhaseEvidence(
  value: unknown,
  label: string,
): asserts value is PassedBootSampleV1["phase_evidence"] {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  for (const field of [
    "run_created_at_unix_ms",
    "vm_created_at_unix_ms",
    "quota_verified_at_unix_ms",
    "runtime_report_observed_at_unix_ms",
    "terminal_report_observed_at_unix_ms",
    "ssh_verified_at_unix_ms",
    "projection_observed_at_unix_ms",
    "ui_terminal_ready_at_unix_ms",
    "terminal_websocket_ready_at_unix_ms",
  ] as const) {
    if (!isNonNegativeSafeInteger(value[field])) {
      throw new Error(`${label}.${field} is invalid`);
    }
  }
  const uiTerminalReadyAtUnixMs = value.ui_terminal_ready_at_unix_ms as number;
  const terminalWebsocketReadyAtUnixMs =
    value.terminal_websocket_ready_at_unix_ms as number;
  if (uiTerminalReadyAtUnixMs > terminalWebsocketReadyAtUnixMs) {
    throw new Error(`${label} has invalid browser UI event ordering`);
  }
  if (!isRecord(value.offsets_ms)) {
    throw new Error(`${label}.offsets_ms is invalid`);
  }
  for (const field of [
    "run_created",
    "vm_created",
    "quota_verified",
    "runtime_report_observed",
    "terminal_report_observed",
    "ssh_verified",
    "projection_observed",
    "ui_terminal_ready",
    "terminal_websocket_ready",
  ] as const) {
    if (!isFiniteNumber(value.offsets_ms[field])) {
      throw new Error(`${label}.offsets_ms.${field} is invalid`);
    }
  }
}

function assertRuntimeEvidence(
  value: unknown,
  label: string,
): asserts value is PassedBootSampleV1["runtime_evidence"] {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.generation) ||
    value.phase !== "steady" ||
    !isNonNegativeFinite(value.steady_cpu_millis) ||
    !isNonNegativeFinite(value.effective_cpu_millis) ||
    !isNonNegativeSafeInteger(value.quota_verified_at_unix_ms) ||
    (value.lease_expires_at_unix_ms !== null &&
      !isNonNegativeSafeInteger(value.lease_expires_at_unix_ms))
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertHostBootEvidence(
  value: unknown,
  label: string,
): asserts value is VmBootEvidenceV1 {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.generation) ||
    !isNonNegativeSafeInteger(value.started_at_unix_ms) ||
    !isNonNegativeSafeInteger(value.ready_at_unix_ms) ||
    !isRecord(value.phases) ||
    !Array.isArray(value.cpu_samples)
  ) {
    throw new Error(`${label} is invalid`);
  }
  for (const field of [
    "image_disk_ms",
    "network_jailer_vmm_ms",
    "guest_to_kino_ms",
    "seal_ssh_publish_ms",
    "total_ms",
    "image_cache_ms",
    "runtime_disk_ms",
    "network_ms",
    "jailer_stage_ms",
    "vmm_start_ms",
    "vm_api_ms",
    "quota_seal_ms",
    "ssh_verify_ms",
    "terminal_publish_ms",
  ] as const) {
    if (!isNonNegativeFinite(value.phases[field])) {
      throw new Error(`${label}.phases.${field} is invalid`);
    }
  }
  value.cpu_samples.forEach((sample, index) => {
    if (!isRecord(sample)) {
      throw new Error(`${label}.cpu_samples[${index}] is invalid`);
    }
    if (
      ![
        "vm_boot_accepted",
        "kino_ready",
        "pre_seal",
        "post_seal",
        "terminal_published",
      ].includes(sample.point as string) ||
      (sample.phase !== "boot_burst" && sample.phase !== "steady") ||
      !isNonEmptyString(sample.cpu_max)
    ) {
      throw new Error(`${label}.cpu_samples[${index}] is invalid`);
    }
    for (const field of [
      "sampled_at_unix_ms",
      "steady_cpu_millis",
      "effective_cpu_millis",
      "cpu_max_burst",
      "quota_verified_at_unix_ms",
      "usage_usec",
      "user_usec",
      "system_usec",
      "nr_periods",
      "nr_throttled",
      "throttled_usec",
    ] as const) {
      if (!isNonNegativeFinite(sample[field])) {
        throw new Error(`${label}.cpu_samples[${index}].${field} is invalid`);
      }
    }
    if (
      sample.boot_deadline_unix_ms !== null &&
      sample.boot_deadline_unix_ms !== undefined &&
      !isNonNegativeSafeInteger(sample.boot_deadline_unix_ms)
    ) {
      throw new Error(
        `${label}.cpu_samples[${index}].boot_deadline_unix_ms is invalid`,
      );
    }
  });
}

function assertCpuEvidence(
  value: unknown,
  label: string,
): asserts value is PassedBootSampleV1["cpu_evidence"] {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.generation) ||
    (value.status !== "available" && value.status !== "unavailable") ||
    (value.observed_at_unix_ms !== null &&
      !isNonNegativeSafeInteger(value.observed_at_unix_ms)) ||
    (value.unavailable_reason !== null &&
      !isNonEmptyString(value.unavailable_reason))
  ) {
    throw new Error(`${label} is invalid`);
  }
  if (value.resource_state !== null) {
    if (!isRecord(value.resource_state)) {
      throw new Error(`${label}.resource_state is invalid`);
    }
    for (const field of [
      "cpu_millis",
      "vcpu_count",
      "cpu_quota_us",
      "cpu_period_us",
      "cpu_usage_usec",
      "cpu_user_usec",
      "cpu_system_usec",
      "cpu_nr_periods",
      "cpu_nr_throttled",
      "cpu_throttled_usec",
    ] as const) {
      if (!isNonNegativeFinite(value.resource_state[field])) {
        throw new Error(`${label}.resource_state.${field} is invalid`);
      }
    }
  }
  if (
    (value.status === "available" && value.unavailable_reason !== null) ||
    (value.status === "unavailable" &&
      (value.resource_state !== null || value.unavailable_reason === null))
  ) {
    throw new Error(`${label} has inconsistent status evidence`);
  }
}

function assertSummary(
  value: unknown,
  label: string,
): asserts value is BootBenchmarkSummaryV1 {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  for (const field of [
    "warmup_passed",
    "warmup_failed",
    "measured_passed",
    "measured_failed",
  ] as const) {
    if (!isNonNegativeSafeInteger(value[field])) {
      throw new Error(`${label}.${field} is invalid`);
    }
  }
  for (const field of [
    "accepted_ms",
    "terminal_report_ready_ms",
    "ui_terminal_ready_ms",
    "terminal_websocket_ready_ms",
    "usable_terminal_ms",
    "image_disk_ms",
    "network_jailer_vmm_ms",
    "guest_to_kino_ms",
    "seal_ssh_publish_ms",
    "seal_projection_ready_ms",
    "seal_projection_ui_ready_ms",
  ] as const) {
    assertDistribution(value[field], `${label}.${field}`);
  }
}

function assertDistribution(
  value: unknown,
  label: string,
): asserts value is DurationDistributionV1 | null {
  if (value === null) return;
  if (
    !isRecord(value) ||
    !isPositiveSafeInteger(value.count) ||
    !isNonNegativeFinite(value.min_ms) ||
    !isNonNegativeFinite(value.p50_ms) ||
    !isNonNegativeFinite(value.p95_ms) ||
    !isNonNegativeFinite(value.max_ms) ||
    !isNonNegativeFinite(value.mean_ms) ||
    value.min_ms > value.p50_ms ||
    value.p50_ms > value.p95_ms ||
    value.p95_ms > value.max_ms
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertPromotion(
  value: unknown,
  label: string,
): asserts value is BootPromotionGateV1 {
  if (
    !isRecord(value) ||
    typeof value.passed !== "boolean" ||
    !Array.isArray(value.reasons) ||
    !value.reasons.every((reason) => typeof reason === "string") ||
    !isRecord(value.requirements)
  ) {
    throw new Error(`${label} is invalid`);
  }
  for (const field of [
    "warmups",
    "measured_samples",
    "accept_p95_max_ms",
    "p50_max_ms",
    "p95_exclusive_max_ms",
    "image_disk_p95_max_ms",
    "network_jailer_vmm_p95_max_ms",
    "guest_to_kino_p95_max_ms",
    "seal_projection_ui_ready_p95_max_ms",
  ] as const) {
    if (!isNonNegativeSafeInteger(value.requirements[field])) {
      throw new Error(`${label}.requirements.${field} is invalid`);
    }
  }
}

function isCanonicalSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isOrigin(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && sameJsonValue(left[key], right[key]),
      )
    );
  }
  return false;
}

function isPassedSample(sample: BootSampleV1): sample is PassedBootSampleV1 {
  return sample.status === "passed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
