import { and, eq, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import {
  hostDesiredState,
  imageBuilds,
  imageBuildBundles,
  scenarioCatalogCandidates,
  scenarioSourceCommits,
  scenarioSources,
  vmScenarios,
  vmScenarioVms,
} from "@/db/schema";
import type { VerifiedAgentHost } from "@/control-plane/auth";
import type { ScenarioVmManifestV5 } from "@/generated/catalog";
import { type AppErrorResponseBody, appError, toErrorResponse } from "@/lib/app-error";
import { BodyLimitExceededError, readBoundedBody } from "@/lib/request-security";
import {
  acceptScenarioSourceUpload,
  endSourceCompiles,
  MAX_COMPILE_ATTEMPTS,
  MAX_SOURCE_UPLOAD_BYTES,
  scenarioSourceBindingPredicate,
  scenarioSourceScope,
  sourceRefusal,
  stagedSourceObjectPrefix,
} from "@/lib/scenario-sources";
import {
  jsonResponse,
  isRecord,
  isSafeBundleRev,
  isSafeBuildId,
  isImageKey,
  normalizeSha256,
  registryImageKey,
  imageObjectKey,
  artifactObjectKey,
  readString,
  IMAGE_KEY_RE,
  SHA256_HEX_RE,
} from "./shared";
import { imageManifestObjectKey } from "./chunks";
import { agentScenarioImageAccess, currentAgentHost } from "./image-access";

interface AgentChunkedImageIndexSource {
  imageKey: unknown;
  imageId: string | null;
  imageFormat: string;
  imageVirtualSizeBytes: number;
  chunkManifestSha256: string | null;
  guestBootstrapAbi: number | null;
  kernelSha256: string | null;
  initrdSha256: string | null;
  bootCmdline: string | null;
}

interface AgentImageIndexEntry {
  image_key: string;
  image_id?: string;
  image_sha256?: string;
  image_format: string;
  image_virtual_size_bytes: number;
  chunk_manifest_sha256?: string;
  guest_bootstrap_abi?: number;
  boot: {
    kernel_sha256: string;
    initrd_sha256: string;
    cmdline: string;
  };
  bytes: number;
  manifest_download_url?: string;
  chunk_download_base_url?: string;
  download_url?: string;
}

const IMAGE_INDEX_CONCURRENCY = 4;
type RegistryHeadCache = Map<string, Promise<R2Object | null>>;

export async function handleAgentBundleDownload(
  request: Request,
  env: Cloudflare.Env,
  rev: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!isSafeBundleRev(rev)) {
    return jsonResponse({ error: "invalid bundle rev" }, 400);
  }

  const db = drizzle(env.DB);
  const activeAssignment = and(
    currentAgentHost(verified.agent),
    eq(imageBuilds.rev, rev),
    eq(imageBuilds.hostId, verified.agent.hostId),
    or(eq(imageBuilds.status, "assigned"), eq(imageBuilds.status, "building")),
  );
  const rows = await db
    .select({ id: imageBuilds.id, r2Key: imageBuildBundles.r2Key })
    .from(imageBuilds)
    .innerJoin(imageBuildBundles, eq(imageBuildBundles.rev, imageBuilds.rev))
    .where(activeAssignment)
    .limit(1);
  const assignment = rows[0];
  const objectKey = assignment?.r2Key;
  if (!objectKey) {
    return jsonResponse({ error: "bundle not found" }, 404);
  }

  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(objectKey);
  if (!object) {
    return jsonResponse({ error: "bundle object not found" }, 404);
  }

  // R2 can wait across a credential rotation or an assignment change. Check
  // the same assignment and object before exposing any source bytes.
  const current = await db
    .select({ id: imageBuilds.id })
    .from(imageBuilds)
    .innerJoin(imageBuildBundles, eq(imageBuildBundles.rev, imageBuilds.rev))
    .where(and(
      activeAssignment,
      eq(imageBuilds.id, assignment.id),
      eq(imageBuildBundles.r2Key, objectKey),
    ))
    .limit(1);
  if (!current.length) {
    await object.body.cancel();
    return jsonResponse({ error: "bundle not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-build-bundle-rev": rev,
    },
  });
}

const MAX_DIAGNOSTICS_CHARS = 64 * 1024;

