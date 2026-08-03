import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/build-scheduler", () => ({
  assignQueuedImageBuilds: vi.fn(),
  queueImageBuildsFromBundle: vi.fn(),
}));
vi.mock("@/lib/scenario-course-catalogs", () => ({
  syncScenarioCourseCatalogSnapshot: vi.fn(),
  validateScenarioCourseCatalogReferences: vi.fn(),
}));
import {
  hydrateRawWorkshopManifest,
  validateWorkshopSourceBundle,
  type ResolvedWorkshopRuntimeProfile,
  type WorkshopCheckpointBuildReport,
} from "./archive";
import { validateWorkshopBuilderManifest } from "./build-result";
import type { PublicationProfileResolution } from "./provider";
import { buildWorkshopBundleFixture } from "./test-support";

describe("workshop builder manifest handoff", () => {
  it("verifies raw source Markdown and stores the canonical hydration", async () => {
    const fixture = await buildWorkshopBundleFixture({
      mutateManifest(compiled) {
        Object.assign(compiled.manifest.workspace, {
          runtime_profiles: [
            {
              id: "hetzner-cx43",
              provider: "hetzner_cloud",
              vm_id: "workspace",
              machine_type: "cx43",
              system_image: "debian-13",
              locations: ["nbg1"],
            },
          ],
        });
      },
      fileOverrides: {
        "slides/01.md": [
          "# Reconciliation",
          "",
          "![Flow](../assets/flow.svg)",
          "",
          "```mermaid",
          "flowchart LR",
          '  git["Git push"] --> reconcile["Reconcile\\nstate"] --> verify["Verify"]',
          "```",
        ].join("\n"),
      },
    });
    const source = await validateWorkshopSourceBundle({
      payload: fixture.bytes.buffer.slice(
        fixture.bytes.byteOffset,
        fixture.bytes.byteOffset + fixture.bytes.byteLength,
      ) as ArrayBuffer,
      claimedWorkshopId: "registry-workshop",
      claimedSha256: fixture.sha256,
    });
    const checkpoints = directCheckpoints();
    const profile = resolvedHetznerProfile();
    const reported = hydrateRawWorkshopManifest({
      source,
      checkpoints,
      resolvedProfiles: [profile],
    });

    const canonical = validateWorkshopBuilderManifest({
      source,
      checkpoints,
      resolutions: [hetznerResolution()],
      rawManifest: reported,
    });

    const slide = canonical.presentation.slides.find(
      (entry) => entry.id === "slide-01",
    );
    expect(slide?.bodyMarkdown).toContain(
      "![Flow](/_intar/workshop-assets/assets/flow.svg)",
    );
    expect(slide?.bodyMarkdown).toMatch(
      /data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/,
    );
    expect(slide?.bodyMarkdown).not.toContain("```mermaid");

    expect(() =>
      validateWorkshopBuilderManifest({
        source,
        checkpoints,
        resolutions: [hetznerResolution()],
        rawManifest: canonical,
      }),
    ).toThrow(
      "hydrated manifest does not exactly match the validated source and checkpoint result",
    );

    reported.modules[0]!.participantMarkdown += "\nunauthorized mutation";
    expect(() =>
      validateWorkshopBuilderManifest({
        source,
        checkpoints,
        resolutions: [hetznerResolution()],
        rawManifest: reported,
      }),
    ).toThrow(
      "hydrated manifest does not exactly match the validated source and checkpoint result",
    );

    const wrongCpu = hydrateRawWorkshopManifest({
      source,
      checkpoints,
      resolvedProfiles: [
        {
          ...profile,
          hardware: { ...profile.hardware, cpuMillis: 4_000 },
        },
      ],
    });
    expect(() =>
      validateWorkshopBuilderManifest({
        source,
        checkpoints,
        resolutions: [hetznerResolution()],
        rawManifest: wrongCpu,
      }),
    ).toThrow(/does not match the pinned catalog observation/);
  });
});

function directCheckpoints(): WorkshopCheckpointBuildReport[] {
  return [
    {
      checkpointId: "checkpoint-00",
      coveredModuleIds: ["00-setup"],
      sanitized: false,
      coldBootVerified: false,
      vmImages: [],
    },
    {
      checkpointId: "checkpoint-01",
      coveredModuleIds: ["00-setup", "01-core"],
      sanitized: false,
      coldBootVerified: false,
      vmImages: [],
    },
  ];
}

function resolvedHetznerProfile(): ResolvedWorkshopRuntimeProfile {
  return {
    id: "hetzner-cx43",
    provider: "hetzner_cloud",
    vmId: "workspace",
    machineType: "cx43",
    requestedSystemImage: "debian-13",
    immutableSystemImage: "image-13",
    locations: ["nbg1"],
    hardware: {
      architecture: "x86_64",
      cpuMillis: 8_000,
      providerCpuCount: 8,
      memoryMib: 16_384,
      diskMib: 163_840,
    },
  };
}

function hetznerResolution(): PublicationProfileResolution {
  return {
    declaration: {
      id: "hetzner-cx43",
      provider: "hetzner_cloud",
      vmId: "workspace",
      machineType: "cx43",
      systemImage: "debian-13",
      rootDiskType: null,
      locations: ["nbg1"],
      requirements: {
        cpuMillis: 4_000,
        memoryMib: 16_384,
        diskMib: 102_400,
      },
    },
    connectionId: "connection-hetzner",
    claimedObservation: {
      profile_id: "hetzner-cx43",
      observation: {
        provider: "hetzner_cloud",
        machine_type: "cx43",
        resolved_system_image: "image-13",
        system_image_is_immutable: true,
        architecture: "x86_64",
        cores: 8,
        memory_mib: 16_384,
        disk_mib: 163_840,
        deprecated: false,
        available_locations: ["nbg1"],
      },
    },
  };
}
