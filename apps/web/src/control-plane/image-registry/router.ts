import { handleBundleUpload } from "./bundle";
import { handlePublish } from "./publish";
import {
  handleUploadCreate,
  handleUploadPart,
  handleUploadComplete,
} from "./uploads";
import {
  handleAgentImageIndex,
  handleAgentImageDownload,
  handleAgentArtifactDownload,
  handleAgentBundleDownload,
  handleAgentBuildLogUpload,
} from "./agent";
import {
  handleAgentImageChunkDownload,
  handleAgentImageManifestDownload,
  handleAgentToolsDiskDownload,
  handleImageChunkExists,
  handleImageChunkUpload,
  handleImageManifestUpload,
} from "./chunks";
import {
  handleScenarioGuestToolsPromotion,
  handleScenarioGuestToolsWarm,
} from "./guest-tools";
import { handleImageBuildRevisionStatus } from "./build-status";
import {
  handleCandidateCatalogPromotion,
  handleCatalogRollback,
} from "./catalog-promotion";
import { handleImageCutoverGate } from "./cutover-gate";
import {
  handleRegistryAdmissionEnforcement,
  handleRegistryAdmissionPause,
  handleRegistryAdmissionReap,
  handleRegistryAdmissionStatus,
  handleUploadSessionComplete,
  handleUploadSessionCreate,
  handleUploadSessionHeartbeat,
} from "./upload-sessions";
import {
  admitRegistryOperation,
  type RegistryOperationLease,
} from "@/lib/image-registry-admission";
import type { ImageRegistryOperationKind } from "@/db/schema";

