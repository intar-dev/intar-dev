import { describe, expect, it } from "vitest";
import {
  serializeAdminScenarioDetail,
  serializeAdminScenarioSummary,
} from "@/lib/admin-scenario-response";
import type { ScenarioDetailRecord } from "@/lib/scenarios";

describe("admin scenario response serialization", () => {
  it("keeps list responses lean while carrying catalog metadata", () => {
    const serialized = serializeAdminScenarioSummary(scenario);

    expect(serialized.category).toBe("web");
    expect(serialized).not.toHaveProperty("solutionMarkdown");
    expect(serialized).not.toHaveProperty("briefingMarkdown");
    expect(serialized).not.toHaveProperty("hints");
    expect(serialized.scenarioHintCount).toBe(1);
  });

  it("includes gated content and full probe fields in detail responses", () => {
    const serialized = serializeAdminScenarioDetail(scenario);

    expect(serialized.briefingMarkdown).toBe("The service is down.");
    expect(serialized.solutionMarkdown).toBe("Run `systemctl restart nginx`.");
    expect(serialized.hints).toEqual(scenario.hints);
    expect(serialized.scenarioHintCount).toBe(1);
    expect(serialized.probes[0]?.hints).toEqual(scenario.probes[0]?.hints);
    expect(serialized.probes[0]?.bodyMarkdown).toBe(
      "Make nginx respond on localhost.",
    );
    expect(serialized.probes[0]).not.toHaveProperty("hintCount");
    expect(serialized.vms[0]?.imageFormat).toBe("raw_zstd");
    expect(serialized.vms[0]?.kernelSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

const scenario: ScenarioDetailRecord = {
  organizationId: null,
  category: "web",
  scenarioId: "broken-nginx",
  title: "Broken Nginx",
  description: "Fix a misconfigured nginx server",
  difficulty: "easy",
  estimatedMinutes: 15,
  tags: ["nginx"],
  briefingMarkdown: "The service is down.",
  solutionMarkdown: "Run `systemctl restart nginx`.",
  hints: [
    {
      id: "service",
      title: "Check the service",
      body_markdown: "Run `systemctl status nginx`.",
    },
  ],
  probeCount: 1,
  vmCount: 1,
  enabled: true,
  enabledAt: 123,
  createdAt: 100,
  updatedAt: 200,
  probes: [
    {
      scenarioVmId: "vm-1",
      scenarioVmName: "web",
      ordinal: 0,
      name: "http-ok",
      description: "HTTP responds",
      kind: "port_open",
      title: "Restore HTTP",
      bodyMarkdown: "Make nginx respond on localhost.",
      hints: [
        {
          id: "curl",
          title: null,
          body_markdown: "Run `curl -i http://127.0.0.1`.",
        },
      ],
      phase: "scenario",
    },
  ],
  vms: [
    {
      id: "vm-1",
      ordinal: 0,
      name: "web",
      image: "web",
      imageKey: null,
      imageSha256: null,
      imageFormat: "raw_zstd",
      imageVirtualSizeBytes: 2_147_483_648,
      kernelSha256: "b".repeat(64),
      initrdSha256: "c".repeat(64),
      bootCmdline: "root=/dev/vda rw console=ttyS0 quiet loglevel=4",
      cpuMillis: 1_000,
      vcpuCount: 1,
      memoryMib: 1024,
      diskMib: 2048,
    },
  ],
};
