import { describe, expect, it } from "vitest";
import {
  RegistryRetentionFault,
  actualVmNeedsImage,
  bootArtifactObjectKey,
  desiredVmNeedsImage,
  bundleObjectKey,
  evaluateHostImageReferences,
  imageChunkObjectKey,
  imageManifestObjectKey,
  imageObjectKey,
  imageRootKey,
  manifestImageMembers,
  manifestImageIds,
  planBuildRetention,
  planCandidateIntentRetention,
  planSnapshotRetention,
  pruneSupersededCachedImages,
  snapshotArtifactRoots,
  readSnapshot,
  registryImageKey,
  planHostCacheIntentRetention,
  type CandidateIntentRow,
  type HostCacheIntentRow,
  type ImageRoot,
  type RetentionBuildRow,
} from "@/lib/image-artifact-retention";
import type {
  DesiredCachedImageV1,
  HostDesiredStateV2,
  HostStateReportV2,
} from "@/generated/bridge";
import type { ScenarioManifestV5 } from "@/generated/catalog";

const LIVE = "a".repeat(64);
const PREVIOUS = "b".repeat(64);
const ANCIENT = "c".repeat(64);
const CANDIDATE_ONLY = "d".repeat(64);

function root(
  vmName: string,
  imageId: string,
  overrides: Partial<ImageRoot> = {},
): ImageRoot {
  return {
    scenarioId: "nginx",
    vmName,
    arch: "x86_64",
    imageId,
    source: "live_pointer",
    ...overrides,
  };
}

function build(overrides: Partial<RetentionBuildRow>): RetentionBuildRow {
  return {
    buildId: "build",
    status: "succeeded",
    members: [],
    chunkManifestSha256s: [],
    bootArtifactSha256s: [],
    artifactsRetired: false,
    ...overrides,
  };
}

/** No direct pointer needs these artifacts in the retention tests. */
const NO_ARTIFACT_ROOTS = {
  chunkManifestSha256s: new Set<string>(),
  bootArtifactSha256s: new Set<string>(),
};

describe("build artifact retention", () => {
  it("keeps a build only while every member of its manifest is rooted", () => {
    const plan = planBuildRetention({
      builds: [
        build({
          buildId: "both-rooted",
          members: [root("web", LIVE), root("db", LIVE)],
        }),
        build({
          buildId: "second-vm-dropped",
          members: [root("web", LIVE), root("db", ANCIENT)],
        }),
      ],
      roots: [root("web", LIVE), root("db", LIVE)],
      ...NO_ARTIFACT_ROOTS,
    });

    expect(plan.keepBuildIds).toEqual(["both-rooted"]);
    expect(plan.retireBuildIds).toEqual(["second-vm-dropped"]);
  });

  it("retires an old two-VM build once one VM changed, keeping only its rooted objects", () => {
    // A scenario whose second VM was republished: the previous build still
    // shares the unchanged first VM image, but it can no longer be fetched as
    // published, so it stops pinning objects.
    const previousBuild = build({
      buildId: "previous",
      members: [
        root("web", PREVIOUS),
        root("db", PREVIOUS),
      ],
    });
    const plan = planBuildRetention({
      builds: [previousBuild],
      roots: [root("web", PREVIOUS), root("db", LIVE)],
      ...NO_ARTIFACT_ROOTS,
    });

    expect(plan.keepBuildIds).toEqual([]);
    expect(plan.retireBuildIds).toEqual(["previous"]);
    // The reachable objects are decided by the per-object root set, not by the
    // build: web's old image stays rooted, db's old image is now unreferenced.
    const rootedImageIds = new Set([
      root("web", PREVIOUS).imageId,
      root("db", LIVE).imageId,
    ]);
    expect(rootedImageIds.has(PREVIOUS)).toBe(true);
    expect(rootedImageIds.has(LIVE)).toBe(true);
  });

  it("treats an active build as available even before its manifest is rooted", () => {
    const plan = planBuildRetention({
      builds: [
        build({
          buildId: "rebuilding",
          status: "queued",
          members: [root("web", ANCIENT)],
        }),
        build({ buildId: "historic", members: [root("web", ANCIENT)] }),
      ],
      roots: [root("web", LIVE)],
      ...NO_ARTIFACT_ROOTS,
    });

    expect(plan.keepBuildIds).toEqual(["rebuilding"]);
    expect(plan.retireBuildIds).toEqual(["historic"]);
  });

  it("does not retire an already retired build twice", () => {
    const plan = planBuildRetention({
      builds: [
        build({
          buildId: "old",
          members: [root("web", ANCIENT)],
          artifactsRetired: true,
        }),
      ],
      roots: [root("web", LIVE)],
      ...NO_ARTIFACT_ROOTS,
    });

    expect(plan.keepBuildIds).toEqual([]);
    expect(plan.retireBuildIds).toEqual([]);
  });

  it("never retires a manifestless build row", () => {
    const plan = planBuildRetention({
      builds: [build({ buildId: "unpublished", members: [] })],
      roots: [root("web", LIVE)],
      ...NO_ARTIFACT_ROOTS,
    });

    expect(plan.keepBuildIds).toEqual([]);
    expect(plan.retireBuildIds).toEqual([]);
  });
});

