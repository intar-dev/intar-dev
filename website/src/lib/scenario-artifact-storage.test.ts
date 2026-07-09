import { describe, expect, it, vi } from "vitest";
import { deleteScenarioArtifactStorage } from "@/lib/scenario-artifact-storage";

function createBucket(overrides?: {
  abort?: () => Promise<void>;
  delete?: (keys: string | string[]) => Promise<void>;
}) {
  const abort = vi.fn(overrides?.abort ?? (async () => undefined));
  const deleteObjects = vi.fn(
    overrides?.delete ?? (async (_keys: string | string[]) => undefined),
  );
  const resumeMultipartUpload = vi.fn((_key: string, _uploadId: string) => ({
    abort,
  }));

  return {
    abort,
    deleteObjects,
    resumeMultipartUpload,
    bucket: {
      delete: deleteObjects,
      resumeMultipartUpload,
    } as unknown as R2Bucket,
  };
}

describe("deleteScenarioArtifactStorage", () => {
  it("aborts multipart uploads and deletes each object once", async () => {
    const { bucket, abort, deleteObjects, resumeMultipartUpload } =
      createBucket();

    const result = await deleteScenarioArtifactStorage(bucket, [
      { r2Key: "run/vm/one", r2UploadId: "upload-1" },
      { r2Key: "run/vm/two", r2UploadId: null },
      { r2Key: "run/vm/one", r2UploadId: null },
    ]);

    expect(resumeMultipartUpload).toHaveBeenCalledWith(
      "run/vm/one",
      "upload-1",
    );
    expect(abort).toHaveBeenCalledOnce();
    expect(deleteObjects).toHaveBeenCalledWith([
      "run/vm/one",
      "run/vm/two",
    ]);
    expect(result).toEqual({
      abortedMultipartUploads: 1,
      failedMultipartAborts: 0,
      deletedObjects: 2,
    });
  });

  it("reports stale multipart uploads without blocking object cleanup", async () => {
    const { bucket, deleteObjects } = createBucket({
      abort: async () => {
        throw new Error("multipart upload no longer exists");
      },
    });

    await expect(
      deleteScenarioArtifactStorage(bucket, [
        { r2Key: "run/vm/one", r2UploadId: "stale-upload" },
      ]),
    ).resolves.toEqual({
      abortedMultipartUploads: 0,
      failedMultipartAborts: 1,
      deletedObjects: 1,
    });
    expect(deleteObjects).toHaveBeenCalledOnce();
  });

  it("preserves D1 metadata by surfacing object deletion failures", async () => {
    const { bucket } = createBucket({
      delete: async () => {
        throw new Error("R2 unavailable");
      },
    });

    await expect(
      deleteScenarioArtifactStorage(bucket, [
        { r2Key: "run/vm/one", r2UploadId: null },
      ]),
    ).rejects.toThrow("R2 unavailable");
  });
});
