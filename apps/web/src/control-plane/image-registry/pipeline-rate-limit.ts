import {
  pipelineSessionTokenHash,
  readPipelineSessionToken,
} from "@/lib/pipeline-upload-sessions";
import { PIPELINE_SESSIONS_PATH } from "./pipeline-sessions";
import { jsonResponse } from "./shared";

/**
 * The limiter's window. The CLI waits what the header says (up to 30
 * seconds) before each of its five attempts, so they outlast it.
 */
export const PIPELINE_RATE_LIMIT_RETRY_SECONDS = 10;

/** The routes a pipeline's push spends storage reads and writes on. */
const LIMITED_PATH = /^\/registry\/v1\/(?:(?:blobs|manifests)\/[^/]+|builds\/[^/]+\/result)$/;

/**
 * Bounds how fast a scenario repository's pipeline calls the registry
 * (#472), before anything is read for the request. A pipeline's bytes and
 * sessions are capped in the database; what this bounds is the cost of its
 * calls, of which a blob check takes a credential lookup, an admission lease
 * and a storage read.
 *
 * - A blob, manifest or result call under a session token is counted on
 *   that session, so one session cannot spend another's allowance. A
 *   made-up token has a key of its own, and costs the one lookup that
 *   refuses it.
 * - Opening a session carries a GitHub OIDC token, which is not verified yet
 *   here: it is counted on the client's address.
 * - The upload-session routes and the close are not limited. They touch no
 *   bucket, and the CLI does not try a heartbeat, a completion or a close
 *   again: a refusal there would fail a push or leave its session open.
 *
 * Null admits the request. A limiter that cannot be asked admits too: it
 * must not stop every publish, and the database's caps hold without it.
 */
export async function limitPipelineRequest(
  request: Request,
  env: Pick<Cloudflare.Env, "REGISTRY_PIPELINE_RATE_LIMITER">,
  pathname: string,
): Promise<Response | null> {
  let key: string | null = null;
  if (LIMITED_PATH.test(pathname)) {
    const token = readPipelineSessionToken(request);
    if (token) key = `session:${await pipelineSessionTokenHash(token)}`;
  } else if (pathname === PIPELINE_SESSIONS_PATH && request.method === "POST") {
    key = `open:${request.headers.get("cf-connecting-ip")?.trim() || "unknown"}`;
  }
  if (key === null) return null;
  let admitted: boolean;
  try {
    admitted = (await env.REGISTRY_PIPELINE_RATE_LIMITER.limit({ key })).success;
  } catch (error) {
    console.error(JSON.stringify({ event: "registry_pipeline_rate_limit_unavailable", error: String(error) }));
    admitted = true;
  }
  if (admitted) return null;
  const response = jsonResponse({ error: "too many requests", code: "rate_limited" }, 429);
  response.headers.set("retry-after", String(PIPELINE_RATE_LIMIT_RETRY_SECONDS));
  return response;
}
