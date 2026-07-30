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
import { appError } from "@/lib/app-error";
import {
  agentBootstrapTokens,
  agentHosts,
  organizationProviderConnections,
  providerCredentialVersions,
  runtimeProviderCheckpointArtifacts,
  organization,
  user,
  workshopPublicationCheckpoints,
  workshopPublicationProviderAttempts,
  workshopPublicationProviderCheckpoints,
  workshopPublicationProviderCostLedger,
  workshopPublications,
  workshopRegistryTokens,
  workshopTemplateRevisions,
  workshopTemplates,
} from "@/db/schema";
import { hashWorkshopRegistryToken } from "@/lib/workshops/registry-tokens";
import { decimalCurrencyToMicros } from "@/lib/workshops/costs";
import { resetD1Database } from "@/test/d1-migrations";
import {
  finalizeVerifiedWorkshopProviderPublication,
  handleWorkshopRegistryRequest,
} from ".";
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

  it("capability-fences direct-provider claims without changing default claim behavior", async () => {
    const agentFixture = await buildWorkshopBundleFixture();
    const directFixture = await buildHetznerWorkshopBundleFixture();
    const agentReceipt = await uploadBundle(ORG_A_TOKEN, agentFixture);
    const directReceipt = await uploadBundle(ORG_A_TOKEN, directFixture);
    const directBuilderToken = await bootstrapBuilder();

    const invalid = await registryRequest(
      new Request(
        "https://intar.test/agent/registry/workshop-publications/next?execution_mode=agent_kvm",
        { headers: bearer(directBuilderToken) },
      ),
    );
    expect(invalid.status).toBe(400);

    const directClaim = await registryRequest(
      new Request(
        "https://intar.test/agent/registry/workshop-publications/next?execution_mode=direct_provider_only",
        { headers: bearer(directBuilderToken) },
      ),
    );
    expect(directClaim.status).toBe(200);
    await expect(directClaim.json()).resolves.toMatchObject({
      publication_id: directReceipt.publicationId,
    });

    const defaultBuilderToken = await bootstrapBuilder(
      "workshop-builder-b",
      BUILDER_B_BOOTSTRAP_TOKEN,
    );
    const defaultClaim = await claimNext(defaultBuilderToken);
    expect(defaultClaim.status).toBe(200);
    await expect(defaultClaim.json()).resolves.toMatchObject({
      publication_id: agentReceipt.publicationId,
    });
  });

  it("stages and atomically finalizes direct Hetzner proof without KVM evidence", async () => {
    await seedHetznerConnection();
    const fixture = await buildHetznerWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);

    const kvmEvidence = checkpointResult(receipt.publicationId);
    await seedCheckpointObjects(kvmEvidence);
    const rejectedKvm = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: kvmEvidence,
    });
    expect(rejectedKvm.status).toBe(400);
    await expect(rejectedKvm.json()).resolves.toEqual({
      error:
        "Hetzner workshop checkpoints require Intar direct provider verification",
    });

    const checkpoints = await directProviderCheckpointResult();
    const builderPinnedVerifier = structuredClone(checkpoints);
    Object.assign(builderPinnedVerifier[0]!.runtime_bundle, {
      workspace_agent_sha256: "c".repeat(64),
    });
    const rejectedVerifierPin = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: builderPinnedVerifier,
    });
    expect(rejectedVerifierPin.status).toBe(400);
    await expect(rejectedVerifierPin.json()).resolves.toEqual({
      error: "checkpoint checkpoint-00 must not assert its verifier binary",
    });

    const staged = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(staged.status).toBe(202);
    await expect(staged.json()).resolves.toMatchObject({
      publication_id: receipt.publicationId,
      status: "verifying",
      checkpoints: [
        { checkpoint_id: "checkpoint-00", status: "pending" },
        { checkpoint_id: "checkpoint-01", status: "pending" },
      ],
    });

    const db = drizzle(env.DB);
    const stagedRows = await db
      .select()
      .from(workshopPublicationProviderCheckpoints)
      .where(
        eq(
          workshopPublicationProviderCheckpoints.publicationId,
          receipt.publicationId,
        ),
      );
    expect(stagedRows).toHaveLength(2);
    expect(stagedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointId: "checkpoint-00",
          expectedProbesJson: [
            { moduleId: "00-setup", probeId: "setup-ready" },
          ],
          resolvedProviderJson: expect.objectContaining({
            kind: "hetzner_cloud",
            serverType: "cx43",
            compatible: true,
          }),
        }),
        expect.objectContaining({
          checkpointId: "checkpoint-01",
          expectedProbesJson: [
            { moduleId: "00-setup", probeId: "setup-ready" },
            { moduleId: "01-core", probeId: "service-ready" },
            { moduleId: "01-core", probeId: "route-ready" },
          ],
        }),
      ]),
    );
    expect(await db.select().from(workshopTemplateRevisions)).toEqual([]);
    expect(await db.select().from(runtimeProviderCheckpointArtifacts)).toEqual(
      [],
    );
    expect(
      await finalizeVerifiedWorkshopProviderPublication({
        publicationId: receipt.publicationId,
        now: 1_800_000_000_000,
      }),
    ).toBe(false);

    const replay = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(replay.status).toBe(202);
    expect(
      await db
        .select()
        .from(workshopPublicationProviderCheckpoints)
        .where(
          eq(
            workshopPublicationProviderCheckpoints.publicationId,
            receipt.publicationId,
          ),
        ),
    ).toHaveLength(2);
    expect(providerMocks.run).toHaveBeenCalledTimes(1);

    const conflicting = structuredClone(checkpoints);
    conflicting[0]!.runtime_bundle.signature_b64 = btoa("\x01".repeat(64));
    const conflict = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: conflicting,
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: "provider verification staging replay does not match",
    });
    expect((await claimNext(builderToken)).status).toBe(204);
    const postStageBundle = await registryRequest(
      new Request(
        `https://intar.test/agent/registry/workshop-publications/${receipt.publicationId}/bundle`,
        { headers: bearer(builderToken) },
      ),
    );
    expect(postStageBundle.status).toBe(404);
    const postStageFailure = await reportBuilderFailure({
      builderToken,
      publicationId: receipt.publicationId,
      error: "builder must no longer own provider verification",
    });
    expect(postStageFailure.status).toBe(409);

    const secondCheckpoint = stagedRows.find(
      (checkpoint) => checkpoint.checkpointId === "checkpoint-01",
    )!;
    const refreshedPrice = structuredClone(
      secondCheckpoint.priceObservationJson,
    );
    refreshedPrice.observedAt += 60_000;
    refreshedPrice.expiresAt += 60_000;
    Object.assign(
      refreshedPrice.locations.find(
        (location) => location.location === "nbg1",
      )!,
      {
        serverHourlyNet: "0.200000",
        serverHourlyGross: "0.250000",
        ipv4HourlyNet: "0.020000",
        ipv4HourlyGross: "0.025000",
      },
    );
    await db
      .update(workshopPublicationProviderCheckpoints)
      .set({ priceObservationJson: refreshedPrice })
      .where(
        eq(workshopPublicationProviderCheckpoints.id, secondCheckpoint.id),
      );

    const proofRows = await seedProviderPublicationProof(receipt.publicationId);
    expect(
      await finalizeVerifiedWorkshopProviderPublication({
        publicationId: receipt.publicationId,
        now: 1_800_000_000_000,
      }),
    ).toBe(false);
    await confirmProviderPublicationCleanup(receipt.publicationId);

    await db
      .update(workshopPublicationProviderAttempts)
      .set({
        checkpointFirstDownloadedAt:
          proofRows[0]!.report.reported_at_unix_ms + 1,
      })
      .where(
        eq(workshopPublicationProviderAttempts.id, proofRows[0]!.attemptId),
      );
    expect(
      await finalizeVerifiedWorkshopProviderPublication({
        publicationId: receipt.publicationId,
        now: 1_800_000_000_000,
      }),
    ).toBe(false);
    await db
      .update(workshopPublicationProviderAttempts)
      .set({
        checkpointFirstDownloadedAt:
          proofRows[0]!.report.reported_at_unix_ms - 30_000,
      })
      .where(
        eq(workshopPublicationProviderAttempts.id, proofRows[0]!.attemptId),
      );

    const corruptedReport = structuredClone(proofRows[0]!.report);
    corruptedReport.probes[0]!.status = "fail";
    await db
      .update(workshopPublicationProviderAttempts)
      .set({ reportJson: corruptedReport })
      .where(
        eq(workshopPublicationProviderAttempts.id, proofRows[0]!.attemptId),
      );
    expect(
      await finalizeVerifiedWorkshopProviderPublication({
        publicationId: receipt.publicationId,
        now: 1_800_000_000_000,
      }),
    ).toBe(false);
    await db
      .update(workshopPublicationProviderAttempts)
      .set({ reportJson: proofRows[0]!.report })
      .where(
        eq(workshopPublicationProviderAttempts.id, proofRows[0]!.attemptId),
      );

    expect(
      await Promise.all([
        finalizeVerifiedWorkshopProviderPublication({
          publicationId: receipt.publicationId,
          now: 1_800_000_000_000,
        }),
        finalizeVerifiedWorkshopProviderPublication({
          publicationId: receipt.publicationId,
          now: 1_800_000_000_000,
        }),
      ]),
    ).toEqual([true, true]);
    const publicationRows = await db
      .select()
      .from(workshopPublications)
      .where(eq(workshopPublications.id, receipt.publicationId));
    expect(publicationRows[0]).toMatchObject({
      status: "published",
      providerVerificationState: "verified",
      publishedRevisionId: expect.any(String),
    });
    const revisionId = publicationRows[0]!.publishedRevisionId!;
    const [revisions, artifacts, buildRows] = await Promise.all([
      db
        .select()
        .from(workshopTemplateRevisions)
        .where(eq(workshopTemplateRevisions.id, revisionId)),
      db
        .select()
        .from(runtimeProviderCheckpointArtifacts)
        .where(
          eq(runtimeProviderCheckpointArtifacts.templateRevisionId, revisionId),
        ),
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
    expect(
      revisions[0]?.manifestJson.workspace.checkpoints.every(
        (checkpoint) => checkpoint.vmImages.length === 0,
      ),
    ).toBe(true);
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
    expect(buildRows).toHaveLength(2);
    expect(
      buildRows.every(
        (row) =>
          row.status === "verified" &&
          row.vmImagesJson?.length === 0 &&
          !row.sanitized &&
          !row.coldBootVerified,
      ),
    ).toBe(true);
    expect(
      await finalizeVerifiedWorkshopProviderPublication({
        publicationId: receipt.publicationId,
        now: 1_800_000_100_000,
      }),
    ).toBe(true);
    expect(await db.select().from(workshopTemplateRevisions)).toHaveLength(1);
    const status = await publicationStatus(ORG_A_TOKEN, receipt.publicationId);
    expect(status.body).toMatchObject({
      status: "published",
      provider_verification: {
        state: "verified",
        checkpoints: [
          expect.objectContaining({
            checkpoint_id: "checkpoint-00",
            status: "verified",
          }),
          expect.objectContaining({
            checkpoint_id: "checkpoint-01",
            status: "verified",
          }),
        ],
      },
    });
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
        .bind(revisionId)
        .run(),
    ).rejects.toThrow(/runtime provider checkpoint artifacts are immutable/);
  });

  it("uses the builder's stable topological order for provider checkpoint coverage", async () => {
    await seedHetznerConnection();
    const fixture = await buildHetznerWorkshopBundleFixture({
      mutateManifest(compiled) {
        compiled.manifest.modules[0]!.checkpoint = "z-setup";
        compiled.manifest.modules[1]!.checkpoint = "a-core";
        compiled.manifest.workspace.initial_checkpoint = "z-setup";
        compiled.manifest.modules.reverse();
      },
    });
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);

    const staged = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: await directProviderCheckpointResult(["z-setup", "a-core"]),
    });
    expect(staged.status).toBe(202);
    const checkpoints = await drizzle(env.DB)
      .select()
      .from(workshopPublicationProviderCheckpoints)
      .where(
        eq(
          workshopPublicationProviderCheckpoints.publicationId,
          receipt.publicationId,
        ),
      );
    expect(checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointId: "z-setup",
          ordinal: 0,
          coveredModuleIdsJson: ["00-setup"],
          expectedProbesJson: [
            { moduleId: "00-setup", probeId: "setup-ready" },
          ],
        }),
        expect.objectContaining({
          checkpointId: "a-core",
          ordinal: 1,
          coveredModuleIdsJson: ["00-setup", "01-core"],
          expectedProbesJson: [
            { moduleId: "00-setup", probeId: "setup-ready" },
            { moduleId: "01-core", probeId: "service-ready" },
            { moduleId: "01-core", probeId: "route-ready" },
          ],
        }),
      ]),
    );
  });

  it("stages a valid exact type when live location capacity is exhausted", async () => {
    await seedHetznerConnection();
    const catalog = hcloudCatalog();
    for (const locationState of catalog.serverTypes[0]!.locations) {
      locationState.available = false;
    }
    providerMocks.run.mockResolvedValue({ data: catalog });
    const fixture = await buildHetznerWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);

    const staged = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: await directProviderCheckpointResult(),
    });
    expect(staged.status).toBe(202);
    const checkpoints = await drizzle(env.DB)
      .select()
      .from(workshopPublicationProviderCheckpoints)
      .where(
        eq(
          workshopPublicationProviderCheckpoints.publicationId,
          receipt.publicationId,
        ),
      );
    expect(checkpoints).toHaveLength(2);
    expect(
      checkpoints.every((checkpoint) =>
        checkpoint.priceObservationJson.locations.every(
          (location) => !location.available,
        ),
      ),
    ).toBe(true);
    expect(
      (
        await drizzle(env.DB)
          .select()
          .from(workshopPublications)
          .where(eq(workshopPublications.id, receipt.publicationId))
      )[0],
    ).toMatchObject({
      status: "building",
      providerVerificationState: "verifying",
    });
  });

  it("fails Hetzner staging closed without signed runtime bundles or a connection", async () => {
    const fixture = await buildHetznerWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);
    const checkpoints = await directProviderCheckpointResult();

    const missingRuntimeBundle = structuredClone(checkpoints);
    delete (
      missingRuntimeBundle[0] as Partial<(typeof missingRuntimeBundle)[number]>
    ).runtime_bundle;
    const missingBundle = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: missingRuntimeBundle,
    });
    expect(missingBundle.status).toBe(400);
    await expect(missingBundle.json()).resolves.toEqual({
      error: "checkpoint checkpoint-00 runtime_bundle must be an object",
    });

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
    expect(
      await drizzle(env.DB).select().from(workshopTemplateRevisions),
    ).toEqual([]);
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
    const checkpoints = await directProviderCheckpointResult();

    const result = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints,
    });
    expect(result.status).toBe(409);
    const body = (await result.json()) as { code: string; error: string };
    expect(body).toMatchObject({
      code: "hcloud_server_type_undersized",
    });
    await expectTerminalProviderStagingFailure({
      publicationId: receipt.publicationId,
      error: body.error,
    });
    expect((await claimNext(builderToken)).status).toBe(204);
    expect(
      await drizzle(env.DB).select().from(workshopTemplateRevisions),
    ).toEqual([]);
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
  ])(
    "rejects a %s exact Hetzner type during publication",
    async (_label, mutate, code) => {
      await seedHetznerConnection();
      const catalog = hcloudCatalog();
      mutate(catalog);
      providerMocks.run.mockResolvedValue({ data: catalog });
      const fixture = await buildHetznerWorkshopBundleFixture();
      const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
      const builderToken = await bootstrapBuilder();
      expect((await claimNext(builderToken)).status).toBe(200);
      const checkpoints = await directProviderCheckpointResult();

      const result = await reportBuilderResult({
        builderToken,
        publicationId: receipt.publicationId,
        checkpoints,
      });
      expect(result.status).toBe(409);
      const body = (await result.json()) as { code: string; error: string };
      expect(body).toMatchObject({ code });
      await expectTerminalProviderStagingFailure({
        publicationId: receipt.publicationId,
        error: body.error,
      });
      expect((await claimNext(builderToken)).status).toBe(204);
      expect(
        await drizzle(env.DB).select().from(workshopTemplateRevisions),
      ).toEqual([]);
    },
  );

  it("terminally fails staging when the pinned Hetzner system image is unavailable", async () => {
    await seedHetznerConnection();
    const catalog = hcloudCatalog();
    catalog.systemImages = [];
    providerMocks.run.mockResolvedValue({ data: catalog });
    const fixture = await buildHetznerWorkshopBundleFixture();
    const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
    const builderToken = await bootstrapBuilder();
    expect((await claimNext(builderToken)).status).toBe(200);

    const result = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: await directProviderCheckpointResult(),
    });
    expect(result.status).toBe(409);
    const body = (await result.json()) as { code: string; error: string };
    expect(body).toMatchObject({ code: "hcloud_system_image_unavailable" });
    await expectTerminalProviderStagingFailure({
      publicationId: receipt.publicationId,
      error: body.error,
    });
    expect((await claimNext(builderToken)).status).toBe(204);
  });

  it.each([
    [
      "pricing",
      503,
      "hcloud_pricing_unavailable",
      "Hetzner pricing metadata is unavailable",
    ],
    [
      "location capacity",
      409,
      "hcloud_location_unavailable",
      "the pinned server type is unavailable in every approved location",
    ],
  ])(
    "keeps retryable provider catalog failure %s assigned to the builder",
    async (_label, status, code, message) => {
      await seedHetznerConnection();
      providerMocks.run.mockRejectedValue(appError(status, code, message));
      const fixture = await buildHetznerWorkshopBundleFixture();
      const receipt = await uploadBundle(ORG_A_TOKEN, fixture);
      const builderToken = await bootstrapBuilder();
      expect((await claimNext(builderToken)).status).toBe(200);

      const result = await reportBuilderResult({
        builderToken,
        publicationId: receipt.publicationId,
        checkpoints: await directProviderCheckpointResult(),
      });
      expect(result.status).toBe(status);
      await expect(result.json()).resolves.toMatchObject({ code });
      await expectRetryableProviderStagingFailure(receipt.publicationId);
      const resumed = await claimNext(builderToken);
      expect(resumed.status).toBe(200);
      await expect(resumed.json()).resolves.toMatchObject({
        publication_id: receipt.publicationId,
      });
    },
  );

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

    const wrongCoverage = checkpointResult(receipt.publicationId);
    wrongCoverage[0]!.covered_module_ids = ["01-core"];
    const coverageResult = await reportBuilderResult({
      builderToken,
      publicationId: receipt.publicationId,
      checkpoints: wrongCoverage,
    });
    expect(coverageResult.status).toBe(400);
    await expect(coverageResult.json()).resolves.toEqual({
      error:
        "checkpoint checkpoint-00 covered module prefix does not match the source manifest",
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
  checkpoints: unknown;
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

async function buildHetznerWorkshopBundleFixture(
  options: {
    mutateManifest?: (compiled: WorkshopBundleFixture["compiled"]) => void;
  } = {},
) {
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
      options.mutateManifest?.(compiled);
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

async function directProviderCheckpointResult(
  checkpointIds = ["checkpoint-00", "checkpoint-01"],
) {
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
  return Promise.all(
    checkpointIds.map(async (checkpointId, index) => {
      const sha256 = (index === 0 ? "8" : "9").repeat(64);
      await env.VM_IMAGE_REGISTRY_BUCKET.put(
        artifactObjectKey(sha256),
        `runtime bundle ${checkpointId}`,
        { customMetadata: { artifact_sha256: sha256 } },
      );
      return {
        checkpoint_id: checkpointId,
        covered_module_ids: ["00-setup", "01-core"].slice(0, index + 1),
        provider_verification_pending: true,
        sanitized: false,
        cold_boot_verified: false,
        runtime_bundle_cold_boot_verified: false,
        vm_images: [],
        runtime_bundle: {
          sha256,
          compression: "zstd",
          signature_b64: signatureB64,
          signing_key_id: "workshop-runtime-v1",
        },
      };
    }),
  );
}

async function expectTerminalProviderStagingFailure(input: {
  publicationId: string;
  error: string;
}): Promise<void> {
  const db = drizzle(env.DB);
  const publications = await db
    .select()
    .from(workshopPublications)
    .where(eq(workshopPublications.id, input.publicationId));
  expect(publications).toHaveLength(1);
  expect(publications[0]).toMatchObject({
    status: "failed",
    providerVerificationState: null,
    error: input.error,
    claimExpiresAt: null,
    finishedAt: expect.any(Number),
  });

  const checkpoints = await db
    .select()
    .from(workshopPublicationCheckpoints)
    .where(
      eq(workshopPublicationCheckpoints.publicationId, input.publicationId),
    );
  expect(checkpoints).toHaveLength(
    publications[0]!.requiredCheckpointIdsJson.length,
  );
  expect(
    checkpoints.every(
      (checkpoint) =>
        checkpoint.status === "failed" &&
        checkpoint.error === input.error &&
        checkpoint.sanitized === false &&
        checkpoint.coldBootVerified === false &&
        checkpoint.verifiedAt === null,
    ),
  ).toBe(true);
  expect(
    await db
      .select()
      .from(workshopPublicationProviderCheckpoints)
      .where(
        eq(
          workshopPublicationProviderCheckpoints.publicationId,
          input.publicationId,
        ),
      ),
  ).toEqual([]);
}

async function expectRetryableProviderStagingFailure(
  publicationId: string,
): Promise<void> {
  const db = drizzle(env.DB);
  const publications = await db
    .select()
    .from(workshopPublications)
    .where(eq(workshopPublications.id, publicationId));
  expect(publications).toHaveLength(1);
  expect(publications[0]).toMatchObject({
    status: "building",
    providerVerificationState: null,
    error: null,
    claimExpiresAt: expect.any(Number),
    finishedAt: null,
  });
  const checkpoints = await db
    .select()
    .from(workshopPublicationCheckpoints)
    .where(eq(workshopPublicationCheckpoints.publicationId, publicationId));
  expect(checkpoints).toHaveLength(
    publications[0]!.requiredCheckpointIdsJson.length,
  );
  expect(
    checkpoints.every(
      (checkpoint) =>
        checkpoint.status === "building" && checkpoint.error === null,
    ),
  ).toBe(true);
}

async function seedProviderPublicationProof(publicationId: string) {
  const db = drizzle(env.DB);
  const checkpoints = (
    await db
      .select()
      .from(workshopPublicationProviderCheckpoints)
      .where(
        eq(workshopPublicationProviderCheckpoints.publicationId, publicationId),
      )
  ).sort((left, right) => left.ordinal - right.ordinal);
  const proofRows: Array<{
    attemptId: string;
    report: {
      contract_version: 1;
      identity: {
        execution_id: string;
        workspace_id: string;
        generation: number;
      };
      sequence: number;
      phase: "ready";
      health: "healthy";
      terminal_ready: true;
      recording_drain_completed: false;
      ssh_host_keys_openssh: string[];
      probes: Array<{
        id: string;
        status: "pass" | "fail";
        observed_at_unix_ms: number;
      }>;
      reported_at_unix_ms: number;
    };
  }> = [];
  for (const [index, checkpoint] of checkpoints.entries()) {
    const attemptId = `provider-attempt-${index + 1}-00000000`;
    const proofAt = 1_799_000_000_000 + index * 10_000;
    const report = {
      contract_version: 1 as const,
      identity: {
        execution_id: attemptId,
        workspace_id: checkpoint.id,
        generation: 1,
      },
      sequence: 5,
      phase: "ready" as const,
      health: "healthy" as const,
      terminal_ready: true as const,
      recording_drain_completed: false as const,
      ssh_host_keys_openssh: [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestVerifierHostKey",
      ],
      probes: checkpoint.expectedProbesJson.map((probe) => ({
        id: probe.probeId,
        status: "pass" as const,
        observed_at_unix_ms: proofAt,
      })),
      reported_at_unix_ms: proofAt,
    };
    await db.insert(workshopPublicationProviderAttempts).values({
      id: attemptId,
      providerCheckpointId: checkpoint.id,
      connectionId: checkpoint.connectionId,
      ordinal: 1,
      deterministicName: `intar-publication-${index + 1}`,
      serverType: checkpoint.resolvedProviderJson.serverType,
      systemImage: checkpoint.resolvedProviderJson.systemImage,
      location: "nbg1",
      serverId: `server-${index + 1}`,
      primaryIpId: `primary-ip-${index + 1}`,
      primaryIpv4: `192.0.2.${index + 10}`,
      sshKeyId: `ssh-key-${index + 1}`,
      createActionId: `create-action-${index + 1}`,
      state: "proof_succeeded",
      controlPlaneBaseUrl: "https://intar.test",
      bootstrapTokenHash: `bootstrap-hash-${index + 1}`,
      bootstrapExpiresAt: proofAt + 60_000,
      bootstrapConsumedAt: proofAt - 60_000,
      reportCredentialHash: `report-hash-${index + 1}`,
      reportCredentialIssuedAt: proofAt - 60_000,
      reportCredentialExpiresAt: proofAt + 60_000,
      checkpointDownloadTokenHash: `download-hash-${index + 1}`,
      checkpointDownloadExpiresAt: proofAt + 60_000,
      checkpointFirstDownloadedAt: proofAt - 30_000,
      lastReportSequence: report.sequence,
      lastReportPhase: report.phase,
      lastReportHealth: report.health,
      lastReportAt: proofAt,
      reportJson: report,
      proofReportSequence: report.sequence,
      proofVerifiedAt: proofAt,
      createdAt: proofAt - 120_000,
      updatedAt: proofAt,
    });
    await db
      .update(workshopPublicationProviderCheckpoints)
      .set({
        verificationStatus: "proof_succeeded",
        proofVerifiedAt: proofAt,
        updatedAt: proofAt,
      })
      .where(eq(workshopPublicationProviderCheckpoints.id, checkpoint.id));
    const prices = checkpoint.priceObservationJson.locations.find(
      (entry) => entry.location === "nbg1",
    )!;
    await db.insert(workshopPublicationProviderCostLedger).values([
      {
        id: `provider-ledger-server-${index + 1}`,
        attemptId,
        providerResourceId: `server-${index + 1}`,
        resourceKind: "server",
        resourceType: checkpoint.resolvedProviderJson.serverType,
        location: "nbg1",
        currency: checkpoint.priceObservationJson.currency,
        hourlyNetRaw: prices.serverHourlyNet,
        hourlyGrossRaw: prices.serverHourlyGross,
        hourlyNetMicros: decimalCurrencyToMicros(prices.serverHourlyNet),
        hourlyGrossMicros: decimalCurrencyToMicros(prices.serverHourlyGross),
        monthlyNetRaw: prices.serverMonthlyNet,
        monthlyGrossRaw: prices.serverMonthlyGross,
        monthlyNetMicros: prices.serverMonthlyNet
          ? decimalCurrencyToMicros(prices.serverMonthlyNet)
          : null,
        monthlyGrossMicros: prices.serverMonthlyGross
          ? decimalCurrencyToMicros(prices.serverMonthlyGross)
          : null,
        providerCreatedAt: proofAt - 60_000,
        createdAt: proofAt - 60_000,
        updatedAt: proofAt,
      },
      {
        id: `provider-ledger-ip-${index + 1}`,
        attemptId,
        providerResourceId: `primary-ip-${index + 1}`,
        resourceKind: "primary_ipv4",
        resourceType: "ipv4",
        location: "nbg1",
        currency: checkpoint.priceObservationJson.currency,
        hourlyNetRaw: prices.ipv4HourlyNet,
        hourlyGrossRaw: prices.ipv4HourlyGross,
        hourlyNetMicros: decimalCurrencyToMicros(prices.ipv4HourlyNet),
        hourlyGrossMicros: decimalCurrencyToMicros(prices.ipv4HourlyGross),
        monthlyNetRaw: prices.ipv4MonthlyNet,
        monthlyGrossRaw: prices.ipv4MonthlyGross,
        monthlyNetMicros: prices.ipv4MonthlyNet
          ? decimalCurrencyToMicros(prices.ipv4MonthlyNet)
          : null,
        monthlyGrossMicros: prices.ipv4MonthlyGross
          ? decimalCurrencyToMicros(prices.ipv4MonthlyGross)
          : null,
        providerCreatedAt: proofAt - 60_000,
        createdAt: proofAt - 60_000,
        updatedAt: proofAt,
      },
    ]);
    proofRows.push({ attemptId, report });
  }
  return proofRows;
}

async function confirmProviderPublicationCleanup(
  publicationId: string,
): Promise<void> {
  const db = drizzle(env.DB);
  const checkpoints = await db
    .select()
    .from(workshopPublicationProviderCheckpoints)
    .where(
      eq(workshopPublicationProviderCheckpoints.publicationId, publicationId),
    );
  for (const checkpoint of checkpoints) {
    const attempts = await db
      .select()
      .from(workshopPublicationProviderAttempts)
      .where(
        eq(
          workshopPublicationProviderAttempts.providerCheckpointId,
          checkpoint.id,
        ),
      );
    const deletionAt =
      (checkpoint.proofVerifiedAt ?? 1_799_000_000_000) + 1_000;
    for (const attempt of attempts) {
      await db
        .update(workshopPublicationProviderAttempts)
        .set({
          state: "deleted",
          deleteActionId: `delete-${attempt.id}`,
          reportCredentialRevokedAt: deletionAt,
          deletionRequestedAt: deletionAt - 500,
          deletionConfirmedAt: deletionAt,
          updatedAt: deletionAt,
        })
        .where(eq(workshopPublicationProviderAttempts.id, attempt.id));
      await db
        .update(workshopPublicationProviderCostLedger)
        .set({ deletionConfirmedAt: deletionAt, updatedAt: deletionAt })
        .where(eq(workshopPublicationProviderCostLedger.attemptId, attempt.id));
    }
    await db
      .update(workshopPublicationProviderCheckpoints)
      .set({
        verificationStatus: "verified",
        deletionConfirmedAt: deletionAt,
        updatedAt: deletionAt,
      })
      .where(eq(workshopPublicationProviderCheckpoints.id, checkpoint.id));
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