/** A pull compile's repository snapshot, for the builder the row names. */
export async function handleAgentSourceSnapshot(
  request: Request,
  env: Cloudflare.Env,
  compileId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;
  try {
    const { row, stillCompiling } = await fencedSourceCompile(
      env,
      verified.agent,
      request,
      compileId,
    );
    const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(sourceArchiveKey(row));
    if (!object) return jsonResponse({ error: "snapshot not found" }, 404);
    // R2 can wait across an expiry or a supersede. Check the same fence
    // before exposing any tenant bytes.
    const [current] = await drizzle(env.DB)
      .select({ id: scenarioSourceCommits.id })
      .from(scenarioSourceCommits)
      .where(stillCompiling)
      .limit(1);
    if (!current) {
      await object.body.cancel();
      throw fenced();
    }
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-length": String(object.size),
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    const refusal = toErrorResponse(error, "scenario source snapshot failed");
    return jsonResponse(refusal.body, refusal.status);
  }
}

/**
 * A pull compile's result: the multipart success runs the request half of
 * ingest with the pull claim, and a JSON `SourceCompileFailureV1` makes the
 * row invalid with its diagnostics. Scope, rev and sha come from the row,
 * never from the builder.
 */
export async function handleAgentSourceResult(
  request: Request,
  env: Cloudflare.Env,
  compileId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;
  const agent = verified.agent;
  try {
    const { row, attempt, stillCompiling } = await fencedSourceCompile(
      env,
      agent,
      request,
      compileId,
    );
    const response = (request.headers.get("content-type") ?? "").startsWith(
      "application/json",
    )
      ? await recordSourceCompileFailure(request, env, row, attempt, stillCompiling)
      : await acceptScenarioSourceUpload(request, env, {
          scope: scenarioSourceScope(row.organizationId),
          repositoryId: row.repositoryId,
          sha: row.sha,
          purpose: row.purpose,
          claim: { via: "pull", commitId: row.id, attempt, hostId: agent.hostId },
        }).catch((error: unknown) => {
          const refusal = toErrorResponse(error, "scenario source compile result failed");
          return jsonResponse(refusal.body, refusal.status);
        });
    const state = response.ok
      ? "ingesting"
      : await settleRefusedResult(env, stillCompiling, response.clone());
    if (state === null) return response;
    // An expiry-like return keeps the archive for the next delivery.
    if (state !== "fetching") {
      await env.VM_IMAGE_REGISTRY_BUCKET.delete(sourceArchiveKey(row));
    }
    await endSourceCompiles(env, [agent.hostId]);
    return response;
  } catch (error) {
    const refusal = toErrorResponse(error, "scenario source compile result failed");
    return jsonResponse(refusal.body, refusal.status);
  }
}

// The fence of both compile routes: the row is still compiling on this
// builder under this attempt, and its binding may still write.
async function fencedSourceCompile(
  env: Cloudflare.Env,
  agent: VerifiedAgentHost,
  request: Request,
  compileId: string,
) {
  const attemptParam = new URL(request.url).searchParams.get("attempt") ?? "";
  if (!isSafeBundleRev(compileId) || !/^\d{1,9}$/.test(attemptParam)) {
    throw appError(400, "compile_invalid", "invalid compile id or attempt");
  }
  const attempt = Number(attemptParam);
  const [row] = await drizzle(env.DB)
    .select({
      id: scenarioSourceCommits.id,
      scopeKey: scenarioSourceCommits.scopeKey,
      purpose: scenarioSourceCommits.purpose,
      sha: scenarioSourceCommits.sha,
      rev: scenarioSourceCommits.rev,
      attempt: scenarioSourceCommits.attempt,
      state: scenarioSourceCommits.state,
      compileHostId: scenarioSourceCommits.compileHostId,
      organizationId: scenarioSources.organizationId,
      repositoryId: scenarioSources.githubRepositoryId,
      active: sql<number>`${scenarioSourceBindingPredicate()}`,
    })
    .from(scenarioSourceCommits)
    .innerJoin(scenarioSources, eq(scenarioSources.scopeKey, scenarioSourceCommits.scopeKey))
    .where(and(eq(scenarioSourceCommits.id, compileId), currentAgentHost(agent)))
    .limit(1);
  if (!row) throw appError(404, "not_found", "compile not found");
  if (
    row.state !== "compiling" ||
    row.compileHostId !== agent.hostId ||
    row.attempt !== attempt
  ) {
    throw fenced();
  }
  if (!row.active) {
    throw sourceRefusal(
      409,
      "binding_inactive",
      "This scenario source is paused or disconnected.",
    );
  }
  const stillCompiling = and(
    eq(scenarioSourceCommits.id, compileId),
    eq(scenarioSourceCommits.attempt, attempt),
    eq(scenarioSourceCommits.compileHostId, agent.hostId),
    eq(scenarioSourceCommits.state, "compiling"),
    currentAgentHost(agent),
    sql`EXISTS (SELECT 1 FROM scenario_sources WHERE scope_key = ${row.scopeKey}
      AND ${scenarioSourceBindingPredicate()})`,
  );
  return { row, attempt, stillCompiling };
}

