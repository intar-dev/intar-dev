import { describe, expect, it, vi } from "vitest";
import { validateWorkshopManifest } from "@/lib/workshops/validation";

vi.mock("@/lib/build-scheduler", () => ({
  assignQueuedImageBuilds: vi.fn(),
  queueImageBuildsFromBundle: vi.fn(),
}));
vi.mock("@/lib/scenario-course-catalogs", () => ({
  syncScenarioCourseCatalogSnapshot: vi.fn(),
  validateScenarioCourseCatalogReferences: vi.fn(),
}));
import {
  hydrateWorkshopManifest,
  hydrateRawWorkshopManifest,
  validateWorkshopSourceBundle,
  WorkshopBundleValidationError,
  type WorkshopCheckpointBuildReport,
  type ResolvedWorkshopRuntimeProfile,
} from "./archive";
import {
  buildWorkshopBundleFixture,
  type WorkshopCompiledFixture,
} from "./test-support";

describe("workshop source bundle validation", () => {
  it("accepts a deterministic bundle and preserves safe Markdown code examples", async () => {
    const [first, second] = await Promise.all([
      buildWorkshopBundleFixture(),
      buildWorkshopBundleFixture(),
    ]);

    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).toEqual(second.bytes);

    const source = await validateWorkshopSourceBundle({
      payload: arrayBuffer(first.bytes),
      claimedWorkshopId: "registry-workshop",
      claimedSha256: first.sha256,
    });

    expect(source).toMatchObject({
      contentHash: first.sha256,
      workshopSlug: "registry-workshop",
      requiredCheckpointIds: ["checkpoint-00", "checkpoint-01"],
      compiledManifest: {
        format_version: 2,
        runtime_tool_format_version: 1,
        scheduled_duration_minutes: 45,
      },
    });
    expect([...source.files.keys()].sort()).toContain("LICENSE");

    const checkpoints: WorkshopCheckpointBuildReport[] = [
      checkpoint("checkpoint-00", "a"),
      checkpoint("checkpoint-01", "b"),
    ];
    const manifest = hydrateWorkshopManifest({ source, checkpoints });

    expect(manifest.durationMinutes).toBe(45);
    expect(manifest.workshop.defaultLobbyMinutes).toBe(20);
    expect(
      manifest.agenda
        .filter((item) => item.scheduled)
        .reduce((total, item) => total + item.durationMinutes, 0),
    ).toBe(45);
    expect(manifest.modules[0]).toMatchObject({
      id: "00-setup",
      title: "Setup",
      catchUpCheckpointId: "checkpoint-00",
      probeIds: ["setup-ready"],
      hints: [
        {
          id: "00-setup-hint-01",
          title: "First setup hint",
        },
      ],
    });
    expect(manifest.modules[0]?.participantMarkdown).toContain(
      "<script>documented, never executed</script>",
    );
    expect(manifest.modules[0]?.participantMarkdown).toContain(
      '`<button onclick="noop()">demo</button>`',
    );
    expect(manifest.presentation.slides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slide-01",
          moduleId: "01-core",
          title: "Reconciliation",
          notesMarkdown: "Pause before revealing the second hint.",
        }),
      ]),
    );
    expect(manifest.workspace).toMatchObject({
      initialCheckpointId: "checkpoint-00",
      vms: [
        {
          id: "workspace",
          cpuMillis: 4_000,
          memoryMib: 16_384,
          diskMib: 102_400,
        },
      ],
      applications: [
        {
          id: "gitea",
          vmId: "workspace",
          port: 30_300,
          upstreamHost: "gitea.internal",
          releaseModuleId: "01-core",
        },
      ],
    });
  });

  it("keeps direct-cloud authoring input untrusted until publication supplies resolved metadata", async () => {
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
    });
    const source = await validate(fixture);
    const checkpoints = [
      checkpoint("checkpoint-00", "a"),
      checkpoint("checkpoint-01", "b"),
    ];
    expect(
      hydrateWorkshopManifest({ source, checkpoints }).workspace.runtimeProfiles,
    ).toEqual([]);

    const manifest = hydrateWorkshopManifest({
      source,
      checkpoints,
      resolvedProfiles: [resolvedHetznerProfile()],
    });
    expect(manifest.workspace.runtimeProfiles).toEqual([
      expect.objectContaining({
        provider: "hetzner_cloud",
        machineType: "cx43",
        immutableSystemImage: "image-13",
      }),
    ]);
  });

  it("requires Intar verification evidence for every provider-only checkpoint", async () => {
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
    });
    const source = await validate(fixture);
    const checkpoints = [
      checkpoint("checkpoint-00", "a"),
      checkpoint("checkpoint-01", "b"),
    ];
    for (const report of checkpoints) {
      report.vmImages = [];
      report.sanitized = false;
      report.coldBootVerified = false;
    }
    const manifest = hydrateWorkshopManifest({
      source,
      checkpoints,
      resolvedProfiles: [resolvedHetznerProfile()],
    });

    expect(() => validateWorkshopManifest(manifest)).toThrow(
      /checkpoint checkpoint-00 has no verified provider artifact/,
    );
    expect(() =>
      validateWorkshopManifest(manifest, {
        verifiedProviderCheckpointIds: new Set(["checkpoint-00"]),
      }),
    ).toThrow(/checkpoint checkpoint-01 has no verified provider artifact/);
    expect(
      validateWorkshopManifest(manifest, {
        verifiedProviderCheckpointIds: new Set([
          "checkpoint-00",
          "checkpoint-01",
        ]),
      }),
    ).toBe(manifest);
    expect(() =>
      validateWorkshopManifest(manifest, {
        verifiedProviderCheckpointIds: new Set(["checkpoint-missing"]),
      }),
    ).toThrow(
      /provider verification references unknown checkpoint checkpoint-missing/,
    );

    const unresolvedManifest = hydrateWorkshopManifest({
      source,
      checkpoints,
    });
    expect(() =>
      validateWorkshopManifest(unresolvedManifest, {
        verifiedProviderCheckpointIds: new Set([
          "checkpoint-00",
          "checkpoint-01",
        ]),
      }),
    ).toThrow(
      /hydrated schemaVersion 2 contract/,
    );
  });

  it.each([
    [
      "an unknown VM",
      (compiled: WorkshopCompiledFixture) => {
        Object.assign(compiled.manifest.workspace, {
          runtime_profiles: [
            {
              id: "hetzner-cx43",
              provider: "hetzner_cloud",
              vm_id: "missing",
              machine_type: "cx43",
              system_image: "debian-13",
              locations: ["nbg1"],
            },
          ],
        });
      },
      /references an unknown VM/,
    ],
    [
      "multiple VMs",
      (compiled: WorkshopCompiledFixture) => {
        compiled.manifest.workspace.vms.push({
          ...compiled.manifest.workspace.vms[0]!,
          id: "second",
        });
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
      /requires one VM/,
    ],
  ])("rejects a direct-cloud profile with %s", async (_label, mutate, error) => {
    const fixture = await buildWorkshopBundleFixture({
      mutateManifest: mutate,
    });
    await expect(validate(fixture)).rejects.toThrow(error);
  });

  it.each([
    ["raw HTML", '<img src="x" onerror="alert(1)">'],
    ["HTML comment", "<!-- hidden payload -->"],
    ["JavaScript URL", "[open me](javascript:alert(1))"],
  ])("rejects unsafe Markdown outside code: %s", async (_label, unsafe) => {
    const fixture = await buildWorkshopBundleFixture({
      fileOverrides: { "content/01.md": `# Unsafe\n\n${unsafe}` },
    });

    await expect(validate(fixture)).rejects.toMatchObject({
      name: "WorkshopBundleValidationError",
      message: expect.stringMatching(/unsafe HTML or JavaScript/),
      status: 400,
    });
  });

  it("rewrites declared bundled images and renders supported Mermaid at compile time", async () => {
    const fixture = await buildWorkshopBundleFixture({
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
    const source = await validate(fixture);
    const manifest = hydrateWorkshopManifest({
      source,
      checkpoints: [
        checkpoint("checkpoint-00", "a"),
        checkpoint("checkpoint-01", "b"),
      ],
    });
    const sourceManifest = hydrateRawWorkshopManifest({
      source,
      checkpoints: [
        checkpoint("checkpoint-00", "a"),
        checkpoint("checkpoint-01", "b"),
      ],
    });
    const slide = manifest.presentation.slides.find(
      (entry) => entry.id === "slide-01",
    );
    const sourceSlide = sourceManifest.presentation.slides.find(
      (entry) => entry.id === "slide-01",
    );
    expect(slide?.bodyMarkdown).toContain(
      "![Flow](/_intar/workshop-assets/assets/flow.svg)",
    );
    expect(slide?.bodyMarkdown).toMatch(
      /data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/,
    );
    expect(slide?.bodyMarkdown).not.toContain("```mermaid");
    expect(sourceSlide?.bodyMarkdown).toContain("![Flow](../assets/flow.svg)");
    expect(sourceSlide?.bodyMarkdown).toContain("```mermaid");
  });

  it("rejects undeclared bundled image references", async () => {
    const fixture = await buildWorkshopBundleFixture({
      fileOverrides: {
        "assets/private.png": "not actually an image",
        "slides/01.md": "# Reconciliation\n\n![private](../assets/private.png)",
      },
    });
    await expect(validate(fixture)).rejects.toThrow(
      /references undeclared presentation asset/,
    );
  });

  it.each(["http", "https"])(
    "rejects %s presentation images while preserving ordinary attribution links",
    async (scheme) => {
      const fixture = await buildWorkshopBundleFixture({
        fileOverrides: {
          "slides/01.md": [
            "# Reconciliation",
            "",
            `[Source](${scheme}://example.test/source)`,
            "",
            `![tracking](${scheme}://example.test/pixel.png)`,
          ].join("\n"),
        },
      });
      await expect(validate(fixture)).rejects.toThrow(
        /remote image URL; workshop images must be bundled/,
      );
    },
  );

  it("rejects reference-style remote images while preserving ordinary links", async () => {
    const fixture = await buildWorkshopBundleFixture({
      fileOverrides: {
        "slides/01.md": [
          "# Reconciliation",
          "",
          "[Source](https://example.test/source)",
          "",
          "![tracking][pixel]",
          "",
          "[pixel]: https://example.test/pixel.png",
        ].join("\n"),
      },
    });
    await expect(validate(fixture)).rejects.toThrow(
      /reference-style image; workshop images must use bundled inline targets/,
    );
  });

  it("rejects Mermaid outside the deterministic v1 flowchart subset", async () => {
    const fixture = await buildWorkshopBundleFixture({
      fileOverrides: {
        "slides/01.md":
          "# Unsupported\n\n```mermaid\nsequenceDiagram\nA->>B: hello\n```",
      },
    });
    await expect(validate(fixture)).rejects.toThrow(
      /must use flowchart LR or flowchart TD/,
    );
  });

  it.each([
    {
      name: "out-of-range default lobby duration",
      mutate: (
        fixture: Awaited<
          ReturnType<typeof buildWorkshopBundleFixture>
        >["compiled"],
      ) => {
        fixture.manifest.workshop.default_lobby_minutes = 1_441;
      },
      error: /default_lobby_minutes must be between 0 and 1440/,
    },
    {
      name: "unknown module dependency",
      mutate: (
        fixture: Awaited<
          ReturnType<typeof buildWorkshopBundleFixture>
        >["compiled"],
      ) => {
        fixture.manifest.modules[1]!.depends_on = ["does-not-exist"];
      },
      error: /module 01-core has an invalid dependency/,
    },
    {
      name: "unknown agenda slide",
      mutate: (
        fixture: Awaited<
          ReturnType<typeof buildWorkshopBundleFixture>
        >["compiled"],
      ) => {
        fixture.manifest.agenda[2]!.slides = ["missing-slide"];
      },
      error: /agenda item core-lab references an unknown slide/,
    },
    {
      name: "unknown application release module",
      mutate: (
        fixture: Awaited<
          ReturnType<typeof buildWorkshopBundleFixture>
        >["compiled"],
      ) => {
        fixture.manifest.workspace.applications[0]!.release_module =
          "missing-module";
      },
      error: /application gitea has an invalid release module/,
    },
    {
      name: "unsafe application upstream host",
      mutate: (
        fixture: Awaited<
          ReturnType<typeof buildWorkshopBundleFixture>
        >["compiled"],
      ) => {
        fixture.manifest.workspace.applications[0]!.upstream_host =
          "https://Gitea.internal:3000";
      },
      error: /application gitea has an invalid upstream host/,
    },
    {
      name: "unsupported encrypted application transport",
      mutate: (
        fixture: Awaited<
          ReturnType<typeof buildWorkshopBundleFixture>
        >["compiled"],
      ) => {
        fixture.manifest.workspace.applications[0]!.protocol = "https";
      },
      error: /application gitea has an invalid protocol/,
    },
    {
      name: "unpublished initial checkpoint",
      mutate: (
        fixture: Awaited<
          ReturnType<typeof buildWorkshopBundleFixture>
        >["compiled"],
      ) => {
        fixture.manifest.workspace.initial_checkpoint = "checkpoint-99";
      },
      error: /initial checkpoint must be published by a module/,
    },
  ])("rejects an invalid reference: $name", async ({ mutate, error }) => {
    const fixture = await buildWorkshopBundleFixture({
      mutateManifest: mutate,
    });
    await expect(validate(fixture)).rejects.toThrow(error);
  });

  it("rejects missing referenced source files", async () => {
    const fixture = await buildWorkshopBundleFixture({
      fileOverrides: { "slides/01.md": null },
    });
    await expect(validate(fixture)).rejects.toThrow(
      /bundle archive is missing slides\/01\.md/,
    );
  });

  it("rejects a compiler duration that differs from scheduled agenda items", async () => {
    const fixture = await buildWorkshopBundleFixture({
      mutateManifest: (compiled) => {
        compiled.scheduled_duration_minutes = 46;
      },
    });
    await expect(validate(fixture)).rejects.toThrow(
      /scheduled_duration_minutes must equal the scheduled agenda duration/,
    );
  });

  it("rejects a legacy bundle without the runtime tool format", async () => {
    const fixture = await buildWorkshopBundleFixture({
      mutateManifest: (compiled) => {
        Reflect.deleteProperty(compiled, "runtime_tool_format_version");
      },
    });
    await expect(validate(fixture)).rejects.toThrow(
      /unsupported workshop runtime_tool_format_version/,
    );
  });

  it("rejects a mismatched content digest before reading the archive", async () => {
    const fixture = await buildWorkshopBundleFixture();
    await expect(
      validateWorkshopSourceBundle({
        payload: arrayBuffer(fixture.bytes),
        claimedWorkshopId: "registry-workshop",
        claimedSha256: "f".repeat(64),
      }),
    ).rejects.toBeInstanceOf(WorkshopBundleValidationError);
  });
});

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

function validate(
  fixture: Awaited<ReturnType<typeof buildWorkshopBundleFixture>>,
) {
  return validateWorkshopSourceBundle({
    payload: arrayBuffer(fixture.bytes),
    claimedWorkshopId: "registry-workshop",
    claimedSha256: fixture.sha256,
  });
}

function checkpoint(
  checkpointId: string,
  digest: string,
): WorkshopCheckpointBuildReport {
  return {
    checkpointId,
    coveredModuleIds:
      checkpointId === "checkpoint-00" ? ["00-setup"] : ["00-setup", "01-core"],
    sanitized: true,
    coldBootVerified: true,
    vmImages: [
      {
        vmId: "workspace",
        imageKey: {
          scenario: `fixture-${checkpointId}`,
          vm: "workspace",
          arch: "x86_64",
        },
        imageSha256: digest.repeat(64),
      },
    ],
  };
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
