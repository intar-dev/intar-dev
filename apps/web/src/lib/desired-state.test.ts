import { describe, expect, it } from "vitest";
import type {
  DesiredCachedImageV1,
  DesiredBuildV1,
  DesiredVmV2,
  HostDesiredStateV2,
} from "@/generated/bridge";
import {
  clearDesiredBuilds,
  clearDesiredCachedImages,
  clearDesiredVms,
  createEmptyHostDesiredState,
  desiredVmFromRunVm,
  markDesiredVmAbsent,
  mutateDesiredState,
  upsertDesiredCachedImage,
  upsertDesiredBuild,
  upsertDesiredVm,
} from "@/lib/desired-state";
import { buildInitialRunState } from "@/lib/run-state";

describe("desired state", () => {
  it("creates an empty version zero host document", () => {
    expect(createEmptyHostDesiredState({
      hostId: "host-alpha",
      nowUnixMs: 1_762_041_600_000,
    })).toEqual({
      schema_version: 4,
      host_id: "host-alpha",
      version: 0,
      generated_at_unix_ms: 1_762_041_600_000,
      cached_images: [],
      cached_guest_tools: [],
      vms: [],
      builds: [],
    });
  });

  it("bumps the version and timestamp when desired content changes", () => {
    const current = createEmptyHostDesiredState({
      hostId: "host-alpha",
      nowUnixMs: 1_762_041_600_000,
    });
    const next = mutateDesiredState(
      current,
      (draft) => {
        upsertDesiredCachedImage(draft, cachedImage("webserver", "sha-a"));
        upsertDesiredVm(draft, desiredVm("run-a", "webserver", "sha-a"));
        upsertDesiredBuild(draft, desiredBuild("build-a"));
      },
      { nowUnixMs: 1_762_041_660_000 },
    );

    expect(next.version).toBe(1);
    expect(next.generated_at_unix_ms).toBe(1_762_041_660_000);
    expect(next.cached_images).toHaveLength(1);
    expect(next.vms).toHaveLength(1);
    expect(next.builds).toHaveLength(1);
    expect(current.cached_images).toHaveLength(0);
    expect(current.vms).toHaveLength(0);
    expect(current.builds).toHaveLength(0);
  });

  it("returns the original document for no-op mutations", () => {
    const current = hostDesiredState({
      version: 7,
      cachedImages: [cachedImage("webserver", "sha-a")],
      vms: [desiredVm("run-a", "webserver", "sha-a")],
      builds: [desiredBuild("build-a")],
    });

    const next = mutateDesiredState(
      current,
      (draft) => {
        upsertDesiredCachedImage(draft, cachedImage("webserver", "sha-a"));
        upsertDesiredVm(draft, desiredVm("run-a", "webserver", "sha-a"));
        upsertDesiredBuild(draft, desiredBuild("build-a"));
      },
      { nowUnixMs: 1_762_041_660_000 },
    );

    expect(next).toBe(current);
  });

  it("deduplicates by image key and vm identity with last write winning", () => {
    const current = createEmptyHostDesiredState({
      hostId: "host-alpha",
      nowUnixMs: 1_762_041_600_000,
    });
    const next = mutateDesiredState(
      current,
      (draft) => {
        draft.cached_images.push(cachedImage("webserver", "sha-a"));
        draft.cached_images.push(cachedImage("webserver", "sha-b"));
        draft.vms.push(desiredVm("run-a", "webserver", "sha-a"));
        draft.vms.push(desiredVm("run-a", "webserver", "sha-b"));
        draft.builds.push(desiredBuild("build-a", "hash-a"));
        draft.builds.push(desiredBuild("build-a", "hash-b"));
      },
      { nowUnixMs: 1_762_041_660_000 },
    );

    expect(next.cached_images).toEqual([
      cachedImage("webserver", "sha-a"),
      cachedImage("webserver", "sha-b"),
    ]);
    expect(next.vms).toEqual([desiredVm("run-a", "webserver", "sha-b")]);
    expect(next.builds).toEqual([desiredBuild("build-a", "hash-b")]);
  });

  it("marks only the matching run and vm absent", () => {
    const current = hostDesiredState({
      version: 3,
      vms: [
        desiredVm("run-a", "webserver", "sha-a"),
        desiredVm("run-b", "webserver", "sha-a"),
      ],
    });
    const next = mutateDesiredState(
      current,
      (draft) => {
        expect(markDesiredVmAbsent(draft, {
          runId: "run-a",
          vmName: "webserver",
        })).toBe(true);
      },
      { nowUnixMs: 1_762_041_660_000 },
    );

    expect(next.version).toBe(4);
    expect(next.vms.map((vm) => [vm.run_id, vm.desired_phase])).toEqual([
      ["run-a", "absent"],
      ["run-b", "running"],
    ]);
  });

  it("does not bump when marking a missing vm absent", () => {
    const current = hostDesiredState({
      version: 3,
      vms: [desiredVm("run-a", "webserver", "sha-a")],
    });
    const next = mutateDesiredState(
      current,
      (draft) => {
        expect(markDesiredVmAbsent(draft, {
          runId: "run-b",
          vmName: "webserver",
        })).toBe(false);
      },
      { nowUnixMs: 1_762_041_660_000 },
    );

    expect(next).toBe(current);
  });

  it("clears role-incompatible desired work", () => {
    const current = hostDesiredState({
      version: 3,
      cachedImages: [cachedImage("webserver", "sha-a")],
      vms: [desiredVm("run-a", "webserver", "sha-a")],
      builds: [desiredBuild("build-a")],
    });
    const next = mutateDesiredState(
      current,
      (draft) => {
        expect(clearDesiredCachedImages(draft)).toBe(true);
        expect(clearDesiredVms(draft)).toBe(true);
        expect(clearDesiredBuilds(draft)).toBe(true);
      },
      { nowUnixMs: 1_762_041_660_000 },
    );

    expect(next.version).toBe(4);
    expect(next.cached_images).toEqual([]);
    expect(next.vms).toEqual([]);
    expect(next.builds).toEqual([]);
  });

  it("builds a desired vm from manifest-backed run provisioning", () => {
    const state = runStateWithProvisioning({
      imageKey: {
        scenario: "broken-nginx",
        vm: "webserver",
        arch: "x86_64",
      },
      imageSha256:
        "565d9a5e65009697de935eab180e6e7ef929a01b7e5963199fb168357021cb19",
    });
    const vm = state.vms[0];
    if (!vm) {
      throw new Error("expected vm");
    }

    expect(desiredVmFromRunVm({
      runId: "run-a",
      vm,
      nowUnixMs: 1_762_041_600_000,
      sshAuthorizedKeysOpenssh: [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunkey user@example",
        " ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunkey user@example ",
      ],
      guestTools: guestTools(),
    })).toEqual({
      run_id: "run-a",
      vm_name: "webserver",
      desired_phase: "running",
      image_key: {
        scenario: "broken-nginx",
        vm: "webserver",
        arch: "x86_64",
      },
      image_id:
        "565d9a5e65009697de935eab180e6e7ef929a01b7e5963199fb168357021cb19",
      guest_tools: guestTools(),
      resources: {
        cpu_millis: 1_000,
        vcpu_count: 1,
        memory_mib: 512,
        disk_mib: 4096,
      },
      ssh_authorized_keys_openssh: [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunkey user@example",
      ],
      lease_expires_at_unix_ms: 1_762_045_200_000,
    });
  });

  it("does not build a desired vm from legacy provisioning without image metadata", () => {
    const state = runStateWithProvisioning({
      imageKey: null,
      imageSha256: null,
    });
    const vm = state.vms[0];
    if (!vm) {
      throw new Error("expected vm");
    }

    expect(desiredVmFromRunVm({
      runId: "run-a",
      vm,
      nowUnixMs: 1_762_041_600_000,
      sshAuthorizedKeysOpenssh: [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunkey user@example",
      ],
      guestTools: guestTools(),
    })).toBeNull();
  });

  it("does not build a desired vm without authorized ssh keys", () => {
    const state = runStateWithProvisioning({
      imageKey: {
        scenario: "broken-nginx",
        vm: "webserver",
        arch: "x86_64",
      },
      imageSha256:
        "565d9a5e65009697de935eab180e6e7ef929a01b7e5963199fb168357021cb19",
    });
    const vm = state.vms[0];
    if (!vm) {
      throw new Error("expected vm");
    }

    expect(desiredVmFromRunVm({
      runId: "run-a",
      vm,
      nowUnixMs: 1_762_041_600_000,
      sshAuthorizedKeysOpenssh: [],
      guestTools: guestTools(),
    })).toBeNull();
  });
});

