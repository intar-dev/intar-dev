import { describe, expect, it } from "vitest";
import type { DesiredVmV3 } from "@/generated/contracts/bridge-message-v9";
import { selectOverdueRunLeases } from "@/lib/scenario-run-leases";

describe("selectOverdueRunLeases", () => {
  it("groups only running VMs whose lease is strictly overdue", () => {
    expect(
      selectOverdueRunLeases(
        { owner_user_id: "user-1", scope: "platform",
          schema_version: 7,
          host_id: "host-alpha",
          version: 1,
          generated_at_unix_ms: 1_000,
          cached_images: [],
          builds: [],
          source_compiles: [],
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
): DesiredVmV3 {
  return {
    owner_user_id: "user-1", runtime_execution_id: runId, generation: 1, vm_id: vmName, run_id: runId, name: vmName,
    desired_phase: desiredPhase, image: `sha256:${"a".repeat(64)}`, spec: `sha256:${"b".repeat(64)}`,
    kino: `sha256:${"c".repeat(64)}`, mode: "learn", cpu_millis: 1_000, memory_mib: 512, disk_mib: 4, egress: false,
    terminal: true, peers: [], ssh_authorized_keys: ["ssh-ed25519 AAAATEST"], lease_expires_at_unix_ms: leaseExpiresAt,
  };
}