export async function handleImageRegistryRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  // Session and admission control. These routes never take a writer lease of
  // their own, otherwise a session could not open while a sweep is settling.
  if (url.pathname === "/registry/v1/upload-sessions") {
    return handleUploadSessionCreate(request, env);
  }
  if (url.pathname === "/registry/v1/upload-sessions/heartbeat") {
    return handleUploadSessionHeartbeat(request, env);
  }
  if (url.pathname === "/registry/v1/upload-sessions/complete") {
    return handleUploadSessionComplete(request, env);
  }
  if (url.pathname === "/registry/v1/admission") {
    return handleRegistryAdmissionStatus(request, env);
  }
  if (url.pathname === "/registry/v1/admission/enforcement") {
    return handleRegistryAdmissionEnforcement(request, env);
  }
  if (url.pathname === "/registry/v1/admission/pause") {
    return handleRegistryAdmissionPause(request, env);
  }
  if (url.pathname === "/registry/v1/admission/reap") {
    return handleRegistryAdmissionReap(request, env);
  }

  if (url.pathname === "/registry/v1/bundles") {
    return admitted(request, env, "POST", "bundle_put", () =>
      handleBundleUpload(request, env),
    );
  }

  if (url.pathname === "/registry/v1/publish") {
    // Publication awaits the cleanup service, so it holds no writer lease here.
    // The handler takes a short lease around its own catalog commit instead.
    return handlePublish(request, env);
  }

  if (url.pathname === "/registry/v1/uploads") {
    return admitted(request, env, "POST", "multipart_create", () =>
      handleUploadCreate(request, env),
    );
  }

  if (url.pathname === "/registry/v1/uploads/parts") {
    return admitted(request, env, "PUT", "multipart_part", () =>
      handleUploadPart(request, env, url),
    );
  }

  if (url.pathname === "/registry/v1/uploads/complete") {
    return admitted(request, env, "POST", "multipart_complete", () =>
      handleUploadComplete(request, env),
    );
  }

  if (url.pathname === "/registry/v1/image-chunks/exists") {
    return admitted(request, env, "POST", "chunk_exists", () =>
      handleImageChunkExists(request, env),
    );
  }
  if (url.pathname === "/registry/v1/guest-tools/promote") {
    return admitted(request, env, "POST", "guest_tools", () =>
      handleScenarioGuestToolsPromotion(request, env),
    );
  }
  if (url.pathname === "/registry/v1/guest-tools/warm") {
    return admitted(request, env, "POST", "guest_tools", () =>
      handleScenarioGuestToolsWarm(request, env),
    );
  }
  if (url.pathname === "/registry/v1/cutover/gate") {
    return handleImageCutoverGate(request, env);
  }

  const buildStatusMatch = url.pathname.match(
    /^\/registry\/v1\/builds\/revisions\/([A-Za-z0-9._-]{1,128})$/,
  );
  if (buildStatusMatch) {
    return handleImageBuildRevisionStatus(
      request,
      env,
      buildStatusMatch[1] ?? "",
    );
  }

  const catalogPromotionMatch = url.pathname.match(
    /^\/registry\/v1\/catalog\/promote\/([A-Za-z0-9._-]{1,128})$/,
  );
  if (catalogPromotionMatch) {
    // Promotion awaits the cleanup service. Wrapping the whole handler in a
    // writer lease would deadlock the collector: the sweep can never acquire
    // while this request holds an unresolved writer. The handler therefore
    // takes a short lease around its own catalog commit only.
    return handleCandidateCatalogPromotion(
      request,
      env,
      catalogPromotionMatch[1] ?? "",
    );
  }
  const catalogRollbackMatch = url.pathname.match(
    /^\/registry\/v1\/catalog\/rollback\/([A-Za-z0-9._-]{1,128})$/,
  );
  if (catalogRollbackMatch) {
    return admitted(request, env, "POST", "pointer_mutation", () =>
      handleCatalogRollback(request, env, catalogRollbackMatch[1] ?? ""),
    );
  }

  const imageChunkUploadMatch = url.pathname.match(
    /^\/registry\/v1\/image-chunks\/([a-f0-9]{64})$/,
  );
  if (imageChunkUploadMatch) {
    return admitted(request, env, "PUT", "chunk_put", () =>
      handleImageChunkUpload(request, env, imageChunkUploadMatch[1] ?? ""),
    );
  }

  const imageManifestUploadMatch = url.pathname.match(
    /^\/registry\/v1\/image-manifests\/([a-f0-9]{64})\.json$/,
  );
  if (imageManifestUploadMatch) {
    return admitted(request, env, "PUT", "manifest_put", () =>
      handleImageManifestUpload(
        request,
        env,
        imageManifestUploadMatch[1] ?? "",
      ),
    );
  }

  if (url.pathname === "/agent/registry/images") {
    return handleAgentImageIndex(request, env);
  }

  const agentChunkMatch = url.pathname.match(
    /^\/agent\/registry\/image-chunks\/([a-f0-9]{64})$/,
  );
  if (agentChunkMatch) {
    return handleAgentImageChunkDownload(request, env, agentChunkMatch[1] ?? "");
  }

  const agentManifestMatch = url.pathname.match(
    /^\/agent\/registry\/image-manifests\/([a-f0-9]{64})$/,
  );
  if (agentManifestMatch) {
    return handleAgentImageManifestDownload(
      request,
      env,
      agentManifestMatch[1] ?? "",
    );
  }

  const agentToolsDiskMatch = url.pathname.match(
    /^\/agent\/registry\/guest-tools\/disks\/([a-f0-9]{64})$/,
  );
  if (agentToolsDiskMatch) {
    return handleAgentToolsDiskDownload(
      request,
      env,
      agentToolsDiskMatch[1] ?? "",
    );
  }

  const downloadMatch = url.pathname.match(
    /^\/agent\/registry\/images\/([^/]+)\/([A-Fa-f0-9]{64})$/,
  );
  if (downloadMatch) {
    return handleAgentImageDownload(
      request,
      env,
      decodeURIComponent(downloadMatch[1] ?? ""),
      (downloadMatch[2] ?? "").toLowerCase(),
    );
  }

  const artifactMatch = url.pathname.match(
    /^\/agent\/registry\/artifacts\/([A-Fa-f0-9]{64})$/,
  );
  if (artifactMatch) {
    return handleAgentArtifactDownload(
      request,
      env,
      (artifactMatch[1] ?? "").toLowerCase(),
    );
  }

  const bundleMatch = url.pathname.match(
    /^\/agent\/registry\/bundles\/([^/]+)$/,
  );
  if (bundleMatch) {
    return handleAgentBundleDownload(
      request,
      env,
      decodeURIComponent(bundleMatch[1] ?? ""),
    );
  }

  const buildLogMatch = url.pathname.match(/^\/agent\/builds\/([^/]+)\/log$/);
  if (buildLogMatch) {
    return handleAgentBuildLogUpload(
      request,
      env,
      decodeURIComponent(buildLogMatch[1] ?? ""),
    );
  }

  return null;
}

/**
 * Registers one shared writer around a registry write handler. Admission runs
 * after the credential check inside the helper and before the handler touches
 * R2 or a catalog pointer, so the whole write is protected.
 *
 * The lease is released in a finally. A process that dies before the release
 * leaves the writer unresolved, which blocks the destructive sweep until an
 * operator reaps it.
 */
async function admitted(
  request: Request,
  env: Cloudflare.Env,
  method: string,
  operation: ImageRegistryOperationKind,
  run: () => Promise<Response>,
): Promise<Response> {
  if (request.method !== method) return run();

  const admitted_ = await admitRegistryOperation(request, env, { operation });
  if (!admitted_.ok) return admitted_.response;
  const lease: RegistryOperationLease = admitted_.lease;

  let outcome: "ok" | "error" | "unknown" = "unknown";
  try {
    const response = await run();
    // A refusal by the handler is settled: these handlers decide before they
    // write. A server error is not settled, because the write may have landed
    // before the failure, so it stays a hold until an operator resolves it.
    outcome = response.status >= 500 ? "unknown" : "ok";
    return response;
  } catch (error) {
    outcome = "unknown";
    throw error;
  } finally {
    await lease.complete(outcome);
  }
}