// A result the builder drops and would only repeat settles the row now, not
// at the lease: a content refusal is invalid with its reason, and a compiler
// mismatch returns the row like an expiry. The fence, a 5xx and a body cut off
// in transit (`multipart_required`) leave it compiling. Null when unchanged.
async function settleRefusedResult(
  env: Cloudflare.Env,
  stillCompiling: ReturnType<typeof and>,
  response: Response,
): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as AppErrorResponseBody | null;
  const outdated = body?.code === "compiler_outdated";
  if (
    !outdated &&
    ((response.status !== 400 && response.status !== 413) ||
      body?.code === "multipart_required")
  ) {
    return null;
  }
  const [settled] = await drizzle(env.DB)
    .update(scenarioSourceCommits)
    .set({
      state: outdated
        ? sql`CASE WHEN attempt >= ${MAX_COMPILE_ATTEMPTS} THEN 'failed' ELSE 'fetching' END`
        : "invalid",
      detail: body?.error ?? `refused with ${response.status}`,
      updatedAt: Date.now(),
    })
    .where(stillCompiling)
    .returning({ state: scenarioSourceCommits.state });
  return settled?.state ?? null;
}

function fenced() {
  return sourceRefusal(409, "fenced", "This compile is no longer assigned to this builder.");
}

function sourceArchiveKey(row: {
  scopeKey: string;
  rev: string;
  purpose: "deploy" | "validate";
}): string {
  return `${stagedSourceObjectPrefix(row.scopeKey, row.rev, row.purpose)}source.tar.gz`;
}

// Diagnostics are kept whole, in order, up to the column's 64 KiB.
async function recordSourceCompileFailure(
  request: Request,
  env: Cloudflare.Env,
  row: { id: string },
  attempt: number,
  stillCompiling: ReturnType<typeof and>,
): Promise<Response> {
  let failure: unknown;
  try {
    const body = request.body
      ? await readBoundedBody(request.body, MAX_SOURCE_UPLOAD_BYTES)
      : new Uint8Array();
    failure = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      throw appError(413, "payload_too_large", "The compile result is too large.");
    }
    throw appError(400, "compile_failure_invalid", "The compile failure is not JSON.");
  }
  if (
    !isRecord(failure) ||
    failure.compile_id !== row.id ||
    failure.attempt !== attempt ||
    !Array.isArray(failure.errors)
  ) {
    throw appError(400, "compile_failure_invalid", "The compile failure names another compile.");
  }
  const diagnostics: unknown[] = [];
  let size = 2;
  for (const entry of failure.errors) {
    if (!isRecord(entry) || typeof entry.message !== "string") continue;
    const text = JSON.stringify(entry);
    size += text.length + 1;
    if (size > MAX_DIAGNOSTICS_CHARS) break;
    diagnostics.push(entry);
  }
  const updated = await drizzle(env.DB)
    .update(scenarioSourceCommits)
    .set({
      state: "invalid",
      detail: "The repository did not compile.",
      diagnosticsJson: JSON.stringify(diagnostics),
      updatedAt: Date.now(),
    })
    .where(stillCompiling)
    .returning({ id: scenarioSourceCommits.id });
  if (!updated.length) throw fenced();
  return jsonResponse({ ok: true }, 202);
}

