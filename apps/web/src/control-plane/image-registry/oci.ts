import {
  REGISTRY_TOKEN_AUDIENCE,
  mintRegistryToken,
  verifyAgentToken,
  verifyHostCredential,
  type VerifiedAgentHost,
} from "@/control-plane/auth";
import { GUEST_CONTRACT, KINO_ARTIFACT_TYPE, MACHINE_ARTIFACT_TYPE } from "@/generated/constants";
import { preparationAuthoritySql } from "@/lib/personal-image-access";
import { currentScenarioRunContentAccessCondition } from "@/lib/scenario-runs/content-access";
import { DIGEST_RE, HEX_RE, ociObjectKey, readKinoPin } from "./push";

/**
 * `/v2`: a read-only OCI Distribution view of the registry for agent hosts,
 * Pull category only. A token carries identity only; every request re-runs
 * its repository's grant before R2 is read and again before the body is
 * returned, and a denial looks exactly like an unknown object.
 */

const SERVICE = "intar.dev";
const NOW_MS = "CAST(unixepoch('subsecond') * 1000 AS INTEGER)";

type Repository =
  | { kind: "machines"; image: string }
  | { kind: "kino" }
  | { kind: "specs" };

export async function handleOciRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v2" && !url.pathname.startsWith("/v2/")) return null;
  const method = request.method;
  if (url.pathname === "/v2/token") {
    if (method === "GET") return issueToken(request, env);
    if (method === "POST") return ociError(404, "NAME_UNKNOWN", "token requests are GET");
  }
  if (method !== "GET" && method !== "HEAD") {
    const response = ociError(405, "UNSUPPORTED", "this registry is read-only");
    response.headers.set("allow", "GET, HEAD");
    return response;
  }

  const route = parseRoute(url.pathname);
  const presented = bearer(request);
  const agent = presented
    ? await verifyAgentToken(env, presented, { audience: REGISTRY_TOKEN_AUDIENCE })
    : null;
  if (!agent?.ok || agent.agent.role !== "agent") {
    return challenge(request, route?.repository, presented !== null);
  }
  const host = agent.agent;
  if (url.pathname === "/v2" || url.pathname === "/v2/") {
    return new Response("{}", {
      headers: { "content-type": "application/json", "docker-distribution-api-version": "registry/2.0" },
    });
  }
  if (!route) return ociError(404, "NAME_UNKNOWN", "unknown repository");
  if ("error" in route) return route.error;

  const response = await serve(request, env, host, route);
  audit({
    event: "registry.pull",
    host_id: host.hostId,
    repository: route.repository.kind,
    // A tag is logged as the digest it resolved to whenever something was served.
    digest: response.headers.get("docker-content-digest") ?? route.digest,
    status: response.status,
    bytes: Number(response.headers.get("content-length") ?? 0),
  });
  return response;
}

type Route =
  | { repository: Repository; manifest: boolean; digest: string }
  | { repository?: Repository; error: Response };

function parseRoute(pathname: string): Route | null {
  const match =
    pathname.match(/^\/v2\/(machines)\/([^/]+)\/(manifests|blobs)\/([^/]+)$/) ??
    pathname.match(/^\/v2\/(kino)()\/(manifests|blobs)\/([^/]+)$/) ??
    pathname.match(/^\/v2\/(specs)()\/(blobs)\/([^/]+)$/);
  if (!match) return null;
  const [, kind, name = "", type, reference = ""] = match;
  const manifest = type === "manifests";
  let repository: Repository;
  if (kind === "machines") {
    if (!HEX_RE.test(name)) {
      return { error: ociError(400, "NAME_INVALID", "invalid repository name") };
    }
    repository = { kind: "machines", image: `sha256:${name}` };
  } else {
    repository = { kind: kind as "kino" | "specs" };
  }
  const unknown = manifest ? "MANIFEST_UNKNOWN" : "BLOB_UNKNOWN";
  if (manifest && reference === (repository.kind === "machines" ? "machine" : "current")) {
    return { repository, manifest, digest: reference };
  }
  if (!reference.startsWith("sha256:")) {
    return { repository, error: ociError(404, unknown, "unknown reference") };
  }
  if (!DIGEST_RE.test(reference)) {
    return { repository, error: ociError(400, "DIGEST_INVALID", "invalid digest") };
  }
  return { repository, manifest, digest: reference };
}

