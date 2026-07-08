import { describe, expect, it } from "vitest";
import type { HostStateReportV1 } from "@/generated/bridge";
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
  phase: HostStateReportV1["cached_images"][number]["phase"],
  imageSha256: string,
  cachedImages: HostStateReportV1["cached_images"] = [
    {
      image_key: { scenario: "pair-ping", vm: "web", arch: "x86_64" },
      image_sha256: imageSha256,
      phase,
      bytes_on_disk: 1024,
      error: null,
      updated_at_unix_ms: 1_762_041_660_000,
    },
  ],
): HostStateReportV1 {
  return {
    schema_version: 2,
    host_id: "host-alpha",
    observed_at_unix_ms: 1_762_041_660_000,
    applied_desired_version: 1,
    capacity: {
      cpu_count: 8,
      memory_total_mib: 32_768,
      memory_available_mib: 24_576,
      disk_probe_path: "/var/lib/intar-agent",
      disk_total_mib: 524_288,
      disk_available_mib: 400_000,
    },
    capabilities: {
      arch: "x86_64",
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
    },
    cached_images: cachedImages,
    vms: [],
    builds: [],
  };
}
