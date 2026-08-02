import {
  imageRegistryMocks,
  hostSelectDb,
  publishManifest,
  resetImageRegistryMocks,
} from "./test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";

const { dbMock, catalogManifestMock } = imageRegistryMocks();

describe("image registry uploads", () => {
  beforeEach(resetImageRegistryMocks);

  it("creates chunked uploads and reports already-present objects", async () => {
    const sha256 = "c".repeat(64);
    const bucketHead = vi.fn().mockResolvedValue(null);
    const createMultipartUpload = vi.fn().mockResolvedValue({
      key: `images/broken-nginx-web-x86_64/${sha256}.raw.zst`,
      uploadId: "upload-1",
    });
    const env = {
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: {
        head: bucketHead,
        createMultipartUpload,
      },
    } as unknown as Cloudflare.Env;

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/uploads", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "image",
          sha256,
          image_key: "broken-nginx-web-x86_64",
          scenario_id: "broken-nginx",
          vm_name: "web",
        }),
      }),
      env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toEqual({
      ok: true,
      object_key: `images/broken-nginx-web-x86_64/${sha256}.raw.zst`,
      upload_id: "upload-1",
      already_exists: false,
    });
    expect(createMultipartUpload).toHaveBeenCalledWith(
      `images/broken-nginx-web-x86_64/${sha256}.raw.zst`,
      expect.objectContaining({
        customMetadata: expect.objectContaining({ image_sha256: sha256 }),
      }),
    );

    bucketHead.mockResolvedValue({
      customMetadata: { image_sha256: sha256 },
    });
    const repeat = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/uploads", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "image",
          sha256,
          image_key: "broken-nginx-web-x86_64",
          scenario_id: "broken-nginx",
          vm_name: "web",
        }),
      }),
      env,
    );
    expect(repeat?.status).toBe(200);
    await expect(repeat?.json()).resolves.toMatchObject({
      already_exists: true,
    });
    expect(createMultipartUpload).toHaveBeenCalledOnce();
  });

  it("uploads parts and completes chunked uploads", async () => {
    const uploadPart = vi
      .fn()
      .mockResolvedValue({ partNumber: 1, etag: "etag-1" });
    const complete = vi.fn().mockResolvedValue({ size: 42 });
    const resumeMultipartUpload = vi
      .fn()
      .mockReturnValue({ uploadPart, complete });
    const env = {
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: { resumeMultipartUpload },
    } as unknown as Cloudflare.Env;
    const objectKey = `artifacts/${"d".repeat(64)}`;

    const partResponse = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/registry/v1/uploads/parts?object_key=${encodeURIComponent(objectKey)}&upload_id=upload-2&part_number=1`,
        {
          method: "PUT",
          headers: { authorization: "Bearer publish-secret" },
          body: new Uint8Array([1, 2, 3]),
        },
      ),
      env,
    );
    expect(partResponse?.status).toBe(200);
    await expect(partResponse?.json()).resolves.toEqual({
      ok: true,
      part_number: 1,
      etag: "etag-1",
    });
    expect(resumeMultipartUpload).toHaveBeenCalledWith(objectKey, "upload-2");

    const completeResponse = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/uploads/complete", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          object_key: objectKey,
          upload_id: "upload-2",
          parts: [{ part_number: 1, etag: "etag-1" }],
        }),
      }),
      env,
    );
    expect(completeResponse?.status).toBe(200);
    await expect(completeResponse?.json()).resolves.toEqual({
      ok: true,
      object_key: objectKey,
      bytes: 42,
    });
    expect(complete).toHaveBeenCalledWith([{ partNumber: 1, etag: "etag-1" }]);
  });

  it("rejects chunked uploads outside the registry object space", async () => {
    const env = {
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: {},
    } as unknown as Cloudflare.Env;

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/uploads/complete", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          object_key: "builds/bundles/evil.tar.gz",
          upload_id: "upload-3",
          parts: [{ part_number: 1, etag: "etag-1" }],
        }),
      }),
      env,
    );
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "invalid object_key or upload_id",
    });
  });

  it("publishes manifests that reference pre-uploaded images", async () => {
    const imageSha256 = "e".repeat(64);
    const artifactSha256 = "f".repeat(64);
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
      images: [
        {
          image_key: "broken-nginx-web-x86_64",
          image_sha256: imageSha256,
          object_key: imageObjectKey,
          bytes: 777,
          reused: true,
        },
      ],
    });
    // Only the sha256 sidecar is written; the image object itself is reused.
    expect(bucketPut).toHaveBeenCalledTimes(1);
    expect(bucketPut).toHaveBeenCalledWith(
      `${imageObjectKey}.sha256`,
      expect.anything(),
      expect.anything(),
    );
    expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledOnce();
  });
});
