import { buildTar, gzipBytes } from "@/lib/tar";

const encoder = new TextEncoder();

export function workshopCompiledFixture() {
  return {
    format_version: 1,
    scheduled_duration_minutes: 45,
    manifest: {
      format_version: 1,
      workshop: {
        id: "registry-workshop",
        title: "Registry workshop",
        summary: "A deterministic workshop registry fixture.",
        prerequisites: ["A browser", "Curiosity"],
        attribution:
          "Platform Engineering Workshop https://example.test/upstream Apache-2.0",
        default_lobby_minutes: 20,
      },
      workspace: {
        lease_grace_minutes: 60,
        initial_checkpoint: "checkpoint-00",
        vms: [
          {
            id: "workspace",
            image: "debian-13-workshop",
            vcpu_millis: 4_000,
            memory_mib: 16_384,
            disk_gib: 100,
          },
        ],
        applications: [
          {
            id: "gitea",
            label: "Gitea",
            vm: "workspace",
            port: 30_300,
            protocol: "http",
            release_module: "01-core",
          },
        ],
      },
      modules: [
        {
          id: "00-setup",
          tier: "gate",
          outcome: "The local toolchain is ready.",
          depends_on: [],
          content: "content/00.md",
          facilitator_notes: "facilitator/00.md",
          hints: ["hints/00-01.md"],
          solution: "solutions/00.md",
          explain_back: "Explain why the preflight runs before the session.",
          verify_script: "scripts/verify-00.sh",
          catch_up_script: "scripts/catch-up-00.sh",
          checkpoint: "checkpoint-00",
          probes: ["setup-ready"],
        },
        {
          id: "01-core",
          tier: "core",
          outcome: "The learner ships a service through the platform.",
          depends_on: ["00-setup"],
          content: "content/01.md",
          facilitator_notes: "facilitator/01.md",
          hints: ["hints/01-01.md", "hints/01-02.md"],
          solution: "solutions/01.md",
          explain_back: "Explain the reconciliation path.",
          verify_script: "scripts/verify-01.sh",
          catch_up_script: "scripts/catch-up-01.sh",
          checkpoint: "checkpoint-01",
          probes: ["service-ready", "route-ready"],
        },
      ],
      agenda: [
        {
          id: "preflight",
          kind: "lab",
          duration_minutes: 0,
          scheduled: false,
          module: "00-setup",
          slides: ["slide-00"],
          release: "automatic",
        },
        {
          id: "opening",
          kind: "briefing",
          duration_minutes: 15,
          scheduled: true,
          module: null,
          slides: ["slide-00"],
          release: "facilitator",
        },
        {
          id: "core-lab",
          kind: "lab",
          duration_minutes: 30,
          scheduled: true,
          module: "01-core",
          slides: ["slide-01"],
          release: "facilitator",
        },
      ],
      presentation: {
        slides: [
          {
            id: "slide-00",
            content: "slides/00.md",
            presenter_notes: "notes/00.md",
            layout: "cover",
          },
          {
            id: "slide-01",
            content: "slides/01.md",
            presenter_notes: "notes/01.md",
            layout: "default",
          },
        ],
        assets: ["assets/flow.svg"],
      },
    },
  };
}

export type WorkshopCompiledFixture = ReturnType<
  typeof workshopCompiledFixture
>;

export interface WorkshopBundleFixture {
  bytes: Uint8Array;
  sha256: string;
  compiled: WorkshopCompiledFixture;
}

export async function buildWorkshopBundleFixture(
  options: {
    mutateManifest?: (compiled: WorkshopCompiledFixture) => void;
    fileOverrides?: Record<string, string | null>;
  } = {},
): Promise<WorkshopBundleFixture> {
  const compiled = workshopCompiledFixture();
  options.mutateManifest?.(compiled);
  const files: Record<string, string> = {
    LICENSE: "Apache License\nVersion 2.0, January 2004\n",
    "assets/flow.svg":
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
    "content/00.md": [
      "# Setup",
      "",
      "Commands that look like HTML remain documentation when fenced:",
      "",
      "```html",
      "<script>documented, never executed</script>",
      "```",
      "",
      'Inline code is safe too: `<button onclick="noop()">demo</button>`.',
    ].join("\n"),
    "content/01.md": "# Ship the service\n\nFollow the reconciliation loop.",
    "facilitator/00.md": "# Setup notes\n\nWatch for local DNS failures.",
    "facilitator/01.md": "# Core notes\n\nAsk for an explain-back.",
    "hints/00-01.md": "# First setup hint\n\nCheck the pinned tools.",
    "hints/01-01.md": "# First core hint\n\nInspect the controller.",
    "hints/01-02.md": "# Second core hint\n\nInspect the route.",
    "notes/00.md": "Welcome learners and confirm the room is ready.",
    "notes/01.md": "Pause before revealing the second hint.",
    "scripts/catch-up-00.sh": "#!/bin/sh\nset -eu\ntrue\n",
    "scripts/catch-up-01.sh": "#!/bin/sh\nset -eu\ntrue\n",
    "scripts/verify-00.sh": "#!/bin/sh\necho 'INTAR_PROBE setup-ready pass'\n",
    "scripts/verify-01.sh":
      "#!/bin/sh\necho 'INTAR_PROBE service-ready pass'\necho 'INTAR_PROBE route-ready pass'\n",
    "slides/00.md": "# Registry workshop\n\nA native Intar presentation.",
    "slides/01.md": "# Reconciliation\n\nDesired state becomes actual state.",
    "solutions/00.md": "# Setup solution\n\nUse the baked toolchain.",
    "solutions/01.md": "# Core solution\n\nApply the declared resources.",
    "workshop.hcl": 'workshop { id = "registry-workshop" }\n',
  };
  for (const [path, value] of Object.entries(options.fileOverrides ?? {})) {
    if (value === null) delete files[path];
    else files[path] = value;
  }
  files["workshop.compiled.json"] = JSON.stringify(compiled);

  const tar = buildTar(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, source]) => ({ path, bytes: encoder.encode(source) })),
  );
  const bytes = await gzipBytes(tar);
  return { bytes, sha256: await sha256Hex(bytes), compiled };
}

export function checkpointResult(
  publicationId: string,
  checkpointIds = ["checkpoint-00", "checkpoint-01"],
) {
  return checkpointIds.map((checkpointId, index) => ({
    checkpoint_id: checkpointId,
    sanitized: true,
    cold_boot_verified: true,
    runtime_bundle_cold_boot_verified: true,
    vm_images: [
      {
        vm_id: "workspace",
        image_key: {
          scenario: `workshop-${publicationId}-${checkpointId}`,
          vm: "workspace",
          arch: "x86_64" as const,
        },
        image_sha256: digestCharacter(index * 3),
        image_format: "raw_zstd",
        image_virtual_size_bytes: 100 * 1_024 * 1_024 * 1_024,
        kernel_sha256: digestCharacter(index * 3 + 1),
        initrd_sha256: digestCharacter(index * 3 + 2),
        boot_cmdline: "console=ttyS0 root=/dev/vda rw",
      },
    ],
  }));
}

function digestCharacter(index: number): string {
  return "abcdef"[index % 6]!.repeat(64);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