export async function handleAgentBuildLogUpload(
  request: Request,
  env: Cloudflare.Env,
  buildId: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!isSafeBuildId(buildId)) {
    return jsonResponse({ error: "invalid build id" }, 400);
  }

  const db = drizzle(env.DB);
  const rows = await db
    .select({ hostId: imageBuilds.hostId })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, buildId))
    .limit(1);
  const build = rows[0];
  if (!build) {
    return jsonResponse({ error: "build not found" }, 404);
  }
  if (build.hostId !== verified.agent.hostId) {
    return jsonResponse(
      { error: "build is not assigned to this builder" },
      409,
    );
  }

  const payload = await request.arrayBuffer();
  const objectKey = `builds/logs/${buildId}.log`;
  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: {
      build_id: buildId,
      host_id: verified.agent.hostId,
    },
  });

  const updated = await db
    .update(imageBuilds)
    .set({
      logR2Key: objectKey,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(imageBuilds.id, buildId),
        eq(imageBuilds.hostId, verified.agent.hostId),
      ),
    )
    .returning({ id: imageBuilds.id });
  if (!updated.length) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(objectKey);
    return jsonResponse(
      { error: "build assignment changed during log upload" },
      409,
    );
  }

  return jsonResponse({ ok: true, build_id: buildId, log_key: objectKey });
}

export async function handleAgentImageIndex(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  const db = drizzle(env.DB);
  const sources = await loadAgentImageIndexSources(db, verified.agent);
  const byKey = new Map<string, AgentImageIndexEntry>();
  const headCache: RegistryHeadCache = new Map();
  await addChunkedImageIndexEntries(byKey, env, sources, headCache);

  // R2 reads can wait across access revocation or replacement of image metadata.
  // Return only captured entries which still have an exact current source.
  const currentSources = await loadAgentImageIndexSources(db, verified.agent);
  const currentByIdentity = new Map(groupChunkedImageIndexSources(currentSources)
    .map(group => [chunkedImageIndexIdentity(group[0]!), group]));
  return jsonResponse({
    images: [...byKey.entries()]
      .filter(([identity, entry]) => currentByIdentity.get(identity)?.some(source =>
        imageIndexEntryMatchesSource(entry, source)))
      .map(([, entry]) => entry)
      .sort((a, b) => a.image_key.localeCompare(b.image_key)),
  });
}

async function loadAgentImageIndexSources(
  db: DrizzleD1Database,
  agent: VerifiedAgentHost,
): Promise<AgentChunkedImageIndexSource[]> {
  const rows = await db
    .select({
      imageKey: vmScenarioVms.imageKeyJson,
      imageSha256: vmScenarioVms.imageSha256,
      imageFormat: vmScenarioVms.imageFormat,
      imageVirtualSizeBytes: vmScenarioVms.imageVirtualSizeBytes,
      chunkManifestSha256: vmScenarioVms.chunkManifestSha256,
      guestBootstrapAbi: vmScenarioVms.guestBootstrapAbi,
      kernelSha256: vmScenarioVms.kernelSha256,
      initrdSha256: vmScenarioVms.initrdSha256,
      bootCmdline: vmScenarioVms.bootCmdline,
    })
    .from(vmScenarioVms)
    .innerJoin(
      vmScenarios,
      eq(vmScenarios.scenarioId, vmScenarioVms.scenarioId),
    )
    .where(agentScenarioImageAccess(agent));

  return [
    ...rows.map((row) => ({
      imageKey: row.imageKey,
      imageId: row.imageSha256,
      imageFormat: row.imageFormat,
      imageVirtualSizeBytes: row.imageVirtualSizeBytes,
      chunkManifestSha256: row.chunkManifestSha256,
      guestBootstrapAbi: row.guestBootstrapAbi,
      kernelSha256: row.kernelSha256,
      initrdSha256: row.initrdSha256,
      bootCmdline: row.bootCmdline,
    })),
    ...(await loadDesiredCandidateVms(db, agent)).map((vm) => ({
      imageKey: vm.image_key,
      imageId: vm.image_id,
      imageFormat: vm.image_format,
      imageVirtualSizeBytes: vm.image_virtual_size_bytes,
      chunkManifestSha256: vm.chunk_manifest_sha256,
      guestBootstrapAbi: vm.guest_bootstrap_abi,
      kernelSha256: vm.boot.kernel_sha256,
      initrdSha256: vm.boot.initrd_sha256,
      bootCmdline: vm.boot.cmdline,
    })),
  ];
}

