/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/lib/hcloud-provider-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hcloud-provider-service")>()),
  hcloudRunOperation: providerMocks.run,
}));

vi.mock("@/lib/workshops/feature-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workshops/feature-flag")>()),
  requireWorkshopHcloudRuntimeEnabledForOrganization: vi
    .fn()
    .mockResolvedValue(undefined),
}));
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import {
  artifactObjectKey,
  imageObjectKey,
  registryImageKey,
} from "@/control-plane/image-registry/shared";
import {
  agentBootstrapTokens,
  agentHosts,
  organizationProviderConnections,
  providerCredentialVersions,
  runtimeProviderCheckpointArtifacts,
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
    providerMocks.run.mockReset();
    providerMocks.run.mockResolvedValue({ data: hcloudCatalog() });
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

  it("pins a live-resolved exact Hetzner type and immutable signed checkpoint bundles", async () => {
    await seedHetznerConnection();
    const fixture = await buildHetznerWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);

    const checkpoints = checkpointResult(receipt.publicationId);
    await seedCheckpointObjects(checkpoints);
    await attachRuntimeBundles(checkpoints);
    const withoutDirectProof = structuredClone(checkpoints);
    withoutDirectProof[0]!.runtime_bundle_cold_boot_verified = false;
    const unproved = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: withoutDirectProof,
    });
    expect(unproved.status).toBe(400);
    await expect(unproved.json()).resolves.toEqual({
      error:
        "checkpoint checkpoint-00 runtime bundle must be cold-boot verified on a clean direct-cloud base",
    });
    const wrongAgent = structuredClone(checkpoints);
    (
      wrongAgent[0] as (typeof wrongAgent)[number] & {
        runtime_bundle: { workspace_agent_sha256: string };
      }
    ).runtime_bundle.workspace_agent_sha256 = "e".repeat(64);
    const mismatchedAgent = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: wrongAgent,
    });
    expect(mismatchedAgent.status).toBe(400);
    await expect(mismatchedAgent.json()).resolves.toEqual({
      error: "workspace guest-tools release does not match the direct-cloud proof",
    });

    const result = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(result.status).toBe(201);
    const resultBody = (await result.json()) as { revision_id: string };

    const db = drizzle(env.DB);
    const [revisions, artifacts] = await Promise.all([
      db
        .select()
        .from(workshopTemplateRevisions)
        .where(eq(workshopTemplateRevisions.id, resultBody.revision_id)),
      db
        .select()
        .from(runtimeProviderCheckpointArtifacts)
        .where(
          eq(
            runtimeProviderCheckpointArtifacts.templateRevisionId,
            resultBody.revision_id,
          ),
        ),
    ]);
    expect(revisions[0]?.manifestJson.workspace.provider).toEqual({
      kind: "hetzner_cloud",
      vmId: "workspace",
      serverType: "cx43",
      systemImage: "debian-13",
      hardware: {
        architecture: "x86",
        cores: 8,
        memoryMib: 16_384,
        diskMib: 163_840,
      },
      compatible: true,
    });
    expect(artifacts).toHaveLength(2);
    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointId: "checkpoint-00",
          providerKind: "hetzner_cloud",
          compression: "zstd",
          sizeBytes: expect.any(Number),
          status: "verified",
          workspaceAgentSha256: "c".repeat(64),
          kinoSha256: "d".repeat(64),
        }),
        expect.objectContaining({ checkpointId: "checkpoint-01" }),
      ]),
    );
    expect(providerMocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "hcloud-connection-a",
        operation: expect.objectContaining({
          kind: "catalog",
          requiredServerTypes: ["cx43"],
          systemImage: "debian-13",
        }),
      }),
    );
    await expect(
      env.DB.prepare(
        "UPDATE runtime_provider_checkpoint_artifacts SET signing_key_id = 'replacement' WHERE template_revision_id = ?",
      )
        .bind(resultBody.revision_id)
        .run(),
    ).rejects.toThrow(/runtime provider checkpoint artifacts are immutable/);
  });

  it("fails Hetzner publication closed without a connection or signed runtime bundles", async () => {
    const fixture = await buildHetznerWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);
    const checkpoints = checkpointResult(receipt.publicationId);
    await seedCheckpointObjects(checkpoints);

    const missingBundle = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(missingBundle.status).toBe(400);
    await expect(missingBundle.json()).resolves.toEqual({
      error: "checkpoint checkpoint-00 runtime_bundle must be an object",
    });

    await attachRuntimeBundles(checkpoints);
    const missingConnection = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(missingConnection.status).toBe(409);
    await expect(missingConnection.json()).resolves.toEqual({
      error:
        "an active organization Hetzner project connection is required to publish this workshop",
      code: "hcloud_provider_connection_required",
    });
    expect(await drizzle(env.DB).select().from(workshopTemplateRevisions)).toEqual(
      [],
    );
    expect(providerMocks.run).not.toHaveBeenCalled();
  });

  it("rejects a pinned Hetzner type when the live catalog shape is undersized", async () => {
    await seedHetznerConnection();
    providerMocks.run.mockResolvedValue({
      data: hcloudCatalog({ memory: 8 }),
    });
    const fixture = await buildHetznerWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);
    const checkpoints = checkpointResult(receipt.publicationId);
    await seedCheckpointObjects(checkpoints);
    await attachRuntimeBundles(checkpoints);

    const result = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(result.status).toBe(409);
    await expect(result.json()).resolves.toMatchObject({
      code: "hcloud_server_type_undersized",
    });
    expect(await drizzle(env.DB).select().from(workshopTemplateRevisions)).toEqual(
      [],
    );
  });

  it.each([
    [
      "missing",
      (catalog: ReturnType<typeof hcloudCatalog>) => {
        catalog.serverTypes = [];
      },
      "hcloud_server_type_unavailable",
    ],
    [
      "deprecated",
      (catalog: ReturnType<typeof hcloudCatalog>) => {
        catalog.serverTypes[0]!.deprecated = true;
      },
      "hcloud_server_type_incompatible",
    ],
    [
      "ARM",
      (catalog: ReturnType<typeof hcloudCatalog>) => {
        catalog.serverTypes[0]!.architecture = "arm";
      },
      "hcloud_server_type_incompatible",
    ],
  ])("rejects a %s exact Hetzner type during publication", async (_label, mutate, code) => {
    await seedHetznerConnection();
    const catalog = hcloudCatalog();
    mutate(catalog);
    providerMocks.run.mockResolvedValue({ data: catalog });
    const fixture = await buildHetznerWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);
    const checkpoints = checkpointResult(receipt.publicationId);
    await seedCheckpointObjects(checkpoints);
    await attachRuntimeBundles(checkpoints);

    const result = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(result.status).toBe(409);
    await expect(result.json()).resolves.toMatchObject({ code });
    expect(await drizzle(env.DB).select().from(workshopTemplateRevisions)).toEqual(
      [],
    );
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

async function buildHetznerWorkshopBundleFixture() {
  return buildWorkshopBundleFixture({
    mutateManifest(compiled) {
      Object.assign(compiled.manifest.workspace, {
        provider: {
          kind: "hetzner_cloud",
          vm_id: "workspace",
          server_type: "cx43",
          system_image: "debian-13",
        },
      });
    },
  });
}

async function seedHetznerConnection(): Promise<void> {
  const now = Date.now();
  const db = drizzle(env.DB);
  await db.insert(organizationProviderConnections).values({
    id: "hcloud-connection-a",
    organizationId: "org-a",
    providerKind: "hetzner_cloud",
    displayName: "Dedicated workshop project",
    state: "active",
    projectFingerprint: "project-fingerprint",
    sentinelFirewallId: "42",
    activeCredentialVersionId: "hcloud-credential-a-v1",
    approvedLocationsJson: ["nbg1", "fsn1", "hel1"],
    maxConcurrentServers: 5,
    currency: "NOK",
    ipv4Enabled: true,
    lastValidatedAt: now,
    createdBy: "publisher-a",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(providerCredentialVersions).values({
    id: "hcloud-credential-a-v1",
    connectionId: "hcloud-connection-a",
    version: 1,
    algorithm: "AES-256-GCM",
    kekVersion: "v1",
    aadSha256: "a".repeat(64),
    encryptedTokenB64: "encrypted-token",
    tokenIvB64: "token-iv",
    wrappedDekB64: "wrapped-dek",
    dekIvB64: "dek-iv",
    envelopeCreatedAt: now,
    tokenFingerprint: "b".repeat(64),
    createdBy: "publisher-a",
    activatedAt: now,
    createdAt: now,
  });
}

async function attachRuntimeBundles(
  checkpoints: ReturnType<typeof checkpointResult>,
): Promise<void> {
  const signatureB64 = btoa("\0".repeat(64));
  const workspaceAgentSha256 = "c".repeat(64);
  const kinoSha256 = "d".repeat(64);
  const workspaceAgent = "workspace-agent-binary";
  const kino = "kino-binary";
  await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      `workspace-agent/releases/${workspaceAgentSha256}/intar-workspace-agent`,
      workspaceAgent,
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      `workspace-agent/kino/releases/${kinoSha256}/kino`,
      kino,
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      "workspace-agent/releases/current.json",
      JSON.stringify({
        schema_version: 2,
        sha256: workspaceAgentSha256,
        size_bytes: workspaceAgent.length,
        kino_sha256: kinoSha256,
        kino_size_bytes: kino.length,
      }),
    ),
  ]);
  for (const [index, checkpoint] of checkpoints.entries()) {
    const sha256 = (index === 0 ? "8" : "9").repeat(64);
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      artifactObjectKey(sha256),
      `runtime bundle ${checkpoint.checkpoint_id}`,
      { customMetadata: { artifact_sha256: sha256 } },
    );
    Object.assign(checkpoint, {
      runtime_bundle: {
        sha256,
        compression: "zstd",
        signature_b64: signatureB64,
        signing_key_id: "workshop-runtime-v1",
        workspace_agent_sha256: workspaceAgentSha256,
      },
    });
  }
}

