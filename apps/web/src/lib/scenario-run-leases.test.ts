import { describe, expect, it } from "vitest";
import type { HostDesiredStateV2 } from "@/generated/bridge";
import { selectOverdueRunLeases } from "@/lib/scenario-run-leases";

describe("selectOverdueRunLeases", () => {
  it("groups only running VMs whose lease is strictly overdue", () => {
    expect(
      selectOverdueRunLeases(
        {
          schema_version: 3,
          host_id: "host-alpha",
          version: 1,
          generated_at_unix_ms: 1_000,
          cached_images: [],
          builds: [],
          vms: [
            desiredVm("run-b", "db", 999, "running"),
            desiredVm("run-a", "web", 900, "running"),
            desiredVm("run-a", "db", 1_000, "running"),
            desiredVm("run-c", "old", 500, "absent"),
          ],
        },
        1_000,
      ),
    ).toEqual([
      { runId: "run-a", vmNames: ["web"] },
      { runId: "run-b", vmNames: ["db"] },
    ]);
  });
});

function desiredVm(
  runId: string,
  vmName: string,
  leaseExpiresAt: number,
  desiredPhase: "running" | "absent",
): HostDesiredStateV2["vms"][number] {
  return {
    run_id: runId,
    vm_name: vmName,
    desired_phase: desiredPhase,
    image_key: { scenario: "scenario", vm: vmName, arch: "x86_64" },
    image_id: "a".repeat(64),
    guest_tools: {
      tools_disk_sha256: "1".repeat(64),
      tools_disk_size_bytes: 64 * 1024 * 1024,
      kino_sha256: "2".repeat(64),
      bootstrap_abi: 1,
    },
    resources: {
      cpu_millis: 1_000,
      vcpu_count: 1,
      memory_mib: 512,
      disk_mib: 4,
    },
    ssh_authorized_keys_openssh: ["ssh-ed25519 AAAATEST"],
    lease_expires_at_unix_ms: leaseExpiresAt,
  };
}
