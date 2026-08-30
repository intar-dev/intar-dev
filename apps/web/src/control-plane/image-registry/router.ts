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

export async function handleImageRegistryRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/registry/v1/bundles") {
    return handleBundleUpload(request, env);
  }

  if (url.pathname === "/registry/v1/publish") {
    return handlePublish(request, env);
  }

  if (url.pathname === "/registry/v1/uploads") {
    return handleUploadCreate(request, env);
  }

  if (url.pathname === "/registry/v1/uploads/parts") {
    return handleUploadPart(request, env, url);
  }

  if (url.pathname === "/registry/v1/uploads/complete") {
    return handleUploadComplete(request, env);
  }

  if (url.pathname === "/registry/v1/image-chunks/exists") {
    return handleImageChunkExists(request, env);
  }
  if (url.pathname === "/registry/v1/guest-tools/promote") {
    return handleScenarioGuestToolsPromotion(request, env);
  }
  if (url.pathname === "/registry/v1/guest-tools/warm") {
    return handleScenarioGuestToolsWarm(request, env);
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
    return handleCatalogRollback(
      request,
      env,
      catalogRollbackMatch[1] ?? "",
    );
  }

  const imageChunkUploadMatch = url.pathname.match(
    /^\/registry\/v1\/image-chunks\/([a-f0-9]{64})$/,
  );
  if (imageChunkUploadMatch) {
    return handleImageChunkUpload(request, env, imageChunkUploadMatch[1] ?? "");
  }

  const imageManifestUploadMatch = url.pathname.match(
    /^\/registry\/v1\/image-manifests\/([a-f0-9]{64})\.json$/,
  );
  if (imageManifestUploadMatch) {
    return handleImageManifestUpload(
      request,
      env,
      imageManifestUploadMatch[1] ?? "",
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
