import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { ImageBuildBundleMeta } from "@/db/schema";
import { appError } from "@/lib/app-error";
import {
  assignQueuedImageBuilds,
  queueImageBuildsFromBundle,
} from "@/lib/build-scheduler";
import { getScenarioSource } from "@/lib/scenario-sources";
import { buildTar, gzipBytes } from "@/lib/tar";
import baseImagesHcl from "../../../base-images.hcl?raw";
import buildToolsHcl from "../../../build-tools.hcl?raw";

// App-triggered image builds from authoring drafts. The admin's browser runs
// prepare_build (the Rust validator/hasher compiled to wasm — proven
// byte-identical to `intar-image-cli hash`) and sends the content hash here;
// the Worker assembles the same source-bundle layout CI uploads and hands it
// to the existing build queue. The hash is not blindly trusted: the builder
// recomputes it from the bundle contents (verify_bundle_for_build) and fails
// the build on any mismatch, and re-validates the scenario before building.

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_ARCHES = new Set(["x86_64", "aarch64"]);

function embeddedKinoVersion(): string {
  const match = buildToolsHcl.match(/version\s*=\s*"([^"]+)"/);
  if (!match?.[1]) {
    throw appError(500, "build_tools_unreadable", "embedded build-tools.hcl has no kino version");
  }
  return match[1];
}

export interface DraftBuildResult {
  rev: string;
  contentHash: string;
  queued: number;
  assigned: Array<{ buildId: string; hostId: string }>;
}

export async function queueDraftBuild(params: {
  scenarioId: string;
  contentHash: string;
  kinoVersion: string;
  imageArch: string;
}): Promise<DraftBuildResult> {
  const source = await getScenarioSource(params.scenarioId);
  if (!source) {
    throw appError(404, "draft_not_found", "no draft for that scenario id");
  }

  const contentHash = params.contentHash.trim().toLowerCase();
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw appError(400, "invalid_content_hash", "content hash must be 64 hex chars");
  }
  if (!IMAGE_ARCHES.has(params.imageArch)) {
    throw appError(400, "invalid_arch", "unsupported image architecture");
  }
  const kinoVersion = embeddedKinoVersion();
  if (params.kinoVersion !== kinoVersion) {
    throw appError(
      409,
      "kino_version_stale",
      `the validator pins kino ${params.kinoVersion} but the deployed pipeline expects ${kinoVersion} — reload the page`,
    );
  }

  const encoder = new TextEncoder();
  const tar = buildTar([
    { path: "base-images.hcl", bytes: encoder.encode(baseImagesHcl) },
    { path: "build-tools.hcl", bytes: encoder.encode(buildToolsHcl) },
    {
      path: `scenarios/${params.scenarioId}/scenario.hcl`,
      bytes: encoder.encode(source.hcl),
    },
  ]);
  const archive = await gzipBytes(tar);

  const now = Date.now();
  const rev = `draft-${params.scenarioId}-${now.toString(36)}`;
  const r2Key = `builds/bundles/${rev}.tar.gz`;
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    r2Key,
    archive as unknown as ArrayBuffer,
    {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { rev, kino_version: kinoVersion },
    },
  );

  const meta: ImageBuildBundleMeta = {
    rev,
    kino_version: kinoVersion,
    build_format_version: "intar-image-build-v7",
    buildFormatVersion: "intar-image-build-v7",
    scenarios: [
      {
        scenarioId: params.scenarioId,
        arch: params.imageArch as ImageBuildBundleMeta["scenarios"][number]["arch"],
        contentHash,
      },
    ],
  };

  const db = drizzle(env.DB);
  const queued = await queueImageBuildsFromBundle(db, {
    rev,
    r2Key,
    kinoVersion,
    meta,
    nowUnixMs: now,
  });
  const assigned = await assignQueuedImageBuilds(db, now);

  return {
    rev,
    contentHash,
    queued: queued.queued,
    assigned,
  };
}