function hcloudCatalog(overrides: { memory?: number } = {}) {
  const locations = ["nbg1", "fsn1", "hel1"].map((name, index) => ({
    id: index + 1,
    name,
    description: name,
    country: "DE",
    city: name,
    latitude: 0,
    longitude: 0,
    network_zone: "eu-central",
  }));
  const price = (location: string) => ({
    location,
    price_hourly: { net: "0.100000", gross: "0.125000" },
    price_monthly: { net: "60.000000", gross: "75.000000" },
    included_traffic: 20,
    price_per_tb_traffic: { net: "1.000000", gross: "1.250000" },
  });
  return {
    observedAt: new Date(1_750_000_000_000).toISOString(),
    serverTypes: [
      {
        id: 43,
        name: "cx43",
        description: "CX43",
        category: "shared",
        cores: 8,
        memory: overrides.memory ?? 16,
        disk: 160,
        storage_type: "local",
        cpu_type: "shared",
        architecture: "x86",
        deprecated: false,
        deprecation: null,
        locations: locations.map((location) => ({
          id: location.id,
          name: location.name,
          recommended: location.name === "nbg1",
          available: true,
          deprecation: null,
        })),
      },
    ],
    locations,
    systemImages: [
      {
        id: 13,
        status: "available",
        type: "system",
        name: "debian-13",
        description: "Debian 13",
        architecture: "x86",
        deprecated: null,
        deleted: null,
        os_flavor: "debian",
        os_version: "13",
      },
    ],
    pricing: {
      currency: "NOK",
      vat_rate: "0.25",
      server_types: [
        {
          id: 43,
          name: "cx43",
          prices: locations.map((location) => price(location.name)),
        },
      ],
      primary_ips: [
        {
          type: "ipv4",
          prices: locations.map((location) => ({
            location: location.name,
            price_hourly: { net: "0.010000", gross: "0.012500" },
            price_monthly: { net: "5.000000", gross: "6.250000" },
          })),
        },
      ],
    },
  };
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