async function serve(
  request: Request,
  env: Cloudflare.Env,
  host: VerifiedAgentHost,
  route: { repository: Repository; manifest: boolean; digest: string },
): Promise<Response> {
  const unknown = () =>
    ociError(404, route.manifest ? "MANIFEST_UNKNOWN" : "BLOB_UNKNOWN", "unknown or not granted");
  let digest = route.digest;
  if (digest === "machine" && route.repository.kind === "machines") digest = route.repository.image;
  if (digest === "current") {
    const pin = await readKinoPin(env, GUEST_CONTRACT);
    if (!pin) return unknown();
    digest = pin.current;
  }
  const grant = () => readGrant(env, host, route.repository, route.manifest, digest);
  const mediaType = await grant();
  if (mediaType === null) return unknown();

  const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
  const key = ociObjectKey(digest);
  const headers = new Headers({
    "content-type": route.manifest ? mediaType : "application/octet-stream",
    "docker-content-digest": digest,
    "cache-control": "private, no-store",
  });
  if (!route.manifest) headers.set("accept-ranges", "bytes");

  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object || (await grant()) === null) return unknown();
    headers.set("content-length", String(object.size));
    return new Response(null, { headers });
  }

  let span: { offset: number; length: number } | undefined;
  const rangeHeader = route.manifest ? null : request.headers.get("range");
  if (rangeHeader) {
    const object = await bucket.head(key);
    if (!object) return unknown();
    const parsed = parseRange(rangeHeader, object.size);
    if (parsed === "unsatisfiable") {
      headers.set("content-range", `bytes */${object.size}`);
      return ociError(416, "RANGE_INVALID", "unsatisfiable range", headers);
    }
    span = parsed ?? undefined;
  }
  const object = await bucket.get(key, span ? { range: span } : {});
  if (!object) return unknown();
  if ((await grant()) === null) {
    await object.body.cancel();
    return unknown();
  }
  if (span) {
    headers.set("content-range", `bytes ${span.offset}-${span.offset + span.length - 1}/${object.size}`);
    headers.set("content-length", String(span.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

/**
 * One `bytes=` range of a blob of `size` bytes: `a-b`, `a-` or `-n`. A
 * multi-range or unparseable header is ignored (null, the whole blob).
 */
export function parseRange(header: string, size: number): { offset: number; length: number } | "unsatisfiable" | null {
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const [, first = "", last = ""] = match;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(first);
  if (last !== "" && Number(last) < offset) return null;
  if (offset >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Number(last);
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

/**
 * The grant of one repository read: the media type of the manifest (or
 * `application/octet-stream` for a blob) when `host` may read `digest`,
 * else null. Always a fresh D1 read.
 *
 * - `machines/<m>`: `m` is an indexed machine image named by something this
 *   host is assigned ({@link assignedImageSql}); a blob must also be indexed
 *   under `m`.
 * - `kino`: any current agent host, for Kino artifacts and their blobs only.
 * - `specs`: the spec of a VM this host is assigned.
 */
async function readGrant(
  env: Cloudflare.Env,
  host: VerifiedAgentHost,
  repository: Repository,
  manifest: boolean,
  digest: string,
): Promise<string | null> {
  let sql: string;
  let target = digest;
  let blob: string | null = null;
  if (repository.kind === "machines") {
    target = repository.image;
    blob = manifest ? null : digest;
    if (manifest && digest !== target) return null;
    sql = `SELECT media_type FROM registry_manifests
      WHERE digest = ?2 AND artifact_type = '${MACHINE_ARTIFACT_TYPE}'
        AND (?4 IS NULL OR EXISTS (SELECT 1 FROM registry_manifest_blobs
          WHERE manifest_digest = ?2 AND blob_digest = ?4))
        AND EXISTS (${assignedImageSql("image")})`;
  } else if (repository.kind === "kino") {
    sql = manifest
      ? `SELECT media_type FROM registry_manifests
          WHERE digest = ?2 AND artifact_type = '${KINO_ARTIFACT_TYPE}' AND EXISTS (SELECT 1 FROM host)`
      : `SELECT 'application/octet-stream' AS media_type FROM registry_manifest_blobs blob
          JOIN registry_manifests kino ON kino.digest = blob.manifest_digest
          WHERE blob.blob_digest = ?2 AND kino.artifact_type = '${KINO_ARTIFACT_TYPE}'
            AND EXISTS (SELECT 1 FROM host)`;
  } else {
    if (manifest) return null;
    sql = `SELECT 'application/octet-stream' AS media_type WHERE EXISTS (${assignedImageSql("spec")})`;
  }
  const binds = [host.hostId, target, host.credentialGeneration, ...(sql.includes("?4") ? [blob] : [])];
  const row = await env.DB.prepare(`WITH ${CURRENT_HOST_SQL} ${sql} LIMIT 1`)
    .bind(...binds)
    .first<{ media_type: string }>();
  return row?.media_type ?? null;
}

/**
 * The token's host (?1, generation ?3), still enrolled as a current agent,
 * its desired state, and the runs and preparations on it that still pass
 * their access checks (materialized apart to stay under D1's expression
 * depth limit).
 */
const CURRENT_HOST_SQL = `host AS (
    SELECT h.id, h.scope, h.user_id, h.organization_id FROM agent_hosts h
     WHERE h.id = ?1 AND h.credential_generation = ?3 AND h.disabled = 0 AND h.role = 'agent'
       AND (h.scope = 'platform'
         OR (h.scope = 'personal' AND EXISTS (SELECT 1 FROM user owner WHERE owner.id = h.user_id
           AND owner.deleted_at IS NULL AND coalesce(owner.banned, 0) = 0))
         OR (h.scope = 'organization' AND EXISTS (SELECT 1 FROM organization org WHERE org.id = h.organization_id)))),
  desired AS (
    SELECT d.doc_json FROM host_desired_state d JOIN host ON host.id = d.host_id
     WHERE (json_extract(d.doc_json, '$.scope'), json_extract(d.doc_json, '$.owner_user_id')) = (host.scope, host.user_id)),
  permitted_runs AS MATERIALIZED (
    SELECT run.run_id FROM scenario_runs run
     WHERE run.host_id = ?1 AND ${currentScenarioRunContentAccessCondition()}),
  permitted_preparations AS MATERIALIZED (
    SELECT prep.images_json FROM personal_image_preparations prep
     WHERE prep.host_id = ?1 AND ${preparationAuthoritySql()})`;

/**
 * What a host is assigned that names digest ?2 in the VM field `field`
 * (`image` or `spec`). This is the one place host assignments grant reads;
 * a new kind of assignment is added here.
 *
 * - Every host: a running desired VM naming it. A platform host's desired state is
 *   the grant; on a personal or organization host the VM must be backed by
 *   the run it names: active, current execution and lease, the owner still
 *   allowed, and the run's content access.
 * - Images only: a platform host's `cached_images`, and the live or
 *   candidate revision of an enabled scenario.
 * - Images only, personal and organization hosts: `cached_images` backed by
 *   an image preparation that names the digest and still passes its
 *   authority check.
 */
function assignedImageSql(field: "image" | "spec"): string {
  const desiredVm = `SELECT 1 FROM host, desired, json_each(desired.doc_json, '$.vms') vm
    WHERE json_extract(vm.value, '$.${field}') = ?2 AND json_extract(vm.value, '$.desired_phase') = 'running'
      AND (host.scope = 'platform' OR EXISTS (${RUN_BACKS_VM_SQL}))`;
  if (field === "spec") return desiredVm;
  return `${desiredVm}
    UNION ALL
    SELECT 1 FROM host, desired, json_each(desired.doc_json, '$.cached_images') cached
     WHERE cached.value = ?2 AND (host.scope = 'platform' OR EXISTS (
       SELECT 1 FROM permitted_preparations prep, json_each(prep.images_json) image
        WHERE image.value = ?2))
    UNION ALL
    SELECT 1 FROM host, scenarios scenario
      JOIN scenario_revisions revision ON revision.scenario_id = scenario.id
        AND revision.rev IN (scenario.live_rev, scenario.candidate_rev)
      JOIN json_each(revision.doc_json, '$.machines') machine
     WHERE host.scope = 'platform' AND scenario.enabled = 1
       AND json_extract(machine.value, '$.image_digest') = ?2`;
}

/** The run a desired VM (`vm`) names, still entitled to it on `host`. */
const RUN_BACKS_VM_SQL = `SELECT 1 FROM scenario_runs run
    JOIN permitted_runs permitted ON permitted.run_id = run.run_id
    JOIN runtime_executions execution ON execution.id = run.runtime_execution_id
    JOIN user owner ON owner.id = execution.user_id
   WHERE run.run_id = json_extract(vm.value, '$.run_id') AND run.host_id = host.id
     AND (execution.id, execution.generation, execution.user_id) = (json_extract(vm.value, '$.runtime_execution_id'),
       json_extract(vm.value, '$.generation'), json_extract(vm.value, '$.owner_user_id'))
     AND json_extract(vm.value, '$.lease_expires_at_unix_ms') > ${NOW_MS}
     AND (execution.user_id, execution.host_id, execution.domain_kind, execution.domain_id) =
       (run.user_id, host.id, 'scenario', run.run_id)
     AND execution.state IN ('provisioning', 'ready') AND execution.ended_at IS NULL
     AND execution.archive_requested_at IS NULL AND execution.lease_expires_at > ${NOW_MS}
     AND NOT EXISTS (SELECT 1 FROM runtime_executions newer
       WHERE newer.domain_kind = execution.domain_kind AND newer.domain_id = execution.domain_id
         AND newer.generation > execution.generation)
     AND run.active_key = execution.user_id AND run.hidden_at IS NULL AND run.completed_at IS NULL
     AND run.failed_at IS NULL AND run.delete_requested_at IS NULL
     AND owner.deleted_at IS NULL AND coalesce(owner.banned, 0) = 0
     AND ((host.scope = 'personal' AND host.user_id = execution.user_id)
       OR (host.scope = 'organization' AND host.organization_id = run.organization_id
         AND EXISTS (SELECT 1 FROM member membership WHERE membership.organization_id = host.organization_id
           AND membership.user_id = execution.user_id)))`;

/**
 * `GET /v2/token`: an agent host's `agent-connect` JWT (Bearer, or Basic
 * with the host id) or its enrollment credential (Basic) for a 15-minute
 * `intar-registry` token.
 */
async function issueToken(request: Request, env: Cloudflare.Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const { success } = await env.REGISTRY_TOKEN_RATE_LIMITER.limit({ key: `ip:${ip}` });
  if (!success) {
    const response = ociError(429, "TOOMANYREQUESTS", "too many token requests");
    response.headers.set("retry-after", "60");
    return response;
  }
  const credential = readCredential(request);
  let kind: "c2" | "jwt" | "none" = "none";
  let verified: { agent: VerifiedAgentHost; notAfter?: number } | null = null;
  if (credential) {
    if (/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(credential.secret)) {
      kind = "jwt";
      const result = await verifyAgentToken(env, credential.secret, {
        audience: String(env.AGENT_JWT_AUDIENCE ?? "agent-connect"),
        expectedHostId: credential.hostId,
      });
      if (result.ok) verified = { agent: result.agent, notAfter: result.expiresAt };
    } else if (credential.hostId && HEX_RE.test(credential.secret)) {
      kind = "c2";
      const result = await verifyHostCredential(env, credential.hostId, credential.secret);
      if (result.ok) verified = { agent: result.host };
    }
  }
  const minted = verified?.agent.role === "agent"
    ? await mintRegistryToken(env, verified.agent, verified.notAfter)
    : null;
  audit({
    event: "registry.token",
    host_id: verified?.agent.hostId ?? null,
    cred_kind: kind,
    outcome: minted ? "issued" : "refused",
    exp: minted?.expiresAt ?? null,
    user_agent: request.headers.get("user-agent")?.split(/[\s/]/)[0]?.slice(0, 64) ?? null,
    colo: typeof request.cf?.colo === "string" ? request.cf.colo : null,
  });
  if (!minted) return challenge(request, undefined, credential !== null);
  return Response.json(
    {
      token: minted.token,
      access_token: minted.token,
      expires_in: minted.expiresAt - minted.issuedAt,
      issued_at: new Date(minted.issuedAt * 1000).toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function readCredential(request: Request): { hostId?: string; secret: string } | null {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    const secret = header.slice(7).trim();
    return secret ? { secret } : null;
  }
  if (!header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  const hostId = decoded.slice(0, colon);
  const secret = decoded.slice(colon + 1);
  return colon > 0 && secret ? { hostId, secret } : null;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

function challenge(request: Request, repository: Repository | undefined, presented: boolean): Response {
  const origin = new URL(request.url).origin;
  let value = `Bearer realm="${origin}/v2/token",service="${SERVICE}"`;
  if (repository) {
    const name = repository.kind === "machines" ? `machines/${repository.image.slice(7)}` : repository.kind;
    value += `,scope="repository:${name}:pull"`;
  }
  if (presented) value += `,error="invalid_token"`;
  return ociError(401, "UNAUTHORIZED", "authentication required", new Headers({ "www-authenticate": value }));
}

function ociError(status: number, code: string, message: string, headers = new Headers()): Response {
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  return new Response(JSON.stringify({ errors: [{ code, message, detail: null }] }), { status, headers });
}

function audit(record: Record<string, unknown>): void {
  console.info(JSON.stringify(record));
}
