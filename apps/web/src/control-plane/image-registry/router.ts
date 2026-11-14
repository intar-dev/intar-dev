import {
  handleSourceBundleUpload,
  handleSourceCompilerDescriptor,
} from "./bundle";
import {
  handleAgentBundleDownload,
  handleAgentBuildLogUpload,
  handleAgentSourceResult,
  handleAgentSourceSnapshot,
} from "./agent";
import { handleImageCutoverGate } from "./cutover-gate";
import {
  handleBlobHead,
  handleBlobPut,
  handleBuildResult,
  handleManifestPut,
} from "./push";
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
import { jsonResponse } from "./shared";
import {
  AGENT_SOURCES_PATH,
  SOURCE_BUNDLES_PATH,
  SOURCE_COMPILER_PATH,
} from "@/generated/constants";

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

  // Scenario sources hold no writer: they only stage under builds/**, which
  // the collector never sweeps.
  if (url.pathname === SOURCE_BUNDLES_PATH) {
    return handleSourceBundleUpload(request, env);
  }
  if (url.pathname === SOURCE_COMPILER_PATH) {
    return handleSourceCompilerDescriptor(request, env);
  }

  if (url.pathname === "/registry/v1/cutover/gate") {
    return handleImageCutoverGate(request, env);
  }

  const ociMatch = url.pathname.match(
    /^\/registry\/v1\/(blobs|manifests)\/([^/]+)$/,
  );
  if (ociMatch) {
    const hex = ociMatch[2]?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
    if (!hex) return jsonResponse({ error: "invalid digest" }, 400);
    if (ociMatch[1] === "manifests") {
      return admitted(request, env, "PUT", "manifest_put", () =>
        handleManifestPut(request, env, hex),
      );
    }
    return request.method === "HEAD"
      ? admitted(request, env, "HEAD", "blob_exists", () =>
          handleBlobHead(request, env, hex),
        )
      : admitted(request, env, "PUT", "blob_put", () =>
          handleBlobPut(request, env, hex),
        );
  }

  const buildResultMatch = url.pathname.match(
    /^\/registry\/v1\/builds\/([^/]+)\/result$/,
  );
  if (buildResultMatch) {
    return admitted(request, env, "POST", "build_result", () =>
      handleBuildResult(request, env, buildResultMatch[1] ?? ""),
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

  // Fenced by row, host and attempt; like the bundle download, no writer.
  const sourceMatch = url.pathname.match(
    new RegExp(`^${AGENT_SOURCES_PATH}/([^/]+)(/result)?$`),
  );
  if (sourceMatch) {
    return sourceMatch[2]
      ? handleAgentSourceResult(request, env, sourceMatch[1] ?? "")
      : handleAgentSourceSnapshot(request, env, sourceMatch[1] ?? "");
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