async function addChunkedImageIndexEntry(
  byKey: Map<string, AgentImageIndexEntry>,
  env: Cloudflare.Env,
  source: AgentChunkedImageIndexSource,
  headCache: RegistryHeadCache,
): Promise<void> {
  if (!isImageKey(source.imageKey)) return;
  const imageId = normalizeSha256(source.imageId ?? "");
  const chunkManifestSha256 = normalizeSha256(source.chunkManifestSha256 ?? "");
  const kernelSha256 = normalizeSha256(source.kernelSha256 ?? "");
  const initrdSha256 = normalizeSha256(source.initrdSha256 ?? "");
  const bootCmdline = source.bootCmdline?.trim() ?? "";
  if (
    !imageId ||
    !chunkManifestSha256 ||
    source.imageFormat !== "raw_chunks_v1" ||
    !Number.isSafeInteger(source.imageVirtualSizeBytes) ||
    source.imageVirtualSizeBytes <= 0 ||
    source.guestBootstrapAbi !== 2 ||
    !kernelSha256 ||
    !initrdSha256 ||
    !bootCmdline
  ) {
    return;
  }

  const imageKey = registryImageKey(source.imageKey);
  const identity = `${imageKey}:${imageId}`;
  const existing = byKey.get(identity);
  if (
    existing && imageIndexEntryMatchesSource(existing, source)
  ) {
    return;
  }
  const object = await registryObjectHead(
    env,
    headCache,
    imageManifestObjectKey(chunkManifestSha256),
  );
  if (
    !object ||
    object.customMetadata?.manifest_sha256 !== chunkManifestSha256 ||
    object.customMetadata?.image_id !== imageId ||
    !(await bootArtifactsExist(env, [kernelSha256, initrdSha256], headCache))
  ) {
    return;
  }

  byKey.set(identity, {
    image_key: imageKey,
    image_id: imageId,
    image_format: source.imageFormat,
    image_virtual_size_bytes: source.imageVirtualSizeBytes,
    chunk_manifest_sha256: chunkManifestSha256,
    guest_bootstrap_abi: 2,
    boot: {
      kernel_sha256: kernelSha256,
      initrd_sha256: initrdSha256,
      cmdline: bootCmdline,
    },
    bytes: source.imageVirtualSizeBytes,
    manifest_download_url: `/agent/registry/image-manifests/${chunkManifestSha256}`,
    chunk_download_base_url: `/agent/registry/image-manifests/${chunkManifestSha256}/chunks`,
  });
}

function imageIndexEntryMatchesSource(
  entry: AgentImageIndexEntry,
  source: AgentChunkedImageIndexSource,
): boolean {
  return entry.image_format === source.imageFormat &&
    entry.image_virtual_size_bytes === source.imageVirtualSizeBytes &&
    entry.chunk_manifest_sha256 === normalizeSha256(source.chunkManifestSha256 ?? "") &&
    entry.guest_bootstrap_abi === source.guestBootstrapAbi &&
    entry.boot.kernel_sha256 === normalizeSha256(source.kernelSha256 ?? "") &&
    entry.boot.initrd_sha256 === normalizeSha256(source.initrdSha256 ?? "") &&
    entry.boot.cmdline === source.bootCmdline?.trim();
}

async function addChunkedImageIndexEntries(
  byKey: Map<string, AgentImageIndexEntry>,
  env: Cloudflare.Env,
  sources: AgentChunkedImageIndexSource[],
  headCache: RegistryHeadCache,
): Promise<void> {
  const groups = groupChunkedImageIndexSources(sources);
  const entriesByGroup: Array<Map<string, AgentImageIndexEntry> | undefined> =
    Array(groups.length);
  let nextGroup = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(IMAGE_INDEX_CONCURRENCY, groups.length) },
      async () => {
        for (;;) {
          const groupIndex = nextGroup++;
          const group = groups[groupIndex];
          if (!group) return;
          const groupEntries = new Map<string, AgentImageIndexEntry>();
          for (const source of group) {
            await addChunkedImageIndexEntry(
              groupEntries,
              env,
              source,
              headCache,
            );
          }
          entriesByGroup[groupIndex] = groupEntries;
        }
      },
    ),
  );
  for (const groupEntries of entriesByGroup) {
    if (!groupEntries) continue;
    for (const [identity, entry] of groupEntries) {
      byKey.set(identity, entry);
    }
  }
}