describe("candidate intent retention", () => {
  function candidate(
    id: string,
    scenarioId: string,
    imageIds: string[],
    stagedAt: number,
    revision = "revision-" + id,
    organizationId: string | null = null,
  ): CandidateIntentRow {
    return {
      id,
      scenarioId,
      organizationId,
      revision,
      members: imageIds.map((imageId) => root("web", imageId, { scenarioId })),
      stagedAt,
    };
  }

  function liveRevisions(
    entries: Record<string, string | null>,
  ): Map<string, string | null> {
    return new Map(Object.entries(entries));
  }

  it("keeps only the newest unpromoted candidate per scenario", () => {
    const plan = planCandidateIntentRetention({
      rows: [
        candidate("c3", "nginx", [CANDIDATE_ONLY], 300, "revision-3"),
        candidate("c2", "nginx", [ANCIENT], 200, "revision-2"),
        candidate("c1", "nginx", [ANCIENT], 100, "revision-1"),
      ],
      liveRevisionByScenario: liveRevisions({ nginx: "revision-0" }),
    });

    expect(plan.keepIds).toEqual(["c3"]);
    expect(plan.retireIds).toEqual(["c1", "c2"]);
  });

  it("keeps a new revision whose image is byte-identical to the live one", () => {
    // A candidate revision can change the kernel, the initrd, the probes, or
    // the metadata while the disk image is the same. It stays promotable.
    const plan = planCandidateIntentRetention({
      rows: [candidate("c1", "nginx", [LIVE], 100, "revision-2")],
      liveRevisionByScenario: liveRevisions({ nginx: "revision-1" }),
    });

    expect(plan.keepIds).toEqual(["c1"]);
    expect(plan.retireIds).toEqual([]);
  });

  it("retires an intent only once the catalog carries that exact revision", () => {
    const plan = planCandidateIntentRetention({
      rows: [candidate("c1", "nginx", [LIVE], 100, "revision-2")],
      liveRevisionByScenario: liveRevisions({ nginx: "revision-2" }),
    });

    expect(plan.keepIds).toEqual([]);
    expect(plan.retireIds).toEqual(["c1"]);
  });

  it("keeps an intent when the live catalog has no revision recorded", () => {
    const plan = planCandidateIntentRetention({
      rows: [candidate("c1", "nginx", [LIVE], 100, "revision-2")],
      liveRevisionByScenario: liveRevisions({ nginx: null }),
    });

    expect(plan.keepIds).toEqual(["c1"]);
    expect(plan.retireIds).toEqual([]);
  });

  it("scopes the revision comparison to the candidate's own scenario", () => {
    const plan = planCandidateIntentRetention({
      rows: [
        candidate("nginx-c", "nginx", [CANDIDATE_ONLY], 100, "revision-2"),
        candidate("dns-c", "dns", [CANDIDATE_ONLY], 100, "revision-2"),
      ],
      liveRevisionByScenario: liveRevisions({ nginx: "revision-2" }),
    });

    expect(plan.keepIds).toEqual(["dns-c"]);
    expect(plan.retireIds).toEqual(["nginx-c"]);
  });

  it("keeps the row an active run was admitted from, whatever its intent became", () => {
    // The catalog already carries the revision a queued run boots from, and a
    // newer revision is staged behind it, next to one row that is pure history.
    const plan = planCandidateIntentRetention({
      rows: [
        candidate("newest", "nginx", [PREVIOUS], 20, "revision-newer"),
        candidate("in-flight", "nginx", [ANCIENT], 10, "revision-older"),
        candidate("history", "nginx", [CANDIDATE_ONLY], 5, "revision-ancient"),
      ],
      liveRevisionByScenario: liveRevisions({ nginx: "revision-older" }),
      activeRunCandidates: [
        { scenarioId: "nginx", organizationId: null, revision: "revision-older" },
      ],
    });

    // The consumed intent survives because a run resolves its manifest through
    // it, the newest row is still the intent, and the history row goes as usual.
    expect(plan.keepIds).toEqual(["in-flight", "newest"]);
    expect(plan.retireIds).toEqual(["history"]);
  });

  it("scopes the active row by tenant, so another tenant's row is not kept", () => {
    const plan = planCandidateIntentRetention({
      rows: [
        candidate("public-row", "nginx", [LIVE], 10, "revision-old", null),
        candidate("org-row", "nginx", [LIVE], 20, "revision-old", "org-1"),
      ],
      liveRevisionByScenario: liveRevisions({}),
      activeRunCandidates: [
        { scenarioId: "nginx", organizationId: "org-1", revision: "revision-old" },
      ],
    });

    // Only the row that tenant's run was admitted from is protected; the
    // identically staged public row is history like any other.
    expect(plan.keepIds).toEqual(["org-row"]);
    expect(plan.retireIds).toEqual(["public-row"]);
  });

  it("retires every old row when no run is active", () => {
    const plan = planCandidateIntentRetention({
      rows: [
        candidate("newest", "nginx", [LIVE], 30, "revision-3"),
        candidate("older", "nginx", [PREVIOUS], 20, "revision-2"),
        candidate("oldest", "nginx", [ANCIENT], 10, "revision-1"),
      ],
      liveRevisionByScenario: liveRevisions({ nginx: "revision-1" }),
      activeRunCandidates: [],
    });

    expect(plan.keepIds).toEqual(["newest"]);
    expect(plan.retireIds).toEqual(["older", "oldest"]);
  });

  it("keeps one intent per scenario independently", () => {
    const plan = planCandidateIntentRetention({
      rows: [
        candidate("nginx-old", "nginx", [ANCIENT], 100, "revision-1"),
        candidate("nginx-new", "nginx", [CANDIDATE_ONLY], 200, "revision-2"),
        candidate("dns-new", "dns", [ANCIENT], 300, "revision-1"),
      ],
      liveRevisionByScenario: liveRevisions({ nginx: "revision-1" }),
    });

    expect(plan.keepIds).toEqual(["dns-new", "nginx-new"]);
    expect(plan.retireIds).toEqual(["nginx-old"]);
  });
});