function hostDesiredState(input: {
  version: number;
  cachedImages?: DesiredCachedImageV1[];
  vms?: DesiredVmV2[];
  builds?: DesiredBuildV1[];
}): HostDesiredStateV2 {
  return {
    schema_version: 4,
    host_id: "host-alpha",
    version: input.version,
    generated_at_unix_ms: 1_762_041_600_000,
    cached_images: input.cachedImages ?? [],
    vms: input.vms ?? [],
    builds: input.builds ?? [],
  };
}

function desiredBuild(
  buildId: string,
  contentHash = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
): DesiredBuildV1 {
  return {
    build_id: buildId,
    scenario_id: "broken-nginx",
    arch: "x86_64",
    rev: "0123456789abcdef0123456789abcdef01234567",
    content_hash: contentHash,
    bundle_ref: "builds/bundles/0123456789abcdef0123456789abcdef01234567.tar.gz",
  };
}

function cachedImage(vmName: string, sha256: string): DesiredCachedImageV1 {
  return {
    image_key: {
      scenario: "broken-nginx",
      vm: vmName,
      arch: "x86_64",
    },
    image_id: sha256,
  };
}

function desiredVm(
  runId: string,
  vmName: string,
  sha256: string,
): DesiredVmV2 {
  return {
    run_id: runId,
    vm_name: vmName,
    desired_phase: "running",
    image_key: {
      scenario: "broken-nginx",
      vm: vmName,
      arch: "x86_64",
    },
    image_id: sha256,
    guest_tools: guestTools(),
    resources: {
      cpu_millis: 1_000,
      vcpu_count: 1,
      memory_mib: 512,
      disk_mib: 4096,
    },
    ssh_authorized_keys_openssh: [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunkey user@example",
    ],
    lease_expires_at_unix_ms: 1_762_045_200_000,
  };
}

function guestTools() {
  return {
    tools_disk_sha256: "1".repeat(64),
    tools_disk_size_bytes: 64 * 1024 * 1024,
    kino_sha256: "2".repeat(64),
    bootstrap_abi: 1,
  };
}

function runStateWithProvisioning(input: {
  imageKey: ReturnType<typeof cachedImage>["image_key"] | null;
  imageSha256: string | null;
}) {
  const state = buildInitialRunState({
    vms: [
      {
        id: "vm-row-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-web",
        scenarioVmName: "webserver",
        runtimeVmName: "webserver",
        hostname: "webserver",
        launchSummary: {
          scenarioVmName: "webserver",
          hostname: "webserver",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  return {
    ...state,
    vms: state.vms.map((vm) => ({
      ...vm,
      provisioning: {
        ...vm.provisioning,
        image: "broken-nginx-webserver-x86_64.raw.zst",
        imageKey: input.imageKey,
        imageSha256: input.imageSha256,
        resources: {
          cpuMillis: 1_000,
          vcpuCount: 1,
          memoryMib: 512,
          diskMib: 4096,
        },
        leaseDurationSeconds: 3600,
      },
    })),
  };
}
