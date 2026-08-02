const R2_DELETE_BATCH_SIZE = 1_000;

export interface ScenarioArtifactStorageRecord {
  r2Key: string;
  r2UploadId: string | null;
}

export interface ScenarioArtifactStorageCleanupResult {
  abortedMultipartUploads: number;
  failedMultipartAborts: number;
  deletedObjects: number;
}

/**
 * Removes every tracked R2 object for a run before its D1 metadata is deleted.
 * Multipart abort failures are reported but do not make a terminal run
 * undeletable: R2 eventually expires incomplete multipart uploads, while
 * deleting completed objects is the durable storage-cleanup boundary.
 */
export async function deleteScenarioArtifactStorage(
  bucket: R2Bucket,
  records: readonly ScenarioArtifactStorageRecord[],
): Promise<ScenarioArtifactStorageCleanupResult> {
  let abortedMultipartUploads = 0;
  let failedMultipartAborts = 0;

  for (const record of records) {
    if (!record.r2UploadId) {
      continue;
    }
    try {
      await bucket
        .resumeMultipartUpload(record.r2Key, record.r2UploadId)
        .abort();
      abortedMultipartUploads += 1;
    } catch {
      failedMultipartAborts += 1;
    }
  }

  const keys = [...new Set(records.map((record) => record.r2Key))];
  for (let offset = 0; offset < keys.length; offset += R2_DELETE_BATCH_SIZE) {
    await bucket.delete(keys.slice(offset, offset + R2_DELETE_BATCH_SIZE));
  }

  return {
    abortedMultipartUploads,
    failedMultipartAborts,
    deletedObjects: keys.length,
  };
}
