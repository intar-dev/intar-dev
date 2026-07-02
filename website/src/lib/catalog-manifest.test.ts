import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ScenarioManifestV1 } from "@/generated/catalog";
import { catalogRowsFromScenarioManifest } from "@/lib/catalog-manifest";

describe("catalog manifest", () => {
  it("maps a scenario manifest into stable catalog rows", () => {
    const manifest = readManifestFixture();
    const rows = catalogRowsFromScenarioManifest(manifest, {
      nowUnixMs: 1_762_041_600_000,
    });

    expect(rows.scenario).toMatchObject({
      scenarioId: "broken-nginx",
      description: "Repair the nginx service.",
      enabled: true,
      enabledAt: 1_762_041_600_000,
    });
    expect(rows.vms).toEqual([
      {
        id: "broken-nginx:web",
        scenarioId: "broken-nginx",
        ordinal: 0,
        vmName: "web",
        image: "broken-nginx-web-x86_64.qcow2",
        imageKeyJson: {
          scenario: "broken-nginx",
          vm: "web",
          arch: "x86_64",
        },
        imageSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        cpu: 2,
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
        phase: "scenario",
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

function readManifestFixture(): ScenarioManifestV1 {
  return JSON.parse(
    readFileSync(
      new URL("../generated/fixtures/catalog/scenario-manifest-v1.json", import.meta.url),
      "utf8",
    ),
  ) as ScenarioManifestV1;
}
