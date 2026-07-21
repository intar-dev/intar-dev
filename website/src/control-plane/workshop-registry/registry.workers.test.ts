/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import {
  artifactObjectKey,
  imageObjectKey,
  registryImageKey,
} from "@/control-plane/image-registry/shared";
import {
  agentBootstrapTokens,
  agentHosts,
  organization,
  user,
  workshopPublicationCheckpoints,
  workshopPublications,
  workshopRegistryTokens,
  workshopTemplateRevisions,
  workshopTemplates,
} from "@/db/schema";
import { hashWorkshopRegistryToken } from "@/lib/workshops/registry-tokens";
import { resetD1Database } from "@/test/d1-migrations";
import { handleWorkshopRegistryRequest } from ".";
import {
  buildWorkshopBundleFixture,
  checkpointResult,
  type WorkshopBundleFixture,
} from "./test-support";

const ORG_A_TOKEN = "intar_ws_organization_a_test_token";
const ORG_B_TOKEN = "intar_ws_organization_b_test_token";
const BUILDER_BOOTSTRAP_TOKEN = "workshop-builder-bootstrap-token";
const BUILDER_B_BOOTSTRAP_TOKEN = "workshop-builder-b-bootstrap-token";

describe("workshop registry publication lifecycle", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedRegistryPrincipals();
  });

  it("publishes atomically after a builder verifies every checkpoint and preserves the immutable revision", async () => {
    const fixture = await buildWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);

    expect(receipt.response.status).toBe(202);
    expect(receipt.body).toMatchObject({
      status: "queued",
      status_url: `https://intar.test/registry/v1/workshop-bundles/${receipt.publicationId}`,
    });

    const builderToken = await bootstrapBuilder();
    const claim = await registryRequest(
      new Request(
        "https://intar.test/agent/registry/workshop-publications/next",
        { headers: bearer(builderToken) },
      ),
    );
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toMatchObject({
      publication_id: receipt.publicationId,
      workshop_slug: "registry-workshop",
      content_hash: fixture.sha256,
      required_checkpoint_ids: ["checkpoint-00", "checkpoint-01"],
      bundle_url: `/agent/registry/workshop-publications/${receipt.publicationId}/bundle`,
    });

    const download = await registryRequest(
      new Request(
        `https://intar.test/agent/registry/workshop-publications/${receipt.publicationId}/bundle`,
        { headers: bearer(builderToken) },
      ),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("x-workshop-content-sha256")).toBe(
      fixture.sha256,
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(fixture.bytes);

    const checkpoints = checkpointResult(receipt.publicationId);
    await seedCheckpointObjects(checkpoints);
    const result = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(result.status).toBe(201);
    const resultBody = (await result.json()) as {
      status: string;
      template_id: string;
      revision_id: string;
      revision: number;
    };
    expect(resultBody).toMatchObject({
      status: "published",
      revision: 1,
    });

    const status = await publicationStatus(ORG_A_TOKEN, receipt.publicationId);
    expect(status.response.status).toBe(200);
    expect(status.body).toMatchObject({
      publication_id: receipt.publicationId,
      workshop_id: "registry-workshop",
      sha256: fixture.sha256,
      status: "published",
      revision_id: resultBody.revision_id,
      checkpoints: [
        {
          checkpoint_id: "checkpoint-00",
          status: "verified",
          sanitized: true,
          cold_boot_verified: true,
        },
        {
          checkpoint_id: "checkpoint-01",
          status: "verified",
          sanitized: true,
          cold_boot_verified: true,
        },
      ],
    });

    const db = drizzle(env.DB);
    const [templates, revisions, publications, checkpointRows] =
      await Promise.all([
        db.select().from(workshopTemplates),
        db.select().from(workshopTemplateRevisions),
        db.select().from(workshopPublications),
        db
          .select()
          .from(workshopPublicationCheckpoints)
          .where(
            eq(
              workshopPublicationCheckpoints.publicationId,
              receipt.publicationId,
            ),
          ),
      ]);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      id: resultBody.template_id,
      organizationId: "org-a",
      slug: "registry-workshop",
      currentRevisionId: resultBody.revision_id,
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      id: resultBody.revision_id,
      templateId: resultBody.template_id,
      revision: 1,
      contentHash: fixture.sha256,
      manifestJson: {
        schemaVersion: 1,
        durationMinutes: 45,
        workshop: { slug: "registry-workshop" },
        modules: [
          expect.objectContaining({
            id: "00-setup",
            participantMarkdown: expect.stringContaining(
              "<script>documented, never executed</script>",
            ),
          }),
          expect.objectContaining({
            id: "01-core",
            dependsOn: ["00-setup"],
          }),
        ],
      },
    });
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      status: "published",
      publishedRevisionId: resultBody.revision_id,
    });
    expect(checkpointRows).toHaveLength(2);
    expect(checkpointRows.every((row) => row.sanitized)).toBe(true);
    expect(checkpointRows.every((row) => row.coldBootVerified)).toBe(true);

    await expect(
      env.DB.prepare(
        "UPDATE workshop_template_revisions SET revision = 2 WHERE id = ?",
      )
        .bind(resultBody.revision_id)
        .run(),
    ).rejects.toThrow(/workshop template revisions are immutable/);

    const idempotentUpload = await uploadBundle(ORG_A_TOKEN, fixture);
    expect(idempotentUpload.response.status).toBe(202);
    expect(idempotentUpload.body).toMatchObject({
      publication_id: receipt.publicationId,
      status: "published",
    });
    expect(await db.select().from(workshopTemplateRevisions)).toHaveLength(1);

    const repeatedResult = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(repeatedResult.status).toBe(200);
    await expect(repeatedResult.json()).resolves.toEqual({
      publication_id: receipt.publicationId,
      status: "published",
      template_id: resultBody.template_id,
      revision_id: resultBody.revision_id,
      revision: 1,
    });
    const conflictingFailure = await reportBuilderFailure({
      builderToken,
      publicationId: receipt.publicationId,
      error: "must not replace a successful publication",
    });
    expect(conflictingFailure.status).toBe(409);
    await expect(conflictingFailure.json()).resolves.toEqual({
      error:
        "publication is already published and cannot accept a failed result",
    });
    expect(await db.select().from(workshopTemplateRevisions)).toHaveLength(1);
  });

  it("renews the assigned builder lease and does not hand unexpired work to another builder", async () => {
    const fixture = await buildWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const [builderToken, builderBToken] = await Promise.all([
      bootstrapBuilder(),
      bootstrapBuilder("workshop-builder-b", BUILDER_B_BOOTSTRAP_TOKEN),
    ]);

    const initialClaim = await claimNext(builderToken);
    expect(initialClaim.status).toBe(200);
    await expect(initialClaim.json()).resolves.toMatchObject({
      publication_id: receipt.publicationId,
    });

    const db = drizzle(env.DB);
    const initialRows = await db
      .select({
        builderHostId: workshopPublications.builderHostId,
        claimedAt: workshopPublications.claimedAt,
        claimExpiresAt: workshopPublications.claimExpiresAt,
      })
      .from(workshopPublications)
      .where(eq(workshopPublications.id, receipt.publicationId));
    const initial = initialRows[0]!;
    expect(initial.builderHostId).toBe("workshop-builder-a");
    expect(initial.claimExpiresAt).toBeGreaterThan(Date.now());

    const unavailableToBuilderB = await claimNext(builderBToken);
    expect(unavailableToBuilderB.status).toBe(204);

    await db
      .update(workshopPublications)
      .set({ claimExpiresAt: Date.now() - 1 })
      .where(eq(workshopPublications.id, receipt.publicationId));
    const resumed = await claimNext(builderToken);
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({
      publication_id: receipt.publicationId,
    });

    const resumedRows = await db
      .select({
        builderHostId: workshopPublications.builderHostId,
        claimedAt: workshopPublications.claimedAt,
        claimExpiresAt: workshopPublications.claimExpiresAt,
      })
      .from(workshopPublications)
      .where(eq(workshopPublications.id, receipt.publicationId));
    expect(resumedRows[0]).toMatchObject({
      builderHostId: "workshop-builder-a",
      claimedAt: initial.claimedAt,
    });
    expect(resumedRows[0]!.claimExpiresAt).toBeGreaterThan(Date.now());

    await db
      .update(workshopPublications)
      .set({ claimExpiresAt: 1 })
      .where(eq(workshopPublications.id, receipt.publicationId));
    const renewedDownload = await registryRequest(
      new Request(
        `https://intar.test/agent/registry/workshop-publications/${receipt.publicationId}/bundle`,
        { headers: bearer(builderToken) },
      ),
    );
    expect(renewedDownload.status).toBe(200);
    const downloadRenewedRows = await db
      .select({ claimExpiresAt: workshopPublications.claimExpiresAt })
      .from(workshopPublications)
      .where(eq(workshopPublications.id, receipt.publicationId));
    expect(downloadRenewedRows[0]!.claimExpiresAt).toBeGreaterThan(Date.now());
  });

  it("reclaims an expired assignment, resets checkpoint build state, and fences the old builder", async () => {
    const fixture = await buildWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const [builderToken, builderBToken] = await Promise.all([
      bootstrapBuilder(),
      bootstrapBuilder("workshop-builder-b", BUILDER_B_BOOTSTRAP_TOKEN),
    ]);
    expect((await claimNext(builderToken)).status).toBe(200);

    const db = drizzle(env.DB);
    await db
      .update(workshopPublicationCheckpoints)
      .set({
        status: "failed",
        vmImagesJson: [{ stale: true }],
        sanitized: true,
        coldBootVerified: true,
        error: "stale partial build",
        verifiedAt: 1,
      })
      .where(
        eq(workshopPublicationCheckpoints.publicationId, receipt.publicationId),
      );
    await db
      .update(workshopPublications)
      .set({ claimedAt: 1, claimExpiresAt: 1 })
      .where(eq(workshopPublications.id, receipt.publicationId));

    const reclaimed = await claimNext(builderBToken);
    expect(reclaimed.status).toBe(200);
    await expect(reclaimed.json()).resolves.toMatchObject({
      publication_id: receipt.publicationId,
    });

    const publicationRows = await db
      .select({
        builderHostId: workshopPublications.builderHostId,
        claimedAt: workshopPublications.claimedAt,
        claimExpiresAt: workshopPublications.claimExpiresAt,
      })
      .from(workshopPublications)
      .where(eq(workshopPublications.id, receipt.publicationId));
    expect(publicationRows[0]!.builderHostId).toBe("workshop-builder-b");
    expect(publicationRows[0]!.claimedAt).toBeGreaterThan(1);
    expect(publicationRows[0]!.claimExpiresAt).toBeGreaterThan(Date.now());

    const checkpointRows = await db
      .select()
      .from(workshopPublicationCheckpoints)
      .where(
        eq(workshopPublicationCheckpoints.publicationId, receipt.publicationId),
      );
    expect(checkpointRows).toHaveLength(2);
    for (const checkpoint of checkpointRows) {
      expect(checkpoint).toMatchObject({
        status: "building",
        vmImagesJson: null,
        sanitized: false,
        coldBootVerified: false,
        error: null,
        verifiedAt: null,
      });
    }

    const oldBuilderDownload = await registryRequest(
      new Request(
        `https://intar.test/agent/registry/workshop-publications/${receipt.publicationId}/bundle`,
        { headers: bearer(builderToken) },
      ),
    );
    expect(oldBuilderDownload.status).toBe(404);
    const oldBuilderResult = await reportBuilderFailure({
      builderToken,
      publicationId: receipt.publicationId,
      error: "stale builder result",
    });
    expect(oldBuilderResult.status).toBe(409);

    const newBuilderDownload = await registryRequest(
      new Request(
        `https://intar.test/agent/registry/workshop-publications/${receipt.publicationId}/bundle`,
        { headers: bearer(builderBToken) },
      ),
    );
    expect(newBuilderDownload.status).toBe(200);
  });

  it("treats repeated failed reports as idempotent without changing the first terminal error", async () => {
    const fixture = await buildWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);

    const db = drizzle(env.DB);
    await db
      .update(workshopPublications)
      .set({ claimExpiresAt: 1 })
      .where(eq(workshopPublications.id, receipt.publicationId));

    const first = await reportBuilderFailure({
      builderToken,
      publicationId: receipt.publicationId,
      error: "first terminal error",
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      publication_id: receipt.publicationId,
      status: "failed",
    });

    const repeated = await reportBuilderFailure({
      builderToken,
      publicationId: receipt.publicationId,
      error: "a retry must not overwrite the original error",
    });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({
      publication_id: receipt.publicationId,
      status: "failed",
    });

    const publicationRows = await db
      .select({
        status: workshopPublications.status,
        error: workshopPublications.error,
        claimExpiresAt: workshopPublications.claimExpiresAt,
      })
      .from(workshopPublications)
      .where(eq(workshopPublications.id, receipt.publicationId));
    expect(publicationRows).toEqual([
      {
        status: "failed",
        error: "first terminal error",
        claimExpiresAt: null,
      },
    ]);

    const conflictingSuccess = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: checkpointResult(receipt.publicationId),
    });
    expect(conflictingSuccess.status).toBe(409);
    await expect(conflictingSuccess.json()).resolves.toEqual({
      error:
        "publication is already failed and cannot accept a succeeded result",
    });
    expect(await db.select().from(workshopTemplateRevisions)).toEqual([]);
  });

  it("keeps uploads and status reads isolated to the publishing organization", async () => {
    const fixture = await buildWorkshopBundleFixture();
    const [orgA, orgB] = await Promise.all([
      uploadBundle(ORG_A_TOKEN, fixture),
      uploadBundle(ORG_B_TOKEN, fixture),
    ]);

    expect(orgA.publicationId).not.toBe(orgB.publicationId);
    expect(orgA.body).toMatchObject({ status: "queued" });
    expect(orgB.body).toMatchObject({ status: "queued" });

    const [aReadsA, bReadsB, aReadsB, bReadsA] = await Promise.all([
      publicationStatus(ORG_A_TOKEN, orgA.publicationId),
      publicationStatus(ORG_B_TOKEN, orgB.publicationId),
      publicationStatus(ORG_A_TOKEN, orgB.publicationId),
      publicationStatus(ORG_B_TOKEN, orgA.publicationId),
    ]);
    expect(aReadsA.response.status).toBe(200);
    expect(bReadsB.response.status).toBe(200);
    expect(aReadsB.response.status).toBe(404);
    expect(bReadsA.response.status).toBe(404);
    expect(aReadsB.body).toEqual({ error: "not found" });
    expect(bReadsA.body).toEqual({ error: "not found" });

    const publications = await drizzle(env.DB)
      .select({
        id: workshopPublications.id,
        organizationId: workshopPublications.organizationId,
        sourceR2Key: workshopPublications.sourceR2Key,
      })
      .from(workshopPublications);
    expect(publications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: orgA.publicationId,
          organizationId: "org-a",
          sourceR2Key: expect.stringContaining("workshops/source/org-a/"),
        }),
        expect.objectContaining({
          id: orgB.publicationId,
          organizationId: "org-b",
          sourceR2Key: expect.stringContaining("workshops/source/org-b/"),
        }),
      ]),
    );
  });

  it("fails closed before accepting a bundle when workshops are disabled", async () => {
    const fixture = await buildWorkshopBundleFixture();
    const upload = await uploadBundle(ORG_A_TOKEN, fixture, false);

    expect(upload.response.status).toBe(401);
    expect(upload.body).toEqual({ error: "unauthorized" });

    const db = drizzle(env.DB);
    expect(await db.select().from(workshopPublications)).toEqual([]);
    const tokens = await db
      .select({ lastUsedAt: workshopRegistryTokens.lastUsedAt })
      .from(workshopRegistryTokens)
      .where(eq(workshopRegistryTokens.id, "registry-token-a"));
    expect(tokens).toEqual([{ lastUsedAt: null }]);
  });

  it("rejects incomplete verification and images outside the publication namespace without publishing", async () => {
    const fixture = await buildWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    const claim = await registryRequest(
      new Request(
        "https://intar.test/agent/registry/workshop-publications/next",
        { headers: bearer(builderToken) },
      ),
    );
    expect(claim.status).toBe(200);

    const withoutSanitization = checkpointResult(receipt.publicationId);
    withoutSanitization[0]!.sanitized = false;
    const sanitizationResult = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: withoutSanitization,
    });
    expect(sanitizationResult.status).toBe(400);
    await expect(sanitizationResult.json()).resolves.toEqual({
      error:
        "checkpoint checkpoint-00 must be sanitized and cold-boot verified",
    });

    const withoutColdBoot = checkpointResult(receipt.publicationId);
    withoutColdBoot[0]!.cold_boot_verified = false;
    const coldBootResult = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: withoutColdBoot,
    });
    expect(coldBootResult.status).toBe(400);
    await expect(coldBootResult.json()).resolves.toEqual({
      error:
        "checkpoint checkpoint-00 must be sanitized and cold-boot verified",
    });

    const wrongNamespace = checkpointResult(receipt.publicationId);
    wrongNamespace[0]!.vm_images[0]!.image_key.scenario =
      "workshop-a-different-publication-checkpoint-00";
    const namespaceResult = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: wrongNamespace,
    });
    expect(namespaceResult.status).toBe(400);
    await expect(namespaceResult.json()).resolves.toEqual({
      error:
        "checkpoint checkpoint-00 image_key is outside its publication namespace",
    });

    const db = drizzle(env.DB);
    const [publication, revisions, templates] = await Promise.all([
      db
        .select({ status: workshopPublications.status })
        .from(workshopPublications)
        .where(eq(workshopPublications.id, receipt.publicationId)),
      db.select().from(workshopTemplateRevisions),
      db.select().from(workshopTemplates),
    ]);
    expect(publication).toEqual([{ status: "building" }]);
    expect(revisions).toEqual([]);
    expect(templates).toEqual([]);
  });
});

