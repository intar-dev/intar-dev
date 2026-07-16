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

  if (url.pathname === "/agent/registry/images") {
    return handleAgentImageIndex(request, env);
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
