/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import {
  agentBootstrapTokens,
  agentHosts,
  organization,
  user,
  vmScenarios,
  vmScenarioVms,
} from "@/db/schema";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { handleAgentImageDownload } from "./agent";
import { imageObjectKey, registryImageKey } from "./shared";

const PUBLIC_SHA = "a".repeat(64);
const ORG_A_SHA = "b".repeat(64);
const ORG_B_SHA = "c".repeat(64);

describe("organization image registry tenancy", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("allows public and same-organization images without leaking private images", async () => {
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "runner-owner",
      name: "Runner Owner",
      email: "runner-owner@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await grantActiveBetaAccess("runner-owner");
    await db.insert(organization).values([
      {
        id: "org-a",
        name: "Organization A",
        slug: "organization-a",
        createdAt: new Date(),
      },
      {
        id: "org-b",
        name: "Organization B",
        slug: "organization-b",
        createdAt: new Date(),
      },
    ]);

    const scenarios = [
      await seedScenario(null, "public-scenario", PUBLIC_SHA),
      await seedScenario("org-a", "organization-a-private", ORG_A_SHA),
      await seedScenario("org-b", "organization-b-private", ORG_B_SHA),
    ];
    for (const scenario of scenarios) {
      await env.VM_IMAGE_REGISTRY_BUCKET.put(
        imageObjectKey(scenario.imageKey, scenario.sha256),
        `${scenario.scenarioId} image`,
        {
          customMetadata: {
            image_key: scenario.imageKey,
            image_sha256: scenario.sha256,
          },
        },
      );
    }

    const organizationToken = await seedAgentAndBootstrap({
      hostId: "org-a-agent",
      organizationId: "org-a",
      bootstrapToken: "org-a-bootstrap-token",
    });
    const platformToken = await seedAgentAndBootstrap({
      hostId: "platform-agent",
      organizationId: null,
      bootstrapToken: "platform-bootstrap-token",
    });

    await expect(
      download(organizationToken, scenarios[0]!),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      download(organizationToken, scenarios[1]!),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      download(organizationToken, scenarios[2]!),
    ).resolves.toMatchObject({ status: 404 });

    await expect(download(platformToken, scenarios[0]!)).resolves.toMatchObject(
      { status: 200 },
    );
    await expect(download(platformToken, scenarios[1]!)).resolves.toMatchObject(
      { status: 404 },
    );
  });
});

interface SeededScenario {
  scenarioId: string;
  imageKey: string;
  sha256: string;
}

async function seedScenario(
  organizationId: string | null,
  scenarioId: string,
  sha256: string,
): Promise<SeededScenario> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const image = { scenario: scenarioId, vm: "vm", arch: "x86_64" as const };
  await db.batch([
    db.insert(vmScenarios).values({
      scenarioId,
      organizationId,
      title: scenarioId,
      category: "test",
      description: "registry tenancy test",
      difficulty: "easy",
      estimatedMinutes: 10,
      tagsJson: [],
      briefingMarkdown: "briefing",
      solutionMarkdown: "solution",
      hintsJson: [],
      enabled: true,
      enabledAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(vmScenarioVms).values({
      id: `${scenarioId}:vm`,
      scenarioId,
      ordinal: 0,
      vmName: "vm",
      image: `${scenarioId}-vm-x86_64.raw.zst`,
      imageKeyJson: image,
      imageSha256: sha256,
      imageFormat: "raw_zstd",
      imageVirtualSizeBytes: 1_024,
      kernelSha256: `${sha256.slice(0, 63)}d`,
      initrdSha256: `${sha256.slice(0, 63)}e`,
      bootCmdline: "console=ttyS0 root=/dev/vda rw",
      cpuMillis: 1_000,
      vcpuCount: 1,
      memoryMib: 512,
      diskMib: 1_024,
    }),
  ]);
  return { scenarioId, imageKey: registryImageKey(image), sha256 };
}

async function seedAgentAndBootstrap(input: {
  hostId: string;
  organizationId: string | null;
  bootstrapToken: string;
}): Promise<string> {
  const db = drizzle(env.DB);
  await db.insert(agentHosts).values({
    id: input.hostId,
    userId: "runner-owner",
    organizationId: input.organizationId,
    name: input.hostId,
    role: "agent",
  });
  await db.insert(agentBootstrapTokens).values({
    id: `${input.hostId}-bootstrap`,
    hostId: input.hostId,
    tokenHash: await sha256Hex(input.bootstrapToken),
    expiresAt: null,
  });

  const response = await handleAgentBootstrap(
    new Request("https://intar.test/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostId: input.hostId,
        bootstrapToken: input.bootstrapToken,
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

async function grantActiveBetaAccess(userId: string): Promise<void> {
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId,
    githubUsername: userId,
  });
}

function download(token: string, scenario: SeededScenario): Promise<Response> {
  return handleAgentImageDownload(
    new Request(
      `https://intar.test/agent/registry/images/${scenario.imageKey}/${scenario.sha256}`,
      { headers: { authorization: `Bearer ${token}` } },
    ),
    env,
    scenario.imageKey,
    scenario.sha256,
  );
}