describe("rollback snapshot retention", () => {
  it("deletes a snapshot whose whole coverage a newer snapshot covers", () => {
    const plan = planSnapshotRetention({
      rows: [
        snapshot("s3", 300, ["nginx"]),
        snapshot("s2", 200, ["nginx"]),
      ],
    });

    expect(plan.keepIds).toEqual(["s3"]);
    expect(plan.deleteIds).toEqual(["s2"]);
    expect(plan.trims).toEqual([]);
  });

  it("trims a multi-scenario snapshot down to the scenario only it covers", () => {
    const plan = planSnapshotRetention({
      rows: [
        snapshot("s3", 300, ["nginx"]),
        snapshot("s2", 200, ["nginx", "dns"], {
          scenarios: [
            { scenarioId: "nginx", title: "Nginx" },
            { scenarioId: "dns", title: "DNS" },
          ],
          vms: [
            { scenarioId: "nginx", vmName: "web", imageSha256: LIVE, imageKeyJson: { arch: "x86_64" } },
            { scenarioId: "dns", vmName: "web", imageSha256: ANCIENT, imageKeyJson: { arch: "x86_64" } },
          ],
          probes: [
            { scenarioId: "nginx", id: "p1" },
            { scenarioId: "dns", id: "p2" },
          ],
        }),
      ],
    });

    expect(plan.keepIds).toEqual(["s3"]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.trims).toHaveLength(1);
    const trimmed = plan.trims[0]!;
    expect(trimmed.id).toEqual("s2");
    expect(trimmed.snapshot.targetScenarioIds).toEqual(["dns"]);
    expect(trimmed.snapshot.scenarios).toEqual([{ scenarioId: "dns", title: "DNS" }]);
    expect(trimmed.snapshot.vms).toHaveLength(1);
    expect(trimmed.snapshot.probes).toEqual([{ scenarioId: "dns", id: "p2" }]);
  });

  it("faults on a malformed snapshot row instead of dropping it", () => {
    // A retained pointer that cannot be read must stop the sweep: treating it
    // as an empty coverage would delete objects a rollback still needs.
    expect(() =>
      planSnapshotRetention({
        rows: [
          { id: "broken", createdAt: 100, snapshot: { targetScenarioIds: [] } },
        ],
      }),
    ).toThrow(RegistryRetentionFault);
  });

  it("faults on an unreadable snapshot instead of returning an empty coverage", () => {
    for (const value of [
      null,
      { targetScenarioIds: "nope" },
      { targetScenarioIds: ["a"], vms: "nope" },
    ]) {
      expect(() => readSnapshot(value)).toThrow(RegistryRetentionFault);
    }
  });

  it("faults on a snapshot VM that is missing a required field", () => {
    const base = {
      targetScenarioIds: ["nginx"],
      vms: [
        {
          scenarioId: "nginx",
          vmName: "web",
          imageSha256: LIVE,
          imageKeyJson: { scenario: "nginx", vm: "web", arch: "x86_64" },
          imageFormat: "raw_chunks_v1",
          chunkManifestSha256: PREVIOUS,
          kernelSha256: "1".repeat(64),
          initrdSha256: "2".repeat(64),
        },
      ],
    };
    const cases = [
      { ...base, vms: [{ ...base.vms[0], imageKeyJson: undefined }] },
      { ...base, vms: [{ ...base.vms[0], imageSha256: undefined }] },
      { ...base, vms: [{ ...base.vms[0], chunkManifestSha256: undefined }] },
      { ...base, vms: [{ ...base.vms[0], kernelSha256: undefined }] },
    ];
    for (const value of cases) {
      expect(() =>
        snapshotArtifactRoots(readSnapshot(value), "rollback_snapshot"),
      ).toThrow(RegistryRetentionFault);
    }
  });

  it("reads a legacy snapshot VM through its snake_case fields", () => {
    const artifacts = snapshotArtifactRoots(
      readSnapshot({
        target_scenario_ids: ["nginx"],
        targetScenarioIds: ["nginx"],
        vms: [
          {
            scenario_id: "nginx",
            vm_name: "web",
            image_sha256: LIVE,
            image_key_json: { scenario: "nginx", vm: "web", arch: "x86_64" },
            image_format: "raw_zstd",
            kernel_sha256: "1".repeat(64),
            initrd_sha256: "2".repeat(64),
          },
        ],
      }),
      "rollback_snapshot",
    );

    expect(artifacts.roots).toEqual([
      {
        scenarioId: "nginx",
        vmName: "web",
        arch: "x86_64",
        imageId: LIVE,
        source: "rollback_snapshot",
      },
    ]);
    expect(artifacts.chunkManifestSha256s).toEqual([]);
    expect(artifacts.bootArtifactSha256s).toEqual(
      ["1".repeat(64), "2".repeat(64)].sort(),
    );
  });

  it("reads the per-image closure of a snapshot VM, camelCase and legacy", () => {
    const camel = snapshotArtifactRoots(
      readSnapshot({
        targetScenarioIds: ["nginx"],
        vms: [
          {
            scenarioId: "nginx",
            vmName: "web",
            imageSha256: LIVE,
            imageKeyJson: { scenario: "nginx", vm: "web", arch: "x86_64" },
            imageFormat: "raw_chunks_v1",
            chunkManifestSha256: PREVIOUS,
            kernelSha256: "1".repeat(64),
            initrdSha256: "2".repeat(64),
          },
        ],
      }),
      "rollback_snapshot",
    );

    // The identity a registry reader resolves an image with, and the full
    // closure that image needs: manifest, kernel, and initrd.
    expect(camel.imageClosures).toEqual([
      {
        identity: "nginx-web-x86_64:" + LIVE,
        // The key and id travel with the closure, so a reader that only has an
        // image id can still find it.
        imageKey: { scenario: "nginx", vm: "web", arch: "x86_64" },
        imageId: LIVE,
        closure: {
          chunkManifestSha256: PREVIOUS,
          kernelSha256: "1".repeat(64),
          initrdSha256: "2".repeat(64),
        },
      },
    ]);

    // A legacy row keeps the same closure through its snake_case fields, and a
    // single-object format leaves the manifest null instead of inventing one.
    const legacy = snapshotArtifactRoots(
      readSnapshot({
        targetScenarioIds: ["nginx"],
        vms: [
          {
            scenario_id: "nginx",
            vm_name: "web",
            image_sha256: ANCIENT,
            image_key_json: { scenario: "nginx", vm: "web", arch: "aarch64" },
            image_format: "raw_zstd",
            kernel_sha256: "3".repeat(64),
            initrd_sha256: "4".repeat(64),
          },
        ],
      }),
      "rollback_snapshot",
    );

    expect(legacy.imageClosures).toEqual([
      {
        identity: "nginx-web-aarch64:" + ANCIENT,
        imageKey: { scenario: "nginx", vm: "web", arch: "aarch64" },
        imageId: ANCIENT,
        closure: {
          chunkManifestSha256: null,
          kernelSha256: "3".repeat(64),
          initrdSha256: "4".repeat(64),
        },
      },
    ]);
  });

  it("faults on a snapshot VM whose arch is missing or unsupported", () => {
    expect(() =>
      snapshotArtifactRoots(
        readSnapshot({
          targetScenarioIds: ["nginx"],
          vms: [
            {
              scenarioId: "nginx",
              vmName: "web",
              imageSha256: LIVE,
              imageKeyJson: { arch: "riscv64" },
            },
          ],
        }),
        "rollback_snapshot",
      ),
    ).toThrow(RegistryRetentionFault);
  });

  it("keeps build availability tied to every artifact dependency", () => {
    const plan = planBuildRetention({
      builds: [
        build({
          buildId: "unchanged-image-new-kernel",
          members: [root("web", LIVE)],
          chunkManifestSha256s: [PREVIOUS],
          bootArtifactSha256s: ["9".repeat(64)],
        }),
      ],
      roots: [root("web", LIVE)],
      chunkManifestSha256s: new Set([PREVIOUS]),
      bootArtifactSha256s: new Set(["1".repeat(64)]),
    });

    // The image is unchanged but the kernel is not a direct dependency of any
    // retained pointer, so the build stops pinning it.
    expect(plan.retireBuildIds).toEqual(["unchanged-image-new-kernel"]);
  });
});

