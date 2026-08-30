import { describe, expect, it } from "vitest";
import type { HostStateReportV2 } from "@/generated/bridge";
import type { RequiredScenarioImage } from "@/lib/scenario-host-readiness";
import { hostHasImagesReady } from "@/lib/scenario-host-readiness";

const required: RequiredScenarioImage[] = [
  {
    imageKey: { scenario: "pair-ping", vm: "web", arch: "x86_64" },
    imageSha256: "a".repeat(64),
  },
];

describe("hostHasImagesReady", () => {
  it("accepts an empty required image list", () => {
    expect(hostHasImagesReady(null, [])).toBe(true);
  });

  it("accepts ready cached images with matching sha", () => {
    expect(hostHasImagesReady(report("ready", "a".repeat(64)), required)).toBe(
      true,
    );
  });

  it("rejects wrong sha, non-ready phases, and missing entries", () => {
    expect(hostHasImagesReady(report("ready", "b".repeat(64)), required)).toBe(
      false,
    );
    expect(
      hostHasImagesReady(report("downloading", "a".repeat(64)), required),
    ).toBe(false);
    expect(hostHasImagesReady(report("failed", "a".repeat(64)), required)).toBe(
      false,
    );
    expect(hostHasImagesReady(report("ready", "a".repeat(64), []), required))
      .toBe(false);
  });
});

function report(
  phase: HostStateReportV2["cached_images"][number]["phase"],
  imageSha256: string,
  cachedImages: HostStateReportV2["cached_images"] = [
    {
      image_key: { scenario: "pair-ping", vm: "web", arch: "x86_64" },
      image_id: imageSha256,
      phase,
      bytes_on_disk: 1024,
      error: null,
      updated_at_unix_ms: 1_762_041_660_000,
    },
  ],
): HostStateReportV2 {
  return {
    schema_version: 4,
    host_id: "host-alpha",
    observed_at_unix_ms: 1_762_041_660_000,
    applied_desired_version: 1,
    capacity: {
      total_cpu_millis: 8_000,
      reserved_cpu_millis: 1_000,
      schedulable_cpu_millis: 7_000,
      committed_cpu_millis: 0,
      memory_total_mib: 32_768,
      memory_available_mib: 24_576,
      disk_probe_path: "/var/lib/intar-agent",
      disk_total_mib: 524_288,
      disk_available_mib: 400_000,
    },
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256: "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
      boot_cpu_millis: 2_000,
      boot_cpu_lease_ms: 45_000,
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v2: true,
      supports_jailer_v3: true,
      supports_raw_chunks_v1: true,
      supports_scenario_guest_tools_v1: true,
      supports_boot_cpu_lease: true,
      supports_template_backed_launch: true,
      fast_template_store: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
    },
    cached_images: cachedImages,
    vms: [],
    builds: [],
  };
}
