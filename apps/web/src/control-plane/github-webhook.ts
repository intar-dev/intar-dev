// GitHub App webhook for scenario sources. Every event is only a poke: it
// never disconnects, pauses or resumes a binding, and never names a tenant.
// The per-binding Durable Object re-reads GitHub through its own token mint,
// so a replayed or reordered delivery can only cause a re-read.
import { hexToBytes } from "@/control-plane/image-registry/chunks";
import {
  textEncoder,
  timingSafeHashEqual,
} from "@/control-plane/image-registry/shared";
import {
  BodyLimitExceededError,
  readBoundedBody,
} from "@/lib/request-security";

export const GITHUB_WEBHOOK_PATH = "/integrations/github/webhook";

// GitHub allows 25 MB. A larger push is picked up by the 10-minute poll.
const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;
// GitHub documents lower-case hex only in examples, so either case passes.
const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

const POKE_BINDING = `UPDATE scenario_sources SET poked_at = ?1
  WHERE github_installation_id = ?2 AND github_repository_id = ?3
    AND disconnected_at IS NULL`;

// A re-run reopens a failed row and retires an invalid one; the DO decides
// the rest on its next tick.
const flipRerequested = (match: string) => `UPDATE scenario_source_commits
  SET state = CASE state WHEN 'failed' THEN 'ingesting' ELSE 'superseded' END,
    updated_at = ?1
  WHERE state IN ('failed', 'invalid') AND ${match}
    AND scope_key IN (SELECT scope_key FROM scenario_sources
      WHERE github_installation_id = ?2 AND github_repository_id = ?3
        AND disconnected_at IS NULL)`;

interface WebhookPayload {
  action?: unknown;
  ref?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { id?: unknown; default_branch?: unknown } | null;
  check_run?: { id?: unknown } | null;
  check_suite?: { head_sha?: unknown } | null;
}

export async function handleGitHubWebhook(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const secret = env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) return answer(404);
  if (request.method !== "POST") return answer(405);

  const signature = SIGNATURE_PATTERN.exec(
    request.headers.get("x-hub-signature-256") ?? "",
  )?.[1];
  if (!signature) return answer(401);

  let body: Uint8Array<ArrayBuffer>;
  try {
    body = request.body
      ? await readBoundedBody(request.body, MAX_WEBHOOK_BODY_BYTES)
      : new Uint8Array();
  } catch (error) {
    if (error instanceof BodyLimitExceededError) return answer(413);
    throw error;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign("HMAC", key, body);
  if (!timingSafeHashEqual(expected, hexToBytes(signature).buffer)) {
    return answer(401);
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as WebhookPayload;
  } catch {
    return answer(400);
  }
  await pokeBindings(env.DB, request.headers.get("x-github-event"), payload);
  return answer(204);
}

async function pokeBindings(
  db: D1Database,
  event: string | null,
  payload: WebhookPayload,
): Promise<void> {
  const installationId = githubId(payload?.installation?.id);
  if (installationId === null) return;
  const now = Date.now();

  if (event === "installation" || event === "installation_repositories") {
    await db
      .prepare(
        `UPDATE scenario_sources SET poked_at = ?1
          WHERE github_installation_id = ?2 AND disconnected_at IS NULL`,
      )
      .bind(now, installationId)
      .run();
    return;
  }

  const repositoryId = githubId(payload.repository?.id);
  if (repositoryId === null) return;
  const poke = () =>
    db.prepare(POKE_BINDING).bind(now, installationId, repositoryId);

  if (event === "push") {
    const branch = payload.repository?.default_branch;
    if (typeof branch === "string" && payload.ref === `refs/heads/${branch}`) {
      await poke().run();
    }
    return;
  }

  // check_suite requested and completed arrive for every push in every
  // installed repository, and the push event already pokes.
  if (payload.action !== "rerequested") return;
  let flip: D1PreparedStatement;
  if (event === "check_run") {
    const checkRunId = githubId(payload.check_run?.id);
    if (checkRunId === null) return;
    flip = db
      .prepare(flipRerequested("check_run_id = ?4"))
      .bind(now, installationId, repositoryId, checkRunId);
  } else if (event === "check_suite") {
    const headSha = payload.check_suite?.head_sha;
    if (typeof headSha !== "string") return;
    flip = db
      .prepare(flipRerequested("purpose = 'deploy' AND sha = ?4"))
      .bind(now, installationId, repositoryId, headSha);
  } else {
    return;
  }
  await db.batch([flip, poke()]);
}

function githubId(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function answer(status: number): Response {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
