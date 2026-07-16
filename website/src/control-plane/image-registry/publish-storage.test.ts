import {
  imageRegistryMocks,
  hostSelectDb,
  publishManifest,
  sha256HexForTest,
  resetImageRegistryMocks,
} from "./test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  handleImageRegistryRequest,
  isRuntimeImageCacheHost,
} from "@/control-plane/image-registry";

const {
  dbMock,
  catalogManifestMock,
  desiredStateStoreMock,
  hostRuntimeWakeMock,
} = imageRegistryMocks();

describe("image registry publish storage", () => {
  beforeEach(resetImageRegistryMocks);

  it("replaces unverified existing boot artifacts during publish", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
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
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: "b".repeat(64) },
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
      artifacts: [
        {
          sha256: artifactSha256,
          object_key: `artifacts/${artifactSha256}`,
          bytes: artifactPayload.byteLength,
          reused: false,
        },
      ],
    });
    expect(bucketPut).toHaveBeenCalledWith(
      `artifacts/${artifactSha256}`,
      expect.any(ArrayBuffer),
      {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { artifact_sha256: artifactSha256 },
      },
    );
    expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledOnce();
  });

  it("normalizes publish manifest hashes before catalog seeding", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
    const manifest = publishManifest({
      imageSha256: imageSha256.toUpperCase(),
      artifactSha256: artifactSha256.toUpperCase(),
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
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
      images: [{ image_sha256: imageSha256 }],
      artifacts: [{ sha256: artifactSha256 }],
    });
    expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        vms: [
          expect.objectContaining({
            image_sha256: imageSha256,
            boot: expect.objectContaining({
              kernel_sha256: artifactSha256,
              initrd_sha256: artifactSha256,
            }),
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it("does not write boot artifacts when a publish image file is missing", async () => {
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
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
      error:
        "missing image for vm web: attach it to the form or upload it via /registry/v1/uploads first",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("does not write boot artifacts when a publish image hash mismatches", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const wrongImagePayload = new Uint8Array([9, 9, 9]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
    const wrongImageSha256 = await sha256HexForTest(wrongImagePayload);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([wrongImagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
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
      error: "sha256 mismatch for vm web",
      expected: imageSha256,
      actual: wrongImageSha256,
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("targets non-disabled agents even while scenario starts are disabled", () => {
    expect(
      isRuntimeImageCacheHost({
        role: "agent",
        disabled: false,
        scenarioEnabled: true,
      }),
    ).toBe(true);
    expect(
      isRuntimeImageCacheHost({
        role: "builder",
        disabled: false,
        scenarioEnabled: false,
      }),
    ).toBe(false);
    expect(
      isRuntimeImageCacheHost({
        role: "agent",
        disabled: false,
        scenarioEnabled: false,
      }),
    ).toBe(true);
    expect(
      isRuntimeImageCacheHost({
        role: "agent",
        disabled: true,
        scenarioEnabled: true,
      }),
    ).toBe(false);
  });

  it("prewarms maintenance-paused agents without waking builder hosts", async () => {
    const now = 1_762_041_660_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const imagePayload = new Uint8Array([1, 2, 3]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
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
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const db = hostSelectDb([
      {
        id: "agent-1",
        role: "agent",
        disabled: false,
        scenarioEnabled: true,
      },
      {
        id: "builder-1",
        role: "builder",
        disabled: false,
        scenarioEnabled: false,
      },
      {
        id: "agent-paused",
        role: "agent",
        disabled: false,
        scenarioEnabled: false,
      },
    ]);
    dbMock.drizzle.mockReturnValueOnce(db);

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
          },
        } as unknown as Cloudflare.Env,
      );

      expect(response?.status).toBe(201);
      expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledWith(
        db,
        manifest,
        {
          enabled: true,
          nowUnixMs: now,
        },
      );
      expect(
        desiredStateStoreMock.mutateStoredHostDesiredState,
      ).toHaveBeenCalledTimes(2);
      expect(
        desiredStateStoreMock.mutateStoredHostDesiredState,
      ).toHaveBeenCalledWith(db, "agent-1", now, expect.any(Function));
      expect(
        desiredStateStoreMock.mutateStoredHostDesiredState,
      ).toHaveBeenCalledWith(db, "agent-paused", now, expect.any(Function));
      expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenCalledTimes(2);
      expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenCalledWith(
        "agent-1",
      );
      expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenCalledWith(
        "agent-paused",
      );
    } finally {
      dateSpy.mockRestore();
    }
  });
});
