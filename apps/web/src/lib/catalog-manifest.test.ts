import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { catalogRowsFromScenarioManifest } from "@/lib/catalog-manifest";

describe("catalog manifest", () => {
  it("maps a scenario manifest into stable catalog rows", () => {
    const manifest = readManifestFixture();
    const rows = catalogRowsFromScenarioManifest(manifest, {
      nowUnixMs: 1_762_041_600_000,
    });

    expect(rows.scenario).toMatchObject({
      scenarioId: "broken-nginx",
      title: "Broken Nginx",
      description: "Repair the nginx service.",
      difficulty: "easy",
      estimatedMinutes: 15,
      tagsJson: ["nginx", "systemd", "linux"],
      briefingMarkdown:
        "The web server should serve the default site, but nginx was disabled during cleanup.",
      solutionMarkdown: "Enable nginx and restore the default site symlink.",
      hintsJson: [
        {
          id: "check-service",
          title: "Start with systemd",
          body_markdown: "Check whether nginx is active before reading config files.",
        },
      ],
      enabled: true,
      enabledAt: 1_762_041_600_000,
    });
    expect(rows.vms).toEqual([
      {
        id: "broken-nginx:web",
        scenarioId: "broken-nginx",
        ordinal: 0,
        vmName: "web",
        image: "broken-nginx-web-x86_64.chunks.json",
        imageKeyJson: {
          scenario: "broken-nginx",
          vm: "web",
          arch: "x86_64",
        },
        imageSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        imageFormat: "raw_chunks_v1",
        imageVirtualSizeBytes: 8589934592,
        chunkManifestSha256:
          "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        guestBootstrapAbi: 1,
        kernelSha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        initrdSha256:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        bootCmdline:
          "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false",
        cpuMillis: 125,
        vcpuCount: 1,
        memoryMib: 2048,
        diskMib: 8192,
      },
    ]);
    expect(rows.probes).toEqual([
      {
        id: "broken-nginx:web:nginx_service_running",
        scenarioId: "broken-nginx",
        scenarioVmId: "broken-nginx:web",
        ordinal: 0,
        name: "nginx_service_running",
        description: "nginx is running",
        title: "Bring nginx back up",
        bodyMarkdown:
          "The nginx service must be running before the site can answer requests.",
        hintsJson: [
          {
            id: "status",
            body_markdown:
              "`systemctl status nginx` shows whether the service is active.",
          },
        ],
        phase: "scenario",
        kind: "service",
      },
    ]);
  });

  it("can seed disabled catalog rows for staged manifests", () => {
    const rows = catalogRowsFromScenarioManifest(readManifestFixture(), {
      nowUnixMs: 1_762_041_600_000,
      enabled: false,
    });

    expect(rows.scenario.enabled).toBe(false);
    expect(rows.scenario.enabledAt).toBeNull();
  });
});

function readManifestFixture(): ScenarioManifestV4 {
  return JSON.parse(
    readFileSync(
      new URL("../generated/fixtures/catalog/scenario-manifest-v4.json", import.meta.url),
      "utf8",
    ),
  ) as ScenarioManifestV4;
}