function snapshot(
  id: string,
  createdAt: number,
  scenarios: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    createdAt,
    snapshot: { schemaVersion: 1, targetScenarioIds: scenarios, ...extra },
  };
}

describe("registry object keys", () => {
  it("derives the registry object keys of one image", () => {
    const imageKey = { scenario: "Broken Nginx", vm: "web 1", arch: "x86_64" } as const;

    expect(registryImageKey(imageKey)).toEqual("Broken-Nginx-web-1-x86_64");
    expect(imageObjectKey(imageKey, LIVE)).toEqual(
      "images/Broken-Nginx-web-1-x86_64/" + LIVE + ".raw.zst",
    );
    expect(imageChunkObjectKey(LIVE)).toEqual("image-chunks/v1/zstd6/" + LIVE);
    expect(imageManifestObjectKey(LIVE)).toEqual("image-manifests/v1/" + LIVE + ".json");
    expect(bootArtifactObjectKey(LIVE)).toEqual("artifacts/" + LIVE);
    expect(bundleObjectKey("rev-1")).toEqual("builds/bundles/rev-1.tar.gz");
  });

  it("keys image roots by scenario, vm, and arch", () => {
    expect(
      imageRootKey({ scenarioId: "nginx", vmName: "web", arch: "x86_64" }),
    ).toEqual("nginx:web:x86_64");
  });
});