function groupChunkedImageIndexSources(
  sources: AgentChunkedImageIndexSource[],
): AgentChunkedImageIndexSource[][] {
  const groups = new Map<string, AgentChunkedImageIndexSource[]>();
  for (const [index, source] of sources.entries()) {
    const identity = chunkedImageIndexIdentity(source) ?? `invalid:${index}`;
    const group = groups.get(identity);
    if (group) group.push(source);
    else groups.set(identity, [source]);
  }
  return [...groups.values()];
}

function chunkedImageIndexIdentity(
  source: AgentChunkedImageIndexSource,
): string | null {
  if (!isImageKey(source.imageKey)) return null;
  const imageId = normalizeSha256(source.imageId ?? "");
  return imageId ? `${registryImageKey(source.imageKey)}:${imageId}` : null;
}

async function loadDesiredCandidateVms(
  db: DrizzleD1Database,
  agent: VerifiedAgentHost,
): Promise<ScenarioVmManifestV5[]> {
  // Candidate prewarming has no owner workload grant for personal hosts.
  if (agent.scope !== "platform") return [];
  const desiredRows = await db
    .select({ docJson: hostDesiredState.docJson })
    .from(hostDesiredState)
    .where(and(eq(hostDesiredState.hostId, agent.hostId), currentAgentHost(agent)))
    .limit(1);
  const desiredImages = new Set(
    (desiredRows[0]?.docJson.cached_images ?? []).flatMap((image) => {
      if (!isImageKey(image.image_key)) return [];
      const imageId = normalizeSha256(image.image_id);
      return imageId ? [`${registryImageKey(image.image_key)}:${imageId}`] : [];
    }),
  );
  if (desiredImages.size === 0) return [];

  const candidateRows = await db
    .select({ manifest: scenarioCatalogCandidates.manifestJson })
    .from(scenarioCatalogCandidates)
    .where(currentAgentHost(agent));
  const matches = new Map<string, ScenarioVmManifestV5>();
  for (const candidate of candidateRows) {
    if (
      candidate.manifest.schema_version !== 5 ||
      !Array.isArray(candidate.manifest.vms)
    ) {
      continue;
    }
    for (const vm of candidate.manifest.vms) {
      if (!isImageKey(vm.image_key)) continue;
      const imageId = normalizeSha256(vm.image_id);
      if (!imageId) continue;
      const identity = `${registryImageKey(vm.image_key)}:${imageId}`;
      if (desiredImages.has(identity) && !matches.has(identity)) {
        matches.set(identity, vm);
      }
    }
  }
  return [...matches.values()];
}

export async function bootArtifactsExist(
  env: Cloudflare.Env,
  sha256s: string[],
  headCache: RegistryHeadCache = new Map(),
): Promise<boolean> {
  const objectKeys = [...new Set(sha256s.map(artifactObjectKey))];
  const objects = await Promise.all(
    objectKeys.map((objectKey) =>
      registryObjectHead(env, headCache, objectKey),
    ),
  );
  return objects.every((head, index) => {
    const objectKey = objectKeys[index];
    const sha256 = objectKey?.slice("artifacts/".length) ?? "";
    return bootArtifactObjectMatchesSha(head, sha256);
  });
}

function registryObjectHead(
  env: Cloudflare.Env,
  headCache: RegistryHeadCache,
  objectKey: string,
): Promise<R2Object | null> {
  const cached = headCache.get(objectKey);
  if (cached) return cached;
  const head = env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
  headCache.set(objectKey, head);
  void head.then(
    (object) => {
      if (!object && headCache.get(objectKey) === head)
        headCache.delete(objectKey);
    },
    () => {
      if (headCache.get(objectKey) === head) headCache.delete(objectKey);
    },
  );
  return head;
}

export function imageObjectMatchesSha<
  T extends { customMetadata?: Record<string, string> },
>(object: T | null, imageKey: string, sha256: string): object is T {
  if (!object) {
    return false;
  }
  const metadataSha256 = normalizeSha256(
    object.customMetadata?.image_sha256 ??
      object.customMetadata?.imageSha256 ??
      "",
  );
  const metadataImageKey =
    readString(object.customMetadata?.image_key) ??
    readString(object.customMetadata?.imageKey);
  return metadataSha256 === sha256 && metadataImageKey === imageKey;
}

