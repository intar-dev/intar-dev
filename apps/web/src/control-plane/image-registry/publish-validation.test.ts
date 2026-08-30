import {
  imageRegistryMocks,
  publishBuildAssignment,
  builderPublishForm,
  publishFenceDb,
  hostSelectDb,
  publishManifest,
  chunkManifestHead,
  sha256HexForTest,
  resetImageRegistryMocks,
} from "./test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import type { ScenarioManifestV4 } from "@/generated/catalog";

const {
  authMock,
  dbMock,
  imageBuildLockMock,
  catalogManifestMock,
  candidateCatalogMock,
} = imageRegistryMocks();

describe("image registry publish validation", () => {
  beforeEach(resetImageRegistryMocks);

  it("accepts builder agent JWTs for image publish requests", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer builder-jwt" },
      }),
      {} as Cloudflare.Env,
    );

    expect(authMock.requireVerifiedAgentRequest).toHaveBeenCalledOnce();
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "multipart form data is required",
    });
  });

  it("rejects non-builder agent JWTs for image publish requests", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer agent-jwt" },
      }),
      {} as Cloudflare.Env,
    );

    expect(authMock.requireVerifiedAgentRequest).toHaveBeenCalledOnce();
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "builder role required",
    });
  });

  it("requires typed build identity fields for builder publishes", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const form = new FormData();
    form.set(
      "manifest",
      JSON.stringify(
        publishManifest({
          imageSha256: "a".repeat(64),
          artifactSha256: "b".repeat(64),
        }),
      ),
    );

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer builder-jwt" },
        body: form,
      }),
      {} as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error:
        "builder publish requires valid build_id, rev, content_hash, and architecture",
    });
    expect(dbMock.drizzle).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown build id", null],
    ["different builder", { hostId: "builder-2" }],
    ["stale build", { status: "stale" }],
    ["different content hash", { contentHash: "e".repeat(64) }],
    ["different scenario", { scenarioId: "pair-ping" }],
    ["different architecture", { arch: "aarch64" }],
    ["different bundle revision", { rev: "def456" }],
  ] as const)(
    "rejects a builder publish for an %s",
    async (_label, assignmentOverride) => {
      authMock.requireVerifiedAgentRequest.mockResolvedValue({
        ok: true,
        agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
      });
      const form = builderPublishForm(
        publishManifest({
          imageSha256: "a".repeat(64),
          artifactSha256: "b".repeat(64),
        }),
      );
      const assignmentRows = assignmentOverride
        ? [publishBuildAssignment(assignmentOverride)]
        : [];
      const db = publishFenceDb({ assignmentRows: [assignmentRows] });
      dbMock.drizzle.mockReturnValueOnce(db);
      const bucketHead = vi.fn();

      const response = await handleImageRegistryRequest(
        new Request("https://intar.test/registry/v1/publish", {
          method: "POST",
          headers: { authorization: "Bearer builder-jwt" },
          body: form,
        }),
        {
          DB: "db-binding",
          VM_IMAGE_REGISTRY_BUCKET: { head: bucketHead },
        } as unknown as Cloudflare.Env,
      );

      expect(response?.status).toBe(409);
      await expect(response?.json()).resolves.toEqual({
        error: "build is not active for this builder",
      });
      expect(bucketHead).not.toHaveBeenCalled();
      expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
    },
  );

  it("stages an exactly assigned candidate result while holding the build lock", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const imageSha256 = "e".repeat(64);
    const artifactSha256 = "f".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = builderPublishForm(manifest);
    const assignment = publishBuildAssignment({ catalogChannel: "candidate" });
    const db = publishFenceDb({
      assignmentRows: [[assignment], [assignment]],
    });
    dbMock.drizzle.mockReturnValueOnce(db);
    const imageObjectKey = `image-manifests/v1/${"d".repeat(64)}.json`;
    const bucketHead = vi.fn().mockImplementation((key: string) =>
      Promise.resolve(
        key === imageObjectKey
          ? chunkManifestHead(manifest)
          : {
              size: 555,
              customMetadata: { artifact_sha256: artifactSha256 },
            },
      ),
    );
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const bucketList = vi.fn().mockResolvedValue({
      objects: [],
      truncated: false,
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer builder-jwt" },
        body: form,
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
          list: bucketList,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      scenario_id: "broken-nginx",
      catalog_channel: "candidate",
      images: [
        {
          image_key: "broken-nginx-web-x86_64",
          image_id: imageSha256,
          object_key: imageObjectKey,
          bytes: 8589934592,
          reused: true,
        },
      ],
    });
    expect(
      imageBuildLockMock.withImageBuildCoordinationLock,
    ).toHaveBeenCalledWith(
      db,
      { scenarioId: "broken-nginx", arch: "x86_64" },
      expect.any(Function),
    );
    expect(imageBuildLockMock.assertHeld).toHaveBeenCalledOnce();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
    expect(candidateCatalogMock.stageCandidateScenarioManifest).toHaveBeenCalledOnce();
    expect(candidateCatalogMock.warmCandidateScenarioManifest).toHaveBeenCalledOnce();
  });

  it("keeps the stale-build 409 when lease release also fails", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const imageSha256 = "e".repeat(64);
    const artifactSha256 = "f".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = builderPublishForm(manifest);
    const db = publishFenceDb({
      assignmentRows: [
        [publishBuildAssignment()],
        [publishBuildAssignment({ status: "stale" })],
      ],
    });
    dbMock.drizzle.mockReturnValueOnce(db);
    imageBuildLockMock.withImageBuildCoordinationLock.mockImplementationOnce(
      async (
        _db: unknown,
        _identity: unknown,
        operation: (lease: {
          assertHeld: () => Promise<void>;
        }) => Promise<unknown>,
      ) => {
        await operation({ assertHeld: imageBuildLockMock.assertHeld });
        throw new Error("lease release failed");
      },
    );
    const imageObjectKey = `image-manifests/v1/${"d".repeat(64)}.json`;
    const bucketHead = vi.fn().mockImplementation((key: string) =>
      Promise.resolve(
        key === imageObjectKey
          ? chunkManifestHead(manifest)
          : {
              size: 555,
              customMetadata: { artifact_sha256: artifactSha256 },
            },
      ),
    );
    const bucketPut = vi.fn().mockResolvedValue(undefined);

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer builder-jwt" },
        body: form,
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: "build is not active for this builder",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(imageBuildLockMock.assertHeld).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests whose image keys do not match the vm identity", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        image_key: {
          scenario: "other-scenario",
          vm: "web",
          arch: "x86_64",
        },
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest image key must match scenario and vm names",
    });
  });

  it("rejects publish manifests with unsafe scenario ids before writing objects", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    manifest.scenario_id = "../broken-nginx";
    manifest.name = "../broken-nginx";
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest scenario_id is invalid",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with unsafe vm names before writing objects", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        name: "../web",
        image_key: {
          scenario: "broken-nginx",
          vm: "../web",
          arch: "x86_64",
        },
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains an invalid vm",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with duplicate vm names", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      vm,
      {
        ...vm,
        image_id: "c".repeat(64),
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains duplicate vm names",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with vm names that would collapse registry keys", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        name: "web a",
        image_key: {
          scenario: "broken-nginx",
          vm: "web a",
          arch: "x86_64",
        },
      },
      {
        ...vm,
        name: "web-a",
        image_key: {
          scenario: "broken-nginx",
          vm: "web-a",
          arch: "x86_64",
        },
        image_id: "c".repeat(64),
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains an invalid vm",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests that are not JSON objects", async () => {
    const form = new FormData();
    form.set("manifest", "null");

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest is not a JSON object",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests missing required scenario metadata", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    delete (manifest as Partial<ScenarioManifestV4>).title;
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid scenario metadata",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with duplicate scenario hint ids", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    manifest.hints = [
      { id: "check-service", body_markdown: "Check systemd." },
      { id: "check-service", body_markdown: "Check nginx." },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid scenario hints",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with unsafe scenario hint ids", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    manifest.hints = [
      { id: "../check-service", body_markdown: "Check systemd." },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid scenario hints",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with unsafe probe ids", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        probes: [
          {
            id: "../nginx-running",
            phase: "scenario",
            kind: "service",
            display_name: "Nginx running",
            hints: [],
          },
        ],
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains an invalid probe",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it.each([
    ["zero CPU", { cpu_millis: 0 }],
    ["u32-overflow CPU", { cpu_millis: 0x1_0000_0000, vcpu_count: 0xffff }],
    ["u16-overflow vCPU count", { vcpu_count: 0x1_0000 }],
    ["u32-overflow memory", { memory_mib: 0x1_0000_0000 }],
    ["u32-overflow disk", { disk_mib: 0x1_0000_0000 }],
    [
      "unsafe integer CPU",
      { cpu_millis: Number.MAX_SAFE_INTEGER + 1, vcpu_count: 0xffff },
    ],
  ])(
    "rejects publish manifests with invalid vm resources: %s",
    async (_, invalid) => {
      const manifest = publishManifest({
        imageSha256: "a".repeat(64),
        artifactSha256: "b".repeat(64),
      });
      const vm = manifest.vms[0];
      if (!vm) {
        throw new Error("expected publish manifest vm");
      }
      manifest.vms = [
        {
          ...vm,
          ...invalid,
        },
      ];
      const form = new FormData();
      form.set("manifest", JSON.stringify(manifest));

      const response = await handleImageRegistryRequest(
        new Request("https://intar.test/registry/v1/publish", {
          method: "POST",
          headers: { authorization: "Bearer publish-secret" },
          body: form,
        }),
        {
          REGISTRY_PUBLISH_TOKEN: "publish-secret",
        } as Cloudflare.Env,
      );

      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toEqual({
        error: "manifest contains invalid vm resources",
      });
      expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
    },
  );

  it("rejects publish manifests with invalid raw-zstd boot metadata", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        image_virtual_size_bytes: 0,
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid boot metadata",
    });
  });

  it("rejects publish manifests with invalid image hashes", async () => {
    const manifest = publishManifest({
      imageSha256: "not-a-sha",
      artifactSha256: "b".repeat(64),
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid chunked image identity",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests that do not direct-boot /dev/vda", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        boot: {
          ...vm.boot,
          cmdline: "root=LABEL=INTARROOT rw console=ttyS0",
        },
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid boot metadata",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish requests missing required boot artifacts", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: `missing boot artifact ${artifactSha256}`,
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish requests whose boot artifact hash mismatches", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const actualArtifactSha256 = await sha256HexForTest(artifactPayload);
    const expectedArtifactSha256 = "b".repeat(64);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256: expectedArtifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    form.set(
      `artifact:${expectedArtifactSha256}`,
      new File([artifactPayload], expectedArtifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(422);
    await expect(response?.json()).resolves.toEqual({
      error: "boot artifact sha256 mismatch",
      expected: expectedArtifactSha256,
      actual: actualArtifactSha256,
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("reuses existing content-addressed boot artifacts during publish", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockImplementation((key: string) =>
      Promise.resolve(
        key.startsWith("image-manifests/")
          ? chunkManifestHead(manifest)
          : {
              size: 123_456,
              customMetadata: { artifact_sha256: artifactSha256 },
            },
      ),
    );
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const db = hostSelectDb([]);
    dbMock.drizzle.mockReturnValueOnce(db);

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        DB: "db-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      artifacts: [
        {
          sha256: artifactSha256,
          object_key: `artifacts/${artifactSha256}`,
          bytes: 123_456,
          reused: true,
        },
      ],
    });
    expect(bucketHead).toHaveBeenCalledWith(`artifacts/${artifactSha256}`);
    expect(bucketPut).not.toHaveBeenCalledWith(
      `artifacts/${artifactSha256}`,
      expect.anything(),
      expect.anything(),
    );
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledOnce();
  });
});