describe("manifest image members", () => {
  it("projects one member per VM and tags their source", () => {
    const manifest = {
      scenario_id: "nginx",
      vms: [
        { name: "web", image_key: { arch: "x86_64" }, image_id: LIVE },
        { name: "db", image_key: { arch: "aarch64" }, image_id: PREVIOUS },
      ],
    } as unknown as ScenarioManifestV5;

    expect(manifestImageMembers(manifest, "candidate_intent")).toEqual([
      {
        scenarioId: "nginx",
        vmName: "web",
        arch: "x86_64",
        imageId: LIVE,
        source: "candidate_intent",
      },
      {
        scenarioId: "nginx",
        vmName: "db",
        arch: "aarch64",
        imageId: PREVIOUS,
        source: "candidate_intent",
      },
    ]);
    expect(manifestImageIds(manifest)).toEqual([LIVE, PREVIOUS].sort());
  });
});

describe("host image references", () => {
  function desired(
    imageIds: string[] = [],
    cached: string[] = [],
  ): HostDesiredStateV2 {
    return {
      version: 1,
      generated_at_unix_ms: 0,
      vms: imageIds.map((imageId, index) => ({
        vm_id: "vm-" + index,
        image_id: imageId,
        // The contract requires a phase, and only a running VM blocks.
        desired_phase: "running",
      })),
      builds: [],
      cached_images: cached.map((imageId, index) => ({
        image_key: { scenario: "nginx", vm: "vm-" + index, arch: "x86_64" },
        image_id: imageId,
      })),
    } as unknown as HostDesiredStateV2;
  }

  /**
   * `cached` feeds the host's cache report and `vms` its VM report, because
   * the two carry different phase vocabularies and are read separately.
   */
  function actual(
    cached: Array<{ imageId: string; phase: string }>,
    vms: Array<{
      imageId: string;
      phase: string;
      archive?: { phase: string };
    }> = [],
  ): HostStateReportV2 {
    return {
      cached_images: cached.map((entry, index) => ({
        image_key: { scenario: "nginx", vm: "vm-" + index, arch: "x86_64" },
        image_id: entry.imageId,
        phase: entry.phase,
        updated_at_unix_ms: 0,
      })),
      vms: vms.map((entry, index) => ({
        run_id: "run-" + index,
        vm_name: "vm-" + index,
        phase: entry.phase,
        image_id: entry.imageId,
        ...(entry.archive ? { archive: entry.archive } : {}),
      })),
      builds: [],
    } as unknown as HostStateReportV2;
  }

  it("blocks when a desired VM still uses the outgoing image", () => {
    expect(
      evaluateHostImageReferences({
        outgoingImageIds: [LIVE],
        desired: desired([LIVE]),
        actual: actual([{ imageId: LIVE, phase: "ready" }]),
      }).blocking,
    ).toEqual([{ imageId: LIVE, reason: "active_vm" }]);
  });

  it("blocks on an actual VM when desired state only has a tombstone", () => {
    // The lag case: desired state says the run ended, but the host is still
    // running, stopping, or stuck in a failed delete. Replacing the image
    // would break it.
    const desiredState = desired([LIVE]);
    desiredState.vms[0]!.desired_phase = "absent" as never;

    for (const entry of [
      { imageId: LIVE, phase: "running" },
      { imageId: LIVE, phase: "stopping" },
      { imageId: LIVE, phase: "failed", archive: { phase: "failed" } },
    ]) {
      const result = evaluateHostImageReferences({
        outgoingImageIds: [LIVE],
        desired: desiredState,
        actual: actual([], [entry]),
      });
      expect(result.blocking).toEqual([{ imageId: LIVE, reason: "active_vm" }]);
    }
  });

  it("allows the replacement when both sides say the VM is gone", () => {
    const desiredState = desired([LIVE]);
    desiredState.vms[0]!.desired_phase = "absent" as never;

    const archived = evaluateHostImageReferences({
      outgoingImageIds: [LIVE],
      desired: desiredState,
      // The archive completed, so the agent has removed the VM.
      actual: actual([], [
        { imageId: LIVE, phase: "stopping", archive: { phase: "complete" } },
      ]),
    });
    expect(archived.blocking).toEqual([]);

    const bothAbsent = evaluateHostImageReferences({
      outgoingImageIds: [LIVE],
      desired: desiredState,
      actual: actual([], [{ imageId: LIVE, phase: "absent" }]),
    });
    expect(bothAbsent.blocking).toEqual([]);
  });
  it("does not block on an absent tombstone that still names the image", () => {
    // The platform writes `absent` when a run ends. The agent pins nothing
    // for it, so it must not hold a promotion either.
    const desiredState = desired([LIVE]);
    desiredState.vms[0]!.desired_phase = "absent" as never;

    const result = evaluateHostImageReferences({
      outgoingImageIds: [LIVE],
      desired: desiredState,
      actual: actual([{ imageId: LIVE, phase: "ready" }]),
    });

    expect(result.blocking).toEqual([]);
    expect(result.leftover).toEqual([LIVE]);
  });

  it("blocks an unfinished transfer", () => {
    const result = evaluateHostImageReferences({
      outgoingImageIds: [LIVE],
      desired: desired([], [LIVE]),
      actual: actual([{ imageId: LIVE, phase: "downloading" }]),
    });

    expect(result.blocking).toEqual([
      { imageId: LIVE, reason: "transfer_in_flight" },
    ]);
    expect(result.leftover).toEqual([]);
  });

  it("treats a ready cache entry that desired no longer needs as leftover", () => {
    const result = evaluateHostImageReferences({
      outgoingImageIds: [LIVE],
      desired: desired(),
      actual: actual([{ imageId: LIVE, phase: "ready" }]),
    });

    expect(result.blocking).toEqual([]);
    expect(result.leftover).toEqual([LIVE]);
  });

  it("ignores images that are not outgoing", () => {
    expect(
      evaluateHostImageReferences({
        outgoingImageIds: [],
        desired: desired([LIVE]),
        actual: actual([{ imageId: LIVE, phase: "ready" }]),
      }),
    ).toEqual({ blocking: [], leftover: [] });
  });
});


