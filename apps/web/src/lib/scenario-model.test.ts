import { describe, expect, it } from "vitest";
import type {
  ScenarioProbeRecord,
  ScenarioVmRecord,
} from "@/lib/scenario-model";
import {
  buildScenarioLaunchSpecs,
  deriveScenarioBriefing,
  normalizeScenarioVmDirectBootMetadata,
  parseScenarioLaunchSummary,
} from "@/lib/scenario-model";

describe("scenario model", () => {
  it("derives briefing content from stored scenario metadata and scenario probes only", () => {
    const briefing = deriveScenarioBriefing({
      scenarioId: "broken-nginx",
      title: " Broken Nginx ",
      category: "web",
      description: " Repair nginx without leaking hints. ",
      difficulty: "hard",
      estimatedMinutes: 42,
      tags: ["nginx", "systemd"],
      briefingMarkdown: "Line one\r\nLine two\rLine three",
      probes: [
        probe({
          name: "boot-network",
          description: "Boot network is up",
          title: "Boot-only title",
          bodyMarkdown: "This boot probe should not become an objective.",
          hints: [
            {
              id: "boot-hint",
              body_markdown: "Boot hint must stay out of the briefing.",
            },
          ],
          phase: "boot",
        }),
        probe({
          name: "nginx_service_running",
          description: "nginx is running",
          title: "Bring nginx back up",
          bodyMarkdown: "The service must be active.",
          hints: [
            {
              id: "status",
              title: "Check systemd",
              body_markdown: "`systemctl status nginx`",
            },
            {
              id: "journal",
              body_markdown: "`journalctl -u nginx`",
            },
          ],
          phase: "scenario",
        }),
      ],
    });

    expect(briefing).toEqual({
      title: "Broken Nginx",
      tagline: "Repair nginx without leaking hints.",
      category: "web",
      difficulty: "hard",
      estimatedMinutes: 42,
      briefingMarkdown: "Line one\nLine two\nLine three",
      tags: ["nginx", "systemd"],
      objectives: [
        {
          probeName: "nginx_service_running",
          vmName: "web",
          label: "nginx is running",
          title: "Bring nginx back up",
          bodyMarkdown: "The service must be active.",
          hintCount: 2,
        },
      ],
    });
  });

  it("builds launch specs from manifest-backed vm image metadata and probe phases", () => {
    const specs = buildScenarioLaunchSpecs({
      scenarioId: "Broken Nginx!!",
      vms: [
        vm({
          id: "vm-web",
          name: "Web Server",
          image: " broken-nginx-web-x86_64.raw.zst ",
        }),
      ],
      probes: [
        probe({
          scenarioVmId: "vm-web",
          ordinal: 0,
          name: "boot-network",
          description: "network is ready",
          phase: "boot",
        }),
        probe({
          scenarioVmId: "vm-web",
          ordinal: 1,
          name: "http-ok",
          description: "HTTP responds",
          phase: "scenario",
        }),
        probe({
          scenarioVmId: "vm-other",
          ordinal: 0,
          name: "other-vm-probe",
          description: "must not attach to web",
          phase: "scenario",
        }),
      ],
    });

    expect(specs).toEqual([
      {
        scenarioVmId: "vm-web",
        scenarioVmName: "web-server",
        runtimeVmNamePrefix: "broken-nginx-web-server",
        image: "broken-nginx-web-x86_64.raw.zst",
        imageKey: {
          scenario: "broken-nginx",
          vm: "web",
          arch: "x86_64",
        },
        imageSha256:
          "565d9a5e65009697de935eab180e6e7ef929a01b7e5963199fb168357021cb19",
        hostname: "web-server",
        resources: {
          cpuMillis: 2_000,
          vcpuCount: 2,
          memoryMib: 2048,
          diskMib: 8192,
        },
        leaseDurationSeconds: 3600,
        summary: {
          scenarioVmName: "web-server",
          hostname: "web-server",
          probePhaseMap: {
            "boot-network": "boot",
            "http-ok": "scenario",
          },
          probeDescriptors: [
            {
              id: "boot-network",
              label: "network is ready",
              kind: "service",
              phase: "boot",
            },
            {
              id: "http-ok",
              label: "HTTP responds",
              kind: "service",
              phase: "scenario",
            },
          ],
        },
      },
    ]);
  });

  it("normalizes launch summaries and ignores malformed probe descriptors", () => {
    expect(
      parseScenarioLaunchSummary(
        JSON.stringify({
          scenarioVmName: "web",
          hostname: "web",
          probePhaseMap: {
            "boot-network": "boot",
            "http-ok": "scenario",
            stale: "invalid",
          },
          probeDescriptors: [
            {
              id: "boot-network",
              label: "network is ready",
              kind: "probe",
              phase: "boot",
            },
            {
              id: "http-ok",
              label: "HTTP responds",
              kind: "probe",
              phase: "scenario",
            },
            {
              id: "bad",
              label: "bad",
              kind: "probe",
              phase: "invalid",
            },
          ],
        }),
      ),
    ).toEqual({
      scenarioVmName: "web",
      hostname: "web",
      probePhaseMap: {
        "boot-network": "boot",
        "http-ok": "scenario",
      },
      probeDescriptors: [
        {
          id: "boot-network",
          label: "network is ready",
          kind: "probe",
          phase: "boot",
        },
        {
          id: "http-ok",
          label: "HTTP responds",
          kind: "probe",
          phase: "scenario",
        },
      ],
    });
  });

  it("normalizes direct-boot VM metadata from catalog rows", () => {
    expect(normalizeScenarioVmDirectBootMetadata({
      imageFormat: "raw_zstd",
      imageVirtualSizeBytes: 2_147_483_648,
      kernelSha256:
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      initrdSha256:
        "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      bootCmdline:
        " root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false ",
    })).toEqual({
      imageFormat: "raw_zstd",
      imageVirtualSizeBytes: 2_147_483_648,
      kernelSha256:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      initrdSha256:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      bootCmdline:
        "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false",
    });
  });

  it("rejects stale or non-direct-boot VM metadata", () => {
    const valid = {
      imageFormat: "raw_zstd",
      imageVirtualSizeBytes: 2_147_483_648,
      kernelSha256:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      initrdSha256:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      bootCmdline: "root=/dev/vda rw console=ttyS0 quiet loglevel=4",
    };

    expect(normalizeScenarioVmDirectBootMetadata({
      ...valid,
      imageVirtualSizeBytes: 0,
    })).toBeNull();
    expect(normalizeScenarioVmDirectBootMetadata({
      ...valid,
      kernelSha256: "not-a-sha",
    })).toBeNull();
    expect(normalizeScenarioVmDirectBootMetadata({
      ...valid,
      bootCmdline: "root=LABEL=INTARROOT rw console=ttyS0",
    })).toBeNull();
    expect(normalizeScenarioVmDirectBootMetadata({
      ...valid,
      imageFormat: "qcow2",
    })).toBeNull();
  });
});

function probe(
  overrides: Partial<ScenarioProbeRecord> = {},
): ScenarioProbeRecord {
  return {
    scenarioVmId: "vm-web",
    scenarioVmName: "web",
    ordinal: 0,
    name: "nginx_service_running",
    description: "nginx is running",
    title: null,
    bodyMarkdown: null,
    hints: [],
    phase: "scenario",
    kind: "service",
    ...overrides,
  };
}

function vm(overrides: Partial<ScenarioVmRecord> = {}): ScenarioVmRecord {
  return {
    id: "vm-web",
    ordinal: 0,
    name: "web",
    image: "broken-nginx-web-x86_64.raw.zst",
    imageKey: {
      scenario: "broken-nginx",
      vm: "web",
      arch: "x86_64",
    },
    imageSha256:
      "565d9a5e65009697de935eab180e6e7ef929a01b7e5963199fb168357021cb19",
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 2_147_483_648,
    kernelSha256:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    initrdSha256:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    bootCmdline: "root=/dev/vda rw console=ttyS0 quiet loglevel=4",
    cpuMillis: 2_000,
    vcpuCount: 2,
    memoryMib: 2048,
    diskMib: 8192,
    ...overrides,
  };
}
