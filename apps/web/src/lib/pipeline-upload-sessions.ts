import {
  sha256Hex,
  textEncoder,
} from "@/control-plane/image-registry/shared";

/**
 * What the registry's write path needs of a pipeline's upload session (#441):
 * its token's shape and hash, and its byte budget. The collector's Worker
 * bundles the write path's modules, so this one imports nothing of the
 * scenario sources; the routes that open and look up a session are in
 * `@/control-plane/image-registry/pipeline-sessions`.
 */

/** Tells a session token from the publish token and a builder's. */
export const PIPELINE_SESSION_TOKEN_PREFIX = "ips_";
/** The bytes one session may store. */
export const PIPELINE_SESSION_MAX_BYTES = 16 * 1024 * 1024 * 1024;
/** The config and layers of one image a pipeline pushes. */
export const PIPELINE_IMAGE_MAX_BYTES = PIPELINE_SESSION_MAX_BYTES;
/** The images one scope may have recorded, counted over those a kept revision names. */
export const PIPELINE_SCOPE_STORAGE_BYTES = 200 * 1024 * 1024 * 1024;

export function readBearer(request: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

/** The request's bearer when it is shaped like a session token. */
export function readPipelineSessionToken(request: Request): string | null {
  const bearer = readBearer(request);
  return bearer?.startsWith(PIPELINE_SESSION_TOKEN_PREFIX) ? bearer : null;
}

/** Only this hash of a session token is stored or compared. */
export function pipelineSessionTokenHash(token: string): Promise<string> {
  return sha256Hex(textEncoder.encode(token).buffer as ArrayBuffer);
}

/**
 * Reserves `bytes` of a session's budget before a blob is stored. One
 * statement checks and adds, so concurrent uploads cannot take more than the
 * budget between them. False when the blob does not fit.
 */
export async function chargePipelineSession(
  env: { DB: D1Database },
  sessionId: string,
  bytes: number,
): Promise<boolean> {
  const charged = await env.DB.prepare(
    `UPDATE pipeline_upload_sessions
        SET bytes_put = bytes_put + ?2
      WHERE id = ?1 AND bytes_put + ?2 <= ?3
      RETURNING id`,
  )
    .bind(sessionId, bytes, PIPELINE_SESSION_MAX_BYTES)
    .first();
  return charged !== null;
}

/** Gives back what a blob reserved when it was not stored after all. */
export async function refundPipelineSession(
  env: { DB: D1Database },
  sessionId: string,
  bytes: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE pipeline_upload_sessions
        SET bytes_put = MAX(0, bytes_put - ?2)
      WHERE id = ?1`,
  )
    .bind(sessionId, bytes)
    .run();
}