describe("host phase policy", () => {
  it("roots a desired VM only while the platform wants it running", () => {
    expect(desiredVmNeedsImage({ desired_phase: "running" })).toBe(true);
    expect(desiredVmNeedsImage({ desired_phase: "absent" })).toBe(false);
    // The stored document is a JSON cast with no runtime validation, so an
    // unknown or missing phase is kept: only an explicit tombstone drops.
    expect(desiredVmNeedsImage({})).toBe(true);
    expect(desiredVmNeedsImage({ desired_phase: "something-new" })).toBe(true);
  });

  it("keeps every actual phase that can still need the image", () => {
    for (const phase of [
      "pending",
      "pulling_image",
      "creating_disks",
      "booting",
      "running",
      "ready",
      "solved",
      "stopping",
      // The contract allows it and nothing proves a stopped VM is gone.
      "stopped",
    ]) {
      expect(actualVmNeedsImage({ phase, archive: null })).toBe(true);
    }
  });

  it("keeps failed VMs only while a failed archive proves delete_failed", () => {
    // report phase `failed` covers both Failed and DeleteFailed. The archive
    // phase is what tells them apart, and only DeleteFailed is still present.
    expect(actualVmNeedsImage({ phase: "failed", archive: { phase: "failed" } })).toBe(true);
    expect(actualVmNeedsImage({ phase: "failed", archive: null })).toBe(false);
    expect(actualVmNeedsImage({ phase: "failed", archive: { phase: "pending" } })).toBe(true);
    expect(actualVmNeedsImage({ phase: "failed", archive: { phase: "uploading" } })).toBe(true);
    expect(actualVmNeedsImage({ phase: "failed", archive: { phase: "complete" } })).toBe(false);
  });

  it("drops only VMs the report proves are gone", () => {
    // A complete archive is the one unambiguous "the agent removed it".
    expect(actualVmNeedsImage({ phase: "running", archive: { phase: "complete" } })).toBe(false);
    // Host-confirmed absent with no unfinished archive.
    expect(actualVmNeedsImage({ phase: "absent", archive: null })).toBe(false);
    // An absent VM whose archive is still running is still being torn down.
    expect(actualVmNeedsImage({ phase: "absent", archive: { phase: "uploading" } })).toBe(true);
    expect(actualVmNeedsImage({ phase: "absent", archive: { phase: "failed" } })).toBe(true);
  });

  it("fails closed on an unknown phase or archive phase", () => {
    expect(actualVmNeedsImage({ phase: "something-new", archive: null })).toBe(true);
    expect(actualVmNeedsImage({})).toBe(true);
    expect(actualVmNeedsImage({ phase: "stopping", archive: { phase: "unknown" } })).toBe(true);
  });
});

