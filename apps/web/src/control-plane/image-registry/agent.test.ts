import {
  imageRegistryMocks,
  buildLogDb,
  candidateArtifactDb,
  imageIndexDb,
  bundleDownloadDb,
  imageIndexRow,
  resetImageRegistryMocks,
} from "./test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";

const { authMock, dbMock } = imageRegistryMocks();

describe("image registry agent routes", () => {
  beforeEach(resetImageRegistryMocks);

  it("deduplicates and advertises only valid chunked direct-boot image index entries", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const validImageSha256 = "a".repeat(64);
    const validKernelSha256 = "b".repeat(64);
    const validInitrdSha256 = "c".repeat(64);
    const missingImageSha256 = "3".repeat(64);
    const missingArtifactImageSha256 = "6".repeat(64);
    const missingArtifactKernelSha256 = "7".repeat(64);
    const missingArtifactInitrdSha256 = "8".repeat(64);
    const staleMetadataImageSha256 = "9".repeat(64);
    const valid = imageIndexRow({
      imageSha256: validImageSha256,
      kernelSha256: validKernelSha256,
      initrdSha256: validInitrdSha256,
    });
    const invalidFormat = imageIndexRow({
      imageSha256: "d".repeat(64),
      imageFormat: "qcow2",
      kernelSha256: "e".repeat(64),
      initrdSha256: "f".repeat(64),
    });
    const invalidBoot = imageIndexRow({
      imageSha256: "1".repeat(64),
      kernelSha256: "not-a-sha",
      initrdSha256: "2".repeat(64),
    });
    const missingObject = imageIndexRow({
      imageSha256: missingImageSha256,
      kernelSha256: "4".repeat(64),
      initrdSha256: "5".repeat(64),
    });
    const missingArtifact = imageIndexRow({
      imageSha256: missingArtifactImageSha256,
      kernelSha256: missingArtifactKernelSha256,
      initrdSha256: missingArtifactInitrdSha256,
    });
    const staleMetadata = imageIndexRow({
      imageSha256: staleMetadataImageSha256,
      kernelSha256: "0".repeat(64),
      initrdSha256: "1".repeat(64),
    });
    dbMock.drizzle.mockReturnValueOnce(
      imageIndexDb([
        valid,
        valid,
        invalidFormat,
        invalidBoot,
        missingObject,
        missingArtifact,
        staleMetadata,
      ]),
    );
    const bucketHead = vi.fn(async (key: string) => {
      if (key === `image-manifests/v1/${"d".repeat(64)}.json`) {
        return {
          size: 321,
          customMetadata: {
            manifest_sha256: "d".repeat(64),
            image_id: validImageSha256,
          },
        };
      }
      if (
        key === `artifacts/${validKernelSha256}` ||
        key === `artifacts/${validInitrdSha256}`
      ) {
        const sha256 = key.slice("artifacts/".length);
        return { size: 42, customMetadata: { artifact_sha256: sha256 } };
      }
      if (
        key ===
        `images/broken-nginx-web-x86_64/${missingArtifactImageSha256}.raw.zst`
      ) {
        return {
          size: 654_321,
          customMetadata: {
            image_key: "broken-nginx-web-x86_64",
            image_sha256: missingArtifactImageSha256,
          },
        };
      }
      if (
        key ===
        `images/broken-nginx-web-x86_64/${staleMetadataImageSha256}.raw.zst`
      ) {
        return {
          size: 987_654,
          customMetadata: {
            image_key: "broken-nginx-web-x86_64",
            image_sha256: "0".repeat(64),
          },
        };
      }
      return null;
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/registry/images", {
        method: "GET",
        headers: { authorization: "Bearer agent-jwt" },
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      images: [
        {
          image_key: "broken-nginx-web-x86_64",
          image_id: validImageSha256,
          image_format: "raw_chunks_v1",
          image_virtual_size_bytes: 8_589_934_592,
          chunk_manifest_sha256: "d".repeat(64),
          guest_bootstrap_abi: 1,
          boot: {
            kernel_sha256: validKernelSha256,
            initrd_sha256: validInitrdSha256,
            cmdline:
              "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false",
          },
          bytes: 8_589_934_592,
          manifest_download_url: `/agent/registry/image-manifests/${"d".repeat(64)}`,
          chunk_download_base_url: "/agent/registry/image-chunks",
        },
      ],
    });
    expect(bucketHead).toHaveBeenCalledWith(
      `image-manifests/v1/${"d".repeat(64)}.json`,
    );
    expect(bucketHead).toHaveBeenCalledWith(`artifacts/${validKernelSha256}`);
    expect(bucketHead).toHaveBeenCalledWith(`artifacts/${validInitrdSha256}`);
    expect(bucketHead).toHaveBeenCalledTimes(6);
  });

  it("checks distinct chunked image identities concurrently", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const first = imageIndexRow({
      imageKey: { scenario: "alpha", vm: "web", arch: "x86_64" },
      imageSha256: "a".repeat(64),
      chunkManifestSha256: "b".repeat(64),
      kernelSha256: "c".repeat(64),
      initrdSha256: "d".repeat(64),
    });
    const second = imageIndexRow({
      imageKey: { scenario: "bravo", vm: "web", arch: "x86_64" },
      imageSha256: "e".repeat(64),
      chunkManifestSha256: "f".repeat(64),
      kernelSha256: "0".repeat(64),
      initrdSha256: "1".repeat(64),
    });
    dbMock.drizzle.mockReturnValueOnce(imageIndexDb([first, second]));

    const manifestKeys = new Map([
      [`image-manifests/v1/${first.chunkManifestSha256}.json`, first],
      [`image-manifests/v1/${second.chunkManifestSha256}.json`, second],
    ]);
    const artifactKeys = new Set([
      `artifacts/${first.kernelSha256}`,
      `artifacts/${first.initrdSha256}`,
      `artifacts/${second.kernelSha256}`,
      `artifacts/${second.initrdSha256}`,
    ]);
    let manifestHeadsStarted = 0;
    let releaseManifestHeads!: () => void;
    const manifestHeads = new Promise<void>((resolve) => {
      releaseManifestHeads = resolve;
    });
    const bucketHead = vi.fn(async (key: string) => {
      const image = manifestKeys.get(key);
      if (image) {
        manifestHeadsStarted += 1;
        await manifestHeads;
        return {
          customMetadata: {
            manifest_sha256: image.chunkManifestSha256,
            image_id: image.imageSha256,
          },
        };
      }
      if (artifactKeys.has(key)) {
        const sha256 = key.slice("artifacts/".length);
        return { customMetadata: { artifact_sha256: sha256 } };
      }
      return null;
    });

    const responsePromise = handleImageRegistryRequest(
      new Request("https://intar.test/agent/registry/images", {
        headers: { authorization: "Bearer agent-jwt" },
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: { head: bucketHead },
      } as unknown as Cloudflare.Env,
    );
    try {
      await vi.waitFor(() => expect(manifestHeadsStarted).toBe(2));
    } finally {
      releaseManifestHeads();
    }

    const response = await responsePromise;
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      images: [
        { image_key: "alpha-web-x86_64", image_id: first.imageSha256 },
        { image_key: "bravo-web-x86_64", image_id: second.imageSha256 },
      ],
    });
    expect(bucketHead).toHaveBeenCalledTimes(6);
  });

  it("advertises a verified desired candidate before catalog promotion", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const imageId = "a".repeat(64);
    const chunkManifestSha256 = "d".repeat(64);
    const kernelSha256 = "b".repeat(64);
    const initrdSha256 = "c".repeat(64);
    const liveManifestSha256 = "e".repeat(64);
    const liveKernelSha256 = "f".repeat(64);
    const liveInitrdSha256 = "0".repeat(64);
    const imageKey = {
      scenario: "broken-nginx",
      vm: "web",
      arch: "x86_64" as const,
    };
    dbMock.drizzle.mockReturnValueOnce(
      imageIndexDb(
        [
          imageIndexRow({
            imageSha256: imageId,
            chunkManifestSha256: liveManifestSha256,
            kernelSha256: liveKernelSha256,
            initrdSha256: liveInitrdSha256,
            bootCmdline: "root=/dev/vda rw console=ttyS0 live",
          }),
        ],
        [{
          docJson: {
            schema_version: 4,
            host_id: "agent-1",
            version: 1,
            generated_at_unix_ms: 1,
            cached_images: [{ image_key: imageKey, image_id: imageId }],
            cached_guest_tools: [],
            vms: [],
            builds: [],
          },
        }],
        [{
          manifest: {
            schema_version: 4,
            scenario_id: "broken-nginx",
            name: "broken-nginx",
            title: "Broken nginx",
            category: "Linux",
            description: "candidate",
            difficulty: "easy",
            estimated_minutes: 10,
            tags: [],
            briefing_markdown: "briefing",
            solution_markdown: "solution",
            hints: [],
            vms: [{
              name: "web",
              image_key: imageKey,
              image_id: imageId,
              image_format: "raw_chunks_v1",
              image_virtual_size_bytes: 4_294_967_296,
              chunk_manifest_sha256: chunkManifestSha256,
              guest_bootstrap_abi: 1,
              boot: {
                kernel_sha256: kernelSha256,
                initrd_sha256: initrdSha256,
                cmdline: "root=/dev/vda rw console=ttyS0",
              },
              cpu_millis: 1_000,
              vcpu_count: 1,
              memory_mib: 512,
              disk_mib: 4_096,
              probes: [],
            }],
          },
        }],
      ),
    );
    const bucketHead = vi.fn(async (key: string) => {
      if (key === `image-manifests/v1/${liveManifestSha256}.json`) {
        return {
          customMetadata: {
            manifest_sha256: liveManifestSha256,
            image_id: imageId,
          },
        };
      }
      if (key === `image-manifests/v1/${chunkManifestSha256}.json`) {
        return {
          customMetadata: {
            manifest_sha256: chunkManifestSha256,
            image_id: imageId,
          },
        };
      }
      if (key === `artifacts/${kernelSha256}` || key === `artifacts/${initrdSha256}`) {
        const sha256 = key.slice("artifacts/".length);
        return { customMetadata: { artifact_sha256: sha256 } };
      }
      if (
        key === `artifacts/${liveKernelSha256}` ||
        key === `artifacts/${liveInitrdSha256}`
      ) {
        const sha256 = key.slice("artifacts/".length);
        return { customMetadata: { artifact_sha256: sha256 } };
      }
      return null;
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/registry/images", {
        headers: { authorization: "Bearer agent-jwt" },
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: { head: bucketHead },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      images: [{
        image_key: "broken-nginx-web-x86_64",
        image_id: imageId,
        chunk_manifest_sha256: chunkManifestSha256,
      }],
    });
    expect(bucketHead).toHaveBeenCalledTimes(6);
  });

  it("streams raw-zstd images to verified agents", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const imageKey = "broken-nginx-web-x86_64";
    const imageSha256 = "a".repeat(64);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "image-bytes",
      size: 11,
      httpEtag: '"image-etag"',
      customMetadata: {
        image_key: imageKey,
        image_sha256: imageSha256,
      },
    });

    const response = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/agent/registry/images/${imageKey}/${imageSha256}`,
        {
          method: "GET",
          headers: { authorization: "Bearer agent-jwt" },
        },
      ),
      {
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("image-bytes");
    expect(response?.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response?.headers.get("content-length")).toBe("11");
    expect(response?.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(response?.headers.get("etag")).toBe('"image-etag"');
    expect(response?.headers.get("x-image-key")).toBe(imageKey);
    expect(response?.headers.get("x-image-sha256")).toBe(imageSha256);
    expect(bucketGet).toHaveBeenCalledWith(
      `images/${imageKey}/${imageSha256}.raw.zst`,
    );
  });

  it("rejects image downloads with stale object metadata", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const imageKey = "broken-nginx-web-x86_64";
    const imageSha256 = "a".repeat(64);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "image-bytes",
      size: 11,
      httpEtag: '"image-etag"',
      customMetadata: {
        image_key: imageKey,
        image_sha256: "b".repeat(64),
      },
    });

    const response = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/agent/registry/images/${imageKey}/${imageSha256}`,
        {
          method: "GET",
          headers: { authorization: "Bearer agent-jwt" },
        },
      ),
      {
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({
      error: "image not found",
    });
    expect(bucketGet).toHaveBeenCalledWith(
      `images/${imageKey}/${imageSha256}.raw.zst`,
    );
  });

  it("streams boot artifacts to verified agents", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const artifactSha256 = "b".repeat(64);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "artifact-bytes",
      size: 14,
      httpEtag: '"artifact-etag"',
      customMetadata: { artifact_sha256: artifactSha256 },
    });

    const response = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/agent/registry/artifacts/${artifactSha256}`,
        {
          method: "GET",
          headers: { authorization: "Bearer agent-jwt" },
        },
      ),
      {
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("artifact-bytes");
    expect(response?.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response?.headers.get("content-length")).toBe("14");
    expect(response?.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(response?.headers.get("etag")).toBe('"artifact-etag"');
    expect(response?.headers.get("x-artifact-sha256")).toBe(artifactSha256);
    expect(bucketGet).toHaveBeenCalledWith(`artifacts/${artifactSha256}`);
  });

  it("streams a boot artifact for an exact desired candidate", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const imageId = "a".repeat(64);
    const artifactSha256 = "b".repeat(64);
    const imageKey = {
      scenario: "broken-nginx",
      vm: "web",
      arch: "x86_64" as const,
    };
    dbMock.drizzle.mockReturnValueOnce(
      candidateArtifactDb(
        [{
          docJson: {
            schema_version: 4,
            host_id: "agent-1",
            version: 1,
            generated_at_unix_ms: 1,
            cached_images: [{ image_key: imageKey, image_id: imageId }],
            cached_guest_tools: [],
            vms: [],
            builds: [],
          },
        }],
        [{
          manifest: {
            schema_version: 4,
            scenario_id: "broken-nginx",
            name: "broken-nginx",
            title: "Broken nginx",
            category: "Linux",
            description: "candidate",
            difficulty: "easy",
            estimated_minutes: 10,
            tags: [],
            briefing_markdown: "briefing",
            solution_markdown: "solution",
            hints: [],
            vms: [{
              name: "web",
              image_key: imageKey,
              image_id: imageId,
              image_format: "raw_chunks_v1",
              image_virtual_size_bytes: 4_294_967_296,
              chunk_manifest_sha256: "d".repeat(64),
              guest_bootstrap_abi: 1,
              boot: {
                kernel_sha256: artifactSha256,
                initrd_sha256: "c".repeat(64),
                cmdline: "root=/dev/vda rw console=ttyS0",
              },
              cpu_millis: 1_000,
              vcpu_count: 1,
              memory_mib: 512,
              disk_mib: 4_096,
              probes: [],
            }],
          },
        }],
      ),
    );
    const bucketGet = vi.fn().mockResolvedValue({
      body: "candidate-kernel",
      size: 16,
      httpEtag: '"candidate-artifact-etag"',
      customMetadata: { artifact_sha256: artifactSha256 },
    });

    const response = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/agent/registry/artifacts/${artifactSha256}`,
        { headers: { authorization: "Bearer agent-jwt" } },
      ),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: { get: bucketGet },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("candidate-kernel");
    expect(bucketGet).toHaveBeenCalledWith(`artifacts/${artifactSha256}`);
  });

  it("rejects boot artifact downloads with stale object metadata", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const artifactSha256 = "b".repeat(64);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "artifact-bytes",
      size: 14,
      httpEtag: '"artifact-etag"',
      customMetadata: { artifact_sha256: "c".repeat(64) },
    });

    const response = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/agent/registry/artifacts/${artifactSha256}`,
        {
          method: "GET",
          headers: { authorization: "Bearer agent-jwt" },
        },
      ),
      {
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({
      error: "artifact not found",
    });
    expect(bucketGet).toHaveBeenCalledWith(`artifacts/${artifactSha256}`);
  });

  it("rejects source bundle downloads from non-builder agents", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/registry/bundles/abc123", {
        method: "GET",
        headers: { authorization: "Bearer agent-jwt" },
      }),
      {} as Cloudflare.Env,
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "builder role required",
    });
  });

  it("streams source bundles to builder agents", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const db = bundleDownloadDb([{ r2Key: "builds/bundles/abc123.tar.gz" }]);
    dbMock.drizzle.mockReturnValueOnce(db);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "bundle-bytes",
      size: 12,
      httpEtag: '"etag"',
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/registry/bundles/abc123", {
        method: "GET",
        headers: { authorization: "Bearer builder-jwt" },
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("bundle-bytes");
    expect(response?.headers.get("content-type")).toBe("application/gzip");
    expect(response?.headers.get("content-length")).toBe("12");
    expect(response?.headers.get("x-build-bundle-rev")).toBe("abc123");
    expect(response?.headers.get("etag")).toBe('"etag"');
    expect(bucketGet).toHaveBeenCalledWith("builds/bundles/abc123.tar.gz");
  });

  it("rejects build log uploads from builders that do not own the build", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-2", userId: "user-1", role: "builder" },
    });
    const db = buildLogDb({
      selectRows: [{ hostId: "builder-1" }],
      updatedRows: [],
    });
    dbMock.drizzle.mockReturnValueOnce(db);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/builds/build-1/log", {
        method: "PUT",
        headers: { authorization: "Bearer builder-jwt" },
        body: "log text",
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: "build is not assigned to this builder",
    });
    expect(bucketPut).not.toHaveBeenCalled();
  });

  it("rejects unsafe build log ids before looking up build ownership", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const unsafeBuildId = "a".repeat(129);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request(`https://intar.test/agent/builds/${unsafeBuildId}/log`, {
        method: "PUT",
        headers: { authorization: "Bearer builder-jwt" },
        body: "log text",
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "invalid build id",
    });
    expect(dbMock.drizzle).not.toHaveBeenCalled();
    expect(bucketPut).not.toHaveBeenCalled();
  });

  it("stores build logs for the assigned builder", async () => {
    const now = 1_762_041_660_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const db = buildLogDb({
      selectRows: [{ hostId: "builder-1" }],
      updatedRows: [{ id: "build-1" }],
    });
    dbMock.drizzle.mockReturnValueOnce(db);
    const bucketPut = vi.fn();

    try {
      const response = await handleImageRegistryRequest(
        new Request("https://intar.test/agent/builds/build-1/log", {
          method: "PUT",
          headers: { authorization: "Bearer builder-jwt" },
          body: "log text",
        }),
        {
          DB: "db-binding",
          VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
        } as unknown as Cloudflare.Env,
      );

      expect(response?.status).toBe(200);
      await expect(response?.json()).resolves.toEqual({
        ok: true,
        build_id: "build-1",
        log_key: "builds/logs/build-1.log",
      });
      expect(bucketPut).toHaveBeenCalledWith(
        "builds/logs/build-1.log",
        expect.any(ArrayBuffer),
        {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
          customMetadata: {
            build_id: "build-1",
            host_id: "builder-1",
          },
        },
      );
      expect(db.updateSet).toHaveBeenCalledWith({
        logR2Key: "builds/logs/build-1.log",
        updatedAt: now,
      });
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("deletes uploaded build logs if assignment changes during upload", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const db = buildLogDb({
      selectRows: [{ hostId: "builder-1" }],
      updatedRows: [],
    });
    dbMock.drizzle.mockReturnValueOnce(db);
    const bucketPut = vi.fn();
    const bucketDelete = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/builds/build-1/log", {
        method: "PUT",
        headers: { authorization: "Bearer builder-jwt" },
        body: "log text",
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: {
          put: bucketPut,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: "build assignment changed during log upload",
    });
    expect(bucketPut).toHaveBeenCalledOnce();
    expect(bucketDelete).toHaveBeenCalledWith("builds/logs/build-1.log");
  });
});
