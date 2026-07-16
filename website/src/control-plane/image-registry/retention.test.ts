import {
  imageRegistryMocks,
  publishPruneDb,
  pruneImageObject,
  pruneCompanionObject,
  publishManifest,
  sha256HexForTest,
  resetImageRegistryMocks,
} from "./test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";

const { dbMock, catalogManifestMock } = imageRegistryMocks();

describe("image registry retention", () => {
  beforeEach(resetImageRegistryMocks);

  it("prunes vm images beyond the retention limit after publish", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const keptSha256 = "2".repeat(64);
    const staleSha256A = "3".repeat(64);
    const staleSha256B = "4".repeat(64);
    const orphanSha256 = "5".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: artifactSha256 },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const bucketList = vi.fn().mockResolvedValue({
      objects: [
        pruneImageObject(imageSha256, 4_000),
        pruneCompanionObject(imageSha256, 4_000),
        pruneImageObject(keptSha256, 3_000),
        pruneCompanionObject(keptSha256, 3_000),
        pruneImageObject(staleSha256A, 2_000),
        pruneCompanionObject(staleSha256A, 2_000),
        pruneImageObject(staleSha256B, 1_000),
        pruneCompanionObject(staleSha256B, 1_000),
        pruneCompanionObject(orphanSha256, 500),
      ],
      truncated: false,
    });
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(publishPruneDb([], []));

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
          list: bucketList,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      pruned: [
        {
          image_key: "broken-nginx-web-x86_64",
          deleted_sha256s: [staleSha256A, staleSha256B, orphanSha256],
        },
      ],
    });
    expect(bucketList).toHaveBeenCalledWith({
      prefix: "images/broken-nginx-web-x86_64/",
    });
    expect(bucketDelete).toHaveBeenCalledTimes(1);
    expect(bucketDelete).toHaveBeenCalledWith([
      `images/broken-nginx-web-x86_64/${staleSha256A}.raw.zst`,
      `images/broken-nginx-web-x86_64/${staleSha256A}.raw.zst.sha256`,
      `images/broken-nginx-web-x86_64/${staleSha256B}.raw.zst`,
      `images/broken-nginx-web-x86_64/${staleSha256B}.raw.zst.sha256`,
      `images/broken-nginx-web-x86_64/${orphanSha256}.raw.zst.sha256`,
    ]);
  });

  it("never prunes a just-published reused image with a stale uploaded timestamp", async () => {
    const imageSha256 = "e".repeat(64);
    const artifactSha256 = "f".repeat(64);
    const newerSha256A = "1".repeat(64);
    const newerSha256B = "2".repeat(64);
    const staleSha256 = "3".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const imageObjectKey = `images/broken-nginx-web-x86_64/${imageSha256}.raw.zst`;
    const bucketHead = vi.fn().mockImplementation((key: string) => {
      if (key === imageObjectKey) {
        return Promise.resolve({
          size: 777,
          customMetadata: {
            image_key: "broken-nginx-web-x86_64",
            image_sha256: imageSha256,
          },
        });
      }
      return Promise.resolve({
        size: 555,
        customMetadata: { artifact_sha256: artifactSha256 },
      });
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    // The reused image keeps its original (oldest) uploaded timestamp.
    const bucketList = vi.fn().mockResolvedValue({
      objects: [
        pruneImageObject(imageSha256, 1_000),
        pruneCompanionObject(imageSha256, 1_000),
        pruneImageObject(newerSha256A, 4_000),
        pruneCompanionObject(newerSha256A, 4_000),
        pruneImageObject(newerSha256B, 3_000),
        pruneCompanionObject(newerSha256B, 3_000),
        pruneImageObject(staleSha256, 2_000),
        pruneCompanionObject(staleSha256, 2_000),
      ],
      truncated: false,
    });
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(publishPruneDb([], []));

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
          list: bucketList,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      pruned: [
        {
          image_key: "broken-nginx-web-x86_64",
          deleted_sha256s: [staleSha256],
        },
      ],
    });
    expect(bucketDelete).toHaveBeenCalledWith([
      `images/broken-nginx-web-x86_64/${staleSha256}.raw.zst`,
      `images/broken-nginx-web-x86_64/${staleSha256}.raw.zst.sha256`,
    ]);
  });

  it("never prunes images still referenced by scenario catalog rows", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const keptSha256 = "1".repeat(64);
    const staleSha256 = "2".repeat(64);
    const referencedSha256 = "3".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: artifactSha256 },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const bucketList = vi.fn().mockResolvedValue({
      objects: [
        pruneImageObject(imageSha256, 4_000),
        pruneImageObject(keptSha256, 3_000),
        pruneImageObject(staleSha256, 2_000),
        pruneImageObject(referencedSha256, 1_000),
      ],
      truncated: false,
    });
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(
      publishPruneDb(
        [],
        [
          {
            imageKey: { scenario: "broken-nginx", vm: "web", arch: "x86_64" },
            imageSha256: referencedSha256,
          },
        ],
      ),
    );

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
          list: bucketList,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      pruned: [
        {
          image_key: "broken-nginx-web-x86_64",
          deleted_sha256s: [staleSha256],
        },
      ],
    });
    expect(bucketDelete).toHaveBeenCalledWith([
      `images/broken-nginx-web-x86_64/${staleSha256}.raw.zst`,
    ]);
  });

  it("follows list cursors when pruning", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const keptSha256 = "1".repeat(64);
    const staleSha256A = "2".repeat(64);
    const staleSha256B = "3".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: artifactSha256 },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    // The second-newest image only shows up on the second page.
    const bucketList = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [
          pruneImageObject(imageSha256, 4_000),
          pruneImageObject(staleSha256A, 1_000),
        ],
        truncated: true,
        cursor: "next-cursor",
      })
      .mockResolvedValueOnce({
        objects: [
          pruneImageObject(keptSha256, 3_000),
          pruneImageObject(staleSha256B, 2_000),
        ],
        truncated: false,
      });
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(publishPruneDb([], []));

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
          list: bucketList,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      pruned: [
        {
          image_key: "broken-nginx-web-x86_64",
          deleted_sha256s: [staleSha256A, staleSha256B],
        },
      ],
    });
    expect(bucketList).toHaveBeenCalledTimes(2);
    expect(bucketList).toHaveBeenNthCalledWith(2, {
      prefix: "images/broken-nginx-web-x86_64/",
      cursor: "next-cursor",
    });
    expect(bucketDelete).toHaveBeenCalledWith([
      `images/broken-nginx-web-x86_64/${staleSha256A}.raw.zst`,
      `images/broken-nginx-web-x86_64/${staleSha256B}.raw.zst`,
    ]);
  });

  it("publishes successfully when image pruning fails", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: artifactSha256 },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const bucketList = vi.fn().mockRejectedValue(new Error("r2 list failed"));
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(publishPruneDb([], []));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
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
            list: bucketList,
            delete: bucketDelete,
          },
        } as unknown as Cloudflare.Env,
      );

      expect(response?.status).toBe(201);
      await expect(response?.json()).resolves.toMatchObject({
        ok: true,
        pruned: [],
      });
      expect(bucketDelete).not.toHaveBeenCalled();
      expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