describe("cached image pruning", () => {
  function cached(scenario: string, arch: string, imageId: string): DesiredCachedImageV1 {
    return {
      image_key: { scenario, vm: "web", arch: arch as never },
      image_id: imageId,
    } as DesiredCachedImageV1;
  }

  it("drops older entries of a promoted family and keeps live plus rollback", () => {
    const pruned = pruneSupersededCachedImages(
      [
        cached("nginx", "x86_64", LIVE),
        cached("nginx", "x86_64", PREVIOUS),
        cached("nginx", "x86_64", ANCIENT),
      ],
      [{ scenarioId: "nginx", arch: "x86_64", keepImageIds: [LIVE, PREVIOUS] }],
    );

    expect(pruned.map((image) => image.image_id)).toEqual([LIVE, PREVIOUS]);
  });

  it("leaves another scenario and another architecture alone", () => {
    const pruned = pruneSupersededCachedImages(
      [
        cached("nginx", "x86_64", ANCIENT),
        cached("dns", "x86_64", ANCIENT),
        cached("nginx", "aarch64", ANCIENT),
      ],
      [{ scenarioId: "nginx", arch: "x86_64", keepImageIds: [LIVE] }],
    );

    expect(pruned.map((image) => image.image_id)).toEqual([ANCIENT, ANCIENT]);
  });
});