async function seedRegistryPrincipals(): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values([
    {
      id: "publisher-a",
      name: "Publisher A",
      email: "publisher-a@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
    {
      id: "publisher-b",
      name: "Publisher B",
      email: "publisher-b@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
    {
      id: "builder-owner",
      name: "Builder owner",
      email: "builder@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  ]);
  await db.insert(organization).values([
    {
      id: "org-a",
      name: "Organization A",
      slug: "organization-a",
      createdAt: new Date(now),
    },
    {
      id: "org-b",
      name: "Organization B",
      slug: "organization-b",
      createdAt: new Date(now),
    },
  ]);
  await db.insert(workshopRegistryTokens).values([
    {
      id: "registry-token-a",
      organizationId: "org-a",
      name: "Organization A publisher",
      tokenPrefix: ORG_A_TOKEN.slice(0, 19),
      tokenHash: await hashWorkshopRegistryToken(ORG_A_TOKEN),
      createdBy: "publisher-a",
      createdAt: now,
    },
    {
      id: "registry-token-b",
      organizationId: "org-b",
      name: "Organization B publisher",
      tokenPrefix: ORG_B_TOKEN.slice(0, 19),
      tokenHash: await hashWorkshopRegistryToken(ORG_B_TOKEN),
      createdBy: "publisher-b",
      createdAt: now,
    },
  ]);
  await db.insert(agentHosts).values([
    {
      id: "workshop-builder-a",
      userId: "builder-owner",
      organizationId: "org-a",
      name: "Workshop builder A",
      role: "builder",
      scenarioEnabled: false,
      disabled: false,
      connected: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "workshop-builder-b",
      userId: "builder-owner",
      organizationId: "org-a",
      name: "Workshop builder B",
      role: "builder",
      scenarioEnabled: false,
      disabled: false,
      connected: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(agentBootstrapTokens).values([
    {
      id: "workshop-builder-bootstrap",
      hostId: "workshop-builder-a",
      tokenHash: await sha256Hex(BUILDER_BOOTSTRAP_TOKEN),
      expiresAt: now + 60_000,
      createdAt: now,
    },
    {
      id: "workshop-builder-b-bootstrap",
      hostId: "workshop-builder-b",
      tokenHash: await sha256Hex(BUILDER_B_BOOTSTRAP_TOKEN),
      expiresAt: now + 60_000,
      createdAt: now,
    },
  ]);
}

async function bootstrapBuilder(
  hostId = "workshop-builder-a",
  bootstrapToken = BUILDER_BOOTSTRAP_TOKEN,
): Promise<string> {
  const response = await handleAgentBootstrap(
    new Request("https://intar.test/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostId,
        bootstrapToken,
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

async function claimNext(builderToken: string): Promise<Response> {
  return registryRequest(
    new Request(
      "https://intar.test/agent/registry/workshop-publications/next",
      { headers: bearer(builderToken) },
    ),
  );
}

async function uploadBundle(
  token: string,
  fixture: WorkshopBundleFixture,
  workshopsEnabled = true,
) {
  const form = new FormData();
  form.set("workshop_id", "registry-workshop");
  form.set("sha256", fixture.sha256);
  form.set(
    "bundle",
    new File([arrayBuffer(fixture.bytes)], "registry-workshop.tar.gz", {
      type: "application/gzip",
    }),
  );
  const response = await registryRequest(
    new Request("https://intar.test/registry/v1/workshop-bundles", {
      method: "POST",
      headers: bearer(token),
      body: form,
    }),
    workshopsEnabled,
  );
  const body = (await response.json()) as {
    publication_id: string;
    status: string;
    status_url: string;
  };
  return { response, body, publicationId: body.publication_id };
}

async function publicationStatus(token: string, publicationId: string) {
  const response = await registryRequest(
    new Request(
      `https://intar.test/registry/v1/workshop-bundles/${publicationId}`,
      { headers: bearer(token) },
    ),
  );
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function reportBuilderResult(params: {
  builderToken: string;
  publicationId: string;
  checkpoints: ReturnType<typeof checkpointResult>;
}) {
  return registryRequest(
    new Request(
      `https://intar.test/agent/registry/workshop-publications/${params.publicationId}/result`,
      {
        method: "POST",
        headers: {
          ...bearer(params.builderToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "succeeded",
          checkpoints: params.checkpoints,
        }),
      },
    ),
  );
}

async function reportBuilderFailure(params: {
  builderToken: string;
  publicationId: string;
  error: string;
}) {
  return registryRequest(
    new Request(
      `https://intar.test/agent/registry/workshop-publications/${params.publicationId}/result`,
      {
        method: "POST",
        headers: {
          ...bearer(params.builderToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "failed", error: params.error }),
      },
    ),
  );
}

async function seedCheckpointObjects(
  checkpoints: ReturnType<typeof checkpointResult>,
): Promise<void> {
  for (const checkpoint of checkpoints) {
    for (const image of checkpoint.vm_images) {
      const registryKey = registryImageKey(image.image_key);
      await Promise.all([
        env.VM_IMAGE_REGISTRY_BUCKET.put(
          imageObjectKey(registryKey, image.image_sha256),
          `image for ${checkpoint.checkpoint_id}`,
          { customMetadata: { image_sha256: image.image_sha256 } },
        ),
        env.VM_IMAGE_REGISTRY_BUCKET.put(
          artifactObjectKey(image.kernel_sha256),
          "kernel",
          { customMetadata: { artifact_sha256: image.kernel_sha256 } },
        ),
        env.VM_IMAGE_REGISTRY_BUCKET.put(
          artifactObjectKey(image.initrd_sha256),
          "initrd",
          { customMetadata: { artifact_sha256: image.initrd_sha256 } },
        ),
      ]);
    }
  }
}

async function registryRequest(
  request: Request,
  workshopsEnabled = true,
): Promise<Response> {
  const response = await handleWorkshopRegistryRequest(
    request,
    registryEnvironment(workshopsEnabled),
  );
  expect(response).not.toBeNull();
  return response!;
}

function registryEnvironment(workshopsEnabled: boolean): Cloudflare.Env {
  return {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
    AGENT_JWT_SECRET: env.AGENT_JWT_SECRET,
    AGENT_JWT_ISSUER: env.AGENT_JWT_ISSUER,
    AGENT_JWT_AUDIENCE: env.AGENT_JWT_AUDIENCE,
    FLAGS: {
      async getBooleanValue(key: string, defaultValue: boolean) {
        return key === "workshops_enabled" ? workshopsEnabled : defaultValue;
      },
    },
  } as unknown as Cloudflare.Env;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