export function bootArtifactObjectMatchesSha<
  T extends { customMetadata?: Record<string, string> },
>(object: T | null, sha256: string): object is T {
  if (!object) {
    return false;
  }
  const metadataSha256 = normalizeSha256(
    object.customMetadata?.artifact_sha256 ??
      object.customMetadata?.artifactSha256 ??
      "",
  );
  return metadataSha256 === sha256;
}

export async function handleAgentImageDownload(
  request: Request,
  env: Cloudflare.Env,
  imageKey: string,
  sha256: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!IMAGE_KEY_RE.test(imageKey) || !SHA256_HEX_RE.test(sha256)) {
    return jsonResponse({ error: "invalid image key or sha256" }, 400);
  }

  const db = drizzle(env.DB);
  if (!(await agentCanAccessImage(db, verified.agent, imageKey, sha256))) {
    return jsonResponse({ error: "image not found" }, 404);
  }

  const objectKey = imageObjectKey(imageKey, sha256);
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(objectKey);
  if (!imageObjectMatchesSha(object, imageKey, sha256) ||
      !await agentCanAccessImage(db, verified.agent, imageKey, sha256)) {
    return jsonResponse({ error: "image not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-image-key": imageKey,
      "x-image-sha256": sha256,
    },
  });
}

export async function handleAgentArtifactDownload(
  request: Request,
  env: Cloudflare.Env,
  sha256: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!SHA256_HEX_RE.test(sha256)) {
    return jsonResponse({ error: "invalid artifact sha256" }, 400);
  }

  const db = drizzle(env.DB);
  if (!(await agentCanAccessArtifact(db, verified.agent, sha256))) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }

  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    artifactObjectKey(sha256),
  );
  if (!bootArtifactObjectMatchesSha(object, sha256) ||
      !await agentCanAccessArtifact(db, verified.agent, sha256)) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-artifact-sha256": sha256,
    },
  });
}

export async function requireBuilderAgentRequest(
  request: Request,
  env: Cloudflare.Env,
) {
  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified;
  if (verified.agent.role !== "builder") {
    return {
      ok: false as const,
      response: jsonResponse({ error: "builder role required" }, 403),
    };
  }
  if (verified.agent.scope !== "platform") {
    return {
      ok: false as const,
      response: jsonResponse(
        { error: "Only platform servers can build images" },
        403,
      ),
    };
  }
  return verified;
}

async function agentCanAccessImage(
  db: DrizzleD1Database,
  agent: VerifiedAgentHost,
  requestedImageKey: string,
  sha256: string,
): Promise<boolean> {
  const rows = await db
    .select({ imageKey: vmScenarioVms.imageKeyJson })
    .from(vmScenarioVms)
    .innerJoin(
      vmScenarios,
      eq(vmScenarios.scenarioId, vmScenarioVms.scenarioId),
    )
    .where(
      and(
        eq(vmScenarioVms.imageSha256, sha256),
        agentScenarioImageAccess(agent),
      ),
    );
  if (
    rows.some(
      (row) =>
        isImageKey(row.imageKey) &&
        registryImageKey(row.imageKey) === requestedImageKey,
    )
  ) {
    return true;
  }
  return false;
}

async function agentCanAccessArtifact(
  db: DrizzleD1Database,
  agent: VerifiedAgentHost,
  sha256: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: vmScenarioVms.id })
    .from(vmScenarioVms)
    .innerJoin(
      vmScenarios,
      eq(vmScenarios.scenarioId, vmScenarioVms.scenarioId),
    )
    .where(
      and(
        or(
          eq(vmScenarioVms.kernelSha256, sha256),
          eq(vmScenarioVms.initrdSha256, sha256),
        ),
        agentScenarioImageAccess(agent),
      ),
    )
    .limit(1);
  if (rows.length > 0) return true;
  const desiredCandidates = await loadDesiredCandidateVms(db, agent);
  if (
    desiredCandidates.some(
      (vm) =>
        normalizeSha256(vm.boot.kernel_sha256) === sha256 ||
        normalizeSha256(vm.boot.initrd_sha256) === sha256,
    )
  ) {
    return true;
  }
  return false;
}