describe("host cache intent retention", () => {
  function cached(
    scenario: string,
    vm: string,
    arch: string,
    imageId: string,
  ): DesiredCachedImageV1 {
    return {
      image_key: { scenario, vm, arch: arch as never },
      image_id: imageId,
    } as DesiredCachedImageV1;
  }

  function host(overrides: Partial<HostCacheIntentRow> = {}): HostCacheIntentRow {
    return {
      hostId: "host-1",
      cachedImages: [],
      neededImageIds: [],
      inFlightImageIds: [],
      ...overrides,
    };
  }

  // The live scenario's family, the removed scenario's family, and a family
  // only an operator named.
  const MANAGED = new Set(["nginx:v1:x86_64", "removed:v1:x86_64"]);

  it("withdraws every obsolete version of a removed managed family", () => {
    const trims = planHostCacheIntentRetention({
      hosts: [
        host({
          cachedImages: [
            cached("removed", "v1", "x86_64", ANCIENT),
            cached("removed", "v1", "x86_64", PREVIOUS),
          ],
        }),
      ],
      managedFamilies: MANAGED,
      keepImageIds: new Set(),
    });

    expect(trims).toEqual([
      { hostId: "host-1", imageIds: [ANCIENT, PREVIOUS].sort() },
    ]);
  });

  it("keeps an unmanaged intent and the live image of a managed family", () => {
    const trims = planHostCacheIntentRetention({
      hosts: [
        host({
          cachedImages: [
            // Another tenant's or an operator's own request.
            cached("operator-pick", "v1", "x86_64", ANCIENT),
            // The live pointer roots this one.
            cached("nginx", "v1", "x86_64", LIVE),
            // Obsolete, and managed.
            cached("nginx", "v1", "x86_64", PREVIOUS),
          ],
        }),
      ],
      managedFamilies: MANAGED,
      keepImageIds: new Set([LIVE]),
    });

    expect(trims).toEqual([{ hostId: "host-1", imageIds: [PREVIOUS] }]);
  });

  it("keeps an image a VM needs and one a transfer is fetching", () => {
    const trims = planHostCacheIntentRetention({
      hosts: [
        host({
          cachedImages: [
            cached("removed", "v1", "x86_64", LIVE),
            cached("removed", "v1", "x86_64", PREVIOUS),
            cached("removed", "v1", "x86_64", ANCIENT),
          ],
          neededImageIds: [LIVE],
          inFlightImageIds: [PREVIOUS],
        }),
      ],
      managedFamilies: MANAGED,
      keepImageIds: new Set(),
    });

    expect(trims).toEqual([{ hostId: "host-1", imageIds: [ANCIENT] }]);
  });

  it("matches the whole family, so a sibling VM or arch is untouched", () => {
    const trims = planHostCacheIntentRetention({
      hosts: [
        host({
          cachedImages: [
            cached("removed", "v2", "x86_64", ANCIENT),
            cached("removed", "v1", "aarch64", ANCIENT),
            cached("removed", "v1", "x86_64", ANCIENT),
          ],
        }),
      ],
      managedFamilies: MANAGED,
      keepImageIds: new Set(),
    });

    expect(trims).toEqual([{ hostId: "host-1", imageIds: [ANCIENT] }]);
  });

  it("keeps an entry it cannot identify rather than guessing at a delete", () => {
    const trims = planHostCacheIntentRetention({
      hosts: [
        host({
          cachedImages: [
            { image_key: undefined, image_id: ANCIENT } as never,
            { image_key: { scenario: "removed" }, image_id: PREVIOUS } as never,
            { image_key: { scenario: "removed", vm: "v1", arch: "x86_64" } } as never,
          ],
        }),
      ],
      managedFamilies: MANAGED,
      keepImageIds: new Set(),
    });

    expect(trims).toEqual([]);
  });

  it("reports one trim per host that has something to withdraw", () => {
    const trims = planHostCacheIntentRetention({
      hosts: [
        host({
          hostId: "host-b",
          cachedImages: [cached("removed", "v1", "x86_64", ANCIENT)],
        }),
        host({ hostId: "host-a", cachedImages: [] }),
        host({
          hostId: "host-c",
          cachedImages: [cached("nginx", "v1", "x86_64", LIVE)],
        }),
      ],
      managedFamilies: MANAGED,
      keepImageIds: new Set([LIVE]),
    });

    expect(trims.map((trim) => trim.hostId)).toEqual(["host-b"]);
  });
});
